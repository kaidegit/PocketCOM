//! POCKETCOM — the `com` surface TCP bridge (M2, SPEC §3.2): TCP client and
//! TCP server. Shared namespace plumbing (registry, emitters, handle counter)
//! lives in `com.rs`; this module owns the op entry points and worker threads.
//!
//! Ops (results mirror serialOpen: `{"handle":N}` or `{"error":{code,msg}}`):
//! - `com.tcpConnect({"host","port"})` — async connect; failures surface as
//!   error+closed events (DNS or connect can take seconds — never stall a
//!   guest turn).
//! - `com.tcpListen({"port"})` — binds synchronously (a busy port is a
//!   structured, immediate error), then accepts in the worker. Writing to a
//!   listener handle broadcasts to all connected children (com.rs registry).
//!
//! Reconnect policy lives entirely in the guest core; the host stays dumb.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::AtomicU32;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use crate::com::{
    accepted, closed, data, fail, next_handle, opened, trace_enabled, validate_host_port,
    ComFailure, ListenCmd, NetConn, NetRegistry, StreamCmd, StreamKind,
};

/// Read granularity / command-drain cadence per worker loop (com_serial
/// parity: commands never wait more than ~2× this behind a read).
pub(crate) const NET_READ_TIMEOUT: Duration = Duration::from_millis(5);
/// Bound on a single TCP connect attempt (per resolved address). DNS itself
/// cannot be bounded without async runtimes; a wedged DNS lookup only stalls
/// the worker thread, never the guest turn.
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound writes so a peer that stops reading cannot wedge the worker forever
/// (a stuck blocking write would delay Shutdown processing indefinitely).
pub(crate) const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// op entry points
// ---------------------------------------------------------------------------

pub(crate) fn tcp_connect(reg: &NetRegistry, params_json: &str) -> String {
    let result = try_tcp_connect(reg, params_json);
    if trace_enabled() {
        eprintln!("pocketcom-trace: com.tcpConnect {params_json} -> {result}");
    }
    result
}

fn try_tcp_connect(reg: &NetRegistry, params_json: &str) -> String {
    let Ok(p) = parse::<TcpConnectParams>(params_json) else {
        return ComFailure::param("malformed tcpConnect params: need {host, port}")
            .to_json()
            .to_string();
    };
    if let Some(f) = validate_host_port(&p.host, p.port) {
        return f.to_json().to_string();
    }
    let handle = reg.alloc();
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let events = reg.event_tx();
    std::thread::spawn(move || {
        tcp_client_worker(handle, p.host, p.port, cmd_rx, events);
    });
    reg.insert_stream(handle, StreamKind::TcpClient, cmd_tx, None);
    json!({"handle": handle}).to_string()
}

pub(crate) fn tcp_listen(reg: &NetRegistry, params_json: &str) -> String {
    let result = try_tcp_listen(reg, params_json);
    if trace_enabled() {
        eprintln!("pocketcom-trace: com.tcpListen {params_json} -> {result}");
    }
    result
}

fn try_tcp_listen(reg: &NetRegistry, params_json: &str) -> String {
    let Ok(p) = parse::<TcpListenParams>(params_json) else {
        return ComFailure::param("malformed tcpListen params: need {port}")
            .to_json()
            .to_string();
    };
    // A server listens on all interfaces (COMTool semantics): accepting
    // connections from LAN devices is the point of the feature. This is an
    // explicit user action, not a background service.
    let bind = format!("0.0.0.0:{}", p.port);
    let listener = match TcpListener::bind(&bind) {
        Ok(l) => l,
        Err(e) => return ComFailure::io(format!("binding {bind}: {e}")).to_json().to_string(),
    };
    let local = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| bind.clone());
    let handle = reg.alloc();
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let events = reg.event_tx();
    let conns = registry_map(reg);
    let handles = registry_handles(reg);
    let local_ref = local.clone();
    std::thread::spawn(move || {
        listener_worker(handle, listener, &local_ref, cmd_rx, events, conns, handles);
    });
    reg.insert_listener(handle, cmd_tx, local);
    json!({"handle": handle}).to_string()
}

fn parse<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T, ()> {
    serde_json::from_str(json).map_err(|_| ())
}

fn registry_map(reg: &NetRegistry) -> Arc<Mutex<HashMap<u32, NetConn>>> {
    reg.conns().clone()
}

