//! POCKETCOM — the MCP server (M4, SPEC §6): a Streamable-HTTP MCP endpoint
//! served by a native thread inside the host process, letting AI agents share
//! the guest's connection and message bus (send / read / connect / config).
//!
//! Architecture (SPEC §6.2): the server thread NEVER touches QuickJS. Agent
//! tool calls are either answered host-side (`read` drains the bounded read
//! buffer the guest feeds via `com.mcpFeed`) or enqueued as JSON commands and
//! drained by the guest at a tick boundary (`com.mcpCmds` → core executor →
//! `com.mcpResults`). Each enqueued command blocks its HTTP thread on a
//! oneshot channel until the guest's result arrives (tick = 16 ms, so the
//! round trip is imperceptible; a wedged guest times out with a structured
//! error instead of hanging the agent).
//!
//! Transport: hand-rolled HTTP/1.1 on std::net (thread-per-connection, same
//! model as com_tcp.rs — no tokio). One endpoint `POST/DELETE /mcp`; no
//! server→client SSE stream, so GET → 405 (allowed by the MCP spec). Every
//! request is answered with `Connection: close`. Bearer-token auth returns
//! 401 before any dispatch (SPEC §5.3: localhost bind + token, no anonymous
//! access). CORS headers are emitted so web-based MCP clients work.
//!
//! Terminal-mode gate (SPEC §6.1): the server only runs while the app is in
//! transfer mode. The guest stops it on mode switches; commands already
//! queued are answered by the guest's executor with `mcp-suspended`.
//!
//! Ops mounted into the `com` namespace (see com.rs):
//! - `com.mcpStart({"port","token"})` → `{"ok":true,"token","port"}` — an
//!   empty token is replaced by 32 fresh random bytes (hex), which the guest
//!   persists (SPEC §5.3).
//! - `com.mcpStop()` → bool.
//! - `com.mcpFeed({"lines":[...]})` — append guest-formatted read lines.
//! - `com.mcpCmds()` → JSON-line batch or null.
//! - `com.mcpResults([...])` — guest answers keyed by command id.
//! Status pushes to the UI ride the shared com event stream:
//! `{"t":"mcp","on":bool,"clients":N}` whenever the client count changes.

use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::com::trace_enabled;

/// Bound of the MCP-side read buffer (SPEC §6.4: bounded like §3.5; oldest
/// whole lines are dropped beyond this).
pub(crate) const READ_BUFFER_MAX_BYTES: usize = 256 * 1024;
/// Max accepted HTTP body (tool arguments are tiny; anything bigger is abuse).
const BODY_MAX: usize = 1024 * 1024;
/// Max accepted request header block.
const HEADER_MAX: usize = 64 * 1024;
/// Per-connection socket read timeout (one request per connection).
const CONN_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a tools/call waits for the guest's tick-boundary execution.
const GUEST_REPLY_TIMEOUT: Duration = Duration::from_secs(10);
/// Server accept-loop poll interval (shutdown observability).
const ACCEPT_POLL: Duration = Duration::from_millis(25);
/// Sessions idle longer than this stop counting as "clients".
const SESSION_TTL: Duration = Duration::from_secs(60);
/// Max commands queued for the guest; beyond this callers get an immediate
/// structured error instead of unbounded memory.
const CMD_QUEUE_MAX: usize = 64;
/// Max commands handed to the guest per drain (per tick).
const CMD_DRAIN_MAX: usize = 32;

// JSON-RPC / MCP error codes.
const E_PARSE: i64 = -32700;
const E_INVALID_REQUEST: i64 = -32600;
const E_METHOD_NOT_FOUND: i64 = -32601;

// ---------------------------------------------------------------------------
// hub — everything the HTTP threads and the guest ops share
// ---------------------------------------------------------------------------

/// Bounded FIFO of read lines (guest-formatted, one message per line).
#[derive(Default)]
struct ReadBuffer {
    lines: VecDeque<String>,
    bytes: usize,
}

