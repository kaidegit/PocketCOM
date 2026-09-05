import { describe, expect, test } from "bun:test";
import { ParamError } from "./errors";
import { RingBuffer, type Message, type NewMessage } from "./message";

function msg(payload: number[], overrides: Partial<NewMessage> = {}): Message {
  return {
    id: 0,
    ts: 0,
    dir: "rx",
    source: "manual",
    payload: new Uint8Array(payload),
    connId: "c1",
    ...overrides,
  };
}

describe("RingBuffer", () => {
  test("默认上限：1000 帧 / 256 KiB", () => {
    const rb = new RingBuffer();
    expect(rb.capacity).toBe(1000);
    expect(rb.byteCapacity).toBe(256 * 1024);
  });

  test("push / peek / drain 基本语义", () => {
    const rb = new RingBuffer({ maxFrames: 3 });
    expect(rb.push(msg([1]))).toEqual([]);
    expect(rb.push(msg([2, 3]))).toEqual([]);
    expect(rb.size).toBe(2);
    expect(rb.bytes).toBe(3);
    const peeked = rb.peek();
    expect(peeked.map((m) => m.payload[0])).toEqual([1, 2]);
    const drained = rb.drain();
    expect(drained.map((m) => m.payload[0])).toEqual([1, 2]);
    expect(rb.size).toBe(0);
    expect(rb.bytes).toBe(0);
  });

  test("帧数溢出：丢最旧帧并返回被逐出帧", () => {
    const rb = new RingBuffer({ maxFrames: 2 });
    const a = msg([1]);
    const b = msg([2]);
    const c = msg([3]);
    rb.push(a);
    rb.push(b);
    const evicted = rb.push(c);
    expect(evicted).toEqual([a]);
    expect(rb.peek().map((m) => m.payload[0])).toEqual([2, 3]);
  });

  test("字节数溢出：按 payload.byteLength 计", () => {
    const rb = new RingBuffer({ maxFrames: 100, maxBytes: 4 });
    const a = msg([1, 2]); // 2 字节
    const b = msg([3, 4]); // 2 字节
    const c = msg([5]); // 1 字节 → 总量 5 > 4，逐出 a
    rb.push(a);
    rb.push(b);
    const evicted = rb.push(c);
    expect(evicted).toEqual([a]);
    expect(rb.bytes).toBe(3);
  });

  test("超大单帧：逐出所有旧帧乃至自身，不会死循环", () => {
    const rb = new RingBuffer({ maxFrames: 10, maxBytes: 4 });
    rb.push(msg([1]));
    const evicted = rb.push(msg([9, 9, 9, 9, 9]));
    expect(evicted.length).toBe(2);
    expect(rb.size).toBe(0);
  });

  test("非法上限抛 ParamError", () => {
    expect(() => new RingBuffer({ maxFrames: 0 })).toThrow(ParamError);
    expect(() => new RingBuffer({ maxBytes: -1 })).toThrow(ParamError);
  });
});