fn registry_handles(reg: &NetRegistry) -> Arc<AtomicU32> {
    reg.handles().clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TcpConnectParams {
    host: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TcpListenParams {
    port: u16,
}

// ---------------------------------------------------------------------------
// workers
// ---------------------------------------------------------------------------

/// Connect (with per-address timeout), then run the plain stream loop.
fn tcp_client_worker(
    handle: u32,
    host: String,
    port: u16,
    cmd_rx: mpsc::Receiver<StreamCmd>,
    events: mpsc::Sender<String>,
) {
    let addrs = match (host.as_str(), port).to_socket_addrs() {
        Ok(it) => it.collect::<Vec<_>>(),
        Err(e) => {
            fail(&events, handle, "io-error", &format!("resolving {host}:{port}: {e}"));
            return;
        }
    };
    if addrs.is_empty() {
        fail(&events, handle, "io-error", &format!("resolving {host}:{port}: no addresses"));
        return;
    }
    let mut last_err = String::from("no addresses");
    let mut stream = None;
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, CONNECT_TIMEOUT) {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last_err = format!("connecting {addr}: {e}"),
        }
    }
    let Some(stream) = stream else {
        fail(&events, handle, "io-error", &last_err);
        return;
    };
    configure_stream(&stream);
    let peer = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_default();
    opened(&events, handle, &peer);
    stream_loop(handle, stream, cmd_rx, events);
}

fn tcp_child_worker(
    handle: u32,
    stream: TcpStream,
    cmd_rx: mpsc::Receiver<StreamCmd>,
    events: mpsc::Sender<String>,
) {
    let peer = stream
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_default();
    opened(&events, handle, &peer);
    stream_loop(handle, stream, cmd_rx, events);
}

fn configure_stream(stream: &TcpStream) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(NET_READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
}

/// Plain TCP stream loop: drain commands, read, emit data events.
fn stream_loop<S: Read + Write>(
    handle: u32,
    mut stream: S,
    cmd_rx: mpsc::Receiver<StreamCmd>,
    events: mpsc::Sender<String>,
) {
    let mut buf = [0u8; 4096];
    loop {
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                StreamCmd::Write(bytes) => {
                    if let Err(e) = stream.write_all(&bytes) {
                        fail(&events, handle, "io-error", &e.to_string());
                        return;
                    }
                }
                StreamCmd::Shutdown => return,
            }
        }
        match stream.read(&mut buf) {
            Ok(0) => {
                closed(&events, handle, "peer closed");
                return;
            }
            Ok(n) => data(&events, handle, &buf[..n]),
            // TimedOut/WouldBlock = read timeout expiry: loop to the queue.
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
            Err(e) => {
                fail(&events, handle, "io-error", &e.to_string());
                return;
            }
        }
    }
}

/// TCP server: accept loop (nonblocking + 5ms sleep so Shutdown is observed).
/// Each accepted child is registered into the shared map from THIS thread and
/// announced via an `accepted` event; the child is immediately usable.
fn listener_worker(
    handle: u32,
    listener: TcpListener,
    local: &str,
    cmd_rx: mpsc::Receiver<ListenCmd>,
    events: mpsc::Sender<String>,
    conns: Arc<Mutex<HashMap<u32, NetConn>>>,
    handles: Arc<AtomicU32>,
) {
    let _ = listener.set_nonblocking(true);
    opened(&events, handle, local);
    loop {
        // Any queued command is a Shutdown (the only ListenCmd variant).
        if cmd_rx.try_recv().is_ok() {
            return;
        }
        match listener.accept() {
            Ok((stream, peer)) => {
                let child = next_handle(&handles);
                configure_stream(&stream);
                let (cmd_tx, cmd_rx) = mpsc::channel();
                let child_events = events.clone();
                std::thread::spawn(move || {
                    tcp_child_worker(child, stream, cmd_rx, child_events);
                });
                {
                    // One lock scope: the child becomes visible in the map and
                    // in the listener's children list atomically (the list
                    // drives broadcast writes and listener-close teardown).
                    let mut map = conns.lock().unwrap();
                    map.insert(
                        child,
                        NetConn::Stream {
                            kind: StreamKind::TcpChild,
                            cmd_tx,
                            parent: Some(handle),
                        },
                    );
                    if let Some(NetConn::Listener { children, .. }) = map.get_mut(&handle) {
                        children.push(child);
                    }
                }
                accepted(&events, handle, child, &peer.to_string());
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {}
            Err(e) => {
                fail(&events, handle, "io-error", &e.to_string());
                return;
            }
        }
        std::thread::sleep(NET_READ_TIMEOUT);
    }
}

// ---------------------------------------------------------------------------
// tests — sources live mirrored under test/host/macos/ (repo convention),
// compiled into this bin's cfg(test) via #[path].
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "../../../test/host/macos/tcp_tests.rs"]
mod tests;
