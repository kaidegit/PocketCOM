// Kept independent of ui.selection: the editor also runs when selection is cut.
function monoColAt(text: string, x: number, measure: (s: string) => number): number {
  if (x <= 0) return 0;
  let lo = 0, hi = text.length;
  if (measure(text) <= x) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (measure(text.slice(0, mid)) <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

export const KEYBOARD_H = 164;
export const EDITOR_H = 80;
export const EDITOR_TITLE_H = 24;
export const EDITOR_PAD = 8;

export interface EditorRow {
  text: string;
  /** UTF-16 index in the original field, including horizontally hidden text. */
  start: number;
}

/** Two bounded rows around the caret; no second draft or full-size text tree. */
export function editorWindow(text: string, caret: number, width: number, measure: (s: string) => number) {
  const pos = Math.max(0, Math.min(caret, text.length));
  const lineStart = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  const previousStart = lineStart > 1 ? text.lastIndexOf("\n", lineStart - 2) + 1 : 0;
  const firstStart = lineStart > 0 ? previousStart : lineStart;
  const row = lineStart > 0 ? 1 : 0;
  const scrollX = Math.max(0, measure(text.slice(lineStart, pos)) - Math.max(1, width - 2));
  const rows: EditorRow[] = [];
  let start = firstStart;
  for (let i = 0; i < 2; i++) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(start, end);
    let from = monoColAt(line, scrollX, measure);
    if (measure(line.slice(0, from)) < scrollX && from < line.length) from++;
    const remaining = line.slice(from);
    const to = monoColAt(remaining, Math.max(1, width), measure);
    rows.push({ start: start + from, text: remaining.slice(0, to) });
    if (newline < 0) break;
    start = newline + 1;
  }
  const current = rows[row]!;
  return { rows, caretRow: row, caretX: measure(text.slice(current.start, pos)) };
}

export function editorCaretAt(rows: readonly EditorRow[], row: number, x: number, measure: (s: string) => number): number {
  const line = rows[Math.max(0, Math.min(row, rows.length - 1))]!;
  return line.start + monoColAt(line.text, x, measure);
}
