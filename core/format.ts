/**
 * 接收区日志行格式化（SPEC §3.3 / §3.5）。
 * 行格式：`[YYYY-MM-DD HH:MM:SS.mmm]? [前缀] 内容`，纯 TS 可单测；
 * 前缀文案由调用方（app 侧 i18n）注入，核心层不依赖语言包。
 */
import type { Message, MessageDir } from "./message";
import { bytesToHex, bytesToStr, utf8Decode } from "./codec";

/** 接收区显示开关（SPEC §3.3）。 */
export interface LogFormatOptions {
  /** HEX 显示（大写空格分隔，无损）；否则 UTF-8 文本 */
  hex: boolean;
  /** 不可见字节渲染为 \xNN */
  escape: boolean;
  /** 行首时间戳 [YYYY-MM-DD HH:MM:SS.mmm]（开启则强制自动换行） */
  timestamp: boolean;
}

/**
 * 前缀文案（i18n 注入）：RX 方向标记、TX 两类来源前缀（SPEC §3.5 冻结为
 * 手动/MCP 两类；timer/history 归入手动类）、sys 事件标记。
 */
export interface LogLineLabels {
  /** RX 方向标记，如 "<=" */
  rx: string;
  /** TX 手动来源前缀（含括号），如 "[手动发送]" */
  txManual: string;
  /** TX MCP 来源前缀（含括号），如 "[MCP发送]" */
  txMcp: string;
  /** sys 事件标记（含括号），如 "[--]" */
  sys: string;
}

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function pad3(n: number): string {
  return n < 10 ? "00" + n : n < 100 ? "0" + n : String(n);
}

/** `YYYY-MM-DD HH:MM:SS.mmm`（本地时区，SPEC §3.3）。 */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`
  );
}

/** 一行消息的方向/来源前缀（SPEC §3.5）。 */
export function messagePrefix(msg: Message, labels: LogLineLabels): string {
  switch (msg.dir) {
    case "rx":
      return labels.rx;
    case "tx":
      return msg.source === "mcp" ? labels.txMcp : labels.txManual;
    case "sys":
      return labels.sys;
  }
}

/** 消息内容：HEX（无损）或 UTF-8 文本（解码失败字节 → U+FFFD，SPEC §3.3）。
 *  仅用于 RX/TX 数据帧；sys 消息走 formatLogText 的文本分支。 */
export function formatContent(payload: Uint8Array, opts: LogFormatOptions): string {
  return opts.hex ? bytesToHex(payload) : bytesToStr(payload, { escape: opts.escape });
}

/** 消息 → 完整单行日志文本。sys 为 UI 生成的可读文本（i18n 提示等，
 *  均为 strToBytes 写入的完整 UTF-8），始终按文本渲染，不受 HEX/转义
 *  显示开关影响（转义是面向 wire 字节的逐字节语义，会打碎 CJK 文案）。 */
export function formatLogText(msg: Message, opts: LogFormatOptions, labels: LogLineLabels): string {
  const ts = opts.timestamp ? `[${formatTimestamp(msg.ts)}] ` : "";
  const content = msg.dir === "sys" ? utf8Decode(msg.payload) : formatContent(msg.payload, opts);
  return `${ts}${messagePrefix(msg, labels)} ${content}`;
}

/** 行着色用的方向（渲染侧按方向取主题色）。 */
export type LogLineDir = MessageDir;
