//! POCKETCOM — the `com` surface: serial-port HostOps mounted into the guest
//! as `globalThis.com` (SPEC §4.2).
//!
//! Transport shape follows `pocket-net` (engine/crates/pocket-net): the core
//! owns handles and validation; a worker thread owns the port; worker events
//! cross an mpsc queue and are only observed when the guest polls at a tick
//! boundary (`com.poll()`). The worker NEVER calls into QuickJS — the desktop
//! host is single-threaded and native threads must not touch the realm.
//!
//! Op summary (JS side of the contract lives in bridge/com.ts):
//! - `com.serialList()`      → JSON array string (macOS: /dev/cu.* only).
//! - `com.serialOpen(json)`  → `{"handle":N}` or `{"error":{code,msg}}`.
//! - `com.write(h, bytes)`   → bool (queued for the worker; TypedArray<u8>,
//!                             the same body convention as pocket-net).
//! - `com.setSignals(h,json)`→ bool (`{dtr?, rts?}` queued for the worker).
//! - `com.close(h)`          → bool.
//! - `com.poll()`            → newline-joined JSON event lines for this tick:
//!                             `{t:"data",h,b64}` / `{t:"closed",h,reason}` /
//!                             `{t:"error",h,code,msg}`; null when idle.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::rc::Rc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::Result;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use pocket_mod::qjs::{Coerced, Ctx, FromJs, Function, TypedArray, Value};
use pocket_mod::{Guest, qjs};
use serde::Deserialize;
use serde_json::json;
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits};

/// Read granularity per worker loop. 4096 covers a full 115200-baud burst
/// with headroom; larger reads only delay command processing.
const READ_BUF: usize = 4096;
/// Port read timeout: the worker alternates read / command-drain at this
/// cadence, so writes and signal changes answer within ~2× this.
const READ_TIMEOUT: Duration = Duration::from_millis(5);
/// close() reaps the worker for at most this long before giving up and
/// leaving the fd close to the worker's own exit. The normal reap is one
/// worker read cycle (~READ_TIMEOUT); the bound only matters for a worker
/// wedged in a blocking write_all, which must not stall a guest turn.
const CLOSE_REAP: Duration = Duration::from_millis(250);

// ---------------------------------------------------------------------------
// guest-string decoding (verbatim rationale from pocket-ui-surface): a host
// op must never abort the frame transaction over a legal JS value.
// ---------------------------------------------------------------------------

struct LossyString(String);

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
// core
// ---------------------------------------------------------------------------

/// Structured failure returned to the guest as JSON, never as a panic.
struct ComFailure {
    code: &'static str,
    message: String,
}

impl ComFailure {
    fn param(message: impl Into<String>) -> Self {
        Self {
            code: "invalid-param",
            message: message.into(),
        }
    }

    fn io(message: impl Into<String>) -> Self {
        Self {
            code: "io-error",
            message: message.into(),
        }
    }

    fn to_json(&self) -> serde_json::Value {
        json!({"error": {"code": self.code, "msg": self.message}})
    }
}

enum WorkerCmd {
    Write(Vec<u8>),
    Signals { dtr: Option<bool>, rts: Option<bool> },
    Shutdown,
}

struct Port {
    cmd_tx: mpsc::Sender<WorkerCmd>,
    /// Pre-formatted JSON event lines from the worker, drained at tick
    /// boundaries by `poll()`.
    event_rx: mpsc::Receiver<String>,
    /// The worker exits by itself on Shutdown or a terminal port error; we
    /// never join it (the host must not block a guest turn on a thread).
    #[allow(dead_code)]
    worker: JoinHandle<()>,
}

struct ComCore {
    ports: HashMap<u32, Port>,
    next_handle: u32,
}

impl ComCore {
    fn new() -> Self {
        Self {
            ports: HashMap::new(),
            next_handle: 1,
        }
    }

