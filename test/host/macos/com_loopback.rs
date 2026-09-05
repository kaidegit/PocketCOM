//! `com.rs` hardware loopback test — needs a real serial port with TX↔RX
//! shorted (plain echo line; DTR/RTS unconnected is fine).
//!
//! Skipped unless `POCKETCOM_LOOPBACK_PORT` is set; baud via
//! `POCKETCOM_LOOPBACK_BAUD` (default 115200):
//!
//! ```sh
//! POCKETCOM_LOOPBACK_PORT=/dev/cu.wchusbserial… POCKETCOM_LOOPBACK_BAUD=3000000 \
//!   cargo test --release --manifest-path host/macos/Cargo.toml \
//!   --bin pocketcom-host com::loopback -- --nocapture
//! ```
//!
//! Mirrored under test/host/macos/ per repo convention; compiled into the
//! `pocketcom-host` bin via `#[path]` from host/macos/src/com.rs.

use super::*;
use std::time::{Duration, Instant};

/// Per-phase deadline: covers the 64 KiB ping-pong at 115200 baud (~12 s)
/// with headroom; at 3M a phase finishes well under 1 s.
const PHASE_DEADLINE: Duration = Duration::from_secs(60);
/// Sustained-traffic volume, ping-ponged in chunks small enough that RX never
/// outruns the worker: full-duplex echo means bytes come back while the
/// worker is still inside `write_all`, and kernel tty input queues are small
/// (≈4 KiB on macOS), so one large single-shot burst can overflow and drop
/// bytes at high baud — a driver property, not a bridge property. 2 KiB in
/// flight stays under any plausible queue.
const BURST_TOTAL: usize = 64 * 1024;
const BURST_CHUNK: usize = 2 * 1024;
/// Grace before declaring the line quiet (worker read cadence is 5 ms).
const IDLE_GRACE: Duration = Duration::from_secs(2);
/// Between-poll sleep while waiting for echo bytes.
const POLL_SLEEP: Duration = Duration::from_millis(2);

#[derive(serde::Deserialize)]
struct Event {
    t: String,
    #[serde(default)]
    h: u32,
    #[serde(default)]
    b64: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    msg: String,
    #[serde(default)]
    reason: String,
}

fn env_port() -> Option<(String, u32)> {
    let path = std::env::var_os("POCKETCOM_LOOPBACK_PORT")?
        .to_string_lossy()
        .into_owned();
    let baud = match std::env::var("POCKETCOM_LOOPBACK_BAUD") {
        Ok(v) => v
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("POCKETCOM_LOOPBACK_BAUD is not a u32: {v}")),
        Err(_) => 115_200,
    };
    Some((path, baud))
}

fn open(core: &mut ComCore, path: &str, baud: u32) -> u32 {
    let opened =
        core.serial_open(&serde_json::json!({"path": path, "baudRate": baud}).to_string());
    let v: serde_json::Value = serde_json::from_str(&opened)
        .unwrap_or_else(|e| panic!("serialOpen returned malformed json {opened:?}: {e}"));
    if let Some(err) = v.get("error") {
        panic!("serialOpen {path}@{baud} failed: {err}");
    }
    v["handle"].as_u64().expect("serialOpen missing handle") as u32
}

/// Poll until `acc` holds `want` bytes for `handle`, asserting the event-line
/// contract (`{"t":"data","h","b64"}`) on every line; error/closed events and
/// wrong-handle events fail the phase. The whole poll batch is always
/// consumed, so duplicated bytes surface as acc.len() > want in the caller.
fn collect_echo(core: &mut ComCore, handle: u32, want: usize, acc: &mut Vec<u8>) {
    let deadline = Instant::now() + PHASE_DEADLINE;
    loop {
        if let Some(batch) = core.poll() {
            for line in batch.lines() {
                let ev: Event = serde_json::from_str(line)
                    .unwrap_or_else(|e| panic!("malformed com event line {line:?}: {e}"));
                if ev.t != "data" {
                    panic!(
                        "unexpected {} event on handle {handle}: code={} msg={} reason={}",
                        ev.t, ev.code, ev.msg, ev.reason
                    );
                }
                assert_eq!(ev.h, handle, "com event for wrong handle: {line}");
                let bytes = B64
                    .decode(&ev.b64)
                    .unwrap_or_else(|e| panic!("data event with bad b64: {e}"));
                acc.extend_from_slice(&bytes);
            }
        }
        if acc.len() >= want {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "echo timeout: want {want} bytes, got {} — port went quiet mid-echo",
            acc.len()
        );
        std::thread::sleep(POLL_SLEEP);
    }
}

