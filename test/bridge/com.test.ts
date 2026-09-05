// test/bridge/com.test.ts — bridge/com.ts connectCom() 封装语义（fake 宿主
// 命名空间，无硬件；硬件回环见 test/host/macos/com_loopback.rs）。
import { afterEach, describe, expect, test } from "bun:test";
import { connectCom, type ComEvent } from "../../bridge/com";

/** globalThis.com 的宿主侧形状（bridge/com.ts 内部 ComNs 的测试镜像）。 */
interface FakeNs {
  serialList(): string;
  serialOpen(paramsJson: string): string;
  write(handle: number, bytes: Uint8Array): boolean;
  setSignals(handle: number, pinsJson: string): boolean;
  close(handle: number): boolean;
  poll(): string | null;
}

function setHost(ns: FakeNs | undefined): void {
  (globalThis as { com?: FakeNs | undefined }).com = ns;
}

/** 方法齐全的合法宿主命名空间，默认全部成功；用 overrides 覆写关注点。 */
function makeNs(overrides: Partial<FakeNs> = {}): FakeNs {
  return {
    serialList: () => "[]",
    serialOpen: () => JSON.stringify({ handle: 1 }),
    write: () => true,
    setSignals: () => true,
    close: () => true,
    poll: () => null,
    ...overrides,
  };
}

describe("connectCom", () => {
  afterEach(() => {
    setHost(undefined);
  });

  test("无 com 命名空间或方法缺失 → null（stock 宿主降级）", () => {
    expect(connectCom()).toBeNull();
    setHost({ serialList: () => "[]" } as unknown as FakeNs); // 只有 1/6 方法
    expect(connectCom()).toBeNull();
  });

  test("serialList：数组透传；错误对象与畸形 JSON 降级为 []", () => {
    setHost(
      makeNs({
        serialList: () =>
          JSON.stringify([{ path: "/dev/cu.x", description: "USB serial device", vid: 0x1a86 }]),
      }),
    );
    expect(connectCom()!.serialList()).toEqual([
      { path: "/dev/cu.x", description: "USB serial device", vid: 0x1a86 },
    ]);

    setHost(
      makeNs({ serialList: () => JSON.stringify({ error: { code: "io-error", msg: "boom" } }) }),
    );
    expect(connectCom()!.serialList()).toEqual([]);

    setHost(makeNs({ serialList: () => "{not json" }));
    expect(connectCom()!.serialList()).toEqual([]);
  });

  test("serialOpen：handle → ok；error 结构透传；缺省字段兜底", () => {
    setHost(makeNs({ serialOpen: () => JSON.stringify({ handle: 3 }) }));
    expect(connectCom()!.serialOpen({ path: "/dev/cu.x", baudRate: 115200 })).toEqual({
      ok: true,
      handle: 3,
    });

    setHost(
      makeNs({ serialOpen: () => JSON.stringify({ error: { code: "io-error", msg: "gone" } }) }),
    );
    expect(connectCom()!.serialOpen({ path: "/dev/cu.x", baudRate: 115200 })).toEqual({
      ok: false,
      code: "io-error",
      msg: "gone",
    });

    setHost(makeNs({ serialOpen: () => JSON.stringify({ error: {} }) }));
    expect(connectCom()!.serialOpen({ path: "/dev/cu.x", baudRate: 115200 })).toEqual({
      ok: false,
      code: "unknown",
      msg: "serialOpen failed",
    });
  });

  test("serialOpen：宿主返回畸形 JSON → bridge-error", () => {
    setHost(makeNs({ serialOpen: () => "{broken" }));
    expect(connectCom()!.serialOpen({ path: "/dev/cu.x", baudRate: 115200 })).toEqual({
      ok: false,
      code: "bridge-error",
      msg: "host returned malformed json",
    });
  });

  test("serialOpen 参数以 JSON 字符串转交宿主", () => {
    let seen = "";
    setHost(
      makeNs({
        serialOpen: (p) => {
          seen = p;
          return JSON.stringify({ handle: 1 });
        },
      }),
    );
    const params = { path: "/dev/cu.x", baudRate: 9600, parity: "even" } as const;
    connectCom()!.serialOpen(params);
    expect(JSON.parse(seen)).toEqual(params);
  });

  test("write / close 直通布尔", () => {
    setHost(makeNs({ write: (_h, bytes) => bytes.length === 0, close: (h) => h === 7 }));
    const com = connectCom()!;
    expect(com.write(1, new Uint8Array([1]))).toBe(false);
    expect(com.write(1, new Uint8Array(0))).toBe(true);
    expect(com.close(7)).toBe(true);
    expect(com.close(8)).toBe(false);
  });

  test("setSignals：pins 序列化为 JSON 转交宿主，返回值直通", () => {
    let seen = "";
    setHost(
      makeNs({
        setSignals: (h, pins) => {
          seen = pins;
          return h === 1;
        },
      }),
    );
    expect(connectCom()!.setSignals(1, { dtr: true, rts: false })).toBe(true);
    expect(JSON.parse(seen)).toEqual({ dtr: true, rts: false });
    expect(connectCom()!.setSignals(2, { rts: true })).toBe(false);
  });

  test("poll：null → []；多行批次解析；坏行与空行跳过", () => {
    setHost(makeNs({ poll: () => null }));
    expect(connectCom()!.poll()).toEqual([]);

    const data: ComEvent = { t: "data", h: 1, b64: "SGk=" };
    const closed: ComEvent = { t: "closed", h: 1, reason: "unplugged" };
    setHost(
      makeNs({
        poll: () => [JSON.stringify(data), "{broken", "", JSON.stringify(closed)].join("\n"),
      }),
    );
    expect(connectCom()!.poll()).toEqual([data, closed]);
  });
});
