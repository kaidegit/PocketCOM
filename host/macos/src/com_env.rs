//! POCKETCOM — the `com` surface environment bridge (M2, SPEC §3.7/§3.8):
//! settings persistence (config.json) + system-appearance events.
//!
//! Ops (mounted into the same `globalThis.com` namespace as serial/net):
//! - `com.cfgRead()`            → file content string, or null when absent.
//! - `com.cfgWrite(json)`       → bool (atomic tmp+rename, permissions 0600).
//! - `com.cfgExport(json)`      → native save panel, then write. The MCP
//!   token is STRIPPED from exported payloads (SPEC §5.3: no credential
//!   duplication outside the 0600-protected config file).
//! - `com.cfgImport()`          → native open panel, then file content.
//!   Export/import results: `{"ok":true,...}` / `{"ok":false,"canceled":true}`
//!   / `{"error":{code,msg}}`.
//!
//! The appearance watcher is a native thread polling the global
//! `AppleInterfaceStyle` preference every 2 s through CoreFoundation FFI
//! (thread-safe, no AppKit/AppThread involvement). It pushes
//! `{t:"appearance",v:"light"|"dark"}` into the shared com event queue on
//! every change — the guest applies it when "follow system" is selected.
//!
//! Config location (SPEC §3.8): `~/Library/Application Support/PocketCOM/
//! config.json`. `POCKETCOM_CONFIG` overrides the path (tests + portable runs).

use std::path::PathBuf;
use std::sync::mpsc;

use serde_json::json;

use crate::com::trace_enabled;

/// Poll cadence for the appearance watcher.
const APPEARANCE_POLL: std::time::Duration = std::time::Duration::from_secs(2);

// ---------------------------------------------------------------------------
// config path + file IO
// ---------------------------------------------------------------------------

pub(crate) fn config_path() -> PathBuf {
    if let Some(p) = std::env::var_os("POCKETCOM_CONFIG") {
        return PathBuf::from(p);
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"));
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/PocketCOM/config.json")
    } else {
        home.join(".config/PocketCOM/config.json")
    }
}

/// Read the config file. `None` = absent or unreadable (the guest treats it
/// as "start from defaults"; a corrupt file is the guest's normalize step's
/// problem, not a host failure).
pub(crate) fn cfg_read() -> Option<String> {
    let path = config_path();
    match std::fs::read(&path) {
        Ok(bytes) => {
            if trace_enabled() {
                eprintln!("pocketcom-trace: com.cfgRead {} -> {} B", path.display(), bytes.len());
            }
            Some(String::from_utf8_lossy(&bytes).into_owned())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if trace_enabled() {
                eprintln!("pocketcom-trace: com.cfgRead {} -> absent", path.display());
            }
            None
        }
        Err(e) => {
            eprintln!("pocketcom-host: reading {}: {e}", path.display());
            None
        }
    }
}

/// Atomic write (tmp + rename) with 0600 permissions — the config may hold
/// the MCP token (SPEC §3.8/§5.3).
pub(crate) fn cfg_write(json: &str) -> bool {
    match write_config_file(&config_path(), json) {
        Ok(()) => {
            if trace_enabled() {
                eprintln!("pocketcom-trace: com.cfgWrite -> {} B", json.len());
            }
            true
        }
        Err(e) => {
            eprintln!("pocketcom-host: writing config: {e}");
            false
        }
    }
}