/// One single-shot echo roundtrip with exact byte comparison.
fn echo(core: &mut ComCore, handle: u32, label: &str, expected: &[u8]) {
    println!("  echo[{label}] {} B …", expected.len());
    let start = Instant::now();
    assert!(
        core.queue_write(handle as i32, expected),
        "queue_write rejected the payload"
    );
    let mut acc = Vec::new();
    collect_echo(core, handle, expected.len(), &mut acc);
    assert_eq!(
        acc.len(),
        expected.len(),
        "{label}: echoed {} B, sent {} B",
        acc.len(),
        expected.len()
    );
    if let Some(i) = acc.iter().zip(expected).position(|(a, b)| a != b) {
        panic!(
            "{label}: first mismatch at byte {i}: sent {:#04x} got {:#04x}",
            expected[i], acc[i]
        );
    }
    println!("    ok ({:?})", start.elapsed());
}

/// Sustained traffic in ping-pong chunks (see BURST_CHUNK for why not one
/// single shot).
fn echo_burst(core: &mut ComCore, handle: u32, label: &str) {
    println!("  echo[{label}] {BURST_TOTAL} B in {BURST_CHUNK} B ping-pong chunks …");
    let start = Instant::now();
    let mut seed = 0x1234_5678_u32;
    let mut sent = 0usize;
    while sent < BURST_TOTAL {
        let n = BURST_CHUNK.min(BURST_TOTAL - sent);
        let chunk: Vec<u8> = (0..n)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 24) as u8
            })
            .collect();
        assert!(core.queue_write(handle as i32, &chunk));
        let mut acc = Vec::new();
        collect_echo(core, handle, n, &mut acc);
        assert_eq!(
            acc.len(),
            n,
            "{label}: chunk at offset {sent} echoed {} B, sent {n} B",
            acc.len()
        );
        if let Some(i) = acc.iter().zip(&chunk).position(|(a, b)| a != b) {
            panic!(
                "{label}: first mismatch in chunk at offset {}: byte {i}: sent {:#04x} got {:#04x}",
                sent, chunk[i], acc[i]
            );
        }
        sent += n;
    }
    println!("    ok ({:?})", start.elapsed());
}

/// Quiet line → poll() must stay None (no spurious/duplicated events).
fn expect_idle(core: &mut ComCore, label: &str) {
    let deadline = Instant::now() + IDLE_GRACE;
    while Instant::now() < deadline {
        if let Some(batch) = core.poll() {
            panic!("{label}: expected a quiet poll(), got {batch}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn hardware_loopback() {
    let Some((path, baud)) = env_port() else {
        eprintln!(
            "skip com::loopback::hardware_loopback: set POCKETCOM_LOOPBACK_PORT \
             (and optional POCKETCOM_LOOPBACK_BAUD, default 115200) to a port \
             with TX↔RX shorted to run the hardware loopback test"
        );
        return;
    };
    println!("com::loopback: {path} @ {baud} (TX↔RX shorted)");

    let mut core = ComCore::new();

    // serialList: the tested port is enumerated, and the macOS list is
    // callout-only (SPEC §3.2).
    let list: serde_json::Value = serde_json::from_str(&core.serial_list())
        .unwrap_or_else(|e| panic!("serialList returned malformed json: {e}"));
    let entries = list.as_array().expect("serialList is not an array");
    assert!(!entries.is_empty(), "serialList is empty");
    assert!(
        entries.iter().any(|p| p["path"] == serde_json::json!(path)),
        "serialList misses the tested port {path}"
    );
    for p in entries {
        let listed = p["path"].as_str().expect("port entry missing path");
        assert!(
            listed.starts_with("/dev/cu."),
            "non-callout device in the list: {listed}"
        );
    }

    // open + signals smoke (queued; a plain TX-RX loopback reflects nothing).
    let handle = open(&mut core, &path, baud);
    assert!(
        core.set_signals(handle as i32, r#"{"dtr":true,"rts":true}"#),
        "setSignals rejected on a live handle"
    );

    // Echo rounds: small ramp, every byte value, then sustained traffic.
    echo(
        &mut core,
        handle,
        "ramp-512",
        &(0u8..).take(512).collect::<Vec<u8>>(),
    );
    echo(
        &mut core,
        handle,
        "binary-2048",
        &(0u8..).take(2048).collect::<Vec<u8>>(),
    );
    echo_burst(&mut core, handle, "burst-64k");

    // All sent bytes are back and nothing else is in flight → quiet.
    expect_idle(&mut core, "after echo");

    // close semantics.
    assert!(core.close(handle as i32), "close on a live handle");
    assert!(!core.close(handle as i32), "double close must be false");
    assert!(
        !core.queue_write(handle as i32, b"after close"),
        "write after close must be false"
    );
    assert!(
        !core.set_signals(handle as i32, r#"{"rts":true}"#),
        "signals after close must be false"
    );

    // Reopen: fresh handle, still echoes, clean shutdown.
    let reopen = open(&mut core, &path, baud);
    assert_ne!(reopen, handle, "handle reuse after close");
    echo(&mut core, reopen, "reopen-256", &[0xa5u8; 256]);
    assert!(core.close(reopen as i32));
    println!("com::loopback: all phases passed");
}
