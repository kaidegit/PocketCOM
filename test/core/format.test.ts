import { describe, expect, test } from "bun:test";
import { formatContent, formatLogText, formatTimestamp, messagePrefix } from "../../core/format";
import { strToBytes } from "../../core/codec";
import type { Message } from "../../core/message";
import type { LogFormatOptions, LogLineLabels } from "../../core/format";

const LABELS: LogLineLabels = { rx: "<=", txManual: "[手动发送]", txMcp: "[MCP发送]", sys: "[--]" };

const OPTS: LogFormatOptions = { hex: false, escape: false, timestamp: false };

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
  test("sys → [--]", () => {
    expect(messagePrefix(msg({ dir: "sys", source: "system" }), LABELS)).toBe("[--]");
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
    expect(line).toBe("[2026-09-05 12:00:00.042] [--] connected");
  });
});
