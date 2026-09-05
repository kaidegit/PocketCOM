/**
 * 编解码（SPEC §3.3，对齐 COMTool utils 语义）：hex / 转义 / UTF-8。
 * 纯 TS 手写实现：不依赖 TextEncoder/TextDecoder（QuickJS 环境可能没有）。
 * 非法输入抛 ParamError（SPEC §5.1）。
 */
import { ParamError } from "./errors";

const HEX_DIGITS = "0123456789ABCDEF";

function hex2(value: number): string {
  return HEX_DIGITS[(value >> 4) & 0x0f]! + HEX_DIGITS[value & 0x0f]!;
}

function isHexCharCode(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x41 && c <= 0x46) || // A-F
    (c >= 0x61 && c <= 0x66) // a-f
  );
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return c - 0x61 + 10;
}

/** bytes → 大写、空格分隔 hex（如 "48 65 6C 6C 6F"）。 */
export function bytesToHex(bytes: Uint8Array): string {
  const parts: string[] = new Array<string>(bytes.byteLength);
  for (let i = 0; i < bytes.byteLength; i++) parts[i] = hex2(bytes[i]!);
  return parts.join(" ");
}

/**
 * hex 串 → bytes。容忍空格 / 换行 / 任意位置的 0x 前缀；
 * 出现非 hex 字符抛 ParamError，奇数个 hex 字符抛 ParamError。
 */
export function hexStrToBytes(str: string): Uint8Array {
  // 去掉空白与 0x/0X 前缀
  let cleaned = "";
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (
      (c === 0x78 || c === 0x58) && // x/X
      cleaned.length > 0 &&
      cleaned.charCodeAt(cleaned.length - 1) === 0x30 // 前一个字符是 0
    ) {
      cleaned = cleaned.slice(0, -1); // 去掉 0x 的 0
      continue;
    }
    cleaned += str.charAt(i);
  }
  for (let i = 0; i < cleaned.length; i++) {
    if (!isHexCharCode(cleaned.charCodeAt(i))) {
      throw new ParamError("PARAM_HEX_INVALID", `invalid hex character '${cleaned.charAt(i)}' at offset ${i}`);
    }
  }
  if (cleaned.length % 2 !== 0) {
    throw new ParamError("PARAM_HEX_ODD_LENGTH", `odd number of hex digits: ${cleaned.length}`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    out[i] = (hexVal(cleaned.charCodeAt(i * 2)) << 4) | hexVal(cleaned.charCodeAt(i * 2 + 1));
  }
  return out;
}

/** 将一个 Unicode 码点以 UTF-8 写入 out。孤立代理项按 U+FFFD 处理。 */
function utf8EncodeCodePoint(cp: number, out: number[]): void {
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
  if (cp <= 0x7f) {
    out.push(cp);
  } else if (cp <= 0x7ff) {
    out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
  } else if (cp <= 0xffff) {
    out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  } else {
    out.push(
      0xf0 | (cp >> 18),
      0x80 | ((cp >> 12) & 0x3f),
      0x80 | ((cp >> 6) & 0x3f),
      0x80 | (cp & 0x3f),
    );
  }
}

function utf8EncodeString(str: string, out: number[]): void {
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    utf8EncodeCodePoint(cp, out);
  }
}

export interface StrBytesOptions {
  /** 开启时解析转义序列：\n \r \t \\ \xNN（hex）\NNN（八进制） */
  escape?: boolean;
}

/**
 * 字符串 → UTF-8 字节。
 * escape 开启时解析 \n \r \t \\ \xNN \NNN（八进制，最多 3 位，值域 0–255），
 * 非法转义序列抛 ParamError。
 */