impl ReadBuffer {
    fn push(&mut self, line: String) {
        let line_len = line.len() + 1;
        self.lines.push_back(line);
        self.bytes += line_len;
        while self.bytes > READ_BUFFER_MAX_BYTES {
            match self.lines.pop_front() {
                Some(old) => self.bytes -= old.len() + 1,
                None => break,
            }
        }
    }

    /// Join all buffered lines; keep the newest bytes that fit `max_bytes`.
    /// `clear` removes what was returned (drain); otherwise peek.
    fn take(&mut self, max_bytes: usize, clear: bool) -> String {
        if self.lines.is_empty() {
            return String::new();
        }
        let all: Vec<&str> = self.lines.iter().map(String::as_str).collect();
        let mut text = all.join("\n");
        if text.len() > max_bytes {
            // Keep the tail (newest data is what an agent is waiting for);
            // cut at a line boundary so lines stay whole.
            let mut cut = text.len() - max_bytes;
            while !text.is_char_boundary(cut) {
                cut += 1;
            }
            let tail = &text[cut..];
            let trimmed = tail.split_once('\n').map_or(tail, |(_, rest)| rest);
            text = format!("(older bytes truncated)\n{trimmed}");
        }
        if clear {
            self.lines.clear();
            self.bytes = 0;
        }
        text
    }
}

pub(crate) struct McpHub {
    running: Arc<AtomicBool>,
    /// Commands waiting for the guest to drain (JSON lines).
    cmds: Arc<Mutex<VecDeque<String>>>,
    /// Oneshot reply channels keyed by command id (guest → waiters).
    results: Arc<Mutex<HashMap<u64, mpsc::SyncSender<String>>>>,
    read_buf: Arc<Mutex<ReadBuffer>>,
    /// Live MCP client sessions (id → last seen); drives the client count.
    sessions: Arc<Mutex<HashMap<String, Instant>>>,
    /// Shared com event stream (UI status pushes + trace parity).
    event_tx: Arc<Mutex<mpsc::Sender<String>>>,
    cmd_seq: AtomicU64,
    session_seq: AtomicU64,
}

impl McpHub {
    pub(crate) fn new(event_tx: mpsc::Sender<String>) -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            cmds: Arc::new(Mutex::new(VecDeque::new())),
            results: Arc::new(Mutex::new(HashMap::new())),
            read_buf: Arc::new(Mutex::new(ReadBuffer::default())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            event_tx: Arc::new(Mutex::new(event_tx)),
            cmd_seq: AtomicU64::new(1),
            session_seq: AtomicU64::new(1),
        }
    }

    fn send_event(&self, value: Value) {
        if let Ok(tx) = self.event_tx.lock() {
            let _ = tx.send(value.to_string());
        }
    }

    fn push_client_count(&self, on: bool) {
        let clients = if on {
            self.sessions.lock().map(|s| s.len()).unwrap_or(0)
        } else {
            0
        };
        self.send_event(json!({"t": "mcp", "on": on, "clients": clients}));
    }

    /// Register/refresh a session; returns the current client count.
    fn touch_session(&self, id: Option<&str>) -> usize {
        let mut changed = false;
        let count = {
            let mut sessions = self.sessions.lock().unwrap();
            let now = Instant::now();
            sessions.retain(|_, seen| now.duration_since(*seen) < SESSION_TTL);
            if let Some(id) = id {
                if sessions.insert(id.to_string(), now).is_none() {
                    changed = true;
                }
            }
            sessions.len()
        };
        if changed {
            self.push_client_count(true);
        }
        count
    }

    fn drop_session(&self, id: &str) {
        let removed = self.sessions.lock().unwrap().remove(id).is_some();
        if removed {
            self.push_client_count(true);
        }
    }
}

// ---------------------------------------------------------------------------
// guest-side ops (called on the main thread inside the guest's turn)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct StartParams {
    port: u16,
    #[serde(default)]
    token: String,
}

/// Bind 127.0.0.1:<port> and spawn the accept loop. Returns the effective
/// token (generated when the caller passed an empty one) so the guest can
/// persist it (SPEC §5.3: 32 random bytes on first enable).
pub(crate) fn mcp_start(hub: &Arc<McpHub>, params_json: &str) -> String {
    let result = try_mcp_start(hub, params_json);
    if trace_enabled() {
        eprintln!("pocketcom-trace: com.mcpStart {params_json} -> {result}");
    }
    result
}

