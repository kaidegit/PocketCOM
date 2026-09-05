/**
 * 设置持久化（SPEC §3.8）：配置 schema、默认值与归一化。
 * 纯 TS：宿主只负责字节级存取（com.cfgRead/cfgWrite，0600 原子写），
 * 这里负责把任意（可能损坏/缺字段的）JSON 归一化成合法配置——永不抛错，
 * 未知字段丢弃，非法值回退默认，历史类字段封顶 50 条。
 *
 * 内容（SPEC §3.8）：语言、主题、字体大小、终端回滚行数、最近连接参数
 * （按类型）、发送历史、接收区开关项、日志路径、MCP 端口与 token。
 */

export type ConfigLanguage = "zh-CN" | "en";
export type ConfigTheme = "light" | "dark" | "system";
/** 字号档位：框架 mono 字形槽只支持 12/14/16px（fontSlotFor 约束）。 */
export type ConfigFontSize = 12 | 14 | 16;

export interface SerialConnParams {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: "none" | "odd" | "even" | "mark" | "space";
  stopBits: 1 | 2;
  flowControl: "none" | "xonxoff" | "rtscts" | "dsrdtr";
  dtr: boolean;
  rts: boolean;
}

export interface TcpConnParams {
  host: string;
  port: number;
  autoReconnect: boolean;
  reconnectSec: number;
}

export interface TcpServerConnParams {
  port: number;
}

export interface UdpConnParams {
  bindPort: number;
  host: string;
  port: number;
}

export interface WsConnParams {
  url: string;
  autoReconnect: boolean;
  reconnectSec: number;
}

export interface LastConnConfig {
  serial?: SerialConnParams;
  tcp?: TcpConnParams;
  tcps?: TcpServerConnParams;
  udp?: UdpConnParams;
  ws?: WsConnParams;
}

export interface McpConfig {
  enabled: boolean;
  port: number;
  token: string;
}

export interface AppConfig {
  version: 1;
  language: ConfigLanguage;
  theme: ConfigTheme;
  fontSize: ConfigFontSize;
  terminal: { scrollbackLines: number };
  receive: { hex: boolean; escape: boolean; timestamp: boolean; wrap: boolean };
  send: { escape: boolean; crlf: boolean; appendNewline: boolean };
  lastConn: LastConnConfig;
  /** 发送历史：去重置顶、最旧在后，上限 50（SPEC §3.3/§3.8）。 */
  sendHistory: string[];
  logPath: string;
  mcp: McpConfig;
}

export const HISTORY_LIMIT = 50;

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  language: "zh-CN",
  theme: "dark",
  fontSize: 14,
  terminal: { scrollbackLines: 9999 },
  receive: { hex: false, escape: false, timestamp: false, wrap: true },
  send: { escape: false, crlf: false, appendNewline: false },
  lastConn: {},
  sendHistory: [],
  logPath: "",
  mcp: { enabled: false, port: 7960, token: "" },
};

// ---------------------------------------------------------------------------
// 归一化工具（宽容读取：外部文件可能来自旧版本或手工编辑）
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asOneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function asOneOfNum<T extends number>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "number" && (allowed as readonly number[]).includes(v)
    ? (v as T)
    : fallback;
}

function asStringArray(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === "string")
    .slice(0, limit);
}

/** 发送历史去重置顶（新的在前）、封顶 50（SPEC §3.8）。 */
export function pushSendHistory(history: string[], entry: string): string[] {
  const trimmed = entry.trim();
  if (trimmed === "") return history;
  return [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, HISTORY_LIMIT);
}

// ---------------------------------------------------------------------------
// per-type 连接参数归一化
// ---------------------------------------------------------------------------

function normSerial(v: unknown): SerialConnParams {
  const r = asRecord(v);
  return {
    path: asString(r.path, ""),
    baudRate: asInt(r.baudRate, 115200, 1, 4500000),
    dataBits: asOneOfNum(r.dataBits, [5, 6, 7, 8] as const, 8),
    parity: asOneOf(r.parity, ["none", "odd", "even", "mark", "space"] as const, "none"),
    stopBits: asOneOfNum(r.stopBits, [1, 2] as const, 1),
    flowControl: asOneOf(r.flowControl, ["none", "xonxoff", "rtscts", "dsrdtr"] as const, "none"),
    dtr: asBool(r.dtr, false),
    rts: asBool(r.rts, false),
  };
}

