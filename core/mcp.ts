/**
 * MCP 服务核心逻辑（SPEC §6）：宿主 MCP 线程 ↔ guest 核心层之间的桥。
 * 纯 TS，零平台依赖：
 * - 命令批解析（宿主 mcpCmds() 的 JSON 行批）与结果信封；
 * - 命令执行（connect / disconnect / send / status / list_serial_ports /
 *   config_read / config_write），面向最小会话接口（ComSession 结构兼容）；
 * - 读行格式化（消息总线的 MCP 侧增量视图，SPEC §6.4 行格式）；
 * - 终端模式门控（SPEC §6.1：MCP 仅在收发模式运行）；
 * - config 白名单校验（SPEC §6.3，token 不可读写）。
 *
 * 读缓冲本体在宿主侧（有界 256 KiB）；`read` 工具由宿主直接应答，不经本执行器。
 */
import { decodeBase64 } from "./base64";
import { hexStrToBytes, strToBytes, utf8Decode } from "./codec";
import type { ConnState } from "./connection";
import type { MessageSource } from "./message";
import { isVisibleToMcp, type MessageBus } from "./bus";
import { ParamError } from "./errors";

// ---------------------------------------------------------------------------
// 终端模式门控（SPEC §6.1）
// ---------------------------------------------------------------------------

/** MCP 有效运行态：开关开 && 收发模式（切终端自动停服）。 */
export function shouldMcpRun(enabled: boolean, uiMode: "transfer" | "terminal"): boolean {
  return enabled && uiMode === "transfer";
}

// ---------------------------------------------------------------------------
// 命令与结果信封
// ---------------------------------------------------------------------------

/** 宿主下发的 MCP 命令（mcpCmds() 批中的一行 JSON）。 */
export interface McpCommand {
  id: number;
  name: string;
  args: Record<string, unknown>;
}

/** guest → 宿主的执行结果（mcpResults() 批中的一行）。 */
export type McpResult =
  | { id: number; ok: true; text: string }
  | { id: number; ok: false; code: string; msg: string };

export function mcpOk(id: number, text: string): McpResult {
  return { id, ok: true, text };
}

export function mcpErr(id: number, code: string, msg: string): McpResult {
  return { id, ok: false, code, msg };
}