fn try_mcp_start(hub: &Arc<McpHub>, params_json: &str) -> String {
    if hub.running.load(Ordering::SeqCst) {
        return crate::com::ComFailure::param("mcp server already running").to_json().to_string();
    }
    let Ok(p) = serde_json::from_str::<StartParams>(params_json) else {
        return crate::com::ComFailure::param("malformed mcpStart params: need {port, token?}")
            .to_json()
            .to_string();
    };
    let token = if p.token.is_empty() {
        match random_token() {
            Ok(t) => t,
            Err(e) => return crate::com::ComFailure::io(format!("generating token: {e}")).to_json().to_string(),
        }
    } else {
        p.token
    };
    let bind = format!("127.0.0.1:{}", p.port);
    let listener = match TcpListener::bind(&bind) {
        Ok(l) => l,
        Err(e) => return crate::com::ComFailure::io(format!("binding {bind}: {e}")).to_json().to_string(),
    };
    let bound_port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(p.port);
    hub.running.store(true, Ordering::SeqCst);
    hub.push_client_count(true);
    let thread_hub = hub.clone();
    let thread_token = token.clone();
    let _ = std::thread::Builder::new()
        .name("pocketcom-mcp".into())
        .spawn(move || accept_loop(thread_hub, listener, thread_token));
    json!({"ok": true, "token": token, "port": bound_port}).to_string()
}

/// Stop the server: refuse new connections, fail pending waiters, drop the
/// read buffer and sessions (SPEC §6.1 close semantics + terminal-mode gate).
pub(crate) fn mcp_stop(hub: &Arc<McpHub>) -> bool {
    if !hub.running.swap(false, Ordering::SeqCst) {
        return true; // idempotent
    }
    hub.push_client_count(false);
    {
        let mut sessions = hub.sessions.lock().unwrap();
        sessions.clear();
    }
    {
        hub.cmds.lock().unwrap().clear();
    }
    let waiters: Vec<mpsc::SyncSender<String>> = {
        let mut map = hub.results.lock().unwrap();
        map.drain().map(|(_, tx)| tx).collect()
    };
    for tx in waiters {
        let _ = tx.send(
            json!({"ok": false, "code": "mcp-stopped", "msg": "MCP server stopped"}).to_string(),
        );
    }
    hub.read_buf.lock().unwrap().lines.clear();
    if trace_enabled() {
        eprintln!("pocketcom-trace: com.mcpStop");
    }
    true
}

/// Append guest-formatted read lines ({"lines":["..."]}) to the read buffer.
pub(crate) fn mcp_feed(hub: &Arc<McpHub>, lines_json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(lines_json) else {
        return false;
    };
    let Some(lines) = v.get("lines").and_then(Value::as_array) else {
        return false;
    };
    let mut buf = hub.read_buf.lock().unwrap();
    for line in lines {
        if let Some(s) = line.as_str() {
            buf.push(s.to_string());
        }
    }
    true
}

/// Drain queued commands (JSON lines) for the guest's tick-boundary turn.
pub(crate) fn mcp_cmds(hub: &Arc<McpHub>) -> Option<String> {
    let mut queue = hub.cmds.lock().unwrap();
    if queue.is_empty() {
        return None;
    }
    let mut batch = String::new();
    for _ in 0..CMD_DRAIN_MAX {
        match queue.pop_front() {
            Some(cmd) => {
                batch.push_str(&cmd);
                batch.push('\n');
            }
            None => break,
        }
    }
    if batch.is_empty() { None } else { Some(batch) }
}

/// Deliver guest execution results (array of {id,ok,text|code,msg}) to the
/// waiting HTTP threads.
pub(crate) fn mcp_results(hub: &Arc<McpHub>, results_json: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(results_json) else {
        return false;
    };
    let Some(items) = v.as_array() else {
        return false;
    };
    let mut map = hub.results.lock().unwrap();
    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_u64) else {
            continue;
        };
        if let Some(tx) = map.remove(&id) {
            let _ = tx.send(item.to_string());
        }
    }
    true
}