function normTcp(v: unknown): TcpConnParams {
  const r = asRecord(v);
  return {
    host: asString(r.host, ""),
    port: asInt(r.port, 9000, 1, 65535),
    autoReconnect: asBool(r.autoReconnect, false),
    reconnectSec: asInt(r.reconnectSec, 5, 1, 3600),
  };
}

function normTcps(v: unknown): TcpServerConnParams {
  const r = asRecord(v);
  return { port: asInt(r.port, 9000, 1, 65535) };
}

function normUdp(v: unknown): UdpConnParams {
  const r = asRecord(v);
  return {
    bindPort: asInt(r.bindPort, 9000, 0, 65535),
    host: asString(r.host, ""),
    port: asInt(r.port, 9000, 1, 65535),
  };
}

function normWs(v: unknown): WsConnParams {
  const r = asRecord(v);
  return {
    url: asString(r.url, ""),
    autoReconnect: asBool(r.autoReconnect, false),
    reconnectSec: asInt(r.reconnectSec, 5, 1, 3600),
  };
}

/**
 * 任意 JSON → 合法配置。缺字段用默认值；非法字段逐项回退；
 * 永不抛错（损坏的 config.json 不能挡住启动）。
 */
export function normalizeConfig(raw: unknown): AppConfig {
  const r = asRecord(raw);
  const lastConn = asRecord(r.lastConn);
  return {
    version: 1,
    language: asOneOf(r.language, ["zh-CN", "en"] as const, DEFAULT_CONFIG.language),
    theme: asOneOf(r.theme, ["light", "dark", "system"] as const, DEFAULT_CONFIG.theme),
    fontSize: asOneOfNum(r.fontSize, [12, 14, 16] as const, DEFAULT_CONFIG.fontSize),
    terminal: {
      scrollbackLines: asInt(
        asRecord(r.terminal).scrollbackLines,
        DEFAULT_CONFIG.terminal.scrollbackLines,
        0,
        100000,
      ),
    },
    receive: {
      hex: asBool(asRecord(r.receive).hex, DEFAULT_CONFIG.receive.hex),
      escape: asBool(asRecord(r.receive).escape, DEFAULT_CONFIG.receive.escape),
      timestamp: asBool(asRecord(r.receive).timestamp, DEFAULT_CONFIG.receive.timestamp),
      wrap: asBool(asRecord(r.receive).wrap, DEFAULT_CONFIG.receive.wrap),
    },
    send: {
      escape: asBool(asRecord(r.send).escape, DEFAULT_CONFIG.send.escape),
      crlf: asBool(asRecord(r.send).crlf, DEFAULT_CONFIG.send.crlf),
      appendNewline: asBool(asRecord(r.send).appendNewline, DEFAULT_CONFIG.send.appendNewline),
    },
    lastConn: {
      serial: lastConn.serial !== undefined ? normSerial(lastConn.serial) : undefined,
      tcp: lastConn.tcp !== undefined ? normTcp(lastConn.tcp) : undefined,
      tcps: lastConn.tcps !== undefined ? normTcps(lastConn.tcps) : undefined,
      udp: lastConn.udp !== undefined ? normUdp(lastConn.udp) : undefined,
      ws: lastConn.ws !== undefined ? normWs(lastConn.ws) : undefined,
    },
    sendHistory: asStringArray(r.sendHistory, HISTORY_LIMIT),
    logPath: asString(r.logPath, ""),
    mcp: {
      enabled: asBool(asRecord(r.mcp).enabled, false),
      port: asInt(asRecord(r.mcp).port, DEFAULT_CONFIG.mcp.port, 1, 65535),
      token: asString(asRecord(r.mcp).token, ""),
    },
  };
}
