/**
 * Base64 解码（手写，SPEC §4.2 事件批的 b64 字段）。
 * QuickJS guest 无 atob —— 纯 TS 实现，零平台依赖。
 * 非法字符抛 ProtocolError（宿主事件 malformed 是宿主侧 bug，SPEC §5.1）。
 */
import { ProtocolError } from "./errors";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_REVERSE = ((): Int16Array => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * base64（可含末尾 = 填充、可含 \r\n 空白）→ bytes。
 * 长度非法（len % 4 !== 0）或出现字母表外字符抛 ProtocolError。
 */
export function decodeBase64(input: string): Uint8Array {
  // 单趟扫描：跳过空白，校验字符，统计有效长度（含 '=' 填充）。
  let total = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c !== 0x3d && (c > 127 || B64_REVERSE[c] < 0)) {
      throw new ProtocolError("PROTOCOL_VIOLATION", `invalid base64 character at offset ${i}`);
    }
    total++;
  }
  if (total % 4 !== 0) {
    throw new ProtocolError("PROTOCOL_VIOLATION", `invalid base64 length: ${total} chars`);
  }
  // 末尾 1~2 个 '=' 为填充；填充只能出现在末尾。
  const last = input.length > 0 ? input.charCodeAt(input.length - 1) : 0;
  const prev = input.length > 1 ? input.charCodeAt(input.length - 2) : 0;
  const pad = last === 0x3d ? (prev === 0x3d ? 2 : 1) : 0;
  const outLen = (total / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let outIdx = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c === 0x3d) break; // 填充开始即结束
    acc = (acc << 6) | B64_REVERSE[c]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (outIdx < outLen) out[outIdx++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}
