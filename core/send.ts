/**
 * 发送区字节组装（SPEC §3.3）：ASCII/HEX 输入 + 转义 + <CRLF> + 追加换行。
 * 纯 TS；非法输入抛 ParamError（HEX 模式不做 CRLF——换行由字节显式表达）。
 */
import { bytesToHex, bytesToStr, hexStrToBytes, strToBytes } from "./codec";

export interface SendOptions {
  /** HEX 输入（hexStrToBytes）；否则 UTF-8 文本 */
  hex: boolean;
  /** 解析 \n \r \t \xNN \NNN 转义（仅 ASCII 模式） */
  escape: boolean;
  /** \n → \r\n（仅 ASCII 模式，SPEC §3.3 <CRLF> 选项） */
  crlf: boolean;
  /** 帧尾追加 \n */
  appendNewline: boolean;
}

/** \n → \r\n 转换（仅 ASCII 文本语义的 LF 字节）。 */
function lfToCrlf(bytes: Uint8Array): Uint8Array {
  let lfCount = 0;
  for (let i = 0; i < bytes.byteLength; i++) if (bytes[i] === 0x0a) lfCount++;
  if (lfCount === 0) return bytes;
  const out = new Uint8Array(bytes.byteLength + lfCount);
  let j = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x0a) out[j++] = 0x0d;
    out[j++] = bytes[i]!;
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * 发送文本 → 字节帧；HEX/转义非法抛 ParamError（SPEC §5.1）。
 * 空文本返回空数组，调用方决定忽略。
 */
export function composeSendBytes(text: string, opts: SendOptions): Uint8Array {
  let bytes = opts.hex ? hexStrToBytes(text) : strToBytes(text, { escape: opts.escape });
  if (!opts.hex && opts.crlf) bytes = lfToCrlf(bytes);
  if (opts.appendNewline) bytes = concatBytes(bytes, new Uint8Array([0x0a]));
  return bytes;
}

/**
 * 发送区 ASCII/HEX 显示切换时的内容互转（SPEC §3.3）。
 * ASCII→HEX 用当前转义设置解释文本；HEX→ASCII 解码失败字节按 U+FFFD（§3.3）。
 */
export function convertInputText(text: string, from: "ascii" | "hex", escape: boolean): string {
  if (text.trim() === "") return "";
  if (from === "ascii") {
    return bytesToHex(strToBytes(text, { escape }));
  }
  return bytesToStr(hexStrToBytes(text));
}