export function strToBytes(str: string, opts: StrBytesOptions = {}): Uint8Array {
  const out: number[] = [];
  if (opts.escape !== true) {
    utf8EncodeString(str, out);
    return new Uint8Array(out);
  }
  let i = 0;
  while (i < str.length) {
    const ch = str.charAt(i);
    if (ch !== "\\") {
      utf8EncodeString(ch, out);
      i++;
      continue;
    }
    const next = str.charAt(i + 1); // 越界时为 ""
    switch (next) {
      case "n":
        out.push(0x0a);
        i += 2;
        break;
      case "r":
        out.push(0x0d);
        i += 2;
        break;
      case "t":
        out.push(0x09);
        i += 2;
        break;
      case "\\":
        out.push(0x5c);
        i += 2;
        break;
      case "x": {
        const h = str.substring(i + 2, i + 4);
        if (h.length !== 2 || !isHexCharCode(h.charCodeAt(0)) || !isHexCharCode(h.charCodeAt(1))) {
          throw new ParamError("PARAM_ESCAPE_INVALID", `\\x expects 2 hex digits at offset ${i}`);
        }
        out.push((hexVal(h.charCodeAt(0)) << 4) | hexVal(h.charCodeAt(1)));
        i += 4;
        break;
      }
      default: {
        if (next >= "0" && next <= "7") {
          let j = i + 1;
          let value = 0;
          let digits = 0;
          while (j < str.length && digits < 3) {
            const oc = str.charCodeAt(j);
            if (oc < 0x30 || oc > 0x37) break;
            value = value * 8 + (oc - 0x30);
            j++;
            digits++;
          }
          if (value > 0xff) {
            throw new ParamError("PARAM_ESCAPE_INVALID", `octal escape out of range at offset ${i}`);
          }
          out.push(value);
          i = j;
          break;
        }
        throw new ParamError(
          "PARAM_ESCAPE_INVALID",
          `unknown escape sequence '\\${next}' at offset ${i}`,
        );
      }
    }
  }
  return new Uint8Array(out);
}

const REPLACEMENT = "\ufffd";

/**
 * UTF-8 解码（手写，等价 TextDecoder fatal:false 语义）：
 * 非法字节、截断的多字节序列均替换为 U+FFFD。
 */
export function utf8Decode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  const n = bytes.byteLength;
  while (i < n) {
    const b0 = bytes[i]!;
    if (b0 <= 0x7f) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    }
    let need: number; // 后续续字节数
    let lo1 = 0x80;
    let hi1 = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      if (b0 === 0xe0) lo1 = 0xa0; // 排除 overlong
      if (b0 === 0xed) hi1 = 0x9f; // 排除 UTF-16 代理项区
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      if (b0 === 0xf0) lo1 = 0x90; // 排除 overlong
      if (b0 === 0xf4) hi1 = 0x8f; // 上限 U+10FFFF
    } else {
      out += REPLACEMENT;
      i++;
      continue;
    }
    if (i + need >= n) {
      // 截断的多字节序列：整体替换为一个 U+FFFD
      out += REPLACEMENT;
      break;
    }
    const b1 = bytes[i + 1]!;
    if (b1 < lo1 || b1 > hi1) {
      out += REPLACEMENT;
      i++;
      continue;
    }
    let valid = true;
    for (let k = 2; k <= need; k++) {
      const bk = bytes[i + k]!;
      if (bk < 0x80 || bk > 0xbf) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      out += REPLACEMENT;
      i++;
      continue;
    }
    let cp: number;
    if (need === 1) {
      cp = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
    } else if (need === 2) {
      cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (bytes[i + 2]! & 0x3f);
    } else {
      cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((bytes[i + 2]! & 0x3f) << 6) | (bytes[i + 3]! & 0x3f);
    }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

/** 可见 ASCII（0x21–0x7E）与常见空白（空格、\t、\n、\r）保持原样，其余字节渲染为 \xNN。 */
function isEscapedLiteral(byte: number): boolean {
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0d ||
    (byte >= 0x21 && byte <= 0x7e)
  );
}

export interface BytesStrOptions {
  /** 开启时不可见字节渲染为 \xNN 形式 */
  escape?: boolean;
}

/**
 * bytes → 字符串：UTF-8 解码，非法字节序列替换为 U+FFFD（SPEC §3.3）。
 * escape 开启时不可见字节渲染为 \xNN 形式（逐字节，HEX 视图始终无损）。
 */
export function bytesToStr(bytes: Uint8Array, opts: BytesStrOptions = {}): string {
  if (opts.escape === true) {
    let out = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      const b = bytes[i]!;
      out += isEscapedLiteral(b) ? String.fromCharCode(b) : "\\x" + hex2(b);
    }
    return out;
  }
  return utf8Decode(bytes);
}
