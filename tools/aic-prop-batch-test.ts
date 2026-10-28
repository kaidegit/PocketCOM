import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Run after package:aic; uses the actual portable QuickJS/native-core libraries.
{
  const root = resolve(import.meta.dir, "..");
  const cache = join(root, ".pocket/aic/probe-host");
  const run = (args: string[]) => {
    const r = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
    assert.equal(r.exitCode, 0, r.stdout.toString() + r.stderr.toString());
    return r.stdout.toString();
  };
  // Same portable libraries as the actual AIC package; never skip this test.
  run(["bun", "host/rtthread/probe.ts", "--turns", "1"]);
  const dir = mkdtempSync(join(tmpdir(), "pocketcom-prop-batch-"));
  try {
    const flags: string[] = JSON.parse(readFileSync(join(cache, "probe.o.flags"), "utf8"));
    const object = join(dir, "test.o"), binary = join(dir, "test");
    run(["cc", "-O2", "-c", "test/host/rtthread/prop_batch.c", "-o", object, ...flags,
      "-Ivendor/pocketjs/hosts/esp-idf/components/pocketjs_ui_qjs/src"]);
    const objects = ["quickjs", "dtoa", "libregexp", "libunicode", "quickjs-libc", "stub", "heap", "tlsf", "package", "guest", "ui_core", "render_rgb565"].map(n => join(cache, n + ".o"));
    run(["cc", "-O2", "-o", binary, object, ...objects, "host/rtthread/probe/native/target/release/libpocketcom_aic_probe_native.a", "-lm"]);
    assert.match(run([binary]), /QuickJS property batch regressions passed/);
    console.log("QuickJS property batch regressions passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
