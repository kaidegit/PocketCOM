import { describe, expect, test } from "bun:test";
import { bytesToHex, bytesToStr, hexStrToBytes, strToBytes } from "./codec";
import { ParamError } from "./errors";

const te = new TextEncoder();
const td = new TextDecoder();

describe("bytesToHex / hexStrToBytes", () => {
  test("大写、空格分隔", () => {
    expect(bytesToHex(te.encode("Hello"))).toBe("48 65 6C 6C 6F");
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe("00 0F FF");
  });

  test("容忍空格、换行与 0x 前缀", () => {
    expect(td.decode(hexStrToBytes("48 65 6c 6c 6f"))).toBe("Hello");
    expect(td.decode(hexStrToBytes("0x48 0x65\n0x6C\t0x6C 0x6F"))).toBe("Hello");
    expect([...hexStrToBytes("48656C6C6F")]).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
  });

  test("奇数个 hex 字符抛 ParamError(PARAM_HEX_ODD_LENGTH)", () => {
    try {
      hexStrToBytes("48 6");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ParamError);
      expect((err as ParamError).code).toBe("PARAM_HEX_ODD_LENGTH");
    }
  });

  test("非法字符抛 ParamError(PARAM_HEX_INVALID)", () => {
    expect(() => hexStrToBytes("48 ZZ")).toThrow(ParamError);
    try {
      hexStrToBytes("GG");
      expect.unreachable();
    } catch (err) {
      expect((err as ParamError).code).toBe("PARAM_HEX_INVALID");
    }
  });

  test("roundtrip", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect([...hexStrToBytes(bytesToHex(bytes))]).toEqual([...bytes]);
  });
});

describe("strToBytes", () => {
  test("UTF-8 编码（含多字节）", () => {
    expect([...strToBytes("Hello")]).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect([...strToBytes("中")]).toEqual([0xe4, 0xb8, 0xad]);
    expect([...strToBytes("🙂")]).toEqual([0xf0, 0x9f, 0x99, 0x82]);
  });

  test("escape：\\n \\r \\t \\\\", () => {
    expect([...strToBytes("a\\nb\\rc\\td\\\\e", { escape: true })]).toEqual([
      0x61, 0x0a, 0x62, 0x0d, 0x63, 0x09, 0x64, 0x5c, 0x65,
    ]);
  });

  test("escape：\\xNN（hex）", () => {
    expect([...strToBytes("\\x00\\x41\\xff", { escape: true })]).toEqual([0, 0x41, 0xff]);
    expect([...strToBytes("\\x0a", { escape: true })]).toEqual([0x0a]);
  });

  test("escape：\\NNN（八进制，1–3 位）", () => {
    expect([...strToBytes("\\0\\7\\77\\377", { escape: true })]).toEqual([0, 7, 0x3f, 0xff]);
    expect([...strToBytes("\\101", { escape: true })]).toEqual([0x41]);
  });

  test("escape 关闭时反斜杠原样编码", () => {
    expect(td.decode(strToBytes("\\n"))).toBe("\\n");
  });

  test("非法转义抛 ParamError(PARAM_ESCAPE_INVALID)", () => {
    for (const bad of ["\\q", "\\x1", "\\xZZ", "\\x", "\\", "\\400"]) {
      try {
        strToBytes(bad, { escape: true });
        expect.unreachable(`expected throw for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ParamError);
        expect((err as ParamError).code).toBe("PARAM_ESCAPE_INVALID");
      }
    }
  });
});

describe("bytesToStr", () => {
  test("UTF-8 解码", () => {
    expect(bytesToStr(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]))).toBe("Hello");
    expect(bytesToStr(new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]))).toBe("中文");
  });

  test("非法字节替换为 U+FFFD", () => {
    expect(bytesToStr(new Uint8Array([0x61, 0x80, 0x62]))).toBe("a�b");
    // 0xC0/0xC1 为非法起始字节
    expect(bytesToStr(new Uint8Array([0xc0, 0xaf]))).toBe("��");
  });

  test("截断的多字节序列替换为 U+FFFD", () => {
    expect(bytesToStr(new Uint8Array([0xe4, 0xb8]))).toBe("�");
    expect(bytesToStr(new Uint8Array([0xf0, 0x9f, 0x99]))).toBe("�");
    expect(bytesToStr(new Uint8Array([0x61, 0xe4, 0xb8]))).toBe("a�");
  });

  test("孤立代理项编码为 U+FFFD", () => {
    expect([...strToBytes("\ud800")]).toEqual([0xef, 0xbf, 0xbd]);
  });

  test("escape：不可见字节渲染为 \\xNN，可见 ASCII 与常见空白保持原样", () => {
    expect(bytesToStr(new Uint8Array([0x01, 0x41, 0x20, 0x7f]), { escape: true })).toBe(
      "\\x01A \\x7F",
    );
    expect(bytesToStr(new Uint8Array([0x09, 0x0a, 0x0d]), { escape: true })).toBe("\t\n\r");
    expect(bytesToStr(new Uint8Array([0xe4, 0xb8, 0xad]), { escape: true })).toBe(
      "\\xE4\\xB8\\xAD",
    );
  });
});
