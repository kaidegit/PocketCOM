import { describe, expect, test } from "bun:test";
import { composeSendBytes, convertInputText } from "./send";
import { ParamError } from "./errors";
import type { SendOptions } from "./send";

const ASCII: SendOptions = { hex: false, escape: false, crlf: false, appendNewline: false };

describe("composeSendBytes", () => {
  test("ASCII 纯文本 → UTF-8", () => {
    expect([...composeSendBytes("hello 世界", ASCII)]).toEqual([
      104, 101, 108, 108, 111, 32, 0xe4, 0xb8, 0x96, 0xe7, 0x95, 0x8c,
    ]);
  });

  test("escape 解析 \\n \\r \\t \\xNN 与八进制", () => {
    expect([...composeSendBytes("a\\nb\\x41\\101", { ...ASCII, escape: true })]).toEqual([
      0x61, 0x0a, 0x62, 0x41, 0x41,
    ]);
  });

  test("非法转义抛 ParamError", () => {
    expect(() => composeSendBytes("a\\qb", { ...ASCII, escape: true })).toThrow(ParamError);
    expect(() => composeSendBytes("\\x1", { ...ASCII, escape: true })).toThrow(ParamError);
  });

  test("HEX 输入（容忍空格与 0x 前缀）", () => {
    expect([...composeSendBytes("DE ad be 0xEF", { ...ASCII, hex: true })]).toEqual([
      0xde, 0xad, 0xbe, 0xef,
    ]);
  });

  test("HEX 非法输入抛 ParamError", () => {
    expect(() => composeSendBytes("zz", { ...ASCII, hex: true })).toThrow(ParamError);
    expect(() => composeSendBytes("abc", { ...ASCII, hex: true })).toThrow(ParamError); // 奇数
  });

  test("<CRLF>：仅 ASCII 模式 \\n → \\r\\n", () => {
    expect([...composeSendBytes("a\nb", { ...ASCII, crlf: true })]).toEqual([0x61, 0x0d, 0x0a, 0x62]);
    // HEX 模式不做 CRLF（0x0a 是显式字节）
    expect([...composeSendBytes("0A", { ...ASCII, hex: true, crlf: true })]).toEqual([0x0a]);
  });

  test("追加换行：ASCII 与 HEX 都在帧尾补 0x0a", () => {
    expect([...composeSendBytes("a", { ...ASCII, appendNewline: true })]).toEqual([0x61, 0x0a]);
    expect([...composeSendBytes("41", { ...ASCII, hex: true, appendNewline: true })]).toEqual([
      0x41, 0x0a,
    ]);
  });
});

describe("convertInputText", () => {
  test("ASCII → HEX（escape 设置参与解释）", () => {
    expect(convertInputText("a\\nb", "ascii", true)).toBe("61 0A 62");
    expect(convertInputText("ab", "ascii", false)).toBe("61 62");
  });

  test("HEX → ASCII（非法字节 → U+FFFD）", () => {
    expect(convertInputText("61 62", "hex", false)).toBe("ab");
    expect(convertInputText("61 FF 62", "hex", false)).toBe("a�b");
  });

  test("空内容互转为空", () => {
    expect(convertInputText("  ", "ascii", false)).toBe("");
    expect(convertInputText("", "hex", false)).toBe("");
  });
});
