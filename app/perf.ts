// Temporary board diagnostics. Only main.aic enables this, and only when the
// diagnostic host supplies a monotonic clock. Remove with the profiling round.
type Span = { label: string; started: number; children: number; parent?: Span };
type Row = { calls: number; total: number; self: number; max: number };
type Perf = ReturnType<typeof createTsPerf>;
let current: Perf | undefined;

export function createTsPerf(now: () => number, log: (line: string) => void) {
  const rows = new Map<string, Row>();
  let active: Span | undefined;
  let created = false;
  function begin(label: string): Span {
    const span = { label, started: now(), children: 0, parent: active };
    active = span;
    if (label.startsWith("create.")) created = true;
    return span;
  }
  function end(span: Span | undefined): void {
    if (!span) return;
    const elapsed = now() - span.started;
    active = span.parent;
    if (active) active.children += elapsed;
    let row = rows.get(span.label);
    if (!row) { row = { calls: 0, total: 0, self: 0, max: 0 }; rows.set(span.label, row); }
    row.calls++;
    row.total += elapsed;
    row.self += Math.max(0, elapsed - span.children);
    row.max = Math.max(row.max, elapsed);
  }
  function flush(label: string, force = false): void {
    // Print after timing has stopped. Console time must not be charged to a
    // parent component. Keep rows reusable rather than allocate them each tick.
    if (active) return;
    let slow = false;
    for (const row of rows.values()) if (row.max >= 50000) { slow = true; break; }
    if (force || created || slow) {
      log(`[PJS-TS] batch=${label} unit=us (nested totals)`);
      for (const [name, row] of rows) if (row.calls) {
        log(`[PJS-TS] ${name} n=${row.calls} sum=${Math.round(row.total)} self=${Math.round(row.self)} max=${Math.round(row.max)}`);
      }
    }
    for (const row of rows.values()) row.calls = row.total = row.self = row.max = 0;
    created = false;
  }
  return { begin, end, flush };
}
export function perfBegin(label: string): Span | undefined { return current?.begin(label); }
export function perfEnd(span: Span | undefined): void { current?.end(span); }

export function installTsPerf(): (() => void) | undefined {
  const g = globalThis as typeof globalThis & {
    __pocketjsPerfNowUs?: () => number;
    __pocketTsPerf?: { begin: (name: string) => unknown; end: (span: unknown) => void };
    ui?: { setPropBatch?: unknown };
    frame?: (...args: unknown[]) => unknown;
  };
  if (!g.__pocketjsPerfNowUs) return;
  console.log(`[PJS-TS] mode=coarse inline=scalar batch_api=${typeof g.ui?.setPropBatch === "function" ? 1 : 0}`);
  const perf = current = createTsPerf(g.__pocketjsPerfNowUs, line => console.log(line));
  g.__pocketTsPerf = { begin: perf.begin, end: span => perf.end(span as Span | undefined) };
  // Coarse mode deliberately leaves ui.* untouched. Per-property/HostOp
  // spans changed the work being measured and obscured net batching gains.
  return () => {
    perf.flush("mount", true);
    const frame = g.frame;
    if (!frame) return;
    let turn = 0;
    g.frame = function (this: unknown, ...args: unknown[]) {
      // Guest jobs can run after the preceding frame returns. Do not silently
      // attach those samples to this frame's inclusive time.
      perf.flush(`jobs-before-${turn + 1}`);
      const span = perf.begin("frame");
      try { return Reflect.apply(frame, this, args); }
      finally { perf.end(span); perf.flush(`frame-${++turn}`); }
    };
  };
}
