// test/bridge/serial.test.ts — bridge/serial.ts 封装语义（fake 宿主命名
// 空间，无硬件；硬件回环见 test/host/macos/serial_loopback.rs）。
import { afterEach, describe, expect, test } from "bun:test";
import { connectCom } from "../../bridge/com";
import { makeNs, setHost } from "./testutil";

describe("serial ops", () => {
  afterEach(() => {
    setHost(undefined);
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
      msg: "open failed", // serial/net 共用解析器，兜底文案中性
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
});
