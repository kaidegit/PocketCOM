//! POCKETCOM — the `com` surface hub: mounts HostOps into the guest as
//! `globalThis.com` (SPEC §4.2) and owns everything shared across the
//! namespace: the handle counter, the connection registry, and the
//! tick-boundary event stream. Protocol implementations live in siblings:
//!
//! - `com_serial.rs` — serial ports (`serialList` / `serialOpen` / `setSignals`).
//! - `com_tcp.rs`    — TCP client + TCP server (`tcpConnect` / `tcpListen`).
//! - `com_udp.rs`    — UDP (`udpBind`).
//! - `com_ws.rs`     — WebSocket client (`wsConnect`).
//! - `com_env.rs`    — settings persistence + system appearance (`cfg*`).
//!
//! Transport shape follows `pocket-net` (engine/crates/pocket-net): the core
//! owns handles and validation; a worker thread owns the socket/port; worker
//! events cross an mpsc queue and are only observed when the guest polls at a
//! tick boundary (`com.poll()`). Workers NEVER call into QuickJS — the desktop
//! host is single-threaded and native threads must not touch the realm.
//!
//! Event shapes (JSON lines on the shared stream; net events from M2):
//! - `{t:"data",h,b64}` / `{t:"error",h,code,msg}` / `{t:"closed",h,reason}`
//! - `{t:"opened",h,addr}`     — async connection established (net).
//! - `{t:"accepted",h,c,addr}` — TCP server accepted child `c` on listener `h`.
//! - `{t:"appearance",v}`      — system appearance changed (com_env watcher).
//!
//! Handles come from ONE monotonic counter shared by serial and net, so the
//! guest treats every handle uniformly; `com.write`/`com.close` dispatch on
//! which map owns the handle.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use anyhow::Result;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use pocket_mod::qjs::{Coerced, Ctx, FromJs, Function, TypedArray, Value};
use pocket_mod::{Guest, qjs};
use serde_json::json;

use crate::com_env;
use crate::com_serial::SerialCore;
use crate::com_tcp;
use crate::com_udp;
use crate::com_ws;

// ---------------------------------------------------------------------------
// guest-string decoding (verbatim rationale from pocket-ui-surface): a host
// op must never abort the frame transaction over a legal JS value.
// ---------------------------------------------------------------------------

pub(crate) struct LossyString(String);

