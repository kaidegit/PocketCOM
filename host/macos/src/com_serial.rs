//! POCKETCOM — the `com` surface serial bridge: serial-port HostOps mounted
//! into the guest as `globalThis.com` (SPEC §4.2, M1). Shared namespace
//! plumbing (handle counter, event stream, mount) lives in `com.rs`; this
//! module owns the serial core and its worker thread.
//!
//! Op summary (JS side of the contract lives in bridge/com.ts + serial.ts):
//! - `com.serialList()`      → JSON array string (macOS: /dev/cu.* only).
//! - `com.serialOpen(json)`  → `{"handle":N}` or `{"error":{code,msg}}`.
//! - `com.setSignals(h,json)`→ bool (`{dtr?, rts?}` queued for the worker).
//! (`com.write` / `com.close` / `com.poll` are namespace ops in com.rs that
//! dispatch into this core for serial handles.)

use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::AtomicU32;
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde::Deserialize;
use serde_json::json;
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortInfo, SerialPortType, StopBits};

use crate::com::{next_handle, trace_enabled, ComFailure};

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

/// The serial side of the `com` namespace (guest-thread object).
pub(crate) struct SerialCore {
    ports: HashMap<u32, Port>,
    /// Shared com-namespace handle counter (serial + net, see next_handle).
    handles: Arc<AtomicU32>,
}

impl SerialCore {
    pub(crate) fn new(handles: Arc<AtomicU32>) -> Self {
        Self {
            ports: HashMap::new(),
            handles,
        }
    }

    pub(crate) fn serial_list(&mut self) -> String {
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
        if trace_enabled() {
            eprintln!("pocketcom-trace: com.serialList -> {result}");
        }
        result
    }

    pub(crate) fn serial_open(&mut self, params_json: &str) -> String {
        let result = match self.try_open(params_json) {
            Ok(handle) => json!({"handle": handle}).to_string(),
            Err(failure) => failure.to_json().to_string(),
        };
        if trace_enabled() {
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

        let handle = next_handle(&self.handles);
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

    /// Whether `handle` belongs to the serial map (net handles live in the
    /// com.rs registry — the write/close ops dispatch on this).
    pub(crate) fn owns(&self, handle: i32) -> bool {
        self.ports.contains_key(&(handle as u32))
    }

    /// Raw write path behind the `com.write` op, split out so the bridge
    /// tests can drive it without a QuickJS realm to build a TypedArray in.
    pub(crate) fn queue_write(&mut self, handle: i32, bytes: &[u8]) -> bool {
        self.ports
            .get(&(handle as u32))
            .is_some_and(|port| port.cmd_tx.send(WorkerCmd::Write(bytes.to_vec())).is_ok())
    }

    pub(crate) fn set_signals(&mut self, handle: i32, json: &str) -> bool {
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

    pub(crate) fn close(&mut self, handle: i32) -> bool {
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
    pub(crate) fn poll(&mut self) -> Option<String> {
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
// tests — sources live mirrored under test/host/macos/ (repo-wide convention),
// compiled into this bin's cfg(test) via #[path]. `use super::*` inside them
// still reaches this module's private items.
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "../../../test/host/macos/serial_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../../../test/host/macos/serial_loopback.rs"]
mod loopback;
