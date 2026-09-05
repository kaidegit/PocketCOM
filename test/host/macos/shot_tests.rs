//! `shot.rs` tests — the pure PNG helpers only. Real window capture needs
//! AppKit + an on-screen window, which CI has neither; the capture path is
//! verified on the dev machine (AGENTS.md 脚本化 UI 验证).
//!
//! Mirrored under test/host/macos/ per repo convention; compiled into the
//! `pocketcom-host` bin via `#[path]` from host/macos/src/shot.rs, so
//! `use super::*` reaches shot.rs's private items.

use super::*;

#[test]
fn png_dims_reads_ihdr_width_and_height() {
    let mut data = Vec::new();
    data.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    data.extend_from_slice(&13u32.to_be_bytes()); // IHDR data length
    data.extend_from_slice(b"IHDR");
    data.extend_from_slice(&1920u32.to_be_bytes());
    data.extend_from_slice(&1280u32.to_be_bytes());
    assert_eq!(png_dims(&data), Some((1920, 1280)));
}

#[test]
fn png_dims_rejects_non_png_and_truncated_data() {
    assert_eq!(png_dims(b""), None);
    assert_eq!(png_dims(b"not a png"), None);
    // Right signature, wrong chunk type.
    let mut data = Vec::new();
    data.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    data.extend_from_slice(b"JUNKJUNKJUNK");
    assert_eq!(png_dims(&data), None);
    // Valid signature but IHDR truncated before the height field.
    let mut data = Vec::new();
    data.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    data.extend_from_slice(&13u32.to_be_bytes());
    data.extend_from_slice(b"IHDR");
    data.extend_from_slice(&1920u32.to_be_bytes());
    assert_eq!(png_dims(&data), None);
}
