import { describe, expect, test } from "bun:test";
import { LogView } from "../../core/logview";
import { MessageBus } from "../../core/bus";
import { strToBytes } from "../../core/codec";
import type { LogFormatOptions, LogLineLabels } from "../../core/format";
import type { NewMessage } from "../../core/message";

const LABELS: LogLineLabels = { rx: "<=", txManual: "[手动发送]", txMcp: "[MCP发送]", sys: "[--]" };
const FORMAT: LogFormatOptions = { hex: false, escape: false, timestamp: false };

function feed(bus: MessageBus, partial: Partial<NewMessage> & { payload: Uint8Array }): void {
  bus.append({ dir: "rx", source: "system", connId: "c", ...partial });
}

describe("LogView", () => {
  test("sync 增量：只追加新消息，重复 sync 不重复", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: strToBytes("one") });
    expect(lv.sync(bus)).toBe(1);
    expect(lv.sync(bus)).toBe(0);
    feed(bus, { payload: strToBytes("two") });
    expect(lv.sync(bus)).toBe(1);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= one", "<= two"]);
  });

  test("tx 两类前缀 + sys 前缀", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { dir: "tx", source: "manual", payload: strToBytes("a") });
    feed(bus, { dir: "tx", source: "mcp", payload: strToBytes("b") });
    feed(bus, { dir: "sys", source: "system", payload: strToBytes("c") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["[手动发送] a", "[MCP发送] b", "[--] c"]);
    expect(lv.rows.map((r) => r.dir)).toEqual(["tx", "tx", "sys"]);
    expect(lv.rows.map((r) => r.prefixKind)).toEqual(["tx-manual", "tx-mcp", "sys"]);
    expect(lv.rows.map((r) => r.prefix)).toEqual(["[手动发送]", "[MCP发送]", "[--]"]);
  });

  test("setFormat 重排版（hex 切换）", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: new Uint8Array([0x41, 0x0d]) });
    lv.sync(bus);
    expect(lv.rows[0]!.text).toBe("<= A\r");
    lv.setFormat({ ...FORMAT, hex: true }, LABELS);
    expect(lv.rows[0]!.text).toBe("<= 41 0D");
    lv.setFormat({ ...FORMAT, timestamp: true }, LABELS);
    expect(lv.rows[0]!.text).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] <= A\r$/);
  });

  test("行数上限：丢最旧", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxRows: 3 });
    for (let i = 0; i < 5; i++) feed(bus, { payload: strToBytes(`m${i}`) });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= m2", "<= m3", "<= m4"]);
  });

  test("clear 后旧消息不复活，新消息继续", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: strToBytes("old") });
    lv.sync(bus);
    lv.clear(lv.lastSeenMsgId);
    expect(lv.rows.length).toBe(0);
    lv.sync(bus); // 总线里还有 old，但已见过
    expect(lv.rows.length).toBe(0);
    feed(bus, { payload: strToBytes("new") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= new"]);
  });

  test("自动换行：注入测量，按宽度折行", () => {
    // 等宽 fake：每字符 10px，宽 25px → 每行 2 字符
    const lv = new LogView(FORMAT, LABELS, {
      measure: () => 10,
      wrapWidth: () => 25,
    });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("abcdefgh") }); // "<= abcdefgh" 11 字符
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<=", " a", "bc", "de", "fg", "h"]);
    expect(lv.rows.every((r) => r.msgId === 1)).toBe(true);
    expect(lv.rows[0]!.prefixKind).toBe("rx");
    expect(lv.rows.slice(1).every((r) => r.prefixKind === "" && r.prefix === "")).toBe(true);
  });

  test("换行宽度变化后 refresh 重排", () => {
    let width = 25;
    const lv = new LogView(FORMAT, LABELS, { measure: () => 10, wrapWidth: () => width });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("abcd") });
    lv.sync(bus);
    expect(lv.rows.length).toBe(4); // "<=" " a" "bc" "d"
    width = 100;
    lv.refresh();
    expect(lv.rows.map((r) => r.text)).toEqual(["<= abcd"]);
  });

  test("无测量函数 = 不换行", () => {
    const lv = new LogView(FORMAT, LABELS, { wrapWidth: () => 10 });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("long line here") });
    lv.sync(bus);
    expect(lv.rows.length).toBe(1);
  });

  test("折行也受行数上限约束", () => {
    const lv = new LogView(FORMAT, LABELS, {
      maxRows: 4,
      measure: () => 10,
      wrapWidth: () => 20,
    });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("aaaa") });
    feed(bus, { payload: strToBytes("bbbb") });
    lv.sync(bus);
    expect(lv.rows.length).toBe(4);
  });
});
