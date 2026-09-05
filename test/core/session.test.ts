import { describe, expect, test } from "bun:test";
import { ComSession, describeNet, normalizeStopBits } from "../../core/session";
import { MessageBus } from "../../core/bus";
import { encodeBase64 } from "./testutil";
import type { Com, ComEvent, ComOpenResult, NetOpenParams, SerialOpenParams } from "../../bridge/com";
import { IoError, StateError } from "../../core/errors";

/** 确定性 fake Com：脚本化事件批，记录调用。 */
class FakeCom implements Com {
  opened: SerialOpenParams[] = [];
  netOpened: NetOpenParams[] = [];
  netOpenResult: ComOpenResult | null = null;
  netOpenThrows = false;
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
  netOpen(params: NetOpenParams): ComOpenResult | null {
    if (this.netOpenThrows) return null;
    if (this.netOpenResult) return this.netOpenResult;
    this.netOpened.push(params);
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
  cfgRead() {
    return null;
  }
  cfgWrite(_json: string) {
    return null;
  }
  cfgExport(_json: string) {
    return null;
  }
  cfgImport() {
    return null;
  }
  mcpStart(_params: { port: number; token: string }) {
    return null;
  }
  mcpStop() {
    return null;
  }
  mcpFeed(_lines: string[]) {
    return null;
  }
  mcpCmds() {
    return null;
  }
  mcpResults(_resultsJson: string) {
    return null;
  }
}

const PARAMS: SerialOpenParams = { path: "/dev/cu.test", baudRate: 9600 };
const TCP_PARAMS = { kind: "tcp" as const, host: "127.0.0.1", port: 9000, autoReconnect: false };
const TCPS_PARAMS = { kind: "tcps" as const, port: 9000 };

function setup() {
  const com = new FakeCom();
  const bus = new MessageBus();
  const states: string[] = [];
  let clientVersions = 0;
  const session = new ComSession(com, bus, {
    onStateChange: (_f, to) => states.push(to),
    onClientsChange: () => clientVersions++,
  });
  /** 注入一批事件并驱动一帧（app pumpSession 的测试镜像）。 */
  const frame = (now: number): void => {
    session.poll(com.poll(), now);
  };
  return { com, bus, session, states, frame, getClients: () => clientVersions };
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

describe("describeNet", () => {
  test("四类连接的人读摘要", () => {
    expect(describeNet({ kind: "tcp", host: "h", port: 1 })).toBe("tcp h:1");
    expect(describeNet({ kind: "tcps", port: 2 })).toBe("tcp-server :2");
    expect(describeNet({ kind: "udp", bindPort: 3, host: "h", port: 4 })).toBe("udp :3 → h:4");
    expect(describeNet({ kind: "ws", url: "ws://x" })).toBe("ws ws://x");
  });
});

describe("ComSession 串口状态机", () => {
  test("openSerial 成功：CONNECTING → CONNECTED，sys 事件入总线", () => {
    const { bus, session, states } = setup();
    session.openSerial(PARAMS);
    expect(session.state).toBe("CONNECTED");
    expect(states).toEqual(["CONNECTING", "CONNECTED"]);
    expect(session.connId).toBe("serial-1");
    const msgs = bus.buffer.drain();
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.dir).toBe("sys");
    expect(msgs[0]!.connId).toBe("serial-1");
  });

  test("openSerial 失败：回 DISCONNECTED 并抛 IoError（code 透传在 message 里）", () => {
    const { com, session, states } = setup();
    com.failOpen = { code: "io-error", msg: "opening /dev/cu.test: busy" };
    expect(() => session.openSerial(PARAMS)).toThrowError(/\[io-error\]/);
    expect(session.state).toBe("DISCONNECTED");
    expect(states).toEqual(["CONNECTING", "DISCONNECTED"]);
  });

  test("重复 open / 未连接 close/write 抛 StateError", () => {
    const { session } = setup();
    expect(() => session.close()).toThrow(StateError);
    expect(() => session.write(new Uint8Array([1]), "manual")).toThrow(StateError);
    session.openSerial(PARAMS);
    expect(() => session.openSerial(PARAMS)).toThrow(StateError);
  });

  test("close：flush 合流残余 → 宿主 close → DISCONNECTED", () => {
    const { com, bus, session } = setup();
    session.openSerial(PARAMS);
    // 残余未合流字节：close 时 flush 成帧入总线
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([65])) }]);
    session.poll(com.poll(), 0);
    session.close();
    expect(session.state).toBe("DISCONNECTED");
    expect(com.closedHandles).toEqual([1]);
    const msgs = bus.buffer.drain();
    expect(msgs.map((m) => m.dir)).toEqual(["sys", "rx", "sys"]);
  });

  test("LOST 状态下 close = 确认掉线：不重复关闭句柄，转 DISCONNECTED + sys", () => {
    const { com, session } = setup();
    session.openSerial(PARAMS);
    com.pushBatch([{ t: "closed", h: 1, reason: "unplugged" }]);
    session.poll(com.poll(), 0);
    expect(session.state).toBe("LOST");
    session.close();
    expect(session.state).toBe("DISCONNECTED");
    expect(com.closedHandles).toEqual([]);
  });
});

