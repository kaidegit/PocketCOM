// test/app/textsel.test.ts — 文本选区几何映射回归（app/textsel.ts，纯函数）。
// mono 字形槽按前缀度量做 px ↔ 列号双向映射：绘制（高亮/光标 x）与命中
// （点击列）必须用同一度量，否则拖动选区的视觉端点会偏离点击处。
import { describe, expect, test } from "bun:test";
import { monoColAt, monoXAt } from "../../app/textsel";

// 确定性度量：ASCII 每字符 10px，CJK 每字符 20px（模拟 mono 槽宽窄比 2:1）。
const measure = (s: string): number =>
  [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 20 : 10), 0);

describe("textsel.monoColAt", () => {
  test("空文本与越界 x 钳位", () => {
    expect(monoColAt("", 100, measure)).toBe(0);
    expect(monoColAt("abc", -5, measure)).toBe(0);
    expect(monoColAt("abc", 0, measure)).toBe(0);
  });

  test("点击超过行宽 → 末列", () => {
    expect(monoColAt("abc", 999, measure)).toBe(3);
  });

  test("字符边界与半格点击", () => {
    expect(monoColAt("abc", 10, measure)).toBe(1);
    expect(monoColAt("abc", 25, measure)).toBe(2);
    expect(monoColAt("abc", 29, measure)).toBe(2);
  });

  test("宽字符（CJK）按 2 倍宽度落列", () => {
    expect(monoColAt("中文", 25, measure)).toBe(1);
    expect(monoColAt("中文", 35, measure)).toBe(1);
    expect(monoColAt("中文", 40, measure)).toBe(2);
  });
});

describe("textsel.monoXAt", () => {
  test("列 0 与越界列钳位", () => {
    expect(monoXAt("abc", 0, measure)).toBe(0);
    expect(monoXAt("abc", -1, measure)).toBe(0);
    expect(monoXAt("abc", 99, measure)).toBe(30);
  });

  test("列 → 前缀宽度，与 monoColAt 互逆", () => {
    expect(monoXAt("a中b", 2, measure)).toBe(30);
    expect(monoColAt("a中b", monoXAt("a中b", 2, measure) - 1, measure)).toBe(1);
    expect(monoColAt("a中b", monoXAt("a中b", 2, measure), measure)).toBe(2);
  });
});
