import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("AIC frame-boundary GC handles pressure, busy frames, stable live sets and clock wrap", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocketcom-gc-"));
  try {
    const binary = join(dir, "gc-policy");
    const compile = Bun.spawnSync(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
      "-fsanitize=address,undefined", "-Ivendor/pocketjs/hosts/aic/port",
      "test/host/rtthread/gc_policy.c", "-o", binary]);
    expect({ code: compile.exitCode, stderr: compile.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    const run = Bun.spawnSync([binary]);
    expect({ code: run.exitCode, stderr: run.stderr.toString() }).toEqual({ code: 0, stderr: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
