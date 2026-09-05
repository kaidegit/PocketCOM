//! POCKETCOM — the `com` surface WebSocket bridge (M2, SPEC §3.2). Shared
//! namespace plumbing (registry, emitters, handle counter) lives in `com.rs`.
//!
//! Op (results mirror serialOpen: `{"handle":N}` or `{"error":{code,msg}}`):
//! - `com.wsConnect({"url","protocols?"})` — ws:// and wss:// via the sync
//!   tungstenite client (rustls with bundled webpki roots). The TCP connect
//!   gets a bounded timeout like tcpConnect; the handshake runs over that
//!   stream, so DNS/connect/handshake all happen in the worker.
//!
//! Reconnect policy lives entirely in the guest core; the host stays dumb.

use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc;

use serde::Deserialize;
use serde_json::json;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::com::{closed, data, fail, opened, trace_enabled, ComFailure, NetRegistry, StreamCmd, StreamKind};
use crate::com_tcp::{CONNECT_TIMEOUT, NET_READ_TIMEOUT, WRITE_TIMEOUT};

pub(crate) fn ws_connect(reg: &NetRegistry, params_json: &str) -> String {
    let result = try_ws_connect(reg, params_json);
    if trace_enabled() {
        eprintln!("pocketcom-trace: com.wsConnect {params_json} -> {result}");
    }
    result
}

fn try_ws_connect(reg: &NetRegistry, params_json: &str) -> String {
    let Ok(p) = parse::<WsConnectParams>(params_json) else {
        return ComFailure::param("malformed wsConnect params: need {url}")
            .to_json()
            .to_string();
    };
    let scheme_ok = p.url.starts_with("ws://") || p.url.starts_with("wss://");
    if !scheme_ok {
        return ComFailure::param(format!("url must use ws:// or wss://, got {:?}", p.url))
            .to_json()
            .to_string();
    }
    if let Some(protocols) = &p.protocols {
        if protocols.iter().any(|s| s.is_empty()) {
            return ComFailure::param("protocols entries must be non-empty")
                .to_json()
                .to_string();
        }
    }
    let handle = reg.alloc();
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let events = reg.event_tx();
    std::thread::spawn(move || {
        ws_worker(handle, p.url, p.protocols.unwrap_or_default(), cmd_rx, events);
    });
    reg.insert_stream(handle, StreamKind::Ws, cmd_tx, None);
    json!({"handle": handle}).to_string()
}

