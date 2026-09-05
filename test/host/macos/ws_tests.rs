//! `com_ws.rs` unit tests — parameter validation only (no network, no WS
//! server); the handshake path is exercised by integration runs.
//! Mirrored under test/host/macos/ per repo convention; compiled into the
//! `pocketcom-host` bin via `#[path]` from host/macos/src/com_ws.rs.

use super::*;
use std::time::Duration;

#[path = "net_testutil.rs"]
mod util;

#[test]
fn open_param_validation_is_structured() {
    let reg = util::new_registry();
    for (bad, op) in [
        (ws_connect(&reg, "{not json"), "wsConnect"),
        (ws_connect(&reg, r#"{"url":"http://x"}"#), "wsConnect"),
        (ws_connect(&reg, r#"{"url":"ws://x","protocols":[""]}"#), "wsConnect"),
        (ws_connect(&reg, "{}"), "wsConnect"),
    ] {
        assert!(
            bad.contains("invalid-param"),
            "{op} should reject with a structured param error, got {bad}"
        );
    }
}

#[test]
fn handshake_failure_is_async_error_then_closed() {
    // Port 1 on 127.0.0.1 refuses the TCP connect; the ws worker must turn
    // that into error+closed events (never a panic, never a sync failure —
    // the op itself returns a handle).
    let reg = util::new_registry();
    let opened = ws_connect(&reg, r#"{"url":"ws://127.0.0.1:1"}"#);
    let handle = util::handle_of(&opened);
    let evs = util::wait_batch(&reg, Duration::from_secs(15), &|vs| {
        vs.iter().any(|v| v["t"] == "error" && v["h"] == handle)
    });
    let err = evs
        .iter()
        .find(|v| v["t"] == "error" && v["h"] == handle)
        .expect("error event");
    assert_eq!(err["code"], "io-error");
    evs.iter()
        .find(|v| v["t"] == "closed" && v["h"] == handle)
        .expect("closed event trails the error");
}

#[test]
fn build_ws_request_injects_subprotocols() {
    let protocols = vec!["chat".to_string(), "v2".to_string()];
    let req = build_ws_request("ws://x/y", &protocols).expect("request builds");
    assert_eq!(
        req.headers()
            .get("Sec-WebSocket-Protocol")
            .and_then(|v| v.to_str().ok()),
        Some("chat, v2")
    );
    let plain = build_ws_request("ws://x/y", &[]).expect("request builds");
    assert!(plain.headers().get("Sec-WebSocket-Protocol").is_none());
    assert!(build_ws_request("not a url", &[]).is_err());
}
