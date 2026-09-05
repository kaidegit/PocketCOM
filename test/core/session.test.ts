import { describe, expect, test } from "bun:test";
import { normalizeStopBits, SerialSession } from "../../core/session";
import { MessageBus } from "../../core/bus";
import { encodeBase64 } from "./testutil";
import type { Com, ComEvent, SerialOpenParams } from "../../bridge/com";
import { StateError } from "../../core/errors";

/** 确定性 fake Com：脚本化事件批，记录调用。 */
class FakeCom implements Com {
  opened: SerialOpenParams[] = [];
  closedHandles: number[] = [];
  writes: { h: number; bytes: Uint8Array }[] = [];
  signals: { h: number; pins: string }[] = [];
  failOpen: { code: string; msg: string } | null = null;
  nextHandle = 1;
  private batches: ComEvent[][] = [];

  pushBatch(ev: ComEvent[]): void {
    this.batches.push(ev);
  }

  serialList() {
    return [];
  }
  serialOpen(params: SerialOpenParams) {
    if (this.failOpen) return { ok: false as const, ...this.failOpen };
    this.opened.push(params);
    return { ok: true as const, handle: this.nextHandle++ };
  }
  write(handle: number, bytes: Uint8Array) {
    this.writes.push({ h: handle, bytes });
    return true;
  }
  setSignals(handle: number, pins: { dtr?: boolean; rts?: boolean }) {
    this.signals.push({ h: handle, pins: JSON.stringify(pins) });
    return true;
  }
  close(handle: number) {
    this.closedHandles.push(handle);
    return true;
  }
  poll(): ComEvent[] {
    return this.batches.shift() ?? [];
  }
}

const PARAMS: SerialOpenParams = { path: "/dev/cu.test", baudRate: 9600 };

function setup() {
  const com = new FakeCom();
  const bus = new MessageBus();
  const states: string[] = [];
  const session = new SerialSession(com, bus, {
    onStateChange: (_f, to) => states.push(to),
  });
  return { com, bus, session, states };
}

describe("normalizeStopBits", () => {
  test("1 / \"1\" / \"1.5\" → 1；2 / \"2\" → 2", () => {
    expect(normalizeStopBits(1)).toBe(1);
    expect(normalizeStopBits("1")).toBe(1);
    expect(normalizeStopBits("1.5")).toBe(1);
    expect(normalizeStopBits(2)).toBe(2);
    expect(normalizeStopBits("2")).toBe(2);
  });
});

describe("SerialSession 状态机", () => {
  test("open 成功：CONNECTING → CONNECTED，sys 事件入总线", () => {
    const { bus, session, states } = setup();
    session.open(PARAMS);
    expect(session.state).toBe("CONNECTED");
    expect(states).toEqual(["CONNECTING", "CONNECTED"]);
    const msgs = bus.buffer.drain();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.dir).toBe("sys");
    expect(msgs[0]!.connId).toBe("serial-1");
  });

  test("open 失败：回 DISCONNECTED 并抛 IoError（code 透传在 message 里）", () => {
    const { com, session, states } = setup();
    com.failOpen = { code: "io-error", msg: "opening /dev/cu.test: busy" };
    expect(() => session.open(PARAMS)).toThrowError(/\[io-error\]/);
    expect(session.state).toBe("DISCONNECTED");
    expect(states).toEqual(["CONNECTING", "DISCONNECTED"]);
  });

  test("重复 open / 未连接 close/write 抛 StateError", () => {
    const { session } = setup();
    expect(() => session.close()).toThrow(StateError);
    expect(() => session.write(new Uint8Array([1]), "manual")).toThrow(StateError);
    session.open(PARAMS);
    expect(() => session.open(PARAMS)).toThrow(StateError);
  });

  test("close：flush 合流残余 → 宿主 close → DISCONNECTED", () => {
    const { com, bus, session } = setup();
    session.open(PARAMS);
    // 残余未合流字节：close 时 flush 成帧入总线
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([65])) }]);
    session.poll(0);
    session.close();
    expect(session.state).toBe("DISCONNECTED");
    expect(com.closedHandles).toEqual([1]);
    const msgs = bus.buffer.drain();
    expect(msgs.map((m) => m.dir)).toEqual(["sys", "rx", "sys"]);
  });

  test("LOST 状态下 close = 确认掉线：不重复关闭句柄，转 DISCONNECTED + sys", () => {
    const { com, session } = setup();
    session.open(PARAMS);
    com.pushBatch([{ t: "closed", h: 1, reason: "unplugged" }]);
    session.poll(0);
    expect(session.state).toBe("LOST");
    session.close();
    expect(session.state).toBe("DISCONNECTED");
    expect(com.closedHandles).toEqual([]);
  });
});

