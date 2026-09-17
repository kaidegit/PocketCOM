// Pure-core performance review probe. Run with Bun, or bundle as an IIFE for
// perf-quickjs.c. No network, hardware, application config, or UI side effects.
import { MessageBus } from "../core/bus";
import { LogView } from "../core/logview";
import { Terminal } from "../core/term";
import { FrameCoalescer } from "../core/framing";
import { strToBytes } from "../core/codec";
import { decodeBase64 } from "../core/base64";
import type { LogFormatOptions } from "../core/format";
import type { Message } from "../core/message";

const labels = { rx: "", txManual: "", txMcp: "[MCP]", sys: "[SYS]" };
const format: LogFormatOptions = { hex: false, escape: false, timestamp: false, color: false };
let sink = 0;

function emit(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

function bench(name: string, fn: () => void, samples = 20, warmup = 2): void {
  for (let i = 0; i < warmup; i++) fn();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const round = (n: number): number => Math.round(n * 1000) / 1000;
  emit({
    type: "timing", name, samples, warmup,
    p50Ms: round(sorted[Math.ceil(samples * 0.5) - 1]!),
    p95Ms: round(sorted[Math.ceil(samples * 0.95) - 1]!),
    maxMs: round(sorted[samples - 1]!),
    samplesMs: times.map(round),
  });
}

function append(bus: MessageBus, payload: Uint8Array): void {
  bus.append({ dir: "rx", source: "system", connId: "perf", payload });
}

function payload(size: number, ansi = false): Uint8Array {
  const pattern = ansi ? "\x1b[31m0123456789abcdef\x1b[0m" : "0123456789abcdef";
  return strToBytes(pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size));
}

function logFixture(entries: number, size: number, opts: { wrap?: boolean; hex?: boolean; color?: boolean } = {}) {
  // Keep production's 1000-frame / 256-KiB bus bounds. Seed in small batches
  // and sync between batches so LogView sees all messages before eviction.
  const bus = new MessageBus({ now: () => 0 });
  const view = new LogView({ ...format, hex: opts.hex ?? false, color: opts.color ?? false }, labels, {
    maxRows: 500,
    showTx: false,
    measure: () => 8, // Isolate core work; no native text layout in this probe.
    wrapWidth: () => opts.wrap === false ? 0 : 640,
  });
  const bytes = payload(size, opts.color);
  const batchSize = Math.min(1000, Math.floor(256 * 1024 / size));
  for (let i = 0; i < entries; i++) {
    append(bus, bytes.slice());
    if ((i + 1) % batchSize === 0) view.sync(bus);
  }
  view.sync(bus);
  return { bus, view, bytes };
}

emit({
  type: "environment",
  runtime: typeof (globalThis as any).Bun !== "undefined" ? `Bun ${(globalThis as any).Bun.version}` : "QuickJS (linked host archive)",
  timestamp: new Date().toISOString(),
  note: "Core only. Constant 8px measurement, 640px wrap width; not native UI frame timing.",
});

// Demonstrate the production app's `added > 0` invalidation failure at 500 rows.
{
  const { bus, view } = logFixture(500, 8, { wrap: false });
  const before = view.rows[view.rows.length - 1]!;
  append(bus, strToBytes("LATEST"));
  const result = view.sync(bus);
  const after = view.rows[view.rows.length - 1]!;
  if (after.text !== "LATEST") throw new Error("probe did not deliver latest row");
  emit({ type: "observation", name: "saturated-log-invalidation", rows: view.rows.length,
    ...result, beforeMsgId: before.msgId, afterMsgId: after.msgId,
    contentsChanged: before.text !== after.text, appWouldBumpLogVersion: result.added > 0 });
}

for (const count of [20, 100, 500]) {
  const { view } = logFixture(count, 256);
  bench(`log.refresh.${count}x256.wrap`, () => { view.refresh(); sink += view.rows.length; });
}

for (const [name, opts] of [
  ["plain", { wrap: false }],
  ["hex-wrap", { hex: true }],
  ["ansi-wrap", { color: true }],
] as const) {
  const { view } = logFixture(500, 256, opts);
  bench(`log.refresh.500x256.${name}`, () => { view.refresh(); sink += view.rows.length; });
}

{
  const { view, bus, bytes } = logFixture(500, 256);
  bench("log.sync.500x256.wrap.new-frame", () => {
    append(bus, bytes.slice());
    sink += view.sync(bus).added;
  });
  bench("log.sync.idle", () => { sink += view.sync(bus).added; });
  bench("log.apply-format.500x256.two-rebuilds", () => {
    view.remeasure();
    view.setShowTx(false);
    view.setFormat(format, labels);
    sink += view.rows.length;
  });
}

for (const [count, size] of [[500, 4096], [12, 48 * 1024]] as const) {
  const { view, bus } = logFixture(count, size);
  // Audit-only introspection: measure retained payloads without changing them.
  const entries = (view as unknown as { entries: Message[] }).entries;
  emit({ type: "observation", name: `retention.${count}x${size}`,
    retainedEntries: entries.length,
    retainedPayloadBytes: entries.reduce((sum, msg) => sum + msg.payload.byteLength, 0),
    busPayloadBytes: bus.buffer.bytes, visibleRows: view.rows.length });
  bench(`log.refresh.${count}x${size}.wrap`, () => { view.refresh(); sink += view.rows.length; });
}

// Core terminal work is incurred in transfer mode too (app/session.ts subscriber).
for (const cols of [80, 240]) {
  const term = new Terminal({ cols, rows: 24, scrollback: 9999 });
  const bytes = payload(16 * 1024);
  bench(`terminal.feed.16KiB.cols${cols}`, () => { term.feed(bytes); sink += term.version; });
}

// Fill to the configured limit before timing to expose saturated history eviction.
for (const limit of [0, 9999, 100000]) {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: limit });
  term.feed(strToBytes("\n".repeat(limit + 24)));
  const bytes = strToBytes("\n".repeat(64));
  bench(`terminal.scroll.64-lines.history${limit}`, () => { term.feed(bytes); sink += term.version; });
}

{
  const bytes = payload(4096);
  bench("framing.1MiB.256x4KiB", () => {
    const framer = new FrameCoalescer({ mode: "network", onFrame: frame => { sink += frame.length; } });
    for (let i = 0; i < 256; i++) framer.feed(bytes, 0);
    framer.flush();
  });
  const encoded = "QUFB".repeat(1365) + "QQ=="; // Exactly 4096 ASCII 'A' bytes.
  bench("base64.decode.1MiB.256x4KiB", () => {
    for (let i = 0; i < 256; i++) sink += decodeBase64(encoded).length;
  });
}

emit({ type: "complete", sink });
