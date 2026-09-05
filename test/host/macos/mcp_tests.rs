//! Host-side unit tests for com_mcp.rs (M4, SPEC §6). Sourced via #[path]
//! into the pocketcom-host bin's cfg(test) — same model as the other
//! test/host/macos files. HTTP dispatch and tool plumbing are driven through
//! `handle_http` / hub ops without spawning the accept loop (mcp_start tests
//! do bind a real ephemeral socket).

use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::com_mcp::{
    handle_http, mcp_cmds, mcp_feed, mcp_results, mcp_start, mcp_stop, token_ok, try_parse_request,
    tools_schema, McpHub, HttpRequest, HttpResponse, READ_BUFFER_MAX_BYTES,
};

fn hub() -> (std::sync::Arc<McpHub>, mpsc::Receiver<String>) {
    let (tx, rx) = mpsc::channel();
    (std::sync::Arc::new(McpHub::new(tx)), rx)
}

/// Hub with the running flag set (round-trip tests bypass the accept loop).
fn hub_running() -> (std::sync::Arc<McpHub>, mpsc::Receiver<String>) {
    let (h, rx) = hub();
    h.running.store(true, std::sync::atomic::Ordering::SeqCst);
    (h, rx)
}

fn request(method: &str, target: &str, headers: &[(&str, &str)], body: &str) -> HttpRequest {
    HttpRequest {
        method: method.to_string(),
        target: target.to_string(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        body: body.as_bytes().to_vec(),
    }
}

fn post(body: &str, session: Option<&str>) -> HttpRequest {
    let mut headers = vec![
        ("content-type", "application/json"),
        ("accept", "application/json, text/event-stream"),
        ("authorization", "Bearer tok"),
    ];
    if let Some(s) = session {
        headers.push(("mcp-session-id", s));
    }
    request("POST", "/mcp", &headers, body)
}

fn body_json(resp: &HttpResponse) -> Value {
    serde_json::from_slice(&resp.body).expect("response body is json")
}

fn status(resp: &HttpResponse) -> u16 {
    resp.status
}

fn header(resp: &HttpResponse, name: &str) -> Option<String> {
    resp.headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
}

// ---------------------------------------------------------------------------
// request parsing
// ---------------------------------------------------------------------------

#[test]
fn parse_request_incomplete_then_complete() {
    let partial = b"POST /mcp HTTP/1.1\r\ncontent-length: 5\r\n\r\nhe";
    assert!(try_parse_request(partial).unwrap().is_none());
    let full = b"POST /mcp HTTP/1.1\r\ncontent-length: 5\r\n\r\nhello";
    let req = try_parse_request(full).unwrap().expect("complete");
    assert_eq!(req.method, "POST");
    assert_eq!(req.target, "/mcp");
    assert_eq!(req.body, b"hello");
}

#[test]
fn parse_request_malformed_rejected() {
    assert_eq!(try_parse_request(b"garbage without crlfcrlf"), Ok(None));
    assert_eq!(try_parse_request(b"XX YY ZZ\r\n\r\n"), Err(400));
    // header block over limit → 431
    let big = vec![b'x'; 80 * 1024];
    let req = format!("POST /mcp HTTP/1.1\r\nx: {}\r\n\r\n", String::from_utf8_lossy(&big));
    assert_eq!(try_parse_request(req.as_bytes()), Err(431));
    // transfer-encoding unsupported → 411
    assert_eq!(
        try_parse_request(b"POST /mcp HTTP/1.1\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n"),
        Err(411)
    );
    // body over limit → 413
    assert_eq!(
        try_parse_request(b"POST /mcp HTTP/1.1\r\ncontent-length: 99999999\r\n\r\n"),
        Err(413)
    );
}

// ---------------------------------------------------------------------------
// auth + routing
// ---------------------------------------------------------------------------

#[test]
fn token_check() {
    assert!(token_ok(Some("abc"), "abc"));
    assert!(!token_ok(None, "abc"));
    assert!(!token_ok(Some("xyz"), "abc"));
    assert!(!token_ok(Some("abcd"), "abc"));
    assert!(!token_ok(Some("Bearer abc"), "abc"));
}

#[test]
fn http_routing_options_path_auth() {
    let (h, _rx) = hub();
    // OPTIONS never requires auth
    let resp = handle_http(&h, &request("OPTIONS", "/mcp", &[], ""), "tok");
    assert_eq!(status(&resp), 204);
    assert!(header(&resp, "access-control-allow-origin").is_some());
    // unknown path
    let resp = handle_http(&h, &request("GET", "/other", &[], ""), "tok");
    assert_eq!(status(&resp), 404);
    // missing / wrong token → 401 with WWW-Authenticate
    let resp = handle_http(&h, &request("POST", "/mcp", &[], "{}"), "tok");
    assert_eq!(status(&resp), 401);
    assert_eq!(header(&resp, "www-authenticate").as_deref(), Some("Bearer"));
    let resp = handle_http(
        &h,
        &request("POST", "/mcp", &[("authorization", "Bearer nope")], "{}"),
        "tok",
    );
    assert_eq!(status(&resp), 401);
    // GET /mcp → 405 (no SSE stream), DELETE with session → 204
    let resp = handle_http(
        &h,
        &request("GET", "/mcp", &[("authorization", "Bearer tok")], ""),
        "tok",
    );
    assert_eq!(status(&resp), 405);
    let resp = handle_http(
        &h,
        &request("DELETE", "/mcp", &[("authorization", "Bearer tok"), ("mcp-session-id", "s1")], ""),
        "tok",
    );
    assert_eq!(status(&resp), 204);
}

#[test]
fn http_post_content_negotiation() {
    let (h, _rx) = hub();
    let resp = handle_http(&h, &request("POST", "/mcp", &[("authorization", "Bearer tok")], "{}"), "tok");
    assert_eq!(status(&resp), 415); // missing content-type
    let resp = handle_http(
        &h,
        &request("POST", "/mcp", &[("authorization", "Bearer tok"), ("content-type", "text/plain")], "{}"),
        "tok",
    );
    assert_eq!(status(&resp), 415);
    let resp = handle_http(
        &h,
        &request(
            "POST",
            "/mcp",
            &[("authorization", "Bearer tok"), ("content-type", "application/json")],
            "{}",
        ),
        "tok",
    );
    assert_eq!(status(&resp), 406); // missing accept
}

// ---------------------------------------------------------------------------
// JSON-RPC methods
// ---------------------------------------------------------------------------

#[test]
fn initialize_assigns_session_and_echoes_version() {
    let (h, rx) = hub();
    let resp = handle_http(
        &h,
        &post(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t"}}}).to_string().as_str(), None),
        "tok",
    );
    assert_eq!(status(&resp), 200);
    let sid = header(&resp, "mcp-session-id").expect("session id assigned");
    assert!(sid.starts_with("mcp-"));
    let v = body_json(&resp);
    assert_eq!(v["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(v["result"]["serverInfo"]["name"], "PocketCOM");
    assert_eq!(v["result"]["capabilities"]["tools"], json!({}));
    // unsupported version → our latest
    let resp = handle_http(
        &h,
        &post(json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}).to_string().as_str(), None),
        "tok",
    );
    assert_eq!(body_json(&resp)["result"]["protocolVersion"], "2025-06-18");
    // UI was told the server is on with 2 sessions
    let events: Vec<Value> = rx.try_iter().map(|l| serde_json::from_str(&l).unwrap()).collect();
    assert!(events.iter().any(|e| e["t"] == "mcp" && e["on"] == true && e["clients"] == 2));
}

#[test]
fn unknown_session_404_notification_202_parse_error() {
    let (h, _rx) = hub();
    let resp = handle_http(&h, &post("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}", Some("mcp-gone")), "tok");
    assert_eq!(status(&resp), 404);
    // notification (no id) → 202 empty
    let resp = handle_http(&h, &post("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}", None), "tok");
    assert_eq!(status(&resp), 202);
    assert!(resp.body.is_empty());
    // malformed JSON → parse error
    let resp = handle_http(&h, &post("{broken", None), "tok");
    assert_eq!(status(&resp), 400);
    assert_eq!(body_json(&resp)["error"]["code"], -32700);
}

#[test]
fn tools_list_and_ping_and_unknown_method() {
    let (h, _rx) = hub();
    let resp = handle_http(&h, &post("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}", None), "tok");
    assert_eq!(status(&resp), 200);
    let tools = body_json(&resp)["result"]["tools"].as_array().expect("tools").clone();
    assert_eq!(tools.len(), 8);
    let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
    for expected in [
        "status",
        "list_serial_ports",
        "connect",
        "disconnect",
        "send",
        "read",
        "config_read",
        "config_write",
    ] {
        assert!(names.contains(&expected), "missing tool {expected}");
    }
    assert_eq!(tools_schema().as_array().unwrap().len(), 8);

    let resp = handle_http(&h, &post("{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}", None), "tok");
    assert_eq!(body_json(&resp)["result"], json!({}));

    let resp = handle_http(&h, &post("{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"resources/list\"}", None), "tok");
    assert_eq!(body_json(&resp)["error"]["code"], -32601);
}

// ---------------------------------------------------------------------------
// read tool (host-side buffer)
// ---------------------------------------------------------------------------

#[test]
fn read_tool_drain_peek_and_truncation() {
    let (h, _rx) = hub();
    // empty → "(no data)"
    let resp = handle_http(&h, &post(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read","arguments":{}}}"#, None), "tok");
    let v = body_json(&resp);
    assert_eq!(v["result"]["isError"], false);
    assert_eq!(v["result"]["content"][0]["text"], "(no data)");

    mcp_feed(&h, r#"{"lines":["l1","l2","l3"]}"#);
    // peek keeps buffer
    let resp = handle_http(&h, &post(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read","arguments":{"clear":false}}}"#, None), "tok");
    assert_eq!(body_json(&resp)["result"]["content"][0]["text"], "l1\nl2\nl3");
    // drain empties it
    let resp = handle_http(&h, &post(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read","arguments":{}}}"#, None), "tok");
    assert_eq!(body_json(&resp)["result"]["content"][0]["text"], "l1\nl2\nl3");
    let resp = handle_http(&h, &post(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read","arguments":{}}}"#, None), "tok");
    assert_eq!(body_json(&resp)["result"]["content"][0]["text"], "(no data)");

    // maxBytes keeps the newest bytes, cuts at a line boundary
    mcp_feed(&h, r#"{"lines":["aaaa","bbbb","cccc"]}"#);
    let resp = handle_http(&h, &post(r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read","arguments":{"maxBytes":9}}}"#, None), "tok");
    let text = body_json(&resp)["result"]["content"][0]["text"].as_str().unwrap().to_string();
    assert!(text.starts_with("(older bytes truncated)"));
    assert!(text.ends_with("cccc"), "tail line preserved: {text}");
    // invalid maxBytes
    let resp = handle_http(&h, &post(r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read","arguments":{"maxBytes":0}}}"#, None), "tok");
    assert_eq!(body_json(&resp)["result"]["isError"], true);
}

#[test]
fn read_buffer_bounded_drop_oldest() {
    let (h, _rx) = hub();
    let big = "x".repeat(200 * 1024);
    mcp_feed(&h, &json!({"lines": [big, "y".repeat(100 * 1024), "latest"]}).to_string());
    let buf = h.read_buf.lock().unwrap();
    let last = buf.lines.back().map(String::as_str);
    assert_eq!(last, Some("latest"));
    // total under cap after eviction (latest + last big line ≤ 256KiB + overhead)
    assert!(buf.bytes <= READ_BUFFER_MAX_BYTES + 8);
}

#[test]
fn feed_malformed_rejected() {
    let (h, _rx) = hub();
    assert!(!mcp_feed(&h, "not json"));
    assert!(!mcp_feed(&h, r#"{"no":"lines"}"#));
    assert!(mcp_feed(&h, r#"{"lines":[]}"#));
}

// ---------------------------------------------------------------------------
// guest command round trip
// ---------------------------------------------------------------------------

#[test]
fn command_round_trip_via_guest() {
    let (h, _rx) = hub_running();
    // A responder thread emulates the guest: drain commands, answer ok.
    let responder_hub = h.clone();
    let responder = std::thread::spawn(move || loop {
        if let Some(batch) = mcp_cmds(&responder_hub) {
            for line in batch.lines().filter(|l| !l.is_empty()) {
                let cmd: Value = serde_json::from_str(line).unwrap();
                let id = cmd["id"].as_u64().unwrap();
                mcp_results(
                    &responder_hub,
                    &json!([{"id": id, "ok": true, "text": format!("done-{}", cmd["name"].as_str().unwrap_or(""))}])
                        .to_string(),
                );
            }
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    });
    let resp = handle_http(
        &h,
        &post(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"status","arguments":{}}}"#, None),
        "tok",
    );
    responder.join().unwrap();
    let v = body_json(&resp);
    assert_eq!(v["result"]["isError"], false);
    assert_eq!(v["result"]["content"][0]["text"], "done-status");
}

#[test]
fn guest_error_maps_to_is_error_result() {
    let (h, _rx) = hub_running();
    let responder_hub = h.clone();
    let responder = std::thread::spawn(move || loop {
        if let Some(batch) = mcp_cmds(&responder_hub) {
            let cmd: Value = serde_json::from_str(batch.lines().next().unwrap()).unwrap();
            mcp_results(
                &responder_hub,
                &json!([{"id": cmd["id"], "ok": false, "code": "not-connected", "msg": "cannot send while disconnected"}])
                    .to_string(),
            );
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    });
    let resp = handle_http(
        &h,
        &post(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send","arguments":{"data":"hi","encoding":"utf8"}}}"#, None),
        "tok",
    );
    responder.join().unwrap();
    let v = body_json(&resp);
    assert_eq!(v["result"]["isError"], true);
    assert_eq!(
        v["result"]["content"][0]["text"],
        "not-connected: cannot send while disconnected"
    );
}

#[test]
fn stop_fails_pending_waiters_and_clears_state() {
    let (h, _rx) = hub();
    let start = mcp_start(&h, r#"{"port":0,"token":"tok"}"#);
    let started: Value = serde_json::from_str(&start).unwrap();
    assert_eq!(started["ok"], true);
    assert!(started["port"].as_u64().unwrap() > 0);
    // start while running is refused
    let again = mcp_start(&h, r#"{"port":0,"token":"tok"}"#);
    let again_v: Value = serde_json::from_str(&again).unwrap();
    assert!(again_v["error"].is_object(), "start while running refused: {again}");
    // enqueue a command whose waiter will only be satisfied by mcp_stop
    let cmd_json = json!({"id": 99, "name": "status", "args": {}}).to_string();
    h.cmds.lock().unwrap().push_back(cmd_json);
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    h.results.lock().unwrap().insert(99, tx);
    assert!(mcp_stop(&h));
    let answer: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
    assert_eq!(answer["ok"], false);
    assert_eq!(answer["code"], "mcp-stopped");
    assert!(mcp_cmds(&h).is_none());
    // idempotent stop
    assert!(mcp_stop(&h));
    // restart after stop works
    let restart = mcp_start(&h, r#"{"port":0,"token":"tok"}"#);
    let restart_v: Value = serde_json::from_str(&restart).unwrap();
    assert_eq!(restart_v["ok"], true);
    assert!(mcp_stop(&h));
}

// ---------------------------------------------------------------------------
// batch handling
// ---------------------------------------------------------------------------

#[test]
fn batch_mixed_messages() {
    let (h, _rx) = hub();
    let body = json!([
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": "abc", "method": "ping"}
    ])
    .to_string();
    let resp = handle_http(&h, &post(body.as_str(), None), "tok");
    assert_eq!(status(&resp), 200);
    let v = body_json(&resp);
    assert_eq!(v["id"], "abc");
    assert_eq!(v["result"], json!({}));
}
