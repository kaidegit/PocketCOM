// Off-device memory probe runner — builds and runs host/rtthread/probe/probe.c
// against the built AIC package, so live/peak memory answers need no board.
// Usage: bun host/rtthread/probe.ts [probe args, default package
// dist/aic/pocketcom-aic.pocket] — e.g. --heap 7340032 to emulate the board's
// unified heap, --turns 600 for a longer soak. --tap X,Y@TURN injects a
// touch, --sample TURN observes memory, --collect TURN explicitly runs GC
// for off-device live-set experiments (not board idle-GC timing).
//
// Prerequisites: the AIC package + contract header (npm run package:aic), cc,
// cargo. Objects cache in .pocket/aic/probe-host/ by mtime; repeat runs only
// relink. This is a measurement aid, not an acceptance gate: 64-bit pointers
// and a malloc heap skew the numbers against the rv32/TLSF board (see the
// header comment in probe/probe.c).
import { statSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { run } from "./build-support";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const VENDOR = `${ROOT}/vendor/pocketjs`;
const HOST = `${VENDOR}/hosts/aic`;
const COMPONENTS = `${VENDOR}/hosts/esp-idf/components`;
const QJS = `${HOST}/third_party/quickjs-ng`;
const GENERATED = `${HOST}/generated`;
const PROBE = `${ROOT}/host/rtthread/probe`;
const BUILD = `${ROOT}/.pocket/aic/probe-host`;
const DEFAULT_PACKAGE = `${ROOT}/dist/aic/pocketcom-aic.pocket`;

const INCLUDES = [
  `${COMPONENTS}/pocketjs_package/include`,
  `${COMPONENTS}/pocketjs_guest/include`,
  `${COMPONENTS}/pocketjs_ui_core/include`,
  `${COMPONENTS}/pocketjs_ui_qjs/include`,
  `${COMPONENTS}/pocketjs_render_rgb565/include`,
  `${HOST}/port`,
  `${HOST}/port/esp_compat`,
  QJS,
  `${PROBE}/rtstub`,
  GENERATED,
].map((dir) => `-I${dir}`);

function requireFile(path: string, hint: string) {
  try {
    statSync(path);
  } catch {
    throw new Error(`${path} is missing; ${hint}`);
  }
}

async function compile(source: string, object: string, extra: string[] = []) {
  const sourceTime = statSync(source).mtimeMs;
  try {
    if (statSync(object).mtimeMs >= sourceTime) return;
  } catch {
    // fall through and compile
  }
  await run(["cc", "-O2", "-c", source, "-o", object, ...INCLUDES, ...extra],
    ROOT);
}

async function main() {
  requireFile(`${ROOT}/package.json`, "run from the repository root");
  requireFile(`${GENERATED}/pocketjs_aic_contract.h`,
    'run "npm run package:aic" first');
  const prepared = `${HOST}/build/quickjs.c`;
  try {
    statSync(prepared);
  } catch {
    await run(["python3", `${HOST}/port/prepare_quickjs.py`,
      `${QJS}/quickjs.c`, prepared], ROOT);
  }

  const nativeLib =
    `${PROBE}/native/target/release/libpocketcom_aic_probe_native.a`;
  await run(["cargo", "build", "--release",
    "--manifest-path", `${PROBE}/native/Cargo.toml`], ROOT);

  mkdirSync(BUILD, { recursive: true });
  const quickjsGroup = [
    { source: prepared, flags: ["-D__wasi__", "-DQUICKJS_NG_BUILD", `-include`, `${HOST}/third_party/port/shim.h`] },
    { source: `${QJS}/dtoa.c`, flags: ["-D__wasi__", "-DQUICKJS_NG_BUILD", `-include`, `${HOST}/third_party/port/shim.h`] },
    { source: `${QJS}/libregexp.c`, flags: ["-D__wasi__", "-DQUICKJS_NG_BUILD", `-include`, `${HOST}/third_party/port/shim.h`] },
    { source: `${QJS}/libunicode.c`, flags: ["-D__wasi__", "-DQUICKJS_NG_BUILD", `-include`, `${HOST}/third_party/port/shim.h`] },
    { source: `${QJS}/quickjs-libc.c`, flags: ["-D__wasi__", "-DQUICKJS_NG_BUILD", `-include`, `${HOST}/third_party/port/shim.h`] },
    { source: `${HOST}/third_party/port/stub.c`, flags: ["-D__wasi__", "-DQUICKJS_NG_BUILD", `-include`, `${HOST}/third_party/port/shim.h`] },
  ];
  const componentGroup = [
    `${PROBE}/probe.c`,
    `${COMPONENTS}/pocketjs_package/src/package.c`,
    `${COMPONENTS}/pocketjs_guest/src/guest.c`,
    `${COMPONENTS}/pocketjs_ui_core/src/ui_core.c`,
    `${COMPONENTS}/pocketjs_ui_qjs/src/ui_qjs.c`,
    `${COMPONENTS}/pocketjs_render_rgb565/src/render_rgb565.c`,
  ];
  const objects: string[] = [];
  for (const entry of quickjsGroup) {
    const object = `${BUILD}/${entry.source.split("/").pop()!.replace(/\.c$/, "")}.o`;
    await compile(entry.source, object, entry.flags);
    objects.push(object);
  }
  for (const source of componentGroup) {
    const object = `${BUILD}/${source.split("/").pop()!.replace(/\.c$/, "")}.o`;
    await compile(source, object, ["-DCONFIG_POCKETJS_GUEST_ALLOC_STATS"]);
    objects.push(object);
  }

  const binary = `${BUILD}/probe`;
  await run(["cc", "-O2", "-o", binary, ...objects, nativeLib, "-lm"], ROOT);

  // The default package rides first; a user-supplied positional after it
  // overrides (the probe takes the last positional as the package path).
  await run([binary, DEFAULT_PACKAGE, ...process.argv.slice(2)], ROOT);
}

await main();