describe("ComSession 串口数据通路", () => {
  test("data 事件 → b64 解码 → 合流成帧 → bus rx + 计数", () => {
    const { com, bus, session } = setup();
    session.openSerial(PARAMS);
    // 9600 8N1：阈值 ≈ 2.29ms。t=0 收到 [72,105]；t=10 超过阈值先产出第一帧；
    // t=12 间隔 2ms 未超阈值，与残余合流；t=20 静默超时产出第二帧。
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([72, 105])) }]);
    session.poll(com.poll(), 0);
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([33])) }]);
    session.poll(com.poll(), 10);
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([10])) }]);
    session.poll(com.poll(), 12);
    session.poll([], 20); // 静默超时：产出残余帧 [33,10]
    const msgs = bus.buffer.drain().filter((m) => m.dir === "rx");
    expect(msgs.length).toBe(2);
    expect([...msgs[0]!.payload]).toEqual([72, 105]);
    expect([...msgs[1]!.payload]).toEqual([33, 10]);
    expect(session.rxBytes).toBe(4);
  });

  test("write：先写宿主再入总线（dir tx + source），txBytes 计数", () => {
    const { com, bus, session } = setup();
    session.openSerial(PARAMS);
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
    session.openSerial(PARAMS);
    com.pushBatch([{ t: "closed", h: 1, reason: "unplugged" }]);
    session.poll(com.poll(), 100);
    expect(session.state).toBe("LOST");
    expect(states).toEqual(["CONNECTING", "CONNECTED", "LOST"]);
    const sys = bus.buffer.drain().filter((m) => m.dir === "sys");
    expect(sys.some((m) => /unplugged/.test(new TextDecoder().decode(m.payload)))).toBe(true);
    // 同一 handle 的迟到事件不再产生新状态
    com.pushBatch([{ t: "closed", h: 1, reason: "again" }]);
    session.poll(com.poll(), 200);
    expect(states.length).toBe(3);
  });

  test("error 事件记 sys；随后的 closed 事件收尾 LOST", () => {
    const { com, bus, session } = setup();
    session.openSerial(PARAMS);
    com.pushBatch([
      { t: "error", h: 1, code: "io-error", msg: "broken pipe" },
      { t: "closed", h: 1, reason: "broken pipe" },
    ]);
    session.poll(com.poll(), 50);
    expect(session.state).toBe("LOST");
    const sys = bus.buffer.drain().filter((m) => m.dir === "sys");
    expect(sys.some((m) => /io-error/.test(new TextDecoder().decode(m.payload)))).toBe(true);
  });

  test("malformed b64 事件丢帧不 crash", () => {
    const { com, session } = setup();
    session.openSerial(PARAMS);
    com.pushBatch([{ t: "data", h: 1, b64: "!!!not-base64!!!" }]);
    expect(() => session.poll(com.poll(), 0)).not.toThrow();
    expect(session.rxBytes).toBe(0);
  });

  test("setSignals 仅串口连接生效，连接前后均可调", () => {
    const { com, session } = setup();
    session.setSignals({ dtr: true }); // 未连接：静默忽略
    expect(com.signals.length).toBe(0);
    session.openSerial(PARAMS);
    session.setSignals({ dtr: true, rts: false });
    expect(com.signals.length).toBe(1);
  });
});

