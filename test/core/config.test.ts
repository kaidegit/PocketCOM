import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  HISTORY_LIMIT,
  normalizeConfig,
  pushSendHistory,
} from "../../core/config";

describe("normalizeConfig", () => {
  test("空/非对象输入 → 全默认配置（损坏文件不挡启动）", () => {
    for (const raw of [undefined, null, 42, "x", [], {}]) {
      expect(normalizeConfig(raw)).toEqual(DEFAULT_CONFIG);
    }
  });

  test("合法字段透传", () => {
    const cfg = normalizeConfig({
      language: "en",
      theme: "system",
      fontSize: 16,
      terminal: { scrollbackLines: 5000 },
      receive: { hex: true, escape: true, timestamp: true, wrap: false },
      send: { escape: true, crlf: true, appendNewline: true },
      logPath: "/tmp/log.txt",
      mcp: { enabled: true, port: 8000, token: "t" },
    });
    expect(cfg.language).toBe("en");
    expect(cfg.theme).toBe("system");
    expect(cfg.fontSize).toBe(16);
    expect(cfg.terminal).toEqual({ scrollbackLines: 5000 });
    expect(cfg.receive).toEqual({ hex: true, escape: true, timestamp: true, wrap: false });
    expect(cfg.send).toEqual({ escape: true, crlf: true, appendNewline: true });
    expect(cfg.logPath).toBe("/tmp/log.txt");
    expect(cfg.mcp).toEqual({ enabled: true, port: 8000, token: "t" });
  });

  test("非法值逐项回退默认", () => {
    const cfg = normalizeConfig({
      language: "fr",
      theme: "sepia",
      fontSize: 20,
      terminal: { scrollbackLines: -5 },
      mcp: { port: 0 },
      receive: { hex: "yes" },
      sendHistory: "nope",
    });
    expect(cfg.language).toBe(DEFAULT_CONFIG.language);
    expect(cfg.theme).toBe(DEFAULT_CONFIG.theme);
    expect(cfg.fontSize).toBe(DEFAULT_CONFIG.fontSize);
    expect(cfg.terminal.scrollbackLines).toBe(0); // clamp 到范围下限
    expect(cfg.mcp.port).toBe(1); // 0 clamp 到下限
    expect(cfg.receive.hex).toBe(false);
    expect(cfg.sendHistory).toEqual([]);
  });

  test("数值字段 clamp 到合法区间", () => {
    const cfg = normalizeConfig({
      terminal: { scrollbackLines: 999999 },
      mcp: { port: 99999 },
    });
    expect(cfg.terminal.scrollbackLines).toBe(100000);
    expect(cfg.mcp.port).toBe(65535);
  });

  test("lastConn 按类型归一化，未提供的类型不出现", () => {
    const cfg = normalizeConfig({
      lastConn: {
        serial: { path: "/dev/cu.x", baudRate: "fast", dataBits: 9 },
        tcp: { host: "h", port: 70000, reconnectSec: 0 },
        udp: { bindPort: 8000, host: "u", port: 9000 },
        ws: { url: 42 },
      },
    });
    expect(cfg.lastConn.serial).toEqual({
      path: "/dev/cu.x",
      baudRate: 115200, // 非数字 → 默认
      dataBits: 8, // 9 非法 → 默认
      parity: "none",
      stopBits: 1,
      flowControl: "none",
      dtr: false,
      rts: false,
    });
    expect(cfg.lastConn.tcp).toEqual({
      host: "h",
      port: 65535, // clamp
      autoReconnect: false,
      reconnectSec: 1, // 0 → 下限
    });
    expect(cfg.lastConn.udp).toEqual({ bindPort: 8000, host: "u", port: 9000 });
    expect(cfg.lastConn.ws).toEqual({ url: "", autoReconnect: false, reconnectSec: 5 });
    expect(cfg.lastConn.tcps).toBeUndefined();
  });
});

describe("pushSendHistory", () => {
  test("去重置顶、最新在前", () => {
    let h = pushSendHistory([], "a");
    h = pushSendHistory(h, "b");
    h = pushSendHistory(h, "a");
    expect(h).toEqual(["a", "b"]);
  });

  test("封顶 50 条", () => {
    let h: string[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = pushSendHistory(h, `m${i}`);
    expect(h.length).toBe(HISTORY_LIMIT);
    expect(h[0]).toBe(`m${HISTORY_LIMIT + 9}`);
  });

  test("空白条目不入历史", () => {
    expect(pushSendHistory(["a"], "  ")).toEqual(["a"]);
  });
});