    fn serial_list(&mut self) -> String {
        let result = match serialport::available_ports() {
            Ok(ports) => serde_json::Value::Array(
                ports
                    .iter()
                    .filter(|p| port_visible(&p.port_name))
                    .map(describe_port)
                    .collect(),
            )
            .to_string(),
            Err(e) => ComFailure::io(format!("enumerating serial ports: {e}")).to_json().to_string(),
        };
        if std::env::var_os("POCKETCOM_TRACE").is_some() {
            eprintln!("pocketcom-trace: com.serialList -> {result}");
        }
        result
    }

    fn serial_open(&mut self, params_json: &str) -> String {
        // POCKETCOM: env-gated trace (POCKETCOM_TRACE=1, scripted UI debugging).
        let trace = std::env::var_os("POCKETCOM_TRACE").is_some();
        let result = match self.try_open(params_json) {
            Ok(handle) => json!({"handle": handle}).to_string(),
            Err(failure) => failure.to_json().to_string(),
        };
        if trace {
            eprintln!("pocketcom-trace: com.serialOpen {params_json} -> {result}");
        }
        result
    }

    fn try_open(&mut self, params_json: &str) -> std::result::Result<u32, ComFailure> {
        let params: OpenParams = serde_json::from_str(params_json)
            .map_err(|e| ComFailure::param(format!("malformed open params: {e}")))?;
        if params.path.is_empty() {
            return Err(ComFailure::param("path is required"));
        }
        let mut builder = serialport::new(&params.path, params.baud_rate).timeout(READ_TIMEOUT);
        if let Some(bits) = params.data_bits {
            builder = builder.data_bits(match bits {
                5 => DataBits::Five,
                6 => DataBits::Six,
                7 => DataBits::Seven,
                8 => DataBits::Eight,
                other => {
                    return Err(ComFailure::param(format!(
                        "dataBits must be 5..8, got {other}"
                    )))
                }
            });
        }
        if let Some(parity) = params.parity {
            builder = builder.parity(match parity.as_str() {
                "none" => Parity::None,
                "odd" => Parity::Odd,
                "even" => Parity::Even,
                // serialport 4 has no Mark/Space (the contract admits values
                // "per serialport capability"): refuse rather than silently
                // downgrade the line format.
                "mark" | "space" => {
                    return Err(ComFailure::param(format!(
                        "parity {parity:?} is not supported by serialport 4"
                    )))
                }
                other => {
                    return Err(ComFailure::param(format!(
                        "parity must be none|odd|even, got {other:?}"
                    )))
                }
            });
        }
        if let Some(stop_bits) = params.stop_bits {
            builder = builder.stop_bits(match stop_bits {
                StopBitsParam::Int(1) => StopBits::One,
                StopBitsParam::Int(2) => StopBits::Two,
                StopBitsParam::Str(s) if s == "1" => StopBits::One,
                StopBitsParam::Str(s) if s == "2" => StopBits::Two,
                // serialport 4 dropped OnePointFive.
                other => {
                    return Err(ComFailure::param(format!(
                        "stopBits must be 1 or 2 (\"1.5\" is not supported by serialport 4), got {other:?}"
                    )))
                }
            });
        }
        if let Some(flow) = params.flow_control {
            builder = builder.flow_control(match flow.as_str() {
                "none" => FlowControl::None,
                "xonxoff" => FlowControl::Software,
                // serialport models both as hardware handshake (the same
                // support ceiling the contract promises).
                "rtscts" | "dsrdtr" => FlowControl::Hardware,
                other => {
                    return Err(ComFailure::param(format!(
                        "flowControl must be none|xonxoff|rtscts|dsrdtr, got {other:?}"
                    )))
                }
            });
        }
        let port = builder
            .open()
            .map_err(|e| ComFailure::io(format!("opening {}: {e}", params.path)))?;

        let handle = self.alloc_handle();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || worker_main(port, handle, cmd_rx, event_tx));
        self.ports.insert(
            handle,
            Port {
                cmd_tx,
                event_rx,
                worker,
            },
        );
        Ok(handle)
    }

    fn alloc_handle(&mut self) -> u32 {
        loop {
            let handle = self.next_handle;
            self.next_handle = if self.next_handle == u32::MAX {
                1
            } else {
                self.next_handle + 1
            };
            if !self.ports.contains_key(&handle) {
                return handle;
            }
        }
    }

    fn write(&mut self, handle: i32, buf: TypedArray<u8>) -> bool {
        let Some(bytes) = buf.as_bytes() else { return false };
        self.queue_write(handle, bytes)
    }

    /// Raw write path behind the `com.write` op, split out so the bridge
    /// tests can drive it without a QuickJS realm to build a TypedArray in.
    fn queue_write(&mut self, handle: i32, bytes: &[u8]) -> bool {
        let ok = self
            .ports
            .get(&(handle as u32))
            .is_some_and(|port| port.cmd_tx.send(WorkerCmd::Write(bytes.to_vec())).is_ok());
        // POCKETCOM: env-gated trace (POCKETCOM_TRACE=1, scripted UI debugging).
        if std::env::var_os("POCKETCOM_TRACE").is_some() {
            eprintln!(
                "pocketcom-trace: com.write h={handle} n={} ok={ok}",
                bytes.len()
            );
        }
        ok
    }

    fn set_signals(&mut self, handle: i32, json: &str) -> bool {
        let Ok(signals) = serde_json::from_str::<Signals>(json) else {
            return false;
        };
        self.ports.get(&(handle as u32)).is_some_and(|port| {
            port.cmd_tx
                .send(WorkerCmd::Signals {
                    dtr: signals.dtr,
                    rts: signals.rts,
                })
                .is_ok()
        })
    }

    fn close(&mut self, handle: i32) -> bool {
        match self.ports.remove(&(handle as u32)) {
            Some(port) => {
                // Best effort: the worker also exits on the next terminal
                // error, and dropping the port closes the fd either way.
                let _ = port.cmd_tx.send(WorkerCmd::Shutdown);
                // Reap the worker so the fd is really closed when close()
                // returns: an immediate reopen of the same path must not race
                // the worker's exit ("Device or resource busy" on exclusive
                // drivers — caught by the hardware loopback test). Bounded so
                // a wedged worker cannot stall the tick; that pathological
                // close just stays async.
                let deadline = Instant::now() + CLOSE_REAP;
                loop {
                    let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                        break;
                    };
                    match port.event_rx.recv_timeout(remaining) {
                        // Residual worker events are dropped: the port is out
                        // of the map, poll() can no longer observe them.
                        Ok(_line) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break, // worker exited, fd closed
                        Err(mpsc::RecvTimeoutError::Timeout) => break,      // wedged worker
                    }
                }
                true
            }
            None => false,
        }
    }

    /// Tick-boundary drain: worker events become the guest's batch. Called
    /// only from the guest's frame turn, never from a native thread.
    fn poll(&mut self) -> Option<String> {
        let mut batch = String::new();
        for port in self.ports.values_mut() {
            while let Ok(line) = port.event_rx.try_recv() {
                batch.push_str(&line);
                batch.push('\n');
            }
        }
        if batch.is_empty() {
            None
        } else {
            Some(batch)
        }
    }
}

