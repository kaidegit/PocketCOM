import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "../../..");
test("fixed SDK TLSF arena: fragmentation, coalescing, alignment and realloc failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "pocketcom-probe-heap-"));
  try {
    const tlsf = "vendor/luban-lite/bsp/artinchip";
    const binary = join(dir, "heap-test");
    const compile = Bun.spawnSync([
      "cc", "-std=c11", "-O1", "-g", "-fsanitize=address,undefined", "-fno-omit-frame-pointer",
      "-Ihost/rtthread/probe", `-I${tlsf}/include/drv_bare`,
      "-Ivendor/pocketjs/hosts/aic/port/esp_compat",
      "test/host/rtthread/probe_heap.c", "host/rtthread/probe/heap.c",
      `${tlsf}/drv_bare/tlsf_heap/tlsf.c`, "-o", binary,
    ], { cwd: root });
    expect({ status: compile.exitCode, stderr: compile.stderr.toString() }).toEqual({ status: 0, stderr: "" });
    const run = Bun.spawnSync([binary], { cwd: root });
    expect({ status: run.exitCode, stderr: run.stderr.toString() }).toEqual({ status: 0, stderr: "" });
    expect(run.stdout.toString()).toContain("fragmentation rejects 8192 bytes");
    expect(run.stdout.toString()).toContain("coalesce and become allocatable again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
