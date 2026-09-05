//! Shared helpers for the com net bridge test modules (tcp/udp/ws), included
//! via `#[path]` from each `*_tests.rs`. Mirrors test/core/testutil.ts's role.

use crate::com::NetRegistry;
use std::sync::atomic::AtomicU32;
use std::sync::Arc;
use std::time::Duration;

/// Fresh registry on its own handle counter.
pub(crate) fn new_registry() -> NetRegistry {
    NetRegistry::new(Arc::new(AtomicU32::new(1)))
}

/// Drain the event queue until an event matching `pred` shows up (bounded).
pub(crate) fn wait_event(
    reg: &NetRegistry,
    timeout: Duration,
    pred: &dyn Fn(&serde_json::Value) -> bool,
) -> Option<serde_json::Value> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if let Some(batch) = reg.poll() {
            for line in batch.lines() {
                let v: serde_json::Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if pred(&v) {
                    return Some(v);
                }
            }
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Accumulate events across poll batches until `pred` matches the whole set
/// (batch boundaries must not drop awaited events), or timeout.
pub(crate) fn wait_batch(
    reg: &NetRegistry,
    timeout: Duration,
    pred: &dyn Fn(&[serde_json::Value]) -> bool,
) -> Vec<serde_json::Value> {
    let deadline = std::time::Instant::now() + timeout;
    let mut all: Vec<serde_json::Value> = Vec::new();
    loop {
        if let Some(batch) = reg.poll() {
            for line in batch.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    all.push(v);
                }
            }
            if pred(&all) {
                return all;
            }
        }
        if std::time::Instant::now() >= deadline {
            return all;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Extract the handle from an op result ({"handle":N} shape).
pub(crate) fn handle_of(result: &str) -> u32 {
    let v: serde_json::Value = serde_json::from_str(result).expect("op result json");
    v["handle"].as_u64().expect("handle field") as u32
}

pub(crate) fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