// ---------------------------------------------------------------------------
// open-params decoding
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenParams {
    path: String,
    baud_rate: u32,
    data_bits: Option<u8>,
    parity: Option<String>,
    stop_bits: Option<StopBitsParam>,
    flow_control: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
enum StopBitsParam {
    Int(u8),
    Str(String),
}

#[derive(Deserialize)]
struct Signals {
    dtr: Option<bool>,
    rts: Option<bool>,
}

// ---------------------------------------------------------------------------
// worker thread
// ---------------------------------------------------------------------------

fn worker_main(
    mut port: Box<dyn SerialPort>,
    handle: u32,
    cmd_rx: mpsc::Receiver<WorkerCmd>,
    events: mpsc::Sender<String>,
) {
    let mut buf = [0u8; READ_BUF];
    loop {
        // Commands first: a close/signal request must not wait on a read.
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                WorkerCmd::Write(bytes) => {
                    if let Err(e) = port.write_all(&bytes) {
                        fail(&events, handle, "io-error", &e.to_string());
                        return;
                    }
                }
                WorkerCmd::Signals { dtr, rts } => {
                    let result = dtr
                        .map_or(Ok(()), |v| port.write_data_terminal_ready(v))
                        .and_then(|()| {
                            rts.map_or(Ok(()), |v| port.write_request_to_send(v))
                        });
                    if let Err(e) = result {
                        fail(&events, handle, "io-error", &e.description);
                        return;
                    }
                }
                WorkerCmd::Shutdown => return,
            }
        }
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                let line = json!({
                    "t": "data",
                    "h": handle,
                    "b64": B64.encode(&buf[..n]),
                })
                .to_string();
                if events.send(line).is_err() {
                    return; // core gone; port drops and the thread ends.
                }
            }
            Ok(_) => {}
            // READ_TIMEOUT expiry: loop back to the command queue.
            Err(e) if e.kind() == ErrorKind::TimedOut => {}
            Err(e) => {
                let code = if e.kind() == ErrorKind::NotFound {
                    "not-found"
                } else {
                    "io-error"
                };
                fail(&events, handle, code, &e.to_string());
                return;
            }
        }
    }
}

