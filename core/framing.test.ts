import { describe, expect, test } from "bun:test";
import { computeByteTimeMs, FrameCoalescer } from "./framing";
import { ParamError } from "./errors";

function collector(): { frames: Uint8Array[]; onFrame: (f: Uint8Array) => void } {
  const frames: Uint8Array[] = [];
  return { frames, onFrame: (f) => frames.push(f) };
}

describe("computeByteTimeMs", () => {
  test("9600 / 8 数据位 / 1 停止位 → 每帧 11 位", () => {
    // 1000 / (9600 / 11) ≈ 1.145833 ms
    expect(computeByteTimeMs({ baudRate: 9600, byteSize: 8, stopBits: 1 })).toBeCloseTo(1.145833, 4);
  });

  test("非法参数抛 ParamError", () => {
    expect(() => computeByteTimeMs({ baudRate: 0, byteSize: 8, stopBits: 1 })).toThrow(ParamError);
  });
});

describe("FrameCoalescer（network 模式，固定 1ms）", () => {
  test("tick 静默超时产出帧", () => {
    const c = collector();
    const fc = new FrameCoalescer({ mode: "network", onFrame: c.onFrame });
    fc.feed(new Uint8Array([1, 2, 3]), 0);
    expect(c.frames.length).toBe(0);
    fc.tick(0.5);
    expect(c.frames.length).toBe(0); // 未超过 1ms
    fc.tick(1.1);
    expect(c.frames.length).toBe(1);
    expect([...c.frames[0]!]).toEqual([1, 2, 3]);
    expect(fc.pendingBytes).toBe(0);
  });

  test("feed 间隔超过阈值先产出已累积帧", () => {
    const c = collector();
    const fc = new FrameCoalescer({ mode: "network", onFrame: c.onFrame });
    fc.feed(new Uint8Array([1]), 0);
    fc.feed(new Uint8Array([2]), 2); // 间隔 2ms > 1ms → 先产出 [1]
    expect(c.frames.length).toBe(1);
    expect([...c.frames[0]!]).toEqual([1]);
    fc.flush();
    expect(c.frames.length).toBe(2);
    expect([...c.frames[1]!]).toEqual([2]);
  });

  test("间隔未超阈值则继续累积（同一帧内多个 feed）", () => {
    const c = collector();
    const fc = new FrameCoalescer({ mode: "network", onFrame: c.onFrame });
    fc.feed(new Uint8Array([1]), 0);
    fc.feed(new Uint8Array([2]), 0.5);
    fc.feed(new Uint8Array([3]), 0.9);
    fc.tick(2);
    expect(c.frames.length).toBe(1);
    expect([...c.frames[0]!]).toEqual([1, 2, 3]);
  });
});

describe("FrameCoalescer（serial 模式，2× 单字节时间）", () => {
  test("阈值 = 2 × 单字节时间", () => {
    const c = collector();
    const fc = new FrameCoalescer({
      mode: "serial",
      serial: { baudRate: 9600, byteSize: 8, stopBits: 1 },
      onFrame: c.onFrame,
    });
    // 阈值 ≈ 2.291667ms
    expect(fc.thresholdMs).toBeCloseTo(2.291667, 4);
    fc.feed(new Uint8Array([0x48, 0x65]), 0);
    fc.tick(2.0);
    expect(c.frames.length).toBe(0);
    fc.tick(2.4);
    expect(c.frames.length).toBe(1);
    expect([...c.frames[0]!]).toEqual([0x48, 0x65]);
  });

  test("高波特率阈值按公式缩小", () => {
    const c = collector();
    const fc = new FrameCoalescer({
      mode: "serial",
      serial: { baudRate: 115200, byteSize: 8, stopBits: 1 },
      onFrame: c.onFrame,
    });
    expect(fc.thresholdMs).toBeCloseTo(2 * (1000 / (115200 / 11)), 6);
  });

  test("serial 模式缺参数抛 ParamError", () => {
    expect(
      () => new FrameCoalescer({ mode: "serial", onFrame: () => {} }),
    ).toThrow(ParamError);
  });
});

describe("FrameCoalescer（其他）", () => {
  test("空 feed 不触发任何事", () => {
    const c = collector();
    const fc = new FrameCoalescer({ mode: "network", onFrame: c.onFrame });
    fc.feed(new Uint8Array(0), 0);
    expect(fc.pendingBytes).toBe(0);
    fc.flush();
    expect(c.frames.length).toBe(0);
  });

  test("flush 强制产出，重复 flush 安全", () => {
    const c = collector();
    const fc = new FrameCoalescer({ mode: "network", onFrame: c.onFrame });
    fc.feed(new Uint8Array([9]), 0);
    fc.flush();
    fc.flush();
    expect(c.frames.length).toBe(1);
    expect([...c.frames[0]!]).toEqual([9]);
  });
});