impl<'js> FromJs<'js> for LossyString {
    fn from_js(ctx: &Ctx<'js>, value: Value<'js>) -> qjs::Result<LossyString> {
        match Coerced::<String>::from_js(ctx, value.clone()) {
            Ok(s) => Ok(LossyString(s.0)),
            Err(_) => {
                let js = value
                    .into_string()
                    .ok_or_else(|| qjs::Error::new_from_js("value", "string"))?;
                let c = js.to_cstring()?;
                let bytes =
                    unsafe { std::slice::from_raw_parts(c.as_ptr() as *const u8, c.len()) };
                Ok(LossyString(String::from_utf8_lossy(bytes).into_owned()))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// shared com-namespace infrastructure
// ---------------------------------------------------------------------------

/// Structured failure returned to the guest as JSON, never as a panic.
pub(crate) struct ComFailure {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ComFailure {
    pub(crate) fn param(message: impl Into<String>) -> Self {
        Self {
            code: "invalid-param",
            message: message.into(),
        }
    }

    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self {
            code: "io-error",
            message: message.into(),
        }
    }

    pub(crate) fn to_json(&self) -> serde_json::Value {
        json!({"error": {"code": self.code, "msg": self.message}})
    }
}

/// Env-gated trace (POCKETCOM_TRACE=1, scripted UI debugging). Shared by every
/// com.* module so `POCKETCOM_TRACE=1` dumps every op.
pub(crate) fn trace_enabled() -> bool {
    std::env::var_os("POCKETCOM_TRACE").is_some()
}

/// Next handle from the shared com-namespace counter. Monotonic across serial
/// AND net (and never 0), so no cross-map collision is possible.
pub(crate) fn next_handle(counter: &AtomicU32) -> u32 {
    loop {
        let h = counter.fetch_add(1, Ordering::Relaxed);
        if h != 0 {
            return h;
        }
    }
}

/// host:port target validation shared by tcp/udp opens.
pub(crate) fn validate_host_port(host: &str, port: u16) -> Option<ComFailure> {
    if host.is_empty() {
        return Some(ComFailure::param("host is required"));
    }
    if port == 0 {
        return Some(ComFailure::param("port must be 1..65535"));
    }
    None
}

// ---------------------------------------------------------------------------
// net connection registry (tcp/udp/ws share one table, one event stream)
// ---------------------------------------------------------------------------

pub(crate) enum StreamCmd {
    Write(Vec<u8>),
    Shutdown,
}

pub(crate) enum ListenCmd {
    Shutdown,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum StreamKind {
    TcpClient,
    TcpChild,
    Udp,
    Ws,
}

/// One entry in the shared connection map. The map lives behind a Mutex
/// because the TCP-listener worker thread registers accepted children from
/// its own thread — the guest must be able to write/close a child handle
/// even before it has processed the `accepted` event.
pub(crate) enum NetConn {
    Stream {
        /// Diagnostic tag (tests / future per-kind behavior).
        #[allow(dead_code)]
        kind: StreamKind,
        cmd_tx: mpsc::Sender<StreamCmd>,
        /// Listener handle that accepted this child (TCP children only).
        parent: Option<u32>,
    },
    Listener {
        cmd_tx: mpsc::Sender<ListenCmd>,
        children: Vec<u32>,
        /// Bound address, reported via the `opened` event (kept for tests).
        #[allow(dead_code)]
        local: String,
    },
}

/// The net side of the `com` namespace: connection table + handle counter
/// (shared with serial) + the global worker-event queue. Op functions in
/// com_tcp/com_udp/com_ws receive `&NetRegistry` and spawn their workers.
pub(crate) struct NetRegistry {
    conns: Arc<Mutex<HashMap<u32, NetConn>>>,
    handles: Arc<AtomicU32>,
    /// Global worker-event queue: every net worker pushes JSON lines here,
    /// `poll()` drains them at a tick boundary.
    event_tx: mpsc::Sender<String>,
    event_rx: Mutex<mpsc::Receiver<String>>,
}

impl NetRegistry {
    pub(crate) fn new(handles: Arc<AtomicU32>) -> Self {
        let (event_tx, event_rx) = mpsc::channel();
        Self {
            conns: Arc::new(Mutex::new(HashMap::new())),
            handles,
            event_tx,
            event_rx: Mutex::new(event_rx),
        }
    }

    /// Event sink shared with the appearance watcher (com_env.rs).
    pub(crate) fn event_tx(&self) -> mpsc::Sender<String> {
        self.event_tx.clone()
    }

    pub(crate) fn alloc(&self) -> u32 {
        next_handle(&self.handles)
    }

    /// Registry internals for the TCP listener worker (accepts register
    /// children from its own thread).
    pub(crate) fn conns(&self) -> &Arc<Mutex<HashMap<u32, NetConn>>> {
        &self.conns
    }

    pub(crate) fn handles(&self) -> &Arc<AtomicU32> {
        &self.handles
    }

    pub(crate) fn insert_stream(
        &self,
        handle: u32,
        kind: StreamKind,
        cmd_tx: mpsc::Sender<StreamCmd>,
        parent: Option<u32>,
    ) {
        self.conns.lock().unwrap().insert(
            handle,
            NetConn::Stream {
                kind,
                cmd_tx,
                parent,
            },
        );
    }

    pub(crate) fn insert_listener(&self, handle: u32, cmd_tx: mpsc::Sender<ListenCmd>, local: String) {
        self.conns.lock().unwrap().insert(
            handle,
            NetConn::Listener {
                cmd_tx,
                children: Vec::new(),
                local,
            },
        );
    }

    /// Whether any connection is still registered (teardown tests).
    #[cfg(test)]
    pub(crate) fn has_connections(&self) -> bool {
        !self.conns.lock().unwrap().is_empty()
    }

    /// Write to a stream queues the bytes; writing to a listener broadcasts
    /// to every connected child. `false` = unknown handle or dead worker.
    pub(crate) fn write(&self, handle: i32, bytes: &[u8]) -> bool {
        let conns = self.conns.lock().unwrap();
        match conns.get(&(handle as u32)) {
            Some(NetConn::Stream { cmd_tx, .. }) => {
                cmd_tx.send(StreamCmd::Write(bytes.to_vec())).is_ok()
            }
            Some(NetConn::Listener { children, .. }) => {
                let mut ok = !children.is_empty();
                for &c in children {
                    if let Some(NetConn::Stream { cmd_tx, .. }) = conns.get(&c) {
                        ok |= cmd_tx.send(StreamCmd::Write(bytes.to_vec())).is_ok();
                    }
                }
                ok
            }
            None => false,
        }
    }

    /// Close a stream or listener. Closing a listener also disconnects all
    /// its children (SPEC §3.2: closing a connection closes the connection).
    /// No bounded reap here (unlike serial): the worker observes Shutdown
    /// within a read timeout and drops its socket on exit; nothing in the
    /// net path needs an fd to be free the instant close() returns.
    pub(crate) fn close(&self, handle: i32) -> bool {
        let mut conns = self.conns.lock().unwrap();
        let Some(conn) = conns.remove(&(handle as u32)) else {
            return false;
        };
        match conn {
            NetConn::Stream { cmd_tx, parent, .. } => {
                let _ = cmd_tx.send(StreamCmd::Shutdown);
                if let Some(p) = parent {
                    if let Some(NetConn::Listener { children, .. }) = conns.get_mut(&p) {
                        children.retain(|&c| c != handle as u32);
                    }
                }
                true
            }
            NetConn::Listener { cmd_tx, children, .. } => {
                let _ = cmd_tx.send(ListenCmd::Shutdown);
                for c in children {
                    if let Some(NetConn::Stream { cmd_tx, .. }) = conns.remove(&c) {
                        let _ = cmd_tx.send(StreamCmd::Shutdown);
                    }
                }
                true
            }
        }
    }

    /// Tick-boundary drain of the shared net event queue (guest thread only).
    pub(crate) fn poll(&self) -> Option<String> {
        let rx = self.event_rx.lock().unwrap();
        let mut batch = String::new();
        while let Ok(line) = rx.try_recv() {
            batch.push_str(&line);
            batch.push('\n');
        }
        if batch.is_empty() { None } else { Some(batch) }
    }
}

// ---------------------------------------------------------------------------
// worker-event emitters (shared by tcp/udp/ws workers)
// ---------------------------------------------------------------------------

pub(crate) fn data(events: &mpsc::Sender<String>, handle: u32, bytes: &[u8]) {
    let _ = events.send(
        json!({"t": "data", "h": handle, "b64": B64.encode(bytes)}).to_string(),
    );
}

pub(crate) fn opened(events: &mpsc::Sender<String>, handle: u32, addr: &str) {
    let _ = events.send(json!({"t": "opened", "h": handle, "addr": addr}).to_string());
}

pub(crate) fn accepted(events: &mpsc::Sender<String>, listener: u32, child: u32, addr: &str) {
    let _ = events.send(
        json!({"t": "accepted", "h": listener, "c": child, "addr": addr}).to_string(),
    );
}

pub(crate) fn closed(events: &mpsc::Sender<String>, handle: u32, reason: &str) {
    let _ = events.send(json!({"t": "closed", "h": handle, "reason": reason}).to_string());
}

/// Terminal failure → error event + closed event, then the thread ends.
pub(crate) fn fail(events: &mpsc::Sender<String>, handle: u32, code: &str, msg: &str) {
    let _ = events.send(json!({"t": "error", "h": handle, "code": code, "msg": msg}).to_string());
    let _ = events.send(json!({"t": "closed", "h": handle, "reason": msg}).to_string());
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

/// Mount `globalThis.com` into `guest`. Call after the ui surface mount,
/// before evaluating the bundle (PocketRoot::boot). One namespace covers
/// serial (`com_serial.rs`) + net (`com_tcp/com_udp/com_ws.rs`) + env
/// (`com_env.rs`): the guest sees a single feature-detectable surface with
/// one shared handle space and one event stream.
pub fn mount(guest: &Guest) -> Result<()> {
    let handles = Arc::new(AtomicU32::new(1));
    let serial = Rc::new(RefCell::new(SerialCore::new(handles.clone())));
    let reg = Rc::new(RefCell::new(NetRegistry::new(handles.clone())));
    // The env bridge (cfg ops + appearance watcher) mounts its own namespace
    // concerns into the same `com` namespace below; the watcher thread only
    // needs the shared event sink.
    com_env::start_appearance_watcher(reg.borrow().event_tx());
    guest.mount("com", move |ctx, ns| {
        macro_rules! op {
            ($name:literal, $f:expr) => {
                ns.set($name, Function::new(ctx.clone(), $f)?)?
            };
        }

        let s = serial.clone();
        op!("serialList", move || s.borrow_mut().serial_list());

        let s = serial.clone();
        op!("serialOpen", move |params: LossyString| s
            .borrow_mut()
            .serial_open(&params.0));

        let s = serial.clone();
        let r = reg.clone();
        op!("write", move |handle: i32, buf: TypedArray<u8>| {
            let Some(bytes) = buf.as_bytes() else { return false };
            let len = bytes.len();
            let owned = s.borrow_mut().owns(handle);
            let ok = if owned {
                s.borrow_mut().queue_write(handle, bytes)
            } else {
                r.borrow().write(handle, bytes)
            };
            if trace_enabled() {
                eprintln!("pocketcom-trace: com.write h={handle} n={len} ok={ok}");
            }
            ok
        });

        let s = serial.clone();
        op!("setSignals", move |handle: i32, json: LossyString| s
            .borrow_mut()
            .set_signals(handle, &json.0));

        let s = serial.clone();
        let r = reg.clone();
        op!("close", move |handle: i32| {
            let owned = s.borrow_mut().owns(handle);
            let ok = if owned {
                s.borrow_mut().close(handle)
            } else {
                r.borrow().close(handle)
            };
            if trace_enabled() {
                eprintln!("pocketcom-trace: com.close h={handle} ok={ok}");
            }
            ok
        });

        let s = serial.clone();
        let r = reg.clone();
        op!("poll", move || -> Option<String> {
            let mut batch = s.borrow_mut().poll();
            match r.borrow().poll() {
                Some(net_batch) => {
                    batch.get_or_insert_with(String::new).push_str(&net_batch);
                    batch
                }
                None => batch,
            }
        });

        // --- net bridge (M2, SPEC §3.2) ---
        let r = reg.clone();
        op!("tcpConnect", move |params: LossyString| com_tcp::tcp_connect(
            &r.borrow(),
            &params.0,
        ));
        let r = reg.clone();
        op!("tcpListen", move |params: LossyString| com_tcp::tcp_listen(
            &r.borrow(),
            &params.0,
        ));
        let r = reg.clone();
        op!("udpBind", move |params: LossyString| com_udp::udp_bind(
            &r.borrow(),
            &params.0,
        ));
        let r = reg.clone();
        op!("wsConnect", move |params: LossyString| com_ws::ws_connect(
            &r.borrow(),
            &params.0,
        ));

        // --- settings persistence + system appearance (M2, SPEC §3.7/3.8) —
        // stateless ops live in com_env.rs ---
        op!("cfgRead", move || com_env::cfg_read());
        op!("cfgWrite", move |json: LossyString| com_env::cfg_write(&json.0));
        op!("cfgExport", move |json: LossyString| com_env::cfg_export(&json.0));
        op!("cfgImport", move || com_env::cfg_import());

        Ok(())
    })
}
