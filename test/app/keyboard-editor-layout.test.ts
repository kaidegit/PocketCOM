import { expect, test } from "bun:test";
import { editorCaretAt, editorWindow } from "../../app/keyboard-editor-layout";

const measure = (s: string) => s.length * 8;

test("empty editor and caret before the first newline", () => {
  expect(editorWindow("", 0, 100, measure)).toEqual({ rows: [{ text: "", start: 0 }], caretRow: 0, caretX: 0 });
  const start = editorWindow("\nab", 0, 100, measure);
  expect(start.caretRow).toBe(0);
  expect(start.rows).toEqual([{ text: "", start: 0 }, { text: "ab", start: 1 }]);
  const next = editorWindow("\nab", 1, 100, measure);
  expect(next.caretRow).toBe(1);
  expect(next.caretX).toBe(0);
});

test("two rows follow the caret, including a trailing empty line", () => {
  const view = editorWindow("first\nsecond\nthird\n", 15, 100, measure);
  expect(view.rows).toEqual([{ text: "second", start: 6 }, { text: "third", start: 13 }]);
  expect(view.caretRow).toBe(1);
  expect(view.caretX).toBe(16);
  const end = editorWindow("first\nsecond\nthird\n", 19, 100, measure);
  expect(end.rows).toEqual([{ text: "third", start: 13 }, { text: "", start: 19 }]);
  expect(end.caretX).toBe(0);
});

test("long single-line content scrolls horizontally and bounds rendered text", () => {
  const text = "0123456789".repeat(100);
  const view = editorWindow(text, text.length, 80, measure);
  expect(view.rows[0]!.text.length).toBeLessThanOrEqual(10);
  expect(view.rows[0]!.start).toBeGreaterThan(980);
  expect(view.caretX).toBeLessThanOrEqual(78);
  expect(editorCaretAt(view.rows, 0, 1000, measure)).toBe(text.length);
  expect(editorCaretAt(view.rows, 0, -20, measure)).toBe(view.rows[0]!.start);
});

test("clicks map visible rows back to the original field indices", () => {
  const view = editorWindow("one\ntwo\nthree", 10, 100, measure);
  expect(editorCaretAt(view.rows, 0, 8, measure)).toBe(5);
  expect(editorCaretAt(view.rows, 1, 16, measure)).toBe(10);
  expect(editorCaretAt(view.rows, 99, 999, measure)).toBe(13);
  expect(editorCaretAt(view.rows, -2, -1, measure)).toBe(4);
});