/** 解析宿主命令批（JSON 行，\n 分隔，与 com.poll 同风格）；非法行跳过。 */
export function parseMcpCommands(batch: string): McpCommand[] {
  const out: McpCommand[] = [];
  for (const line of batch.split("\n")) {
    if (line === "") continue;
    try {
      const v = JSON.parse(line) as { id?: unknown; name?: unknown; args?: unknown };
      if (typeof v.id !== "number" || typeof v.name !== "string") continue;
      out.push({
        id: v.id,
        name: v.name,
        args: typeof v.args === "object" && v.args !== null ? (v.args as Record<string, unknown>) : {},
      });
    } catch {
      // 非法行是宿主 bug：跳过，不卡命令泵
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 读行格式化（SPEC §6.4：`[ts] [来源] 内容`，agent 侧视图）
// ---------------------------------------------------------------------------

/** 读行来源标签（app 侧由 i18n 注入；RX/SYS 为稳定标记）。 */
export interface McpLabels {
  /** RX 帧标记，如 "[RX]" */
  rx: string;
  /** 手动 TX 前缀（含括号），与 UI 前缀同源，如 "[手动发送]" */
  txManual: string;
  /** sys 事件标记，如 "[SYS]" */
  sys: string;
}

/** 时间戳（本地时区，与 formatTimestamp 同格式）。 */
function mcpTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 消息内容 → 单行文本：UTF-8 解码（非法序列 U+FFFD），控制字符转义保证一行一条。 */
export function mcpContentText(payload: Uint8Array): string {
  let out = "";
  const text = utf8Decode(payload);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).toUpperCase().padStart(2, "0");
    else out += ch;
  }
  return out;
}

/** 消息 → MCP 读行。tx 且 source=mcp 的帧不可见（调用方保证，见 isVisibleToMcp）。 */
export function formatMcpLine(msg: { ts: number; dir: "rx" | "tx" | "sys"; source: MessageSource; payload: Uint8Array }, labels: McpLabels): string {
  const label = msg.dir === "rx" ? labels.rx : msg.dir === "sys" ? labels.sys : labels.txManual;
  return `[${mcpTimestamp(msg.ts)}] ${label} ${mcpContentText(msg.payload)}`;
}

/**
 * 消息总线的 MCP 侧增量视图（SPEC §6.4）：peek 出 id > lastId 的可见帧
 * （RX + 非 mcp TX + sys），格式化为读行。缓冲有界，若裁掉尚未喂出的帧
 * （id 断档）则前置一条 [SYS] 丢帧行（稳定英文，§6.3；时间戳取首条幸存帧）。
 */
export function collectMcpLines(
  bus: MessageBus,
  lastId: number,
  labels: McpLabels,
  maxLines = 200,
): { lines: string[]; lastId: number } {
  const lines: string[] = [];
  let seen = lastId;
  let first = true;
  for (const msg of bus.buffer.peek()) {
    if (msg.id <= lastId) continue;
    if (first) {
      first = false;
      const lost = msg.id - lastId - 1;
      if (lost > 0) {
        lines.push(`[${mcpTimestamp(msg.ts)}] ${labels.sys} buffer overflow, dropped ${lost} frame(s)`);
      }
    }
    seen = Math.max(seen, msg.id);
    if (!isVisibleToMcp(msg)) continue;
    if (lines.length >= maxLines) break;
    lines.push(formatMcpLine(msg, labels));
  }
  return { lines, lastId: seen };
}

// ---------------------------------------------------------------------------
// 命令执行器
// ---------------------------------------------------------------------------

/** 执行器所需的最小会话接口（ComSession 结构兼容）。 */
export interface McpSessionLike {
  readonly state: ConnState;
  readonly kind: string | null;
  readonly describe: string;
  readonly rxBytes: number;
  readonly txBytes: number;
  ports(): { path: string; description?: string }[];
  openSerial(params: {
    path: string;
    baudRate: number;
    dataBits?: 5 | 6 | 7 | 8;
    parity?: "none" | "odd" | "even" | "mark" | "space";
    stopBits?: 1 | 2;
    flowControl?: "none" | "xonxoff" | "rtscts" | "dsrdtr";
  }): void;
  openNet(
    params:
      | { kind: "tcp"; host: string; port: number; autoReconnect?: boolean; reconnectSec?: number }
      | { kind: "tcps"; port: number }
      | { kind: "udp"; bindPort: number; host: string; port: number }
      | { kind: "ws"; url: string; autoReconnect?: boolean; reconnectSec?: number },
  ): void;
  close(): void;
  write(bytes: Uint8Array, source: MessageSource): void;
  setSignals(pins: { dtr: boolean; rts: boolean }): void;
}

/** 执行器上下文：app 层注入的副作用出口（保持本模块可单测）。 */
export interface McpContext {
  /** 当前会话（com 桥缺失时为 null）。 */
  session: McpSessionLike | null;
  /** MCP 客户端数（状态栏/状态工具共享，宿主经 com 事件回推）。 */
  mcpClients: () => number;
  /** 白名单配置快照（config_read）。 */
  configRead: () => Record<string, unknown>;
  /** 应用白名单配置补丁（config_write；输入已过 validateConfigPatch）。 */
  configWrite: (patch: McpConfigPatch) => void;
  /** 终端模式门控（SPEC §6.1）：false = 服务已停，拒绝一切命令。 */
  gateOpen: () => boolean;
}

const TERMINAL_GATE_MSG = "app is in terminal mode; MCP service suspended (switch back to transfer mode)";

/** 执行一条 MCP 命令；永不抛错（错误走结果信封，SPEC §5.1）。 */
export function executeMcpCommand(cmd: McpCommand, ctx: McpContext): McpResult {
  if (!ctx.gateOpen()) {
    return mcpErr(cmd.id, "mcp-suspended", TERMINAL_GATE_MSG);
  }
  try {
    switch (cmd.name) {
      case "status":
        return mcpOk(cmd.id, statusText(ctx));
      case "list_serial_ports":
        return mcpOk(cmd.id, listPortsText(ctx));
      case "connect":
        return connectCommand(cmd, ctx);
      case "disconnect":
        return disconnectCommand(cmd, ctx);
      case "send":
        return sendCommand(cmd, ctx);
      case "config_read":
        return mcpOk(cmd.id, JSON.stringify(ctx.configRead()));
      case "config_write":
        return configWriteCommand(cmd, ctx);
      default:
        return mcpErr(cmd.id, "unknown-tool", `unknown tool: ${cmd.name}`);
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (typeof code === "string") {
      return mcpErr(cmd.id, code, err instanceof Error ? err.message : String(err));
    }
    return mcpErr(cmd.id, "internal", err instanceof Error ? err.message : String(err));
  }
}

function statusText(ctx: McpContext): string {
  const s = ctx.session;
  return JSON.stringify({
    state: s?.state ?? "DISCONNECTED",
    kind: s?.kind ?? null,
    describe: s?.describe ?? "",
    rxBytes: s?.rxBytes ?? 0,
    txBytes: s?.txBytes ?? 0,
    mcpClients: ctx.mcpClients(),
  });
}

function listPortsText(ctx: McpContext): string {
  const ports = ctx.session?.ports() ?? [];
  if (ports.length === 0) return "(no serial ports)";
  return ports.map((p) => (p.description ? `${p.path} — ${p.description}` : p.path)).join("\n");
}

// --- connect（SPEC §6.3：已有连接默认拒绝，force 才断开重连） ---

function needString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") {
    throw new ParamError("PARAM_INVALID", `missing or invalid string argument: ${key}`);
  }
  return v;
}

function optBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof args[key] === "boolean" ? (args[key] as boolean) : fallback;
}

function optInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ParamError("PARAM_INVALID", `invalid number argument: ${key}`);
  }
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function connectCommand(cmd: McpCommand, ctx: McpContext): McpResult {
  const s = ctx.session;
  if (!s) return mcpErr(cmd.id, "no-bridge", "com bridge unavailable");
  const type = needString(cmd.args, "type");
  if (s.state === "CONNECTED" || s.state === "CONNECTING") {
    if (!optBool(cmd.args, "force", false)) {
      return mcpErr(
        cmd.id,
        "already-connected",
        `already ${s.state.toLowerCase()} (${s.describe}); pass force:true to disconnect first`,
      );
    }
    s.close();
  }
  switch (type) {
    case "serial": {
      s.openSerial({
        path: needString(cmd.args, "path"),
        baudRate: optInt(cmd.args, "baudRate", 115200, 1, 4500000),
        dataBits: optInt(cmd.args, "dataBits", 8, 5, 8) as 5 | 6 | 7 | 8,
        parity: parityArg(cmd.args),
        stopBits: optInt(cmd.args, "stopBits", 1, 1, 2) as 1 | 2,
        flowControl: flowArg(cmd.args),
      });
      if (typeof cmd.args.dtr === "boolean" || typeof cmd.args.rts === "boolean") {
        s.setSignals({ dtr: optBool(cmd.args, "dtr", false), rts: optBool(cmd.args, "rts", false) });
      }
      break;
    }
    case "tcp":
      s.openNet({
        kind: "tcp",
        host: needString(cmd.args, "host"),
        port: optInt(cmd.args, "port", 0, 1, 65535),
        autoReconnect: optBool(cmd.args, "autoReconnect", false),
        reconnectSec: optInt(cmd.args, "reconnectSec", 5, 1, 3600),
      });
      break;
    case "tcps":
      s.openNet({ kind: "tcps", port: optInt(cmd.args, "port", 0, 1, 65535) });
      break;
    case "udp": {
      const port = optInt(cmd.args, "port", 0, 1, 65535);
      s.openNet({
        kind: "udp",
        bindPort: optInt(cmd.args, "bindPort", port, 0, 65535),
        host: needString(cmd.args, "host"),
        port,
      });
      break;
    }
    case "ws":
      s.openNet({
        kind: "ws",
        url: needString(cmd.args, "url"),
        autoReconnect: optBool(cmd.args, "autoReconnect", false),
        reconnectSec: optInt(cmd.args, "reconnectSec", 5, 1, 3600),
      });
      break;
    default:
      return mcpErr(cmd.id, "invalid-param", `unknown connection type: ${type} (serial|tcp|tcps|udp|ws)`);
  }
  return mcpOk(cmd.id, `connected: ${s.describe}`);
}