pub(crate) fn write_config_file(path: &PathBuf, json: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let dir = path
        .parent()
        .ok_or_else(|| format!("config path has no parent: {}", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("config.json"),
        std::process::id()
    ));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("creating {}: {e}", tmp.display()))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("writing {}: {e}", tmp.display()))?;
        f.sync_all()
            .map_err(|e| format!("flushing {}: {e}", tmp.display()))?;
    }
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod 0600 {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("renaming into {}: {e}", path.display()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// export / import (native panels via osascript)
// ---------------------------------------------------------------------------

/// Export: save panel → write (token stripped). Runs a modal panel from the
/// guest's op turn (the guest realm lives on the main thread, where modal
/// panels are legal); the frame loop pauses for the duration of the dialog.
pub(crate) fn cfg_export(json: &str) -> String {
    let payload = match export_payload(json) {
        Ok(p) => p,
        Err(e) => return json!({"error": {"code": "invalid-param", "msg": e}}).to_string(),
    };
    let Some(path) = osascript(&[
        r#"choose file name with prompt "Export PocketCOM config" default name "pocketcom-config.json""#,
        "POSIX path of result",
    ]) else {
        return json!({"ok": false, "canceled": true}).to_string();
    };
    match write_config_file(&PathBuf::from(&path), &payload) {
        Ok(()) => json!({"ok": true, "path": path}).to_string(),
        Err(e) => json!({"error": {"code": "io-error", "msg": e}}).to_string(),
    }
}

/// Import: open panel → file text (the guest normalizes + applies it).
pub(crate) fn cfg_import() -> String {
    let Some(path) = osascript(&[
        r#"POSIX path of (choose file of type {"public.json"} with prompt "Import PocketCOM config")"#,
    ]) else {
        return json!({"ok": false, "canceled": true}).to_string();
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => json!({"ok": true, "json": text}).to_string(),
        Err(e) => json!({"error": {"code": "io-error", "msg": format!("reading {path}: {e}")}}).to_string(),
    }
}

/// Strip credential material before export (SPEC §5.3). Pure function so the
/// tests can cover it without a dialog.
pub(crate) fn export_payload(json: &str) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("malformed config json: {e}"))?;
    if let Some(mcp) = value.get_mut("mcp").and_then(|m| m.as_object_mut()) {
        mcp.remove("token");
    }
    Ok(value.to_string())
}

/// Run osascript with the given program lines → trimmed stdout, or None on
/// any failure (user cancel is just "no path").
fn osascript(lines: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("osascript");
    for line in lines {
        cmd.arg("-e").arg(line);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        if trace_enabled() {
            eprintln!(
                "pocketcom-trace: osascript failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

// ---------------------------------------------------------------------------
// system appearance (follow-system theme, SPEC §3.7)
// ---------------------------------------------------------------------------

/// Spawn the appearance watcher. It emits `{t:"appearance",v}` on every
/// change (including the first observation, which seeds the guest's state).
pub(crate) fn start_appearance_watcher(event_tx: mpsc::Sender<String>) {
    std::thread::Builder::new()
        .name("pocketcom-appearance".into())
        .spawn(move || {
            let mut last: Option<&'static str> = None;
            loop {
                if let Some(v) = system_appearance() {
                    if Some(v) != last {
                        last = Some(v);
                        let _ = event_tx.send(json!({"t": "appearance", "v": v}).to_string());
                    }
                }
                std::thread::sleep(APPEARANCE_POLL);
            }
        })
        .expect("spawning appearance watcher thread");
}

#[cfg(target_os = "macos")]
mod appearance {
    use std::os::raw::{c_char, c_void};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFPreferencesAnyApplication: CFStringRef;
        fn CFPreferencesCopyAppValue(key: CFStringRef, applicationID: CFStringRef) -> CFTypeRef;
        fn CFStringCreateWithCString(
            alloc: *const c_void,
            cStr: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFStringGetCString(
            theString: CFStringRef,
            buffer: *mut c_char,
            bufferSize: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(cf: CFTypeRef);
    }

    fn cf_string(s: &str) -> CFStringRef {
        let c = std::ffi::CString::new(s).expect("no interior NUL in constant key");
        unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8) }
    }

    /// Global `AppleInterfaceStyle` preference: `"Dark"` in dark mode, absent
    /// in light mode (the documented key NSUserDefaults exposes it under).
    /// Reads through cfprefsd, so changes are picked up live.
    pub fn system_appearance() -> Option<&'static str> {
        unsafe {
            let key = cf_string("AppleInterfaceStyle");
            let value = CFPreferencesCopyAppValue(key, kCFPreferencesAnyApplication);
            CFRelease(key);
            if value.is_null() {
                return Some("light");
            }
            let mut buf = [0u8; 64];
            let ok = CFStringGetCString(
                value as CFStringRef,
                buf.as_mut_ptr() as *mut c_char,
                buf.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
            );
            CFRelease(value);
            if ok == 0 {
                return None;
            }
            let s = std::ffi::CStr::from_ptr(buf.as_ptr() as *const c_char)
                .to_string_lossy()
                .trim()
                .to_string();
            Some(if s.eq_ignore_ascii_case("dark") { "dark" } else { "light" })
        }
    }
}

#[cfg(target_os = "macos")]
fn system_appearance() -> Option<&'static str> {
    appearance::system_appearance()
}

#[cfg(not(target_os = "macos"))]
fn system_appearance() -> Option<&'static str> {
    None
}

// ---------------------------------------------------------------------------
// tests — sources live mirrored under test/host/macos/ (repo convention),
// compiled into this bin's cfg(test) via #[path].
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "../../../test/host/macos/env_tests.rs"]
mod tests;