/// 32 random bytes → 64 lowercase hex chars (from /dev/urandom; no crypto
/// crate for exactly one call site).
fn random_token() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .map_err(|e| e.to_string())?;
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub(crate) struct HttpRequest {
    pub(crate) method: String,
    pub(crate) target: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl HttpRequest {
    fn header(&self, name: &str) -> Option<&str> {
        let lower = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(k, _)| *k == lower)
            .map(|(_, v)| v.as_str())
    }
}

pub(crate) struct HttpResponse {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

impl HttpResponse {
    fn json(status: u16, value: &Value, extra: Vec<(String, String)>) -> Self {
        Self {
            status,
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("mcp-protocol-version".into(), "2025-06-18".into()),
            ],
            body: value.to_string().into_bytes(),
        }
        .with_headers(extra)
    }

    fn empty(status: u16, extra: Vec<(String, String)>) -> Self {
        Self { status, headers: Vec::new(), body: Vec::new() }.with_headers(extra)
    }

    fn with_headers(mut self, extra: Vec<(String, String)>) -> Self {
        self.headers.extend(extra);
        self
    }
}

/// Accumulate bytes → complete request. Ok(None) = need more bytes;
/// Err(status) = unrecoverable request-level error.
pub(crate) fn try_parse_request(bytes: &[u8]) -> Result<Option<HttpRequest>, u16> {
    let Some(header_end) = find_header_end(bytes) else {
        // No end-of-headers yet: incomplete (more bytes needed) unless we are
        // already over the header budget.
        return if bytes.len() > HEADER_MAX { Err(431) } else { Ok(None) };
    };
    if header_end > HEADER_MAX {
        return Err(431);
    }
    let head = std::str::from_utf8(&bytes[..header_end]).map_err(|_| 400u16)?;
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split(' ');
    let method = parts.next().unwrap_or_default().to_string();
    let target = parts.next().unwrap_or_default().to_string();
    let version = parts.next().unwrap_or_default();
    if method.is_empty() || target.is_empty() || !version.starts_with("HTTP/1.") {
        return Err(400);
    }
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err(400);
        };
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    let content_length = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    if headers.iter().any(|(k, _)| k == "transfer-encoding") {
        return Err(411); // one-shot JSON bodies always carry content-length
    }
    if content_length > BODY_MAX {
        return Err(413);
    }
    let body_start = header_end + 4;
    if bytes.len() < body_start + content_length {
        return Ok(None);
    }
    Ok(Some(HttpRequest {
        method,
        target,
        headers,
        body: bytes[body_start..body_start + content_length].to_vec(),
    }))
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Token check: constant-time-ish byte comparison (length leak is harmless —
/// the token length is fixed 64 hex unless user-provided).
fn token_ok(provided: Option<&str>, token: &str) -> bool {
    let Some(provided) = provided else { return false };
    let a = provided.as_bytes();
    let b = token.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Full request dispatch — pure over shared state, unit-testable without
/// sockets. `token` is the active server token.
pub(crate) fn handle_http(hub: &Arc<McpHub>, req: &HttpRequest, token: &str) -> HttpResponse {
    let cors = vec![
        ("access-control-allow-origin".to_string(), "*".to_string()),
        (
            "access-control-allow-methods".to_string(),
            "GET, POST, DELETE, OPTIONS".to_string(),
        ),
        (
            "access-control-allow-headers".to_string(),
            "content-type, authorization, mcp-session-id, mcp-protocol-version".to_string(),
        ),
        (
            "access-control-expose-headers".to_string(),
            "mcp-session-id".to_string(),
        ),
    ];
    let path = req.target.split('?').next().unwrap_or_default();
    if req.method == "OPTIONS" {
        return HttpResponse::empty(204, cors);
    }
    if path != "/mcp" {
        return HttpResponse::json(404, &json!({"error": {"code": "not-found", "msg": "unknown path"}}), cors);
    }
    if !token_ok(req.header("authorization").and_then(|v| v.strip_prefix("Bearer ")), token) {
        return HttpResponse::json(
            401,
            &json!({"error": {"code": "unauthorized", "msg": "missing or invalid bearer token"}}),
            vec![("www-authenticate".to_string(), "Bearer".to_string())],
        )
        .with_headers(cors);
    }
    match req.method.as_str() {
        "POST" => handle_post(hub, req, cors),
        "GET" => HttpResponse::json(
            405,
            &json!({"error": {"code": "method-not-allowed", "msg": "no server→client SSE stream; use POST"}}),
            vec![("allow".to_string(), "POST, DELETE, OPTIONS".to_string())],
        )
        .with_headers(cors),
        "DELETE" => {
            if let Some(id) = req.header("mcp-session-id") {
                hub.drop_session(id);
            }
            HttpResponse::empty(204, cors)
        }
        _ => HttpResponse::json(
            405,
            &json!({"error": {"code": "method-not-allowed", "msg": "method not allowed"}}),
            vec![("allow".to_string(), "POST, DELETE, OPTIONS".to_string())],
        )
        .with_headers(cors),
    }
}

fn handle_post(hub: &Arc<McpHub>, req: &HttpRequest, cors: Vec<(String, String)>) -> HttpResponse {
    let content_type = req.header("content-type").unwrap_or_default();
    if !content_type.split(';').next().unwrap_or_default().trim().eq_ignore_ascii_case("application/json") {
        return HttpResponse::json(415, &json!({"error": {"code": "unsupported-media-type", "msg": "content-type must be application/json"}}), cors);
    }
    let accept = req.header("accept").unwrap_or_default();
    if !accept.contains("application/json") && !accept.contains("text/event-stream") {
        return HttpResponse::json(406, &json!({"error": {"code": "not-acceptable", "msg": "accept must include application/json or text/event-stream"}}), cors);
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(&req.body) else {
        return jsonrpc_error_http(None, E_PARSE, "malformed JSON body", cors);
    };
    let session_header = req.header("mcp-session-id").map(str::to_string);
    let mut responses: Vec<Value> = Vec::new();
    let mut new_session: Option<String> = None;
    let messages: Vec<Value> = match parsed {
        Value::Array(items) => items,
        single @ Value::Object(_) => vec![single],
        _ => return jsonrpc_error_http(None, E_INVALID_REQUEST, "body must be a JSON-RPC message or batch", cors),
    };
    for msg in messages {
        let is_response = msg.get("result").is_some() || msg.get("error").is_some();
        if is_response {
            continue; // we never issue server→client requests
        }
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            if msg.get("id").is_some() {
                responses.push(jsonrpc_error_value(msg.get("id"), E_INVALID_REQUEST, "missing method"));
            }
            continue;
        };
        // Unknown session ids are rejected (spec: 404 for terminated sessions).
        if let Some(id) = &session_header
            && !hub.sessions.lock().unwrap().contains_key(id)
        {
            return HttpResponse::json(404, &json!({"error": {"code": "session-not-found", "msg": "unknown mcp-session-id"}}), cors);
        }
        let has_id = msg.get("id").is_some();
        match (method, has_id) {
            ("initialize", true) => {
                let count = hub.touch_session(None); // provisional; real id below
                let session_id = session_header.clone().unwrap_or_else(|| {
                    let id = format!(
                        "mcp-{:08x}{:06x}",
                        hub.session_seq.fetch_add(1, Ordering::SeqCst),
                        std::process::id()
                    );
                    id
                });
                let _ = hub.touch_session(Some(&session_id));
                new_session = Some(session_id);
                let requested = msg
                    .pointer("/params/protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let version = if matches!(requested, "2025-03-26" | "2025-06-18") {
                    requested
                } else {
                    "2025-06-18"
                };
                if has_id {
                    responses.push(json!({
                        "jsonrpc": "2.0", "id": msg["id"].clone(),
                        "result": {
                            "protocolVersion": version,
                            "capabilities": {"tools": {}},
                            "serverInfo": {"name": "PocketCOM", "version": env!("CARGO_PKG_VERSION")},
                            "instructions": format!(
                                "PocketCOM serial/network debug assistant. Use tools to inspect status, \
                                 open connections, exchange bytes and read responses. Clients now: {count}."
                            ),
                        }
                    }));
                }
            }
            ("notifications/initialized", _) | ("notifications/cancelled", _) => {
                hub.touch_session(session_header.as_deref());
            }
            ("ping", true) => {
                responses.push(json!({"jsonrpc": "2.0", "id": msg["id"].clone(), "result": {}}));
            }
            ("tools/list", true) => {
                hub.touch_session(session_header.as_deref());
                responses.push(json!({
                    "jsonrpc": "2.0", "id": msg["id"].clone(),
                    "result": {"tools": tools_schema()}
                }));
            }
            ("tools/call", true) => {
                hub.touch_session(session_header.as_deref());
                responses.push(tool_call(hub, &msg));
            }
            (_, true) => {
                responses.push(jsonrpc_error_value(
                    msg.get("id"),
                    E_METHOD_NOT_FOUND,
                    &format!("unknown method: {method}"),
                ));
            }
            (_, false) => {
                // Unknown notification: 202, no response (spec behavior).
            }
        }
    }
    let mut extra = cors;
    if let Some(id) = new_session {
        extra.push(("mcp-session-id".to_string(), id));
    }
    if responses.is_empty() {
        return HttpResponse::empty(202, extra);
    }
    let body = if responses.len() == 1 {
        responses.remove(0)
    } else {
        Value::Array(responses)
    };
    HttpResponse::json(200, &body, extra)
}

// ---------------------------------------------------------------------------
// JSON-RPC + tool dispatch
// ---------------------------------------------------------------------------

fn jsonrpc_error_value(id: Option<&Value>, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.cloned().unwrap_or(Value::Null),
        "error": {"code": code, "message": message}
    })
}

