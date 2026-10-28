import { expect, test } from "bun:test";
import { createTsPerf, installTsPerf } from "../../app/perf";

test("TS diagnostics attribute nested time and reuse/reset rows outside active spans", () => {
  let now = 0;
  const logs: string[] = [];
  const perf = createTsPerf(() => now, line => logs.push(line));
  const frame = perf.begin("frame");
  now = 10;
  const parent = perf.begin("create.panel");
  now = 20;
  const child = perf.begin("ui.setProp");
  now = 50; perf.end(child);
  perf.flush("active", true);
  expect(logs).toEqual([]);
  now = 80; perf.end(parent);
  now = 100; perf.end(frame);
  perf.flush("one");
  expect(logs).toContain("[PJS-TS] create.panel n=1 sum=70 self=40 max=70");
  expect(logs).toContain("[PJS-TS] ui.setProp n=1 sum=30 self=30 max=30");
  expect(logs).toContain("[PJS-TS] frame n=1 sum=100 self=30 max=100");
  logs.length = 0;
  const idle = perf.begin("frame"); now = 110; perf.end(idle); perf.flush("idle");
  expect(logs).toEqual([]);
  const long = perf.begin("frame"); now += 60000; perf.end(long); perf.flush("long");
  expect(logs).toContain("[PJS-TS] frame n=1 sum=60000 self=60000 max=60000");
  expect(logs.some(line => line.includes("create.panel"))).toBe(false);
});

test("TS diagnostics leave ordinary hosts untouched without a diagnostic clock", () => {
  const globals = globalThis as { __pocketjsPerfNowUs?: unknown; ui?: unknown; frame?: unknown };
  const before = { clock: globals.__pocketjsPerfNowUs, ui: globals.ui, frame: globals.frame };
  try {
    delete globals.__pocketjsPerfNowUs;
    const ui = { method() { return this; } };
    const frame = () => {};
    globals.ui = ui; globals.frame = frame;
    expect(installTsPerf()).toBeUndefined();
    expect(globals.ui).toBe(ui);
    expect(globals.frame).toBe(frame);
  } finally {
    for (const [key, value] of [["__pocketjsPerfNowUs", before.clock], ["ui", before.ui], ["frame", before.frame]] as const) {
      if (value === undefined) delete (globals as Record<string, unknown>)[key];
      else (globals as Record<string, unknown>)[key] = value;
    }
  }
});