describe("ComSession 网络连接（异步打开）", () => {
  test("tcp：openNet → CONNECTING；opened 事件 → CONNECTED；1ms 网络合帧", () => {
    const { com, bus, session, states } = setup();
    session.openNet({ ...TCP_PARAMS });
    expect(session.state).toBe("CONNECTING");
    expect(session.connId).toBe("tcp-1");
    com.pushBatch([{ t: "opened", h: 1, addr: "127.0.0.1:9000" }]);
    session.poll(com.poll(), 0);
    expect(session.state).toBe("CONNECTED");
    expect(states).toEqual(["CONNECTING", "CONNECTED"]);
    expect(session.describe).toBe("tcp 127.0.0.1:9000");
    // network 模式阈值 1ms：间隔 >1ms 分帧
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([1])) }]);
    session.poll(com.poll(), 100);
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([2])) }]);
    session.poll(com.poll(), 102);
    com.pushBatch([{ t: "data", h: 1, b64: encodeBase64(new Uint8Array([3])) }]);
    session.poll(com.poll(), 103);
    session.poll([], 110); // 静默超时产出残余帧 [2,3]
    const rx = bus.buffer.drain().filter((m) => m.dir === "rx");
    expect(rx.length).toBe(2);
    expect([...rx[0]!.payload]).toEqual([1]);
    expect([...rx[1]!.payload]).toEqual([2, 3]);
  });

  test("tcp：连接期失败（error+closed）→ LOST；无自动重连时停留 LOST", () => {
    const { com, session, states } = setup();
    session.openNet({ ...TCP_PARAMS });
    com.pushBatch([
      { t: "error", h: 1, code: "io-error", msg: "connecting 127.0.0.1:9000: refused" },
      { t: "closed", h: 1, reason: "connecting 127.0.0.1:9000: refused" },
    ]);
    session.poll(com.poll(), 1000);
    expect(session.state).toBe("LOST");
    expect(states).toEqual(["CONNECTING", "LOST"]);
  });

  test("tcp：自动重连到点重开（新 connId），重开成功回 CONNECTED", () => {
    const { com, session, states } = setup();
    session.openNet({ ...TCP_PARAMS, autoReconnect: true, reconnectSec: 2 });
    com.pushBatch([{ t: "opened", h: 1, addr: "a" }]);
    session.poll(com.poll(), 0);
    com.pushBatch([{ t: "closed", h: 1, reason: "reset" }]);
    session.poll(com.poll(), 100);
    expect(session.state).toBe("LOST");
    // 间隔未到：不重试
    session.poll([], 100 + 2 * 1000 - 1);
    expect(states.filter((s) => s === "CONNECTING")).toHaveLength(1);
    // 到点：LOST → CONNECTING（宿主新句柄 2）→ opened → CONNECTED
    session.poll([], 100 + 2 * 1000);
    expect(states).toEqual(["CONNECTING", "CONNECTED", "LOST", "CONNECTING"]);
    expect(session.connId).toBe("tcp-2");
    com.pushBatch([{ t: "opened", h: 2, addr: "a" }]);
    session.poll(com.poll(), 3001);
    expect(session.state).toBe("CONNECTED");
  });

  test("tcp：用户 close 在 LOST 后确认掉线并清除重连计划", () => {
    const { com, session } = setup();
    session.openNet({ ...TCP_PARAMS, autoReconnect: true, reconnectSec: 1 });
    com.pushBatch([{ t: "closed", h: 1, reason: "reset" }]);
    session.poll(com.poll(), 0);
    session.close();
    expect(session.state).toBe("DISCONNECTED");
    session.poll([], 100000);
    expect(session.state).toBe("DISCONNECTED"); // 不再重试
  });

  test("udp：bindPort 透传宿主；ws：url 透传", () => {
    const { com, session } = setup();
    session.openNet({ kind: "udp", bindPort: 8000, host: "127.0.0.1", port: 9000 });
    session.openNet;
    expect(com.netOpened[0]).toEqual({ kind: "udp", bindPort: 8000, host: "127.0.0.1", port: 9000 });
    session.close();
    session.openNet({ kind: "ws", url: "ws://x/y" });
    expect(com.netOpened[1]).toEqual({ kind: "ws", url: "ws://x/y" });
  });

  test("宿主无网络桥（netOpen → null）→ IoError，回 DISCONNECTED", () => {
    const { com, session } = setup();
    com.netOpenThrows = true;
    expect(() => session.openNet({ ...TCP_PARAMS })).toThrow(IoError);
    expect(session.state).toBe("DISCONNECTED");
  });

  test("宿主拒绝（结构化错误）→ IoError 且 message 携带 code", () => {
    const { com, session } = setup();
    com.netOpenResult = { ok: false, code: "io-error", msg: "binding 0.0.0.0:80: denied" };
    expect(() => session.openNet(TCPS_PARAMS)).toThrowError(/\[io-error\]/);
    expect(session.state).toBe("DISCONNECTED");
  });
});