fn jsonrpc_error_http(id: Option<&Value>, code: i64, message: &str, cors: Vec<(String, String)>) -> HttpResponse {
    HttpResponse::json(400, &jsonrpc_error_value(id, code, message), cors)
}

/// One tools/call → JSON-RPC result. `read` is answered host-side from the
/// read buffer; every other tool is executed by the guest core at a tick
/// boundary (enqueue → block on the oneshot reply → shape the envelope).
fn tool_call(hub: &Arc<McpHub>, msg: &Value) -> Value {
    let id = msg.get("id").cloned().unwrap_or(Value::Null);
    let name = msg.pointer("/params/name").and_then(Value::as_str).unwrap_or_default();
    let args = msg.pointer("/params/arguments").cloned().unwrap_or_else(|| json!({}));
    let outcome: Result<String, (String, String)> = if name == "read" {
        read_tool(hub, &args).map_err(|m| ("invalid-param".into(), m))
    } else if name.is_empty() {
        Err(("invalid-params".into(), "missing tool name".into()))
    } else {
        execute_via_guest(hub, name, &args)
    };
    match outcome {
        Ok(text) => json!({
            "jsonrpc": "2.0", "id": id,
            "result": {"content": [{"type": "text", "text": text}], "isError": false}
        }),
        Err((code, m)) => json!({
            "jsonrpc": "2.0", "id": id,
            "result": {"content": [{"type": "text", "text": format!("{code}: {m}")}], "isError": true}
        }),
    }
}

