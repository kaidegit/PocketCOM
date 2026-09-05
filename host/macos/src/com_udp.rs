//! POCKETCOM — the `com` surface UDP bridge (M2, SPEC §3.2). Shared namespace
//! plumbing (registry, emitters, handle counter) lives in `com.rs`.
//!
//! Op (results mirror serialOpen: `{"handle":N}` or `{"error":{code,msg}}`):
//! - `com.udpBind({"bindPort","host","port"})` — binds synchronously (a busy
//!   local port is a structured, immediate error), then connects the peer
//!   asynchronously (COMTool's UDP model: local bind + fixed target, so
//!   reads only see the target peer). DNS happens in the worker.

use std::net::UdpSocket;
use std::io::ErrorKind;
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::com::{
    data, fail, opened, trace_enabled, validate_host_port, ComFailure, NetRegistry, StreamCmd,
    StreamKind,
};

/// Read granularity / command-drain cadence per worker loop (com_serial
/// parity: commands never wait more than ~2× this behind a read).
const NET_READ_TIMEOUT: Duration = Duration::from_millis(5);
/// Bound writes so an unreachable peer cannot wedge the worker forever.
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn udp_bind(reg: &NetRegistry, params_json: &str) -> String {
    let result = try_udp_bind(reg, params_json);
    if trace_enabled() {
        eprintln!("pocketcom-trace: com.udpBind {params_json} -> {result}");
    }
    result
}

fn try_udp_bind(reg: &NetRegistry, params_json: &str) -> String {
    let Ok(p) = parse::<UdpBindParams>(params_json) else {
        return ComFailure::param("malformed udpBind params: need {bindPort, host, port}")
            .to_json()
            .to_string();
    };
    if let Some(f) = validate_host_port(&p.host, p.port) {
        return f.to_json().to_string();
    }
    // Bind synchronously: a busy local port is an immediate structured
    // error (same reasoning as tcpListen).
    let socket = match UdpSocket::bind(("0.0.0.0", p.bind_port)) {
        Ok(s) => s,
        Err(e) => {
            return ComFailure::io(format!("binding 0.0.0.0:{}: {e}", p.bind_port))
                .to_json()
                .to_string()
        }
    };
    let handle = reg.alloc();
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let events = reg.event_tx();
    std::thread::spawn(move || {
        udp_worker(handle, socket, p.host, p.port, cmd_rx, events);
    });
    reg.insert_stream(handle, StreamKind::Udp, cmd_tx, None);
    json!({"handle": handle}).to_string()
}

fn parse<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T, ()> {
    serde_json::from_str(json).map_err(|_| ())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UdpBindParams {
    bind_port: u16,
    host: String,
    port: u16,
}

/// Connected-UDP worker: `connect()` fixes the peer (and filters reads to
/// it). UdpSocket has no Read/Write impl in std, so this loop is a sibling
/// of com_tcp's stream_loop rather than a reuse.
fn udp_worker(
    handle: u32,
    socket: UdpSocket,
    host: String,
    port: u16,
    cmd_rx: mpsc::Receiver<StreamCmd>,
    events: mpsc::Sender<String>,
) {
    if let Err(e) = socket.connect((host.as_str(), port)) {
        fail(&events, handle, "io-error", &format!("resolving {host}:{port}: {e}"));
        return;
    }
    let _ = socket.set_read_timeout(Some(NET_READ_TIMEOUT));
    let _ = socket.set_write_timeout(Some(WRITE_TIMEOUT));
    let peer = socket
        .peer_addr()
        .map(|a| a.to_string())
        .unwrap_or_default();
    opened(&events, handle, &peer);
    let mut buf = [0u8; 4096];
    loop {
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                StreamCmd::Write(bytes) => {
                    if let Err(e) = socket.send(&bytes) {
                        fail(&events, handle, "io-error", &e.to_string());
                        return;
                    }
                }
                StreamCmd::Shutdown => return,
            }
        }
        match socket.recv(&mut buf) {
            Ok(0) => {} // connected UDP never EOFs; treat as idle
            Ok(n) => data(&events, handle, &buf[..n]),
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {}
            Err(e) => {
                fail(&events, handle, "io-error", &e.to_string());
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tests — sources live mirrored under test/host/macos/ (repo convention),
// compiled into this bin's cfg(test) via #[path].
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "../../../test/host/macos/udp_tests.rs"]
mod tests;
