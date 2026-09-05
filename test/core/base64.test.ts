import { describe, expect, test } from "bun:test";
import { decodeBase64 } from "../../core/base64";
import { ProtocolError } from "../../core/errors";

describe("decodeBase64", () => {
  test("空串 → 空数组", () => {
    expect(decodeBase64("").byteLength).toBe(0);
  });

  test("RFC 4648 测试向量", () => {
    expect([...decodeBase64("Zg==")]).toEqual([0x66]);
    expect([...decodeBase64("Zm8=")]).toEqual([0x66, 0x6f]);
    expect([...decodeBase64("Zm9v")]).toEqual([0x66, 0x6f, 0x6f]);
    expect([...decodeBase64("Zm9vYg==")]).toEqual([0x66, 0x6f, 0x6f, 0x62]);
    expect([...decodeBase64("Zm9vYmE=")]).toEqual([0x66, 0x6f, 0x6f, 0x62, 0x61]);
    expect([...decodeBase64("Zm9vYmFy")]).toEqual([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]);
  });

  test("二进制 round-trip（0..255）", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    // 手写参照编码：与 decodeBase64 同一字母表，独立实现
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let b64 = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i]!;
      const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
      b64 += alphabet[b0 >> 2]! + alphabet[((b0 & 3) << 4) | (b1 >> 4)]!;
      b64 += i + 1 < bytes.length ? alphabet[((b1 & 15) << 2) | (b2 >> 6)]! : "=";
      b64 += i + 2 < bytes.length ? alphabet[b2 & 63]! : "=";
    }
    expect([...decodeBase64(b64)]).toEqual([...bytes]);
  });

  test("容忍换行空白", () => {
    expect([...decodeBase64("Zm9v\nYmFy")]).toEqual([0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72]);
  });

  test("字母表外字符抛 ProtocolError", () => {
    expect(() => decodeBase64("Zm9v!g==")).toThrow(ProtocolError);
    expect(() => decodeBase64("Zm9v€g==")).toThrow(ProtocolError);
  });

  test("长度非 4 的倍数抛 ProtocolError", () => {
    expect(() => decodeBase64("Zg=")).toThrow(ProtocolError);
    expect(() => decodeBase64("Z")).toThrow(ProtocolError);
    expect(() => decodeBase64("Zg==Zg==")).not.toThrow();
  });
});
