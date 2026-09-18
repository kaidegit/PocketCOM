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
  // 宿主常规输入没有空白；兼容带空白的外部事件时才分配规范化字符串。
  const text = /[ \t\r\n]/.test(input) ? input.replace(/[ \t\r\n]/g, "") : input;
  const n = text.length;
  if (n % 4 !== 0) {
    throw new ProtocolError("PROTOCOL_VIOLATION", `invalid base64 length: ${n} chars`);
  }
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array(n / 4 * 3 - pad);
  let at = 0;
  for (let i = 0; i < n; i += 4) {
    const a = text.charCodeAt(i), b = text.charCodeAt(i + 1);
    const c = text.charCodeAt(i + 2), d = text.charCodeAt(i + 3);
    const last = i + 4 === n;
    const va = a < 128 ? B64_REVERSE[a]! : -1;
    const vb = b < 128 ? B64_REVERSE[b]! : -1;
    const vc = last && c === 61 && pad === 2 ? 0 : c < 128 ? B64_REVERSE[c]! : -1;
    const vd = last && d === 61 ? 0 : d < 128 ? B64_REVERSE[d]! : -1;
    if ((va | vb | vc | vd) < 0) {
      throw new ProtocolError("PROTOCOL_VIOLATION", `invalid base64 quartet at offset ${i}`);
    }
    const bits = (va << 18) | (vb << 12) | (vc << 6) | vd;
    out[at++] = bits >> 16;
    if (at < out.length) out[at++] = bits >> 8;
    if (at < out.length) out[at++] = bits;
  }
  return out;
}
