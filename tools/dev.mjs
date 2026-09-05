#!/usr/bin/env node
// dev.mjs — run the built PocketCOM bundle on the PocketCOM gpui desktop host.
// Flags derive from .pocket/macos-app/plan.json (same logic as upstream
// tools/macos.ts): viewport, density, fixed, native-text, companions.
//
// Host binary: our fork (host/macos, binary pocketcom-host — the stock host
// plus the com.* serial bridge, SPEC §4.2) wins; fall back to the vendored
// stock pocket-desktop-host with a warning when the fork is not built yet.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const plan = JSON.parse(readFileSync(resolve(root, ".pocket/macos-app/plan.json"), "utf8"));
const fork = resolve(root, "host/macos/target/release/pocketcom-host");
const stock = resolve(root, "vendor/pocketjs/hosts/desktop/target/release/pocket-desktop-host");
const bin = existsSync(fork) ? fork : stock;
if (bin === stock) {
  console.warn(
    `[dev] host/macos/target/release/pocketcom-host not built — falling back to the stock\n` +
      `[dev] pocket-desktop-host: com.* serial bridge UNAVAILABLE (the app shows 桥接不可用).`,
  );
}

const flags = [
  "--app", plan.app.output,
  "--title", plan.app.title,
  "--viewport", `${plan.viewport.logical[0]}x${plan.viewport.logical[1]}`,
  "--density", String(plan.viewport.rasterDensity),
  ...(plan.viewport.policy === "fixed" ? ["--fixed"] : []),
  ...(plan.features["text.layout.native"] ? ["--native-text"] : []),
  ...(plan.companions?.length ? ["--companions", plan.companions.join(",")] : []),
  // editor dialect (svc: keyboard/IME/pointer/scroll) once a companion is declared
  ...(plan.companions?.length ? ["--editor"] : []),
];

// `--` ends dev.mjs's own args; the rest are forwarded verbatim to the host
// binary (scripted UI verification flags, e.g.
// `node tools/dev.mjs -- --screenshot out.png@120 --quit-after 130`).
const sep = process.argv.indexOf("--");
const extra = sep === -1 ? [] : process.argv.slice(sep + 1);

const child = spawn(bin, [...flags, ...extra], {
  stdio: "inherit",
  env: { ...process.env, POCKETJS_DIST: resolve(root, "dist"), RUST_LOG: process.env.RUST_LOG ?? "info" },
});
child.on("exit", (code) => process.exit(code ?? 0));
