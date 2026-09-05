import { describe, expect, test } from "bun:test";
import { MessageBus } from "../../core/bus";
import { StateError, ParamError } from "../../core/errors";
import type { ConnState } from "../../core/connection";
import {
  collectMcpLines,
  executeMcpCommand,
  formatMcpLine,
  mcpContentText,
  parseMcpCommands,
  shouldMcpRun,
  validateConfigPatch,
  type McpCommand,
  type McpContext,
  type McpLabels,
  type McpResult,
  type McpSessionLike,
} from "../../core/mcp";

const LABELS: McpLabels = { rx: "[RX]", txManual: "[手动发送]", sys: "[SYS]" };
const EN_LABELS: McpLabels = { rx: "[RX]", txManual: "[Manual TX]", sys: "[SYS]" };

// ---------------------------------------------------------------------------
// fake session（结构兼容 McpSessionLike，行为记录供断言）
// ---------------------------------------------------------------------------

interface FakeSessionOpts {
  state?: ConnState;
  openError?: Error;
}

class FakeSession implements McpSessionLike {
  state: ConnState;
  kind: string | null = null;
  describe = "";
  rxBytes = 0;
  txBytes = 0;
  calls: { op: string; arg?: unknown }[] = [];
  openError: Error | undefined;

  constructor(opts: FakeSessionOpts = {}) {
    this.state = opts.state ?? "DISCONNECTED";
    this.openError = opts.openError;
  }

  ports(): { path: string; description?: string }[] {
    this.calls.push({ op: "ports" });
    return [
      { path: "/dev/cu.usbserial-A", description: "USB Serial" },
      { path: "/dev/cu.Bluetooth" },
    ];
  }

  openSerial(params: Parameters<McpSessionLike["openSerial"]>[0]): void {
    if (this.openError) throw this.openError;
    this.calls.push({ op: "openSerial", arg: params });
    this.state = "CONNECTED";
    this.kind = "serial";
    this.describe = `serial ${params.path} @ ${params.baudRate}`;
  }

  openNet(params: Parameters<McpSessionLike["openNet"]>[0]): void {
    if (this.openError) throw this.openError;
    this.calls.push({ op: "openNet", arg: params });
    if ("kind" in params && params.kind === "tcps") {
      this.state = "CONNECTING"; // tcps 异步打开
    } else {
      this.state = "CONNECTING";
    }
    this.kind = params.kind;
    this.describe = `${params.kind}`;
  }

  close(): void {
    this.calls.push({ op: "close" });
    this.state = "DISCONNECTED";
    this.kind = null;
    this.describe = "";
  }

  write(bytes: Uint8Array, source: "manual" | "mcp" | "timer" | "history" | "system"): void {
    if (this.state !== "CONNECTED") throw new StateError("STATE_ILLEGAL_TRANSITION", "cannot write");
    this.calls.push({ op: "write", arg: { bytes: Array.from(bytes), source } });
    this.txBytes += bytes.byteLength;
  }

  setSignals(pins: { dtr: boolean; rts: boolean }): void {
    this.calls.push({ op: "setSignals", arg: pins });
  }

  last(op: string): { op: string; arg?: unknown } | undefined {
    return this.calls.filter((c) => c.op === op).pop();
  }
}

function makeCtx(overrides: Partial<McpContext> = {}): { ctx: McpContext; session: FakeSession } {
  const session = (overrides.session as FakeSession | undefined) ?? new FakeSession();
  const ctx: McpContext = {
    session,
    mcpClients: () => 2,
    configRead: () => ({ language: "en", mcp: { enabled: true, port: 7960 } }),
    configWrite: () => {},
    gateOpen: () => true,
    ...overrides,
  };
  return { ctx, session };
}

function call(ctx: McpContext, name: string, args: Record<string, unknown> = {}): McpResult {
  return executeMcpCommand({ id: 7, name, args } as McpCommand, ctx);
}

// ---------------------------------------------------------------------------
// 门控与批解析
// ---------------------------------------------------------------------------

