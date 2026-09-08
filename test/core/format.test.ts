import { describe, expect, test } from "bun:test";
import { formatContent, formatLogText, formatTimestamp, messagePrefix } from "../../core/format";
import { strToBytes } from "../../core/codec";
import type { Message } from "../../core/message";
import type { LogFormatOptions, LogLineLabels } from "../../core/format";

const LABELS: LogLineLabels = { rx: "<=", txManual: "[手动发送]", txMcp: "[MCP发送]", sys: "[SYS]" };
/** MCP server 未运行（SPEC §3.5）：RX/TX 来源前缀均隐藏为 ""。 */
const NO_MCP_LABELS: LogLineLabels = { ...LABELS, rx: "", txManual: "" };

const OPTS: LogFormatOptions = { hex: false, escape: false, timestamp: false, color: false };

function msg(partial: Partial<Message> & { payload?: Uint8Array }): Message {
  return { id: 1, ts: 0, dir: "rx", source: "system", connId: "c", payload: new Uint8Array(0), ...partial };
}

describe("formatTimestamp", () => {
  test("YYYY-MM-DD HH:MM:SS.mmm 零填充", () => {
    // 2026-09-05 08:09:05.007 本地时区构造：用 Date 字段往返验证格式本身
    const d = new Date(2026, 8, 5, 8, 9, 5, 7);
    expect(formatTimestamp(d.getTime())).toBe("2026-09-05 08:09:05.007");
  });

  test("毫秒三位数", () => {
    const d = new Date(2026, 11, 31, 23, 59, 59, 999);
    expect(formatTimestamp(d.getTime())).toBe("2026-12-31 23:59:59.999");
  });
});

describe("messagePrefix", () => {
  test("rx → <=", () => {
    expect(messagePrefix(msg({ dir: "rx" }), LABELS)).toBe("<=");
  });
  test("tx manual/timer/history → 手动前缀；mcp → MCP 前缀", () => {
    expect(messagePrefix(msg({ dir: "tx", source: "manual" }), LABELS)).toBe("[手动发送]");
    expect(messagePrefix(msg({ dir: "tx", source: "timer" }), LABELS)).toBe("[手动发送]");
    expect(messagePrefix(msg({ dir: "tx", source: "history" }), LABELS)).toBe("[手动发送]");
    expect(messagePrefix(msg({ dir: "tx", source: "mcp" }), LABELS)).toBe("[MCP发送]");
  });
  test("MCP 未运行：rx/txManual 为空 → 数据行前缀为 \"\"，MCP/sys 不受影响", () => {
    expect(messagePrefix(msg({ dir: "rx" }), NO_MCP_LABELS)).toBe("");
    expect(messagePrefix(msg({ dir: "tx", source: "manual" }), NO_MCP_LABELS)).toBe("");
    expect(messagePrefix(msg({ dir: "tx", source: "mcp" }), NO_MCP_LABELS)).toBe("[MCP发送]");
  });
  test("sys → [SYS]", () => {
    expect(messagePrefix(msg({ dir: "sys", source: "system" }), LABELS)).toBe("[SYS]");
  });
});

describe("formatContent", () => {
  test("UTF-8 文本（含 CJK）", () => {
    expect(formatContent(strToBytes("hello 世界"), OPTS)).toBe("hello 世界");
  });
  test("非法 UTF-8 字节 → U+FFFD", () => {
    expect(formatContent(new Uint8Array([0x61, 0xff, 0x62]), OPTS)).toBe("a�b");
  });
  test("escape 开启：不可见字节 → \\xNN，常见空白保持原样", () => {
    expect(formatContent(new Uint8Array([0x01, 0x41, 0x0a]), { ...OPTS, escape: true })).toBe(
      "\\x01A\n",
    );
    expect(formatContent(new Uint8Array([0x00, 0x7f]), { ...OPTS, escape: true })).toBe("\\x00\\x7F");
  });
  test("HEX：大写空格分隔、无损", () => {
    expect(formatContent(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { ...OPTS, hex: true })).toBe(
      "DE AD BE EF",
    );
  });
});

describe("formatLogText", () => {
  test("无时间戳行", () => {
    expect(formatLogText(msg({ dir: "rx", payload: strToBytes("ok") }), OPTS, LABELS)).toBe("<= ok");
  });
  test("带时间戳行", () => {
    const d = new Date(2026, 8, 5, 12, 0, 0, 42);
    const line = formatLogText(
      msg({ dir: "sys", payload: strToBytes("connected"), ts: d.getTime() }),
      { ...OPTS, timestamp: true },
      LABELS,
    );
    expect(line).toBe("[2026-09-05 12:00:00.042] [SYS] connected");
  });
  test("MCP 未运行：TX 行无前缀且不留多余空格", () => {
    expect(formatLogText(msg({ dir: "tx", source: "manual", payload: strToBytes("hi") }), OPTS, NO_MCP_LABELS)).toBe(
      "hi",
    );
    const d = new Date(2026, 8, 5, 12, 0, 0, 42);
    expect(
      formatLogText(
        msg({ dir: "tx", source: "manual", payload: strToBytes("hi"), ts: d.getTime() }),
        { ...OPTS, timestamp: true },
        NO_MCP_LABELS,
      ),
    ).toBe("[2026-09-05 12:00:00.042] hi");
    expect(
      formatLogText(
        msg({ dir: "rx", payload: strToBytes("yo"), ts: d.getTime() }),
        { ...OPTS, timestamp: true },
        NO_MCP_LABELS,
      ),
    ).toBe("[2026-09-05 12:00:00.042] yo");
  });
  test("HEX 开关只作用于 RX/TX 数据帧", () => {
    const hex = { ...OPTS, hex: true };
    expect(formatLogText(msg({ dir: "rx", payload: strToBytes("AT") }), hex, LABELS)).toBe("<= 41 54");
    expect(formatLogText(msg({ dir: "tx", source: "manual", payload: strToBytes("AT") }), hex, LABELS)).toBe(
      "[手动发送] 41 54",
    );
  });
  test("sys 消息不受 HEX/转义开关影响（始终可读文本，含 CJK）", () => {
    const m = msg({ dir: "sys", payload: strToBytes("连接已断开") });
    expect(formatLogText(m, { ...OPTS, hex: true }, LABELS)).toBe("[SYS] 连接已断开");
    expect(formatLogText(m, { ...OPTS, hex: true, escape: true }, LABELS)).toBe("[SYS] 连接已断开");
  });
});
