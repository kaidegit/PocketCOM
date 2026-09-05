// test/bridge/net.test.ts — bridge/net.ts 封装语义（fake 宿主命名空间；
// 宿主侧回环见 test/host/macos/tcp_tests.rs / udp_tests.rs）。
import { afterEach, describe, expect, test } from "bun:test";
import { connectCom, type NetOpenParams } from "../../bridge/com";
import { makeNs, setHost } from "./testutil";

describe("net ops", () => {
  afterEach(() => {
    setHost(undefined);
  });

  test("netOpen：按 kind 分发宿主 op，且剥离会话侧字段（kind/重连策略）", () => {
    const seen: Record<string, string> = {};
    setHost(
      makeNs({
        tcpConnect: (p) => {
          seen.tcpConnect = p;
          return JSON.stringify({ handle: 4 });
        },
        tcpListen: (p) => {
          seen.tcpListen = p;
          return JSON.stringify({ handle: 5 });
        },
        udpBind: (p) => {
          seen.udpBind = p;
          return JSON.stringify({ handle: 6 });
        },
        wsConnect: (p) => {
          seen.wsConnect = p;
          return JSON.stringify({ error: { code: "io-error", msg: "handshake" } });
        },
      }),
    );
    const com = connectCom()!;
    expect(com.netOpen({ kind: "tcp", host: "h", port: 1 })).toEqual({ ok: true, handle: 4 });
    expect(JSON.parse(seen.tcpConnect!)).toEqual({ host: "h", port: 1 });
    expect(com.netOpen({ kind: "tcps", port: 2 })).toEqual({ ok: true, handle: 5 });
    expect(JSON.parse(seen.tcpListen!)).toEqual({ port: 2 });
    expect(com.netOpen({ kind: "udp", bindPort: 3, host: "u", port: 4 })).toEqual({
      ok: true,
      handle: 6,
    });
    expect(JSON.parse(seen.udpBind!)).toEqual({ bindPort: 3, host: "u", port: 4 });
    const wsParams = { ...({ kind: "ws", url: "ws://x" } as NetOpenParams), autoReconnect: true, reconnectSec: 5 };
    expect(com.netOpen(wsParams)).toEqual({
      ok: false,
      code: "io-error",
      msg: "handshake",
    });
    const wsJson = JSON.parse(seen.wsConnect!);
    expect(wsJson).toEqual({ url: "ws://x" }); // 重连策略不进线路参数
  });

  test("netOpen：宿主缺网络 op → null（app 据此报桥接不可用）", () => {
    setHost(makeNs()); // 无 tcpConnect 等方法
    expect(connectCom()!.netOpen({ kind: "tcp", host: "h", port: 1 })).toBeNull();
  });
});