describe("SerialSession 数据通路", () => {
  test("data 事件 → b64 解码 → 合流成帧 → bus rx + 计数", () => {
    const { com, bus, session } = setup();
    session.open(PARAMS);
    // 9600 8N1：阈值 ≈ 2.29ms。t=0 收到 [72,105]；t=10 超过阈值先产出第一帧；
    // t=12 间隔 2ms 未超阈值，与残余合流；t=20 静默超时产出第二帧。
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([72, 105])) }]);
    session.poll(0);
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([33])) }]);
    session.poll(10);
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([10])) }]);
    session.poll(12);
    session.poll(20); // 静默超时：产出残余帧 [33,10]
    const msgs = bus.buffer.drain().filter((m) => m.dir === "rx");
    expect(msgs.length).toBe(2);
    expect([...msgs[0]!.payload]).toEqual([72, 105]);
    expect([...msgs[1]!.payload]).toEqual([33, 10]);
    expect(session.rxBytes).toBe(4);
  });

  test("write：先写宿主再入总线（dir tx + source），txBytes 计数", () => {
    const { com, bus, session } = setup();
    session.open(PARAMS);
    const before = com.writes.length;
    session.write(new Uint8Array([1, 2, 3]), "manual");
    expect(com.writes.length).toBe(before + 1);
    expect([...com.writes[before]!.bytes]).toEqual([1, 2, 3]);
    const tx = bus.buffer.drain().filter((m) => m.dir === "tx");
    expect(tx.length).toBe(1);
    expect(tx[0]!.source).toBe("manual");
    expect(session.txBytes).toBe(3);
  });

  test("closed 事件 → LOST + sys 事件，迟到事件忽略", () => {
    const { com, bus, session, states } = setup();
    session.open(PARAMS);
    com.pushBatch([{ t: "closed", h: 1, reason: "unplugged" }]);
    session.poll(100);
    expect(session.state).toBe("LOST");
    expect(states).toEqual(["CONNECTING", "CONNECTED", "LOST"]);
    const sys = bus.buffer.drain().filter((m) => m.dir === "sys");
    expect(sys.some((m) => /unplugged/.test(new TextDecoder().decode(m.payload)))).toBe(true);
    // 同一 handle 的迟到事件不再产生新状态
    com.pushBatch([{ t: "closed", h: 1, reason: "again" }]);
    session.poll(200);
    expect(states.length).toBe(3);
  });

  test("error 事件记 sys；随后的 closed 事件收尾 LOST", () => {
    const { com, bus, session } = setup();
    session.open(PARAMS);
    com.pushBatch([
      { t: "error", h: 1, code: "io-error", msg: "broken pipe" },
      { t: "closed", h: 1, reason: "broken pipe" },
    ]);
    session.poll(50);
    expect(session.state).toBe("LOST");
    const sys = bus.buffer.drain().filter((m) => m.dir === "sys");
    expect(sys.some((m) => /io-error/.test(new TextDecoder().decode(m.payload)))).toBe(true);
  });

  test("malformed b64 事件丢帧不 crash", () => {
    const { com, session } = setup();
    session.open(PARAMS);
    com.pushBatch([{ t: "data", h: 1, b64: "!!!not-base64!!!" }]);
    expect(() => session.poll(0)).not.toThrow();
    expect(session.rxBytes).toBe(0);
  });

  test("setSignals 连接前后均可调", () => {
    const { com, session } = setup();
    session.setSignals({ dtr: true }); // 未连接：静默忽略
    expect(com.signals.length).toBe(0);
    session.open(PARAMS);
    session.setSignals({ dtr: true, rts: false });
    expect(com.signals.length).toBe(1);
  });
});
