import { describe, expect, test } from "bun:test";
import { AnsiFgScanner } from "../../core/ansicolor";
import { TERM_DEFAULT_COLOR, termRgb } from "../../core/term";

const D = TERM_DEFAULT_COLOR;

/** feed 文本 → {剥离后文本, 颜色分段压缩}（[色, 文本] 序列）。 */
function runs(scan: AnsiFgScanner, text: string): { plain: string; runs: [number, string][] } {
  const { plain, fg } = scan.feed(text);
  const out: [number, string][] = [];
  let start = 0;
  for (let i = 1; i <= fg.length; i++) {
    if (i === fg.length || fg[i] !== fg[start]) {
      out.push([fg[start]!, plain.slice(start, i)]);
      start = i;
    }
  }
  return { plain, runs: out };
}

describe("AnsiFgScanner", () => {
  test("无序列：文本原样、全文默认色", () => {
    const r = runs(new AnsiFgScanner(), "hello 世界");
    expect(r.plain).toBe("hello 世界");
    expect(r.runs).toEqual([[D, "hello 世界"]]);
  });

  test("SGR 30–37 着色并剥离；0 复位", () => {
    const r = runs(new AnsiFgScanner(), "\x1b[31mred\x1b[0m plain");
    expect(r.plain).toBe("red plain");
    expect(r.runs).toEqual([
      [1, "red"],
      [D, " plain"],
    ]);
  });

  test("90–97 亮色系映射到调色板 8–15", () => {
    const r = runs(new AnsiFgScanner(), "\x1b[92mgreen");
    expect(r.runs).toEqual([[10, "green"]]);
  });

  test("空 body 与空参数复位（ESC[m / ESC[;m），39 复位", () => {
    expect(runs(new AnsiFgScanner(), "\x1b[32ma\x1b[mb").runs).toEqual([[2, "a"], [D, "b"]]);
    expect(runs(new AnsiFgScanner(), "\x1b[32ma\x1b[;mb").runs).toEqual([[2, "a"], [D, "b"]]);
    expect(runs(new AnsiFgScanner(), "\x1b[32ma\x1b[39mb").runs).toEqual([[2, "a"], [D, "b"]]);
  });

  test("颜色状态跨 feed 持续（SGR 不逐帧复位）", () => {
    const s = new AnsiFgScanner();
    expect(runs(s, "\x1b[34mblu").runs).toEqual([[4, "blu"]]);
    expect(runs(s, "e").runs).toEqual([[4, "e"]]);
    expect(runs(s, "\x1b[0mx").runs).toEqual([[D, "x"]]);
  });

  test("38;5;N / 38:5:N（256 色）与 38;2;R;G;B / 38:2:R:G:B（24-bit）", () => {
    expect(runs(new AnsiFgScanner(), "\x1b[38;5;196mx").runs).toEqual([[196, "x"]]);
    expect(runs(new AnsiFgScanner(), "\x1b[38:5:196my").runs).toEqual([[196, "y"]]);
    const rgb = termRgb(1, 2, 3);
    expect(runs(new AnsiFgScanner(), "\x1b[38;2;1;2;3mz").runs).toEqual([[rgb, "z"]]);
    expect(runs(new AnsiFgScanner(), "\x1b[38:2:1:2:3mw").runs).toEqual([[rgb, "w"]]);
  });

  test("背景 48 扩展照常消费，不误染前景", () => {
    // 48;5;31 若不消费参数，"31" 会被误读为前景红
    expect(runs(new AnsiFgScanner(), "\x1b[48;5;31mx").runs).toEqual([[D, "x"]]);
    expect(runs(new AnsiFgScanner(), "\x1b[48;2;9;9;9mx").runs).toEqual([[D, "x"]]);
  });

  test("帧尾截断序列缓存到下一帧续接（跨包缓冲，SPEC §3.3）", () => {
    const s = new AnsiFgScanner();
    const a = runs(s, "ok\x1b[3");
    expect(a.plain).toBe("ok"); // 截断序列不计入本帧行
    expect(a.runs).toEqual([[D, "ok"]]);
    const b = runs(s, "1mred");
    expect(b.plain).toBe("red");
    expect(b.runs).toEqual([[1, "red"]]);
  });

  test("孤 ESC 截断也缓存；下一帧按普通文本续接", () => {
    const s = new AnsiFgScanner();
    expect(runs(s, "a\x1b").plain).toBe("a");
    expect(runs(s, "b").plain).toBe("\x1bb"); // ESC + 非 CSI：原样保留
  });

  test("非 SGR 的 CSI 原样保留（不吞字、不落色变化）", () => {
    const r = runs(new AnsiFgScanner(), "\x1b[2Jclear\x1b[?25h!");
    expect(r.plain).toBe("\x1b[2Jclear\x1b[?25h!");
    expect(r.runs).toEqual([[D, "\x1b[2Jclear\x1b[?25h!"]]);
  });

  test("非数字 SGR 参数跳过不影响状态；多条序列连续解析", () => {
    const r = runs(new AnsiFgScanner(), "\x1b[?32ma\x1b[1;33mb");
    expect(r.plain).toBe("ab");
    expect(r.runs).toEqual([
      [D, "a"],
      [3, "b"], // 1（粗体，忽略）+ 33（黄）→ 调色板 3
    ]);
  });

  test("调色板越界 clamp 到 0–255（对齐 term.ts）", () => {
    expect(runs(new AnsiFgScanner(), "\x1b[38;5;300mx").runs).toEqual([[255, "x"]]);
  });
});