fn parse<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T, ()> {
    serde_json::from_str(json).map_err(|_| ())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsConnectParams {
    url: String,
    protocols: Option<Vec<String>>,
}

fn ws_worker(
    handle: u32,
    url: String,
    protocols: Vec<String>,
    cmd_rx: mpsc::Receiver<StreamCmd>,
    events: mpsc::Sender<String>,
) {
    let request = match build_ws_request(&url, &protocols) {
        Ok(r) => r,
        Err(e) => {
            fail(&events, handle, "io-error", &e);
            return;
        }
    };
    let uri = request.uri().clone();
    let scheme = uri.scheme_str().unwrap_or("ws").to_string();
    let host = match uri.host() {
        Some(h) => h.to_string(),
        None => {
            fail(&events, handle, "io-error", &format!("url has no host: {url}"));
            return;
        }
    };
    let port = uri.port_u16().unwrap_or(if scheme == "wss" { 443 } else { 80 });
    let addrs = match (host.as_str(), port).to_socket_addrs() {
        Ok(it) => it.collect::<Vec<_>>(),
        Err(e) => {
            fail(&events, handle, "io-error", &format!("resolving {host}:{port}: {e}"));
            return;
        }
    };
    let mut stream = None;
    let mut last_err = String::from("no addresses");
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
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(NET_READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    // Unify the stream type: the plain client runs over MaybeTlsStream::Plain.
    let ws = if scheme == "wss" {
        tungstenite::client_tls(request, stream).map(|(ws, _)| ws)
    } else {
        tungstenite::client(request, MaybeTlsStream::Plain(stream)).map(|(ws, _)| ws)
    };
    let mut ws = match ws {
        Ok(ws) => ws,
        Err(e) => {
            fail(&events, handle, "io-error", &format!("handshake: {e}"));
            return;
        }
    };
    set_ws_read_timeout(&mut ws);
    let peer = ws_peer_addr(&ws).unwrap_or_else(|| format!("{host}:{port}"));
    opened(&events, handle, &peer);
    ws_loop(handle, ws, cmd_rx, events);
}

/// Request with subprotocol headers, split out of ws_worker for testability.
fn build_ws_request(
    url: &str,
    protocols: &[String],
) -> Result<tungstenite::handshake::client::Request, String> {
    let mut request = tungstenite::client::IntoClientRequest::into_client_request(url)
        .map_err(|e| e.to_string())?;
    if !protocols.is_empty() {
        let value = protocols.join(", ");
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            tungstenite::http::HeaderValue::from_str(&value)
                .map_err(|e| format!("bad subprotocol {value:?}: {e}"))?,
        );
    }
    Ok(request)
}

/// Peer address behind the (possibly TLS) WebSocket stream.
fn ws_peer_addr(ws: &WebSocket<MaybeTlsStream<TcpStream>>) -> Option<String> {
    match ws.get_ref() {
        MaybeTlsStream::Plain(s) => s.peer_addr().ok(),
        MaybeTlsStream::Rustls(s) => s.get_ref().peer_addr().ok(),
        _ => None,
    }
    .map(|a| a.to_string())
}

/// Set the read timeout on the underlying TCP stream behind the (possibly
/// TLS) WebSocket so the loop can alternate read / command-drain.
fn set_ws_read_timeout(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>) {
    let tcp: &mut TcpStream = match ws.get_mut() {
        MaybeTlsStream::Plain(s) => s,
        MaybeTlsStream::Rustls(s) => s.get_mut(),
        _ => return,
    };
    let _ = tcp.set_read_timeout(Some(NET_READ_TIMEOUT));
}

fn ws_loop(
    handle: u32,
    mut ws: WebSocket<MaybeTlsStream<TcpStream>>,
    cmd_rx: mpsc::Receiver<StreamCmd>,
    events: mpsc::Sender<String>,
) {
    loop {
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                StreamCmd::Write(bytes) => {
                    if let Err(e) = ws.send(Message::Binary(bytes.into())) {
                        fail(&events, handle, "io-error", &e.to_string());
                        return;
                    }
                }
                StreamCmd::Shutdown => return,
            }
        }
        match ws.read() {
            Ok(Message::Binary(b)) => data(&events, handle, &b),
            Ok(Message::Text(t)) => data(&events, handle, t.as_bytes()),
            // Ping payloads are auto-answered with a queued Pong; flush sends it.
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Ok(Message::Close(_)) => {
                let _ = ws.send(Message::Close(None));
                let _ = ws.flush();
                closed(&events, handle, "peer closed");
                return;
            }
            Ok(_) => {}
            Err(e) if is_would_block(&e) => {
                let _ = ws.flush();
            }
            Err(tungstenite::Error::ConnectionClosed) => {
                closed(&events, handle, "peer closed");
                return;
            }
            Err(e) => {
                fail(&events, handle, "io-error", &e.to_string());
                return;
            }
        }
    }
}

/// tungstenite surfaces read-timeout expiry as Error::Io(WouldBlock) (or the
/// platform's TimedOut); both mean "no complete message yet", not fatal.
fn is_would_block(e: &tungstenite::Error) -> bool {
    match e {
        tungstenite::Error::Io(io) => {
            matches!(io.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
        }
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// tests — sources live mirrored under test/host/macos/ (repo convention),
// compiled into this bin's cfg(test) via #[path].
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "../../../test/host/macos/ws_tests.rs"]
mod tests;
