// Re-export the fork's native crates so the probe's staticlib link pulls the
// same UI core and renderer code the AIC firmware uses.
#![no_std]

extern crate pocketjs_idf_abi;
extern crate pocketjs_idf_runtime;
extern crate pocketjs_idf_ui_core;
extern crate pocketjs_idf_render_rgb565;
