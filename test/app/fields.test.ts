// test/app/fields.test.ts — 焦点路由身份语义回归。
// activeField 必须以 shallowRef 存储：ref 会把对象值包成 reactive 代理，
// 读取时与存入的原始实现对象身份不等，TextField 的 isActive()
// （activeField.value === impl）将恒为 false —— 表现为聚焦后光标竖条与
// 聚焦边框永不显示（2026-09 实际回归）。
import { describe, expect, test } from "bun:test";
import { activeField, setActiveField, type TextField } from "../../app/fields";

const fakeField: TextField = {
  onCh: () => {},
  onKey: () => {},
  onPaste: () => {},
  onIme: () => {},
};

describe("fields.activeField", () => {
  test("存入的域对象按原始引用读出（不得被 reactive 代理包裹）", () => {
    setActiveField(fakeField);
    expect(activeField.value).toBe(fakeField);
    setActiveField(null);
    expect(activeField.value).toBeNull();
  });
});
