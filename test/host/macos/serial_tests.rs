//! `com_serial.rs` unit tests — no guest, no serial port required.
//!
//! Mirrored under test/host/macos/ per repo convention; compiled into the
//! `pocketcom-host` bin via `#[path]` from host/macos/src/com_serial.rs, so
//! `use super::*` reaches com_serial's private items.

use super::*;

#[test]
fn open_param_validation_is_structured() {
    let mut core = SerialCore::new(Arc::new(AtomicU32::new(1)));
    let bad = core.serial_open("{not json");
    assert!(bad.contains("invalid-param"));
    let bad = core.serial_open(r#"{"path":"","baudRate":115200}"#);
    assert!(bad.contains("invalid-param"));
    let bad = core.serial_open(r#"{"path":"/dev/cu.X","baudRate":115200,"dataBits":9}"#);
    assert!(bad.contains("invalid-param"));
    let bad = core.serial_open(r#"{"path":"/dev/cu.X","baudRate":115200,"parity":"sometimes"}"#);
    assert!(bad.contains("invalid-param"));
    let bad = core.serial_open(r#"{"path":"/dev/cu.X","baudRate":115200,"stopBits":3}"#);
    assert!(bad.contains("invalid-param"));
    let bad = core.serial_open(r#"{"path":"/dev/cu.X","baudRate":115200,"flowControl":"magic"}"#);
    assert!(bad.contains("invalid-param"));
    // A well-formed open of a path that does not exist is an io error,
    // not a param error and never a panic.
    let missing = core.serial_open(r#"{"path":"/dev/cu.no-such-pocketcom","baudRate":115200}"#);
    assert!(missing.contains("io-error"));
    assert!(core.ports.is_empty());
}

#[test]
fn macos_lists_only_callout_devices() {
    if cfg!(target_os = "macos") {
        assert!(port_visible("/dev/cu.usbserial-1"));
        assert!(!port_visible("/dev/tty.usbserial-1"));
        assert!(!port_visible("/dev/cu")); // prefix without the dot
    }
}

#[test]
fn worker_failure_emits_error_then_closed() {
    let (tx, rx) = mpsc::channel();
    fail(&tx, 7, "io-error", "unplugged");
    let first = rx.try_recv().unwrap();
    let second = rx.try_recv().unwrap();
    assert!(first.contains(r#""t":"error""#));
    assert!(first.contains(r#""h":7"#));
    assert!(first.contains("unplugged"));
    assert!(second.contains(r#""t":"closed""#));
    assert!(second.contains(r#""h":7"#));
    assert!(second.contains("unplugged"));
}

#[test]
fn ops_on_unknown_handles_are_false() {
    let mut core = SerialCore::new(Arc::new(AtomicU32::new(1)));
    assert!(!core.queue_write(99, b"x"));
    assert!(!core.set_signals(99, r#"{"dtr":true}"#));
    assert!(!core.close(99));
    // Negative handles cast into a not-allocated u32 slot, same answer.
    assert!(!core.queue_write(-1, b"x"));
    assert!(!core.close(-1));
    // Malformed signals JSON is rejected before the handle even matters.
    assert!(!core.set_signals(1, "{not json"));
    assert!(core.ports.is_empty());
}
