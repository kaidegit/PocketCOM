// test/app/settings-modal-layout.test.ts — "应用配置"弹窗几何回归
// （app/settings-modal-layout.ts，纯函数，同 sendlayout.test.ts 的 headless 模式）。
// 居中/夹取约束：桌面默认 960×640 完整居中；嵌入式规格屏 480×272 与更小
// 视口下按 8px 边距夹取缩框（内容改走内部滚动），不溢出视口。
import { describe, expect, test } from "bun:test";
import {
  MODAL_CONTENT_H,
  MODAL_MARGIN,
  MODAL_W,
  modalFrame,
  modalRowY,
} from "../../app/settings-modal-layout";

describe("settings-modal-layout.modalFrame", () => {
  test("桌面默认 960×640：完整尺寸居中（奇差取整）", () => {
    const f = modalFrame(960, 640);
    expect(f.w).toBe(MODAL_W);
    expect(f.h).toBe(MODAL_CONTENT_H);
    expect(f.x).toBe((960 - MODAL_W) / 2);
    expect(f.y).toBe(Math.floor((640 - MODAL_CONTENT_H) / 2));
  });

  test("宽不足（<400+边距）时缩宽并保持居中、不溢出", () => {
    const f = modalFrame(300, 640);
    expect(f.w).toBe(300 - MODAL_MARGIN * 2);
    expect(f.x).toBe(MODAL_MARGIN);
    expect(f.x + f.w).toBe(300 - MODAL_MARGIN);
  });

  test("高不足（嵌入式规格屏 480×272）时缩高，内容走内部滚动", () => {
    const f = modalFrame(480, 272);
    expect(f.h).toBe(272 - MODAL_MARGIN * 2);
    expect(f.y).toBe(MODAL_MARGIN);
    expect(f.h).toBeLessThan(MODAL_CONTENT_H);
    // 宽不受影响（480 > 400 + 16）
    expect(f.w).toBe(MODAL_W);
  });

  test("极小视口不产生负尺寸", () => {
    const f = modalFrame(10, 10);
    expect(f.w).toBe(0);
    expect(f.h).toBe(0);
    expect(f.x).toBe(5);
    expect(f.y).toBe(5);
  });
});

describe("settings-modal-layout.modalRowY", () => {
  test("五行等距累计（行高 34 + 行距 10）", () => {
    expect(modalRowY(0)).toBe(40);
    expect(modalRowY(1)).toBe(40 + 44);
    expect(modalRowY(2)).toBe(40 + 88);
    expect(modalRowY(3)).toBe(40 + 132);
    expect(modalRowY(4)).toBe(40 + 176);
  });
});
