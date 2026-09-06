import { describe, expect, test } from "bun:test";
import { isVisibleToMcp, MessageBus } from "../../core/bus";
import type { Message } from "../../core/message";

function makeBus(now: () => number = () => 1000): MessageBus {
  return new MessageBus({ now, maxFrames: 100, maxBytes: 1024 * 1024 });
}

function rx(bus: MessageBus, text: string, connId = "c1"): Message {
  return bus.append({ dir: "rx", source: "manual", payload: new TextEncoder().encode(text), connId });
}

describe("MessageBus", () => {
  test("append 分配单调递增 id 与注入的 ts", () => {
    let t = 100;
    const bus = makeBus(() => (t += 10));
    const m1 = rx(bus, "a");
    const m2 = rx(bus, "b");
    expect(m1.id).toBe(1);
    expect(m2.id).toBe(2);
    expect(m1.ts).toBe(110);
    expect(m2.ts).toBe(120);
  });

  test("订阅者同步收到消息，可取消订阅", () => {
    const bus = makeBus();
    const seen: number[] = [];
    const off = bus.subscribe((m) => seen.push(m.id));
    rx(bus, "a");
    rx(bus, "b");
    expect(seen).toEqual([1, 2]);
    off();
    rx(bus, "c");
    expect(seen).toEqual([1, 2]);
  });

  test("订阅者抛异常不影响其他订阅者与缓冲写入", () => {
    const bus = makeBus();
    const errors: unknown[] = [];
    const bus2 = new MessageBus({
      now: () => 0,
      onSubscriberError: (err) => errors.push(err),
    });
    const seen: number[] = [];
    bus2.subscribe(() => {
      throw new Error("boom");
    });
    bus2.subscribe((m) => seen.push(m.id));
    bus2.append({ dir: "rx", source: "manual", payload: new Uint8Array([1]), connId: "c" });
    expect(seen).toEqual([1]);
    expect(errors.length).toBe(1);
    expect(bus2.buffer.size).toBe(1);
    void bus;
  });

  test("缓冲溢出静默丢最旧帧，不注入 sys 事件（历史裁剪属正常行为）", () => {
    const events: Message[] = [];
    const bus = new MessageBus({ now: () => 0, maxFrames: 2 });
    bus.subscribe((m) => events.push(m));
    bus.append({ dir: "rx", source: "manual", payload: new Uint8Array([1]), connId: "c" });
    bus.append({ dir: "rx", source: "manual", payload: new Uint8Array([2]), connId: "c" });
    bus.append({ dir: "rx", source: "manual", payload: new Uint8Array([3]), connId: "c" });
    expect(bus.buffer.peek().map((m) => m.id)).toEqual([2, 3]);
    expect(events.map((m) => m.dir)).toEqual(["rx", "rx", "rx"]);
  });

  test("满缓冲稳态：持续 append 尺寸稳定在 maxFrames，无 sys 事件产生", () => {
    const bus = new MessageBus({ now: () => 0, maxFrames: 3 });
    const sysEvents: Message[] = [];
    bus.subscribe((m) => {
      if (m.dir === "sys") sysEvents.push(m);
    });
    for (let i = 0; i < 20; i++) {
      bus.append({ dir: "rx", source: "manual", payload: new Uint8Array([i]), connId: "c" });
    }
    expect(bus.buffer.size).toBe(3);
    expect(bus.buffer.peek().map((m) => m.id)).toEqual([18, 19, 20]);
    expect(sysEvents.length).toBe(0);
  });

  test("drainForMcp：RX + 手动 TX + sys，不含 mcp 的 TX", () => {
    const bus = makeBus();
    bus.append({ dir: "rx", source: "manual", payload: new Uint8Array([1]), connId: "c" });
    bus.append({ dir: "tx", source: "manual", payload: new Uint8Array([2]), connId: "c" });
    bus.append({ dir: "tx", source: "mcp", payload: new Uint8Array([3]), connId: "c" });
    bus.append({ dir: "tx", source: "timer", payload: new Uint8Array([4]), connId: "c" });
    bus.append({ dir: "sys", source: "system", payload: new Uint8Array([5]), connId: "c" });

    const drained = bus.drainForMcp();
    expect(drained.map((m) => m.payload[0])).toEqual([1, 2, 4, 5]);
    // 默认取空
    expect(bus.buffer.size).toBe(0);
  });

  test("isVisibleToMcp：mcp 来源的 TX 不可见，其余可见", () => {
    const base = { id: 1, ts: 0, payload: new Uint8Array(0), connId: "c" };
    expect(isVisibleToMcp({ ...base, dir: "rx", source: "mcp" })).toBe(true);
    expect(isVisibleToMcp({ ...base, dir: "sys", source: "system" })).toBe(true);
    expect(isVisibleToMcp({ ...base, dir: "tx", source: "manual" })).toBe(true);
    expect(isVisibleToMcp({ ...base, dir: "tx", source: "mcp" })).toBe(false);
  });
});
