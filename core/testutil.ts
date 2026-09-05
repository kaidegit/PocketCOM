/**
 * 测试工具：base64 编码（独立实现，用于构造 fake 宿主事件）。
 * 生产路径只有解码（core/base64.ts）。
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += ALPHABET[b0 >> 2]! + ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]!;
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 15) << 2) | (b2 >> 6)]! : "=";
    out += i + 2 < bytes.length ? ALPHABET[b2 & 63]! : "=";
  }
  return out;
}
