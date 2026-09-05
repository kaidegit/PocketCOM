//! POCKETCOM — `--screenshot PATH@TICK` (AGENTS.md 脚本化 UI 验证).
//!
//! Captures the host's own window as PNG at a scheduled tick, via the
//! system `screencapture -l <windowNumber>` (window-server compositing, so
//! the gpui Metal layer is captured exactly as presented). Own-window
//! content is included without Screen Recording permission — macOS strips
//! only *other* apps' windows — so scripted/agent runs and CI stay
//! prompt-free. The pure-AppKit alternatives were evaluated and rejected:
//! `CGWindowListCreateImage` is deprecated and Sequoia's monthly
//! re-approval target; `cacheDisplayInRect:` cannot see layer-backed
//! (Metal) content (blank frames, verified on the dev machine); and
//! `drawViewHierarchyInRect:` is iOS-only (unrecognized selector at
//! runtime).
//!
//! Main thread only — called from `PocketRoot::pump`, which runs on the
//! gpui foreground executor. Not exercised in CI (no window there); only
//! the pure helpers carry unit tests.

use std::path::Path;

use anyhow::{Context, Result};

/// Capture the host's own window (matched by `title`) to `path` as PNG,
/// creating parent directories as needed. Returns the pixel size for the
/// receipt line.
pub fn capture_to_path(path: &Path, title: &str) -> Result<(u32, u32)> {
    let data = capture_png_data(title)?;
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating directory {}", parent.display()))?;
    }
    std::fs::write(path, &data).with_context(|| format!("writing {}", path.display()))?;
    png_dims(&data).ok_or_else(|| anyhow::anyhow!("wrote invalid PNG to {}", path.display()))
}

/// PNG signature + IHDR width/height — enough for the receipt line and the
/// unit tests; full decoding stays with the golden tooling.
pub fn png_dims(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() < 24 || data[0..8] != *b"\x89PNG\r\n\x1a\n" || data[12..16] != *b"IHDR" {
        return None;
    }
    Some((
        u32::from_be_bytes(data[16..20].try_into().ok()?),
        u32::from_be_bytes(data[20..24].try_into().ok()?),
    ))
}

fn capture_png_data(title: &str) -> Result<Vec<u8>> {
    appkit::capture_png_data(title)
}

#[cfg(target_os = "macos")]
mod appkit {
    use anyhow::{anyhow, Context, Result};
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWindow};

    /// `screencapture -x -o -l <windowNumber> <tmp>` — `-x` silences the
    /// shutter sound, `-o` drops the window shadow. The PNG lands in a
    /// per-pid temp file and is read back as bytes.
    pub(super) fn capture_png_data(title: &str) -> Result<Vec<u8>> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| anyhow!("screenshot: not on the main thread"))?;
        let window = find_own_window(mtm, title)
            .ok_or_else(|| anyhow!("no on-screen window titled {title:?}"))?;
        let tmp = std::env::temp_dir().join(format!("pocketcom-shot-{}.png", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        let status = std::process::Command::new("/usr/sbin/screencapture")
            .args(["-x", "-o", "-l"])
            .arg(window.windowNumber().to_string())
            .arg(&tmp)
            .status()
            .context("spawning /usr/sbin/screencapture")?;
        if !status.success() {
            return Err(anyhow!("screencapture exited with {status}"));
        }
        let data = std::fs::read(&tmp).with_context(|| format!("reading {}", tmp.display()))?;
        let _ = std::fs::remove_file(&tmp);
        Ok(data)
    }

    /// The app window whose title matches — the app canvas window, not
    /// companion/editor windows.
    fn find_own_window(mtm: MainThreadMarker, title: &str) -> Option<Retained<NSWindow>> {
        let app = NSApplication::sharedApplication(mtm);
        for window in app.windows().iter() {
            if window.title().to_string() == title {
                return Some(window);
            }
        }
        None
    }
}

#[cfg(not(target_os = "macos"))]
mod appkit {
    use anyhow::{Result, anyhow};

    pub(super) fn capture_png_data(_title: &str) -> Result<Vec<u8>> {
        Err(anyhow!("--screenshot requires macOS (AppKit window capture)"))
    }
}

#[cfg(test)]
#[path = "../../../test/host/macos/shot_tests.rs"]
mod tests;