/// `read` tool (SPEC §6.3): pull the read buffer (read-and-drain by default).
fn read_tool(hub: &Arc<McpHub>, args: &Value) -> Result<String, String> {
    let max_bytes = match args.get("maxBytes") {
        None | Some(Value::Null) => 65536,
        Some(Value::Number(n)) => {
            let v = n.as_f64().unwrap_or_default();
            if !(1.0..=READ_BUFFER_MAX_BYTES as f64).contains(&v) {
                return Err("maxBytes must be 1..262144".into());
            }
            v as usize
        }
        Some(_) => return Err("maxBytes must be a number".into()),
    };
    let clear = !matches!(args.get("clear"), Some(Value::Bool(false)));
    let mut buf = hub.read_buf.lock().unwrap();
    let text = buf.take(max_bytes, clear);
    if text.is_empty() {
        Ok("(no data)".to_string())
    } else {
        Ok(text)
    }
}

/// Enqueue a guest command and wait for the tick-boundary reply.
fn execute_via_guest(hub: &Arc<McpHub>, name: &str, args: &Value) -> Result<String, (String, String)> {
    if !hub.running.load(Ordering::SeqCst) {
        return Err(("mcp-stopped".into(), "MCP server is stopping".into()));
    }
    let cmd_id = hub.cmd_seq.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::sync_channel::<String>(1);
    {
        let mut map = hub.results.lock().unwrap();
        map.insert(cmd_id, tx);
    }
    let queued = {
        let mut queue = hub.cmds.lock().unwrap();
        if queue.len() >= CMD_QUEUE_MAX {
            false
        } else {
            queue.push_back(
                json!({"id": cmd_id, "name": name, "args": args}).to_string(),
            );
            true
        }
    };
    if !queued {
        hub.results.lock().unwrap().remove(&cmd_id);
        return Err(("overloaded".into(), "command queue full; try again".into()));
    }
    match rx.recv_timeout(GUEST_REPLY_TIMEOUT) {
        Ok(line) => {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                return Err(("internal".into(), "guest returned malformed result".into()));
            };
            if v.get("ok").and_then(Value::as_bool) == Some(true) {
                Ok(v.get("text").and_then(Value::as_str).unwrap_or_default().to_string())
            } else {
                let code = v.get("code").and_then(Value::as_str).unwrap_or("internal").to_string();
                let m = v.get("msg").and_then(Value::as_str).unwrap_or("unknown error").to_string();
                Err((code, m))
            }
        }
        Err(_) => {
            hub.results.lock().unwrap().remove(&cmd_id);
            Err((
                "guest-timeout".into(),
                format!("guest did not answer within {}s", GUEST_REPLY_TIMEOUT.as_secs()),
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// tool descriptors (SPEC §6.3)
// ---------------------------------------------------------------------------

fn tools_schema() -> Value {
    Value::Array(vec![
        tool(
            "status",
            "Get the current connection status: state, connection kind, human-readable \
             description, rx/tx byte counters and the number of connected MCP clients.",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "list_serial_ports",
            "List available serial ports, one per line as \"device - description\".",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "connect",
            "Open a connection. Refused when a connection already exists unless force:true \
             (which disconnects first). Types: serial(path,baudRate,dataBits,parity,stopBits,\
             flowControl,dtr,rts) | tcp(host,port,autoReconnect,reconnectSec) | tcps(port) | \
             udp(host,port,bindPort) | ws(url,autoReconnect,reconnectSec).",
            json!({
                "type": "object",
                "required": ["type"],
                "properties": {
                    "type": {"type": "string", "enum": ["serial", "tcp", "tcps", "udp", "ws"]},
                    "force": {"type": "boolean", "description": "disconnect the existing connection first"},
                    "path": {"type": "string", "description": "serial device path, e.g. /dev/cu.usbserial-xxx"},
                    "baudRate": {"type": "number"},
                    "dataBits": {"type": "number", "enum": [5, 6, 7, 8]},
                    "parity": {"type": "string", "enum": ["none", "odd", "even"]},
                    "stopBits": {"type": "number", "enum": [1, 2]},
                    "flowControl": {"type": "string", "enum": ["none", "xonxoff", "rtscts", "dsrdtr"]},
                    "dtr": {"type": "boolean"},
                    "rts": {"type": "boolean"},
                    "host": {"type": "string"},
                    "port": {"type": "number"},
                    "bindPort": {"type": "number", "description": "udp local bind port (default = port)"},
                    "url": {"type": "string", "description": "ws:// or wss:// URL"},
                    "autoReconnect": {"type": "boolean"},
                    "reconnectSec": {"type": "number"}
                }
            }),
        ),
        tool(
            "disconnect",
            "Close the current connection (idempotent).",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "send",
            "Send bytes on the current connection. Never appends a newline implicitly; \
             pass appendNewline:true to append \\r\\n. The send is echoed in the app UI as \
             an MCP-sourced TX frame and is NOT fed back into your read buffer.",
            json!({
                "type": "object",
                "required": ["data", "encoding"],
                "properties": {
                    "data": {"type": "string", "description": "payload in the chosen encoding"},
                    "encoding": {"type": "string", "enum": ["utf8", "hex", "base64"]},
                    "appendNewline": {"type": "boolean", "description": "append \\r\\n to the payload"}
                }
            }),
        ),
        tool(
            "read",
            "Read bytes received so far (plus manual user sends and system events), formatted \
             as lines `[timestamp] [source] content`. Drains the buffer by default; pass \
             clear:false to peek. Empty buffer returns \"(no data)\". Sends you made via the \
             send tool are excluded.",
            json!({
                "type": "object",
                "properties": {
                    "maxBytes": {"type": "number", "description": "return at most this many bytes (newest kept)"},
                    "clear": {"type": "boolean", "description": "drain after reading (default true)"}
                }
            }),
        ),
        tool(
            "config_read",
            "Read the whitelisted app configuration (never includes the MCP token).",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "config_write",
            "Patch whitelisted app configuration keys: language, theme, fontSize, \
             terminal.scrollbackLines, receive.{hex,escape,timestamp,wrap}, \
             send.{escape,crlf,appendNewline}, mcp.{enabled,port}. The MCP token cannot be \
             read or written.",
            json!({
                "type": "object",
                "properties": {
                    "config": {"type": "object", "description": "partial config to apply"}
                }
            }),
        ),
    ])
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name": name, "description": description, "inputSchema": input_schema})
}

// ---------------------------------------------------------------------------
// server threads
// ---------------------------------------------------------------------------

/// Accept loop: nonblocking listener + short poll so shutdown is observed
/// within ACCEPT_POLL. One detached thread per connection; every connection
/// serves exactly one request, then closes.
fn accept_loop(hub: Arc<McpHub>, listener: TcpListener, token: String) {
    let _ = listener.set_nonblocking(true);
    loop {
        if !hub.running.load(Ordering::SeqCst) {
            return;
        }
        match listener.accept() {
            Ok((stream, _peer)) => {
                let hub = hub.clone();
                let token = token.clone();
                std::thread::spawn(move || {
                    let _ = serve_connection(&hub, stream, &token);
                });
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => return,
        }
        std::thread::sleep(ACCEPT_POLL);
    }
}

/// Read one request, dispatch, respond, close.
fn serve_connection(hub: &Arc<McpHub>, mut stream: TcpStream, token: &str) -> std::io::Result<()> {
    let _ = stream.set_read_timeout(Some(CONN_READ_TIMEOUT));
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let request = loop {
        match stream.read(&mut chunk) {
            Ok(0) => return Ok(()), // client closed before a full request
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut => {
                return Ok(())
            }
            Err(_) => return Ok(()),
        }
        match try_parse_request(&buf) {
            Ok(Some(req)) => break req,
            Ok(None) => {
                if buf.len() > HEADER_MAX + BODY_MAX {
                    return Ok(()); // oversized: drop the connection
                }
            }
            Err(status) => {
                write_response(
                    &mut stream,
                    &HttpResponse::json(
                        status,
                        &json!({"error": {"code": "bad-request", "msg": "malformed HTTP request"}}),
                        Vec::new(),
                    ),
                )?;
                return Ok(());
            }
        }
    };
    let response = handle_http(hub, &request, token);
    write_response(&mut stream, &response)
}

fn write_response(stream: &mut TcpStream, response: &HttpResponse) -> std::io::Result<()> {
    let reason = match response.status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        411 => "Length Required",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    let mut head = format!("HTTP/1.1 {} {reason}\r\n", response.status);
    for (name, value) in &response.headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!("content-length: {}\r\n", response.body.len()));
    head.push_str("connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&response.body)?;
    stream.flush()
}

// ---------------------------------------------------------------------------
// tests — sources live mirrored under test/host/macos/ (repo convention),
// compiled into this bin's cfg(test) via #[path].
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "../../../test/host/macos/mcp_tests.rs"]
mod tests;