describe("mcp gate / parsing", () => {
  test("shouldMcpRun：仅收发模式且开关开时运行", () => {
    expect(shouldMcpRun(true, "transfer")).toBe(true);
    expect(shouldMcpRun(true, "terminal")).toBe(false);
    expect(shouldMcpRun(false, "transfer")).toBe(false);
  });

  test("gate 关闭：一切命令返回 mcp-suspended", () => {
    const { ctx } = makeCtx({ gateOpen: () => false });
    for (const name of ["status", "connect", "send", "disconnect"]) {
      const r = call(ctx, name);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("mcp-suspended");
    }
  });

  test("parseMcpCommands：JSON 行批 → 命令，非法行跳过", () => {
    const cmds = parseMcpCommands(
      '{"id":1,"name":"status"}\nnot-json\n{"id":2,"name":"send","args":{"data":"hi","encoding":"utf8"}}\n\n{"name":"no-id"}',
    );
    expect(cmds.length).toBe(2);
    expect(cmds[0]!.id).toBe(1);
    expect(cmds[0]!.name).toBe("status");
    expect(cmds[1]!.id).toBe(2);
    expect(cmds[1]!.args.data).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// 读行格式化
// ---------------------------------------------------------------------------

describe("mcp read lines", () => {
  test("formatMcpLine：行格式 [ts] [来源] 内容", () => {
    const line = formatMcpLine(
      { ts: new Date(2026, 8, 5, 12, 0, 0, 123).getTime(), dir: "rx", source: "system", payload: new TextEncoder().encode("hello") },
      LABELS,
    );
    expect(line).toBe("[2026-09-05 12:00:00.123] [RX] hello");
  });

  test("手动 TX 使用注入的 i18n 前缀（SPEC §6.4 人工干预可见）", () => {
    const ts = new Date(2026, 8, 5, 12, 0, 0, 0).getTime();
    const zh = formatMcpLine({ ts, dir: "tx", source: "manual", payload: new Uint8Array([0x41]) }, LABELS);
    const en = formatMcpLine({ ts, dir: "tx", source: "manual", payload: new Uint8Array([0x41]) }, EN_LABELS);
    expect(zh.endsWith("[手动发送] A")).toBe(true); // 0x41
    expect(en.endsWith("[Manual TX] A")).toBe(true);
  });

  test("mcpContentText：控制字符转义保证一条消息一行", () => {
    expect(mcpContentText(new TextEncoder().encode("a\nb\r\tc"))).toBe("a\\nb\\r\\tc");
    expect(mcpContentText(new Uint8Array([0x00, 0x7f, 0x80]))).toBe("\\x00\\x7F\ufffd");
    expect(mcpContentText(new TextEncoder().encode("好"))).toBe("好");
    expect(mcpContentText(new Uint8Array([0xff]))).toBe("\ufffd");
    expect(mcpContentText(new TextEncoder().encode("a\\b"))).toBe("a\\\\b");
  });

  test("collectMcpLines：增量视图，mcp 自发帧不回灌（SPEC §6.4）", () => {
    const bus = new MessageBus({ now: () => 1000 });
    bus.append({ dir: "rx", source: "system", payload: new TextEncoder().encode("rx1"), connId: "c" });
    bus.append({ dir: "tx", source: "mcp", payload: new TextEncoder().encode("agent-echo"), connId: "c" });
    bus.append({ dir: "tx", source: "manual", payload: new TextEncoder().encode("human"), connId: "c" });
    bus.append({ dir: "sys", source: "system", payload: new TextEncoder().encode("connected"), connId: "c" });
    const { lines, lastId } = collectMcpLines(bus, 0, LABELS);
    expect(lines.length).toBe(3); // mcp tx 被过滤
    expect(lines[0]!.endsWith("[RX] rx1")).toBe(true);
    expect(lines[1]!.endsWith("[手动发送] human")).toBe(true);
    expect(lines[2]!.endsWith("[SYS] connected")).toBe(true);
    expect(lastId).toBe(4);
    // 增量：从 lastId 继续，无重复
    const again = collectMcpLines(bus, lastId, LABELS);
    expect(again.lines.length).toBe(0);
    bus.append({ dir: "rx", source: "system", payload: new TextEncoder().encode("rx2"), connId: "c" });
    const third = collectMcpLines(bus, lastId, LABELS);
    expect(third.lines.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 命令执行
// ---------------------------------------------------------------------------

describe("mcp commands: status / ports", () => {
  test("status：连接状态 + 计数 + MCP 客户端数", () => {
    const s = new FakeSession({ state: "CONNECTED" });
    s.kind = "serial";
    s.describe = "serial /dev/cu.usbserial-A @ 115200";
    s.rxBytes = 12;
    s.txBytes = 34;
    const { ctx } = makeCtx({ session: s });
    const r = call(ctx, "status");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = JSON.parse(r.text) as Record<string, unknown>;
      expect(v.state).toBe("CONNECTED");
      expect(v.kind).toBe("serial");
      expect(v.rxBytes).toBe(12);
      expect(v.mcpClients).toBe(2);
    }
  });

  test("list_serial_ports：`设备 - 描述` 每行一条", () => {
    const { ctx } = makeCtx();
    const r = call(ctx, "list_serial_ports");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("/dev/cu.usbserial-A — USB Serial\n/dev/cu.Bluetooth");
    }
  });

  test("未知工具：unknown-tool 错误", () => {
    const { ctx } = makeCtx();
    const r = call(ctx, "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown-tool");
  });
});

describe("mcp commands: connect / disconnect", () => {
  test("connect serial：参数映射（缺省 115200/8/none/1/none）", () => {
    const { ctx, session } = makeCtx();
    const r = call(ctx, "connect", { type: "serial", path: "/dev/cu.usbserial-A", baudRate: 9600 });
    expect(r.ok).toBe(true);
    const arg = session.last("openSerial")!.arg as Record<string, unknown>;
    expect(arg.baudRate).toBe(9600);
    expect(arg.dataBits).toBe(8);
    expect(arg.parity).toBe("none");
    expect(arg.stopBits).toBe(1);
    expect(arg.flowControl).toBe("none");
  });

  test("connect serial：dtr/rts 经 setSignals 应用", () => {
    const { ctx, session } = makeCtx();
    call(ctx, "connect", { type: "serial", path: "/dev/cu.x", dtr: true });
    const arg = session.last("setSignals")!.arg as Record<string, unknown>;
    expect(arg.dtr).toBe(true);
    expect(arg.rts).toBe(false);
  });

  test("connect tcp：host/port/autoReconnect", () => {
    const { ctx, session } = makeCtx();
    call(ctx, "connect", { type: "tcp", host: "127.0.0.1", port: 9000, autoReconnect: true });
    const arg = session.last("openNet")!.arg as Record<string, unknown>;
    expect(arg.kind).toBe("tcp");
    expect(arg.port).toBe(9000);
    expect(arg.autoReconnect).toBe(true);
  });

  test("connect udp：bindPort 缺省 = port", () => {
    const { ctx, session } = makeCtx();
    call(ctx, "connect", { type: "udp", host: "127.0.0.1", port: 5000 });
    const arg = session.last("openNet")!.arg as Record<string, unknown>;
    expect(arg.bindPort).toBe(5000);
  });

  test("connect：已有连接默认拒绝，force 先断开（规避静默抢占，SPEC §6.3）", () => {
    const s = new FakeSession({ state: "CONNECTED" });
    s.kind = "serial";
    s.describe = "serial x";
    const { ctx } = makeCtx({ session: s });
    const refused = call(ctx, "connect", { type: "serial", path: "/dev/cu.y" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("already-connected");
      expect(refused.msg).toContain("force:true");
    }
    expect(s.calls.some((c) => c.op === "close")).toBe(false);
    const forced = call(ctx, "connect", { type: "serial", path: "/dev/cu.y", force: true });
    expect(forced.ok).toBe(true);
    expect(s.calls.some((c) => c.op === "close")).toBe(true);
  });

  test("connect：打开失败透传结构化 code", () => {
    const { ctx } = makeCtx({
      session: new FakeSession({ openError: new StateError("STATE_ILLEGAL_TRANSITION", "cannot open while CONNECTING") }),
    });
    const r = call(ctx, "connect", { type: "serial", path: "/dev/cu.x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("STATE_ILLEGAL_TRANSITION");
  });

  test("connect：缺 path / 未知类型 / mark 校验拒绝", () => {
    const { ctx } = makeCtx();
    expect(call(ctx, "connect", { type: "serial" }).ok).toBe(false);
    expect(call(ctx, "connect", { type: "modbus", path: "x" }).ok).toBe(false);
    expect(call(ctx, "connect", { type: "serial", path: "x", parity: "mark" }).ok).toBe(false);
  });

  test("disconnect：幂等（未连接成功提示），LOST 时确认掉线", () => {
    const { ctx, session } = makeCtx();
    expect(call(ctx, "disconnect").ok).toBe(true);
    const lost = new FakeSession({ state: "LOST" });
    lost.kind = "tcp";
    const ctx2 = makeCtx({ session: lost }).ctx;
    const r = call(ctx2, "disconnect");
    expect(r.ok).toBe(true);
    expect(lost.last("close")!.op).toBe("close");
  });
});

describe("mcp commands: send", () => {
  test("send utf8 + appendNewline 追加 CRLF，source=mcp", () => {
    const s = new FakeSession({ state: "CONNECTED" });
    s.kind = "serial";
    const { ctx } = makeCtx({ session: s });
    const r = call(ctx, "send", { data: "hello", encoding: "utf8", appendNewline: true });
    expect(r.ok).toBe(true);
    const arg = s.last("write")!.arg as { bytes: number[]; source: string };
    expect(arg.bytes).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x0d, 0x0a]);
    expect(arg.source).toBe("mcp");
  });

  test("send hex / base64 编码", () => {
    const s = new FakeSession({ state: "CONNECTED" });
    s.kind = "serial";
    const { ctx } = makeCtx({ session: s });
    call(ctx, "send", { data: "01 FF", encoding: "hex" });
    expect((s.last("write")!.arg as { bytes: number[] }).bytes).toEqual([0x01, 0xff]);
    call(ctx, "send", { data: "AQI=", encoding: "base64" });
    expect((s.last("write")!.arg as { bytes: number[] }).bytes).toEqual([0x01, 0x02]);
  });

  test("send：未连接 / 缺 encoding / 空 data 拒绝", () => {
    const { ctx } = makeCtx();
    expect(call(ctx, "send", { data: "hi", encoding: "utf8" }).ok).toBe(false);
    const s = new FakeSession({ state: "CONNECTED" });
    s.kind = "serial";
    const ctx2 = makeCtx({ session: s }).ctx;
    expect(call(ctx2, "send", { data: "hi" }).ok).toBe(false);
    expect(call(ctx2, "send", { data: "", encoding: "utf8" }).ok).toBe(false);
    expect(call(ctx2, "send", { data: "zz", encoding: "hex" }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config 白名单
// ---------------------------------------------------------------------------

describe("mcp config whitelist", () => {
  test("validateConfigPatch：合法补丁归一", () => {
    const patch = validateConfigPatch({
      language: "en",
      theme: "dark",
      fontSize: 12,
      terminal: { scrollbackLines: 500 },
      receive: { hex: true, wrap: false },
      send: { crlf: true },
      mcp: { enabled: true, port: 8000 },
    });
    expect(patch).toEqual({
      language: "en",
      theme: "dark",
      fontSize: 12,
      scrollbackLines: 500,
      receive: { hex: true, wrap: false },
      send: { crlf: true },
      mcp: { enabled: true, port: 8000 },
    });
  });

  test("validateConfigPatch：白名单外键与非法值拒绝（token 不可触）", () => {
    expect(() => validateConfigPatch({ sendHistory: [] })).toThrow(ParamError);
    expect(() => validateConfigPatch({ mcp: { token: "x" } })).toThrow(ParamError);
    expect(() => validateConfigPatch({ language: "ja" })).toThrow(ParamError);
    expect(() => validateConfigPatch({ fontSize: 13 })).toThrow(ParamError);
    expect(() => validateConfigPatch({ terminal: { scrollbackLines: -1 } })).toThrow(ParamError);
    expect(() => validateConfigPatch({ mcp: { port: 0 } })).toThrow(ParamError);
    expect(() => validateConfigPatch({})).toThrow(ParamError);
  });

  test("config_read / config_write", () => {
    let applied: unknown = null;
    const { ctx } = makeCtx({
      configWrite: (patch) => {
        applied = patch;
      },
    });
    const r1 = call(ctx, "config_read");
    expect(r1.ok).toBe(true);
    if (r1.ok) expect((JSON.parse(r1.text) as Record<string, unknown>).language).toBe("en");
    const r2 = call(ctx, "config_write", { config: { fontSize: 16 } });
    expect(r2.ok).toBe(true);
    expect(applied).toEqual({ fontSize: 16 });
    const r3 = call(ctx, "config_write", { config: { mcp: { token: "x" } } });
    expect(r3.ok).toBe(false);
  });
});