function parityArg(args: Record<string, unknown>): "none" | "odd" | "even" {
  const v = args.parity;
  if (v === undefined) return "none";
  if (v === "none" || v === "odd" || v === "even") return v;
  throw new ParamError("PARAM_INVALID", `invalid parity: ${String(v)} (none|odd|even; mark/space unsupported)`);
}

function flowArg(args: Record<string, unknown>): "none" | "xonxoff" | "rtscts" | "dsrdtr" {
  const v = args.flowControl;
  if (v === undefined) return "none";
  if (v === "none" || v === "xonxoff" || v === "rtscts" || v === "dsrdtr") return v;
  throw new ParamError("PARAM_INVALID", `invalid flowControl: ${String(v)}`);
}

// --- disconnect（幂等：未连接也成功） ---

function disconnectCommand(cmd: McpCommand, ctx: McpContext): McpResult {
  const s = ctx.session;
  if (!s) return mcpErr(cmd.id, "no-bridge", "com bridge unavailable");
  if (s.state === "DISCONNECTED") {
    return mcpOk(cmd.id, "not connected");
  }
  s.close();
  return mcpOk(cmd.id, "disconnected");
}

// --- send（SPEC §6.3：不隐式追加换行；source=mcp，不回灌读缓冲） ---

function sendCommand(cmd: McpCommand, ctx: McpContext): McpResult {
  const s = ctx.session;
  if (!s) return mcpErr(cmd.id, "no-bridge", "com bridge unavailable");
  if (s.state !== "CONNECTED") {
    return mcpErr(cmd.id, "not-connected", `cannot send while ${s.state.toLowerCase()}`);
  }
  const data = needString(cmd.args, "data");
  const encoding = cmd.args.encoding;
  let bytes: Uint8Array;
  switch (encoding) {
    case "utf8":
      bytes = strToBytes(data);
      break;
    case "hex":
      bytes = hexStrToBytes(data);
      break;
    case "base64":
      try {
        bytes = decodeBase64(data);
      } catch {
        throw new ParamError("PARAM_INVALID", "invalid base64 data");
      }
      break;
    default:
      throw new ParamError("PARAM_INVALID", `missing or invalid encoding: ${String(encoding)} (utf8|hex|base64)`);
  }
  if (optBool(cmd.args, "appendNewline", false)) {
    const withNl = new Uint8Array(bytes.byteLength + 2);
    withNl.set(bytes);
    withNl[bytes.byteLength] = 0x0d;
    withNl[bytes.byteLength + 1] = 0x0a;
    bytes = withNl;
  }
  if (bytes.byteLength === 0) {
    throw new ParamError("PARAM_INVALID", "empty payload");
  }
  s.write(bytes, "mcp");
  return mcpOk(cmd.id, `sent ${bytes.byteLength} byte(s)`);
}

// ---------------------------------------------------------------------------
// config 白名单（SPEC §6.3：读写非敏感配置，token 不可触）
// ---------------------------------------------------------------------------

export type McpConfigPatch = {
  language?: "zh-CN" | "en";
  theme?: "light" | "dark" | "system";
  fontSize?: 12 | 14 | 16;
  scrollbackLines?: number;
  receive?: { hex?: boolean; escape?: boolean; timestamp?: boolean; wrap?: boolean };
  send?: { escape?: boolean; crlf?: boolean; appendNewline?: boolean };
  mcp?: { enabled?: boolean; port?: number };
};

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function rejectUnknown(scope: string, rec: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.includes(key)) {
      throw new ParamError("PARAM_INVALID", `unknown config key: ${scope}${key} (not in whitelist)`);
    }
  }
}

