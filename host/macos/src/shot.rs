//! POCKETCOM — `--screenshot PATH@TICK` (AGENTS.md 脚本化 UI 验证).
//!
//! Captures the app canvas at a scheduled tick by reading back the retained
//! wgpu render target (gpu::Target::read_rgba) and encoding it as PNG. This
//! replaces the earlier `screencapture -l` window capture: the window server
//! stops recompositing an occluded window (occlusionState loses Visible), so
//! window captures froze on the boot frame in headless/agent runs. The render
//! target IS the window canvas byte-for-byte (presentation blits 1:1), and a
//! readback needs no Screen Recording authorization, no AppKit and no
//! main-thread window lookup — so scripted/agent runs and CI stay prompt-free.
//! Captures carry canvas pixels only (no title bar): 画布坐标 = 截图像素/density.
//!
//! Not exercised in CI (no GPU there); only the pure helpers carry unit tests.

use std::path::Path;

use anyhow::{Context, Result};

/// Encode `rgba` (8-bit RGBA, tightly packed) as PNG at `path`, creating
/// parent directories as needed. Returns the pixel size for the receipt line.
pub fn capture_rgba_to_path(path: &Path, w: u32, h: u32, rgba: &[u8]) -> Result<(u32, u32)> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating directory {}", parent.display()))?;
    }
    let data = encode_png(w, h, rgba);
    std::fs::write(path, &data).with_context(|| format!("writing {}", path.display()))?;
    png_dims(&data).ok_or_else(|| anyhow::anyhow!("wrote invalid PNG to {}", path.display()))
}

/// Encode a tightly-packed RGBA8 buffer as a PNG (8-bit, non-interlaced).
fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + rgba.len() / 8);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    // 8-bit depth, RGBA color type, deflate, adaptive filtering, no interlace.
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    push_chunk(&mut out, b"IHDR", &ihdr);
    // Scanlines: one filter byte (None) per row ahead of its RGBA pixels.
    let stride = w as usize * 4;
    let mut raw = Vec::with_capacity((stride + 1) * h as usize);
    for row in 0..h as usize {
        raw.push(0u8);
        let start = row * stride;
        raw.extend_from_slice(&rgba[start..start + stride]);
    }
    push_chunk(&mut out, b"IDAT", &zlib_store(&raw));
    push_chunk(&mut out, b"IEND", &[]);
    out
}

/// One PNG chunk: length + type + data + CRC-32 over type and data.
fn push_chunk(out: &mut Vec<u8>, typ: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut crc = 0xFFFF_FFFFu32;
    for byte in typ.iter().chain(data.iter()) {
        out.push(*byte);
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    out.extend_from_slice(&(!crc).to_be_bytes());
}

/// zlib wrapper (0x78 0x01) around stored deflate blocks — uncompressed but
/// valid IDAT; screenshots are e2e artifacts, size is irrelevant.
fn zlib_store(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + raw.len() / 65535 * 5 + 6);
    out.extend_from_slice(&[0x78, 0x01]);
    for chunk in raw.chunks(65535) {
        let last = chunk.len() < 65535;
        out.push(u8::from(last));
        out.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
        out.extend_from_slice(&(!(chunk.len() as u16)).to_le_bytes());
        out.extend_from_slice(chunk);
    }
    // Adler-32 of the uncompressed data.
    let (mut a, mut b) = (1u32, 0u32);
    for byte in raw {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    out.extend_from_slice(&((b << 16) | a).to_be_bytes());
    out
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

#[cfg(test)]
#[path = "../../../test/host/macos/shot_tests.rs"]
mod tests;