describe("ComSession TCP Server 客户端管理", () => {
  test("accepted → 客户端入表 + onClientsChange；广播写监听句柄；定向写子句柄", () => {
    const { com, bus, session, getClients } = setup();
    session.openNet({ ...TCPS_PARAMS });
    com.pushBatch([{ t: "opened", h: 1, addr: "0.0.0.0:9000" }]);
    session.poll(com.poll(), 0);
    com.pushBatch([{ t: "accepted", h: 1, c: 2, addr: "127.0.0.1:1111" }]);
    session.poll(com.poll(), 1);
    expect(session.clientsInfo()).toEqual([{ handle: 2, addr: "127.0.0.1:1111" }]);
    expect(getClients()).toBeGreaterThan(0);
    // 广播：写监听句柄（宿主扇出）
    const before = com.writes.length;
    session.write(new Uint8Array([9]), "manual");
    expect(com.writes[before]!.h).toBe(1);
    // 定向：写子句柄
    session.write(new Uint8Array([8]), "manual", 2);
    expect(com.writes[before + 1]!.h).toBe(2);
    expect(session.txBytes).toBe(2);
    expect(bus.buffer.drain().filter((m) => m.dir === "tx").length).toBe(2);
  });

  test("客户端断开（closed 子句柄）→ 摘除 + sys；kick 调宿主 close", () => {
    const { com, session, getClients } = setup();
    session.openNet({ ...TCPS_PARAMS });
    com.pushBatch([{ t: "opened", h: 1, addr: "0.0.0.0:9000" }]);
    session.poll(com.poll(), 0);
    com.pushBatch([{ t: "accepted", h: 1, c: 2, addr: "127.0.0.1:1111" }]);
    session.poll(com.poll(), 1);
    com.pushBatch([{ t: "closed", h: 2, reason: "peer closed" }]);
    session.poll(com.poll(), 2);
    expect(session.clientsInfo()).toEqual([]);
    expect(getClients()).toBeGreaterThanOrEqual(2);
    // 再接入一个后 kick
    com.pushBatch([{ t: "accepted", h: 1, c: 3, addr: "127.0.0.1:2222" }]);
    session.poll(com.poll(), 3);
    session.kick(3);
    expect(com.closedHandles).toEqual([3]);
    expect(session.clientsInfo()).toEqual([]);
  });

  test("close 关监听句柄；子句柄的迟到事件被忽略", () => {
    const { com, session } = setup();
    session.openNet({ ...TCPS_PARAMS });
    com.pushBatch([{ t: "opened", h: 1, addr: "0.0.0.0:9000" }]);
    session.poll(com.poll(), 0);
    com.pushBatch([{ t: "accepted", h: 1, c: 2, addr: "a" }]);
    session.poll(com.poll(), 1);
    session.close();
    expect(com.closedHandles).toEqual([1]);
    com.pushBatch([{ t: "data", h: 2, b64: encodeBase64(new Uint8Array([1])) }]);
    expect(() => session.poll(com.poll(), 2)).not.toThrow();
    expect(session.rxBytes).toBe(0);
  });
});