function boolField(rec: Record<string, unknown>, key: string): boolean | undefined {
  const v = rec[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new ParamError("PARAM_INVALID", `config ${key} must be a boolean`);
  return v;
}

/**
 * 校验并归一 config_write 补丁：白名单外键、非法值类型一律 ParamError。
 * 白名单：language / theme / fontSize / terminal.scrollbackLines /
 * receive.* / send.* / mcp.{enabled,port}（mcp.token 不可触）。
 */
export function validateConfigPatch(raw: unknown): McpConfigPatch {
  const top = asRecord(raw);
  if (Object.keys(top).length === 0) {
    throw new ParamError("PARAM_INVALID", "config patch is empty");
  }
  rejectUnknown("", top, ["language", "theme", "fontSize", "terminal", "receive", "send", "mcp"]);
  const patch: McpConfigPatch = {};
  if (top.language !== undefined) {
    if (top.language !== "zh-CN" && top.language !== "en") {
      throw new ParamError("PARAM_INVALID", `config language must be "zh-CN" or "en"`);
    }
    patch.language = top.language;
  }
  if (top.theme !== undefined) {
    if (top.theme !== "light" && top.theme !== "dark" && top.theme !== "system") {
      throw new ParamError("PARAM_INVALID", `config theme must be "light", "dark" or "system"`);
    }
    patch.theme = top.theme;
  }
  if (top.fontSize !== undefined) {
    if (top.fontSize !== 12 && top.fontSize !== 14 && top.fontSize !== 16) {
      throw new ParamError("PARAM_INVALID", "config fontSize must be 12, 14 or 16");
    }
    patch.fontSize = top.fontSize;
  }
  if (top.terminal !== undefined) {
    const rec = asRecord(top.terminal);
    rejectUnknown("terminal.", rec, ["scrollbackLines"]);
    if (rec.scrollbackLines !== undefined) {
      const v = rec.scrollbackLines;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100000) {
        throw new ParamError("PARAM_INVALID", "config terminal.scrollbackLines must be 0..100000");
      }
      patch.scrollbackLines = Math.floor(v);
    }
  }
  if (top.receive !== undefined) {
    const rec = asRecord(top.receive);
    rejectUnknown("receive.", rec, ["hex", "escape", "timestamp", "wrap"]);
    const sub: McpConfigPatch["receive"] = {};
    for (const key of ["hex", "escape", "timestamp", "wrap"] as const) {
      const v = boolField(rec, key);
      if (v !== undefined) sub[key] = v;
    }
    if (Object.keys(sub).length > 0) patch.receive = sub;
  }
  if (top.send !== undefined) {
    const rec = asRecord(top.send);
    rejectUnknown("send.", rec, ["escape", "crlf", "appendNewline"]);
    const sub: McpConfigPatch["send"] = {};
    for (const key of ["escape", "crlf", "appendNewline"] as const) {
      const v = boolField(rec, key);
      if (v !== undefined) sub[key] = v;
    }
    if (Object.keys(sub).length > 0) patch.send = sub;
  }
  if (top.mcp !== undefined) {
    const rec = asRecord(top.mcp);
    rejectUnknown("mcp.", rec, ["enabled", "port"]);
    const sub: McpConfigPatch["mcp"] = {};
    const enabled = boolField(rec, "enabled");
    if (enabled !== undefined) sub.enabled = enabled;
    if (rec.port !== undefined) {
      const v = rec.port;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 65535 || Math.floor(v) !== v) {
        throw new ParamError("PARAM_INVALID", "config mcp.port must be an integer 1..65535");
      }
      sub.port = v;
    }
    if (Object.keys(sub).length > 0) patch.mcp = sub;
  }
  return patch;
}

function configWriteCommand(cmd: McpCommand, ctx: McpContext): McpResult {
  const patch = validateConfigPatch(cmd.args.config ?? cmd.args);
  ctx.configWrite(patch);
  return mcpOk(cmd.id, `config updated: ${JSON.stringify(patch)}`);
}
