// test/bridge/com.test.ts — bridge/com.ts 枢纽语义：命名空间探测、共享
// write/close/poll op（fake 宿主命名空间，无硬件；硬件回环见
// test/host/macos/serial_loopback.rs，tcp/udp 回环见 tcp_tests.rs/udp_tests.rs）。
import { afterEach, describe, expect, test } from "bun:test";
import { connectCom, type ComEvent } from "../../bridge/com";
import { makeNs, setHost } from "./testutil";

describe("connectCom 枢纽", () => {
  afterEach(() => {
    setHost(undefined);
  });

  test("无 com 命名空间或串口基础 op 缺失 → null（stock 宿主降级）", () => {
    expect(connectCom()).toBeNull();
    setHost({ serialList: () => "[]" } as unknown as ReturnType<typeof makeNs>); // 只有 1/6 基础方法
    expect(connectCom()).toBeNull();
  });

  test("write / close 直通布尔", () => {
    setHost(makeNs({ write: (_h, bytes) => bytes.length === 0, close: (h) => h === 7 }));
    const com = connectCom()!;
    expect(com.write(1, new Uint8Array([1]))).toBe(false);
    expect(com.write(1, new Uint8Array(0))).toBe(true);
    expect(com.close(7)).toBe(true);
    expect(com.close(8)).toBe(false);
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

  test("poll：opened/accepted/appearance 事件透传", () => {
    setHost(
      makeNs({
        poll: () =>
          [
            JSON.stringify({ t: "opened", h: 1, addr: "127.0.0.1:9" }),
            JSON.stringify({ t: "accepted", h: 1, c: 2, addr: "127.0.0.1:3" }),
            JSON.stringify({ t: "appearance", v: "dark" }),
          ].join("\n"),
      }),
    );
    expect(connectCom()!.poll()).toEqual([
      { t: "opened", h: 1, addr: "127.0.0.1:9" },
      { t: "accepted", h: 1, c: 2, addr: "127.0.0.1:3" },
      { t: "appearance", v: "dark" },
    ]);
  });

  test("mcp ops：未实现 mcp 桥的宿主降级为 null", () => {
    setHost(makeNs({}));
    const com = connectCom()!;
    expect(com.mcpStart({ port: 7960, token: "" })).toBeNull();
    expect(com.mcpStop()).toBeNull();
    expect(com.mcpFeed(["x"])).toBeNull();
    expect(com.mcpCmds()).toBeNull();
    expect(com.mcpResults("[]")).toBeNull();
  });

  test("mcp ops：参数封包与结果解析", () => {
    const seen: { paramsJson?: string; linesJson?: string; resultsJson?: string } = {};
    setHost(
      makeNs({
        mcpStart: (paramsJson) => {
          seen.paramsJson = paramsJson;
          const p = JSON.parse(paramsJson) as { port: number };
          return JSON.stringify({ ok: true, token: "abc", port: p.port });
        },
        mcpStop: () => true,
        mcpFeed: (linesJson) => {
          seen.linesJson = linesJson;
          return true;
        },
        mcpCmds: () => '{"id":1,"name":"status"}',
        mcpResults: (resultsJson) => {
          seen.resultsJson = resultsJson;
          return true;
        },
      }),
    );
    const com = connectCom()!;
    expect(com.mcpStart({ port: 7960, token: "tok" })).toEqual({ ok: true, token: "abc", port: 7960 });
    expect(JSON.parse(seen.paramsJson!)).toEqual({ port: 7960, token: "tok" });
    expect(com.mcpStop()).toBe(true);
    com.mcpFeed(["a", "b"]);
    expect(JSON.parse(seen.linesJson!)).toEqual({ lines: ["a", "b"] });
    expect(com.mcpCmds()).toBe('{"id":1,"name":"status"}');
    com.mcpResults('{"id":1,"ok":true,"text":"x"}');
    expect(seen.resultsJson).toBe('{"id":1,"ok":true,"text":"x"}');
  });

  test("mcpStart：失败结果与非法 JSON 归一为 ok:false", () => {
    setHost(
      makeNs({
        mcpStart: (_paramsJson) => JSON.stringify({ error: { code: "io-error", msg: "port in use" } }),
      }),
    );
    expect(connectCom()!.mcpStart({ port: 7960, token: "" })).toEqual({
      ok: false,
      code: "io-error",
      msg: "port in use",
    });
    setHost(makeNs({ mcpStart: () => "not-json" }));
    const r = connectCom()!.mcpStart({ port: 7960, token: "" });
    expect(r === null || r.ok === false).toBe(true);
  });
});
