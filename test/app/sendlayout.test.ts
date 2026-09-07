// test/app/sendlayout.test.ts — 发送区选项行流式几何回归（app/sendlayout.ts）。
// 弹层锚点必须复现 flex 行的占位累计：SegCtrl(92) + 三个 CheckRow
// (14+8+标签宽) + 4 个 gap-2，否则弹层与控件脱节（2026-09 实测回归：
// 弹层开在 x=380 而控件实际在 587）。zh-CN 实测标签宽：转义 24 / <CRLF> 45 /
// 追加换行 48，控件历史 Select 落在行内 x=307（绝对 587）。
import { describe, expect, test } from "bun:test";
import { checkRowW, sendOptSelectX } from "../../app/sendlayout";

const measure = (s: string): number => {
  if (s === "转义") return 24;
  if (s === "<CRLF>") return 45;
  if (s === "追加换行") return 48;
  return [...s].length * 8; // 其他文本按 8px/字兜底
};

const zh = { escape: "转义", crlf: "<CRLF>", appendNewline: "追加换行" };

describe("sendlayout.checkRowW", () => {
  test("占位 = 14 框 + 8 内距 + 标签宽", () => {
    expect(checkRowW("转义", measure)).toBe(46);
    expect(checkRowW("", measure)).toBe(22);
  });
});

describe("sendlayout.sendOptSelectX", () => {
  test("zh-CN 无定向：历史 Select 行内 x=307（绝对 280+307=587，实测对齐）", () => {
    const { targetX, historyX } = sendOptSelectX(zh, measure, false);
    expect(targetX).toBe(307);
    expect(historyX).toBe(307);
  });

  test("定向显示时历史右移 150+8", () => {
    const { targetX, historyX } = sendOptSelectX(zh, measure, true);
    expect(targetX).toBe(307);
    expect(historyX).toBe(307 + 158);
  });

  test("标签变宽（en）x 随之前移", () => {
    const en = { escape: "Escape", crlf: "<CRLF>", appendNewline: "Append NL" };
    const { historyX } = sendOptSelectX(en, measure, false);
    // Escape 6 字 ×8=48、Append NL 9 字 ×8=72 → 92+70+67+94+32=355
    expect(historyX).toBe(355);
  });

  test("gap 累计恒为 4（SegCtrl→escape→crlf→appendNl→Select）", () => {
    const zero = (s: string): number => (s === "" ? 0 : s.length * 0);
    const { targetX } = sendOptSelectX(
      { escape: "", crlf: "", appendNewline: "" },
      zero,
      false,
    );
    expect(targetX).toBe(92 + 22 * 3 + 8 * 4);
  });
});
