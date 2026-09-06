// app/textsel.ts — 文本选区纯几何 helper（无框架依赖，可 headless 单测）。
// mono 字形槽按前缀度量映射 px ↔ 列号：绘制（高亮/光标 x）与命中（点击列）
// 用同一度量函数，保证两者一致。长文本按二分求列（每次 O(log n) 次度量）。

/** 第 col 列的 x（px）：前缀宽度。col 钳位到 [0, text.length]。 */
export function monoXAt(text: string, col: number, measure: (s: string) => number): number {
  const c = Math.max(0, Math.min(col, text.length));
  return c === 0 ? 0 : measure(text.slice(0, c));
}

/** 点击 x（px，相对行首）→ 列号：前缀度量 ≤ x 的最大列（行尾外钳到末列）。 */
export function monoColAt(text: string, x: number, measure: (s: string) => number): number {
  if (text === "" || x <= 0) return 0;
  if (measure(text) <= x) return text.length;
  let lo = 0;
  let hi = text.length; // 不变式：measure(prefix(lo)) ≤ x < measure(prefix(hi))
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (measure(text.slice(0, mid)) <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}