/// Terminal port failure → error event + closed event, then the thread ends.
fn fail(events: &mpsc::Sender<String>, handle: u32, code: &str, msg: &str) {
    let _ = events.send(json!({"t": "error", "h": handle, "code": code, "msg": msg}).to_string());
    let _ = events.send(json!({"t": "closed", "h": handle, "reason": msg}).to_string());
}

// ---------------------------------------------------------------------------
// port description
// ---------------------------------------------------------------------------

/// SPEC §3.2: macOS lists only callout devices (`/dev/cu.*`), never the
/// matching `/dev/tty.*` duplicates.
fn port_visible(path: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        path.starts_with("/dev/cu.")
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        true
    }
}

fn describe_port(info: &SerialPortInfo) -> serde_json::Value {
    let description = match &info.port_type {
        SerialPortType::UsbPort(_) => "USB serial device",
        SerialPortType::PciPort => "PCI serial port",
        SerialPortType::BluetoothPort => "Bluetooth serial port",
        SerialPortType::Unknown => "Serial port",
    };
    let mut v = json!({
        "path": info.port_name,
        "description": description,
    });
    if let SerialPortType::UsbPort(usb) = &info.port_type {
        if let Some(manufacturer) = &usb.manufacturer {
            v["manufacturer"] = json!(manufacturer);
        }
        v["vid"] = json!(usb.vid);
        v["pid"] = json!(usb.pid);
        if let Some(product) = &usb.product {
            v["description"] = json!(product);
        }
    }
    v
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

/// Mount `globalThis.com` into `guest`. Call after the ui surface mount,
/// before evaluating the bundle (PocketRoot::boot).
pub fn mount(guest: &Guest) -> Result<()> {
    let core = Rc::new(RefCell::new(ComCore::new()));
    guest.mount("com", move |ctx, ns| {
        macro_rules! op {
            ($name:literal, $f:expr) => {
                ns.set($name, Function::new(ctx.clone(), $f)?)?
            };
        }

        let c = core.clone();
        op!("serialList", move || c.borrow_mut().serial_list());

        let c = core.clone();
        op!("serialOpen", move |params: LossyString| c
            .borrow_mut()
            .serial_open(&params.0));

        let c = core.clone();
        op!("write", move |handle: i32, buf: TypedArray<u8>| c
            .borrow_mut()
            .write(handle, buf));

        let c = core.clone();
        op!("setSignals", move |handle: i32, json: LossyString| c
            .borrow_mut()
            .set_signals(handle, &json.0));

        let c = core.clone();
        op!("close", move |handle: i32| c.borrow_mut().close(handle));

        let c = core.clone();
        op!("poll", move || -> Option<String> { c.borrow_mut().poll() });

        Ok(())
    })
}

// ---------------------------------------------------------------------------
// tests — sources live mirrored under test/host/macos/ (repo-wide convention),
// compiled into this bin's cfg(test) via #[path]. `use super::*` inside them
// still reaches this module's private items.
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "../../../test/host/macos/com_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../test/host/macos/com_loopback.rs"]
mod loopback;
