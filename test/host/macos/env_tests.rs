//! `com_env.rs` unit tests — config file IO + export payload (no dialogs).
//! Mirrored under test/host/macos/ per repo convention; compiled into the
//! `pocketcom-host` bin via `#[path]` from host/macos/src/com_env.rs, so
//! `use super::*` reaches com_env's private items.

use super::*;

/// tempfile-free unique dir under the target dir's temp space.
fn temp_config(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pocketcom-env-test-{}-{}-{label}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    dir.join("PocketCOM").join("config.json")
}

/// One test for the POCKETCOM_CONFIG-driven paths: env vars are process-global
/// and edition-2024 makes mutating them unsafe, so the roundtrip + missing
/// cases run here sequentially under explicit unsafe blocks.
#[test]
fn config_roundtrip_atomic_0600_and_missing() {
    let path = temp_config("roundtrip");
    let body = r#"{"version":1,"language":"zh-CN"}"#;
    write_config_file(&path, body).expect("write");

    // Permissions: 0600 (the file may hold the MCP token, SPEC §5.3).
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "config file must be 0600, got {mode:o}");

    // No tmp leftovers in the target dir.
    let dir = path.parent().unwrap();
    let stray: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with('.'))
        .collect();
    assert!(stray.is_empty(), "tmp files must be renamed away: {stray:?}");

    // cfg_read (via the env override) returns the same bytes…
    // SAFETY: single-threaded with respect to POCKETCOM_CONFIG (all env
    // access for this variable lives in this one test).
    unsafe { std::env::set_var("POCKETCOM_CONFIG", &path) };
    assert_eq!(cfg_read().as_deref(), Some(body));

    // …and a missing file reads as None (guest falls back to defaults).
    let missing = temp_config("missing");
    unsafe { std::env::set_var("POCKETCOM_CONFIG", &missing) };
    assert_eq!(cfg_read(), None);
    unsafe { std::env::remove_var("POCKETCOM_CONFIG") };

    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn export_payload_strips_the_mcp_token() {
    let full = r#"{
        "version": 1,
        "language": "en",
        "mcp": {"enabled": true, "port": 7960, "token": "secret-token"},
        "lastConn": {}
    }"#;
    let exported = export_payload(full).unwrap();
    assert!(!exported.contains("secret-token"), "token must not survive export");
    let v: serde_json::Value = serde_json::from_str(&exported).unwrap();
    assert_eq!(v["mcp"]["port"], 7960, "non-sensitive mcp fields stay");
    assert_eq!(v["language"], "en");
}

#[test]
fn export_payload_rejects_malformed_json() {
    assert!(export_payload("{nope").is_err());
}
