// app/session.ts — 会话接线单例：com 桥 + 消息总线 + 统一会话 + 日志视图 +
// 设置持久化（SPEC §3.8）+ 左面板连接参数仓库。
// 只放装配与响应式适配（app 层逻辑）；纯逻辑都在 core/（可单测）。
// 数据流（SPEC §4.1/§4.2）：
//   宿主 → com.poll（每帧一次，app 层 drain）→ appearance 事件 → 主题；
//         其余事件 → ComSession（base64 解码/帧合流/状态机/重连）→ MessageBus
//   → LogView（格式化显示行）→ ReceivePane；发送反向经 session.write。
// 持久化：加载归一化配置 → 灌入各响应式状态；任何受管字段变化 → 500ms 防抖
// 整体回写（以加载时的归一化结果为底，未接 UI 的字段原样保留）。
import { ref, watch } from "vue";
import { getOps } from "@pocketjs/framework";
import { connectCom, type ComEvent, type NetOpenParams, type SerialPortInfo } from "../bridge/com";
import { MessageBus } from "../core/bus";
import { ComSession, type ClientInfo, type NetSessionParams } from "../core/session";
import { Terminal } from "../core/term";
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  pushSendHistory,
  type AppConfig,
  type ConfigFontSize,
  type LastConnConfig,
  type SerialConnParams,
} from "../core/config";
import { LogView, type LogRow } from "../core/logview";
import type { LogLineLabels } from "../core/format";
import { composeSendBytes, type SendOptions } from "../core/send";
import { strToBytes } from "../core/codec";
import type { ConnState } from "../core/connection";
import {
  collectMcpLines,
  executeMcpCommand,
  parseMcpCommands,
  shouldMcpRun,
  type McpConfigPatch,
  type McpContext,
  type McpLabels,
} from "../core/mcp";
import { locale, setLocale, t, type Locale } from "./i18n";
import { setSystemAppearance, themeMode } from "./theme";

// ---------------------------------------------------------------------------
// 桥接与会话
// ---------------------------------------------------------------------------

/** com.* 桥（stock 宿主无 com 命名空间 → null，界面降级）。 */
export const com = connectCom();
export const comAvailable = com !== null;

/** 单一事实源消息总线（SPEC §3.5）。 */
export const bus = new MessageBus();

export const connState = ref<ConnState>("DISCONNECTED");
export const rxCount = ref(0);
export const txCount = ref(0);

/** UI 模式（SPEC §3.1 模式开关：收发 / 终端；切换不断开连接）。 */
export const uiMode = ref<"transfer" | "terminal">("transfer");

/** 切换 UI 模式（连接与终端屏幕缓冲保持，SPEC §3.1）。MCP 仅在收发模式
 *  运行（SPEC §6.1 终端模式门控）：切到终端自动停服，切回自动重启。 */
export function setUiMode(next: "transfer" | "terminal"): void {
  uiMode.value = next;
  syncMcpServer();
}

/** 终端回滚行数设置（SPEC §3.4：terminal.scrollbackLines，0–100000）。 */
export const scrollbackLines = ref(DEFAULT_CONFIG.terminal.scrollbackLines);

/** 终端模式核心（SPEC §3.4）：RX 帧持续灌入（模式切换不清屏），响应字节经
 *  pumpSession 写回连接。 */
export const terminal = new Terminal({ scrollback: scrollbackLines.value });
/** terminal.version 的渲染镜像：每帧比对，变更才 bump 触发重绘。 */
export const termVersion = ref(0);
/** 终端视口滚动偏移（0 = 贴底，向上为正，单位：行）。 */
export const termScroll = ref(0);

// RX → 终端模型（单一事实源总线；tx/sys 不进终端屏）。
bus.subscribe((msg) => {
  if (msg.dir !== "rx" || msg.payload.byteLength === 0) return;
  try {
    terminal.feed(msg.payload);
  } catch {
    // 终端模型错误不阻断总线（与订阅者错误隔离同策略）
  }
});

/** 回滚行数设置（即时生效，越界裁剪，SPEC §3.4）。 */
export function setScrollbackLines(n: number): void {
  if (!Number.isFinite(n)) return;
  const v = Math.min(100000, Math.max(0, Math.floor(n)));
  scrollbackLines.value = v;
  terminal.setScrollback(v);
  termScroll.value = Math.min(termScroll.value, terminal.scrollbackCount);
}

/** 终端键入/粘贴直发（无本地回显，SPEC §3.4）；未连接静默丢弃。 */
export function sendTermBytes(bytes: Uint8Array): boolean {
  if (!session || connState.value !== "CONNECTED" || bytes.byteLength === 0) return false;
  try {
    session.write(bytes, "manual");
    return true;
  } catch {
    return false;
  }
}

/** TCP Server 已接入客户端快照（onClientsChange 钩子刷新）。 */
export const clientList = ref<ClientInfo[]>([]);

export const session =
  com !== null
    ? new ComSession(com, bus, {
        onStateChange: (_from, to) => {
          connState.value = to;
        },
        onClientsChange: () => {
          clientList.value = session?.clientsInfo() ?? [];
        },
      })
    : null;

// ---------------------------------------------------------------------------
// MCP 服务（M4，SPEC §6）：开关偏好 + 运行态 + 启停 + 命令/读行中继
// ---------------------------------------------------------------------------

/** MCP 共享开关（用户偏好，随配置持久化；有效运行态另受终端模式门控）。 */
export const mcpEnabled = ref(DEFAULT_CONFIG.mcp.enabled);
/** MCP 监听端口（SPEC §6.1 默认 7960）。 */
export const mcpPort = ref(DEFAULT_CONFIG.mcp.port);
/** Bearer token（宿主首启随机生成 32 字节回传后持久化；0600 配置文件，
 *  导出时宿主剥离，SPEC §5.3）。 */
export const mcpToken = ref("");
/** MCP server 运行态（宿主经 {t:"mcp"} 事件回推；状态栏/状态工具共享）。 */
export const mcpState = ref({ on: false, clients: 0 });

/** MCP 读行来源标签（i18n 注入，RX/SYS 稳定标记，SPEC §6.4）。 */
function mcpLabels(): McpLabels {
  return { rx: "[RX]", txManual: `[${t("source.manual")}]`, sys: "[SYS]" };
}

/** 读行增量同步点：server 启动时归位到最新消息，agent 只看开启之后的流量。 */
let mcpLastMsgId = 0;

/** 按有效运行态（开关 && 收发模式）启停 MCP server（幂等）。 */
export function syncMcpServer(): void {
  if (!com) return;
  const want = shouldMcpRun(mcpEnabled.value, uiMode.value);
  if (want && !mcpState.value.on) {
    if (typeof com.mcpStart !== "function") return; // 旧宿主无 mcp 桥
    const r = com.mcpStart({ port: mcpPort.value, token: mcpToken.value });
    if (r === null) return;
    if (r.ok) {
      if (r.token !== mcpToken.value) {
        mcpToken.value = r.token; // 首启生成的 token 需持久化（防抖回写）
      }
      const snap = bus.buffer.peek();
      mcpLastMsgId = snap.length > 0 ? snap[snap.length - 1]!.id : 0;
      mcpState.value = { on: true, clients: 0 }; // 事件回推会再校准
      sysMsg(`${t("mcp.on")}: ${mcpUrl()}`);
    } else {
      mcpEnabled.value = false; // 端口占用等失败：回退开关并提示
      sysMsg(`${t("mcp.startFailed")}: ${r.msg}`);
    }
  } else if (!want && mcpState.value.on) {
    com.mcpStop();
    mcpState.value = { on: false, clients: 0 };
  }
}

/** MCP 端点 URL（面板显示 / sys 提示共用）。 */
export function mcpUrl(): string {
  return `http://127.0.0.1:${mcpPort.value}/mcp`;
}

/** 白名单配置快照（config_read 工具；token 永不出现在其中）。 */
function buildMcpConfigSnapshot(): Record<string, unknown> {
  return {
    language: locale.value,
    theme: themeMode.value,
    fontSize: fontSize.value,
    terminal: { scrollbackLines: scrollbackLines.value },
    receive: {
      hex: rxHex.value,
      escape: rxEscape.value,
      timestamp: rxTimestamp.value,
      wrap: rxWrap.value,
    },
    send: {
      escape: sendEscape.value,
      crlf: sendCrlf.value,
      appendNewline: sendAppendNl.value,
    },
    mcp: { enabled: mcpEnabled.value, port: mcpPort.value },
  };
}

/** 应用 MCP config_write 补丁（补丁已过 validateConfigPatch 白名单校验）。 */
function applyMcpConfigPatch(patch: McpConfigPatch): void {
  let needFormat = false;
  if (patch.language !== undefined && patch.language !== locale.value) {
    setLocale(patch.language);
    needFormat = true;
  }
  if (patch.theme !== undefined) themeMode.value = patch.theme;
  if (patch.fontSize !== undefined) {
    fontSize.value = patch.fontSize;
    needFormat = true;
  }
  if (patch.scrollbackLines !== undefined) setScrollbackLines(patch.scrollbackLines);
  if (patch.receive) {
    if (patch.receive.hex !== undefined) rxHex.value = patch.receive.hex;
    if (patch.receive.escape !== undefined) rxEscape.value = patch.receive.escape;
    if (patch.receive.timestamp !== undefined) rxTimestamp.value = patch.receive.timestamp;
    if (patch.receive.wrap !== undefined) rxWrap.value = patch.receive.wrap;
    needFormat = true;
  }
  if (patch.send) {
    if (patch.send.escape !== undefined) sendEscape.value = patch.send.escape;
    if (patch.send.crlf !== undefined) sendCrlf.value = patch.send.crlf;
    if (patch.send.appendNewline !== undefined) sendAppendNl.value = patch.send.appendNewline;
  }
  if (patch.mcp?.port !== undefined) mcpPort.value = patch.mcp.port;
  if (patch.mcp?.enabled !== undefined) mcpEnabled.value = patch.mcp.enabled;
  if (needFormat) applyLogFormat();
  persistNow();
}

/** MCP 命令执行上下文（核心执行器经它触达会话/配置/门控）。 */
function mcpContext(): McpContext {
  return {
    session,
    mcpClients: () => mcpState.value.clients,
    configRead: buildMcpConfigSnapshot,
    configWrite: applyMcpConfigPatch,
    gateOpen: () => shouldMcpRun(mcpEnabled.value, uiMode.value),
  };
}

/** 每帧 MCP 中继（pumpSession 内调用）：命令批 drain → 执行 → 回结果；
 *  总线增量（RX + 手动 TX + sys）格式化为读行 feed 给宿主读缓冲。 */
function pumpMcp(): void {
  if (!com || !mcpState.value.on) return;
  const batch = com.mcpCmds();
  if (batch) {
    const cmds = parseMcpCommands(batch);
    if (cmds.length > 0) {
      const results = cmds.map((c) => executeMcpCommand(c, mcpContext()));
      com.mcpResults(JSON.stringify(results));
    }
  }
  const { lines, lastId } = collectMcpLines(bus, mcpLastMsgId, mcpLabels());
  mcpLastMsgId = lastId;
  if (lines.length > 0) com.mcpFeed(lines);
}

// ---------------------------------------------------------------------------
// 连接参数仓库（左面板状态；打开时快照进 session.open*，成功后写入 lastConn）
// ---------------------------------------------------------------------------

export const connType = ref<"serial" | NetOpenParams["kind"]>("serial");

// 串口
export const portPath = ref("");
export const baud = ref("115200");
export const dataBits = ref("8");
export const parity = ref("none");
export const stopBits = ref("1");
export const flowControl = ref("none");
export const dtr = ref(false);
export const rts = ref(false);

// TCP Client / UDP / WS 共用的 host/port 形态
export const tcpHost = ref("");
export const tcpPort = ref("9000");
export const tcpAutoReconnect = ref(false);
export const tcpReconnectSec = ref("5");
export const tcpsPort = ref("9000");
export const udpBindPort = ref("9000");
export const udpHost = ref("");
export const udpPort = ref("9000");
export const wsUrl = ref("");
export const wsAutoReconnect = ref(false);
export const wsReconnectSec = ref("5");

export const ports = ref<SerialPortInfo[]>([]);

export function refreshPorts(): void {
  ports.value = session?.ports() ?? [];
  // 枚举后校验当前选择：已拔掉的端口不再显示（保存的 lastConn.serial.path
  // 不受影响，设备插回后下次启动仍恢复）。
  if (portPath.value !== "" && !ports.value.some((p) => p.path === portPath.value)) {
    portPath.value = "";
  }
}

/** 切换连接类型时自动断开旧连接（SPEC §3.2 通用行为）。 */
export function setConnType(next: typeof connType.value): void {
  if (connType.value === next) return;
  if (session && (connState.value === "CONNECTED" || connState.value === "LOST")) {
    closeConnection();
  }
  connType.value = next;
}

function serialParams(): SerialConnParams {
  const baudText = baud.value;
  return {
    path: portPath.value,
    baudRate: Number.parseInt(baudText, 10) || 115200,
    dataBits: Number(dataBits.value) as 5 | 6 | 7 | 8,
    parity: parity.value as SerialConnParams["parity"],
    stopBits: Number(stopBits.value) as 1 | 2,
    flowControl: flowControl.value as SerialConnParams["flowControl"],
    dtr: dtr.value,
    rts: rts.value,
  };
}

function snapshotLastConn(kind: typeof connType.value): void {
  const last = lastConn.value;
  switch (kind) {
    case "serial":
      last.serial = serialParams();
      break;
    case "tcp":
      last.tcp = {
        host: tcpHost.value,
        port: Number.parseInt(tcpPort.value, 10) || 9000,
        autoReconnect: tcpAutoReconnect.value,
        reconnectSec: Number.parseInt(tcpReconnectSec.value, 10) || 5,
      };
      break;
    case "tcps":
      last.tcps = { port: Number.parseInt(tcpsPort.value, 10) || 9000 };
      break;
    case "udp":
      last.udp = {
        bindPort: Number.parseInt(udpBindPort.value, 10) || 0,
        host: udpHost.value,
        port: Number.parseInt(udpPort.value, 10) || 9000,
      };
      break;
    case "ws":
      last.ws = {
        url: wsUrl.value,
        autoReconnect: wsAutoReconnect.value,
        reconnectSec: Number.parseInt(wsReconnectSec.value, 10) || 5,
      };
      break;
  }
  lastConn.value = last;
}

// ---------------------------------------------------------------------------
// 接收区状态（ReceivePane 使用）
// ---------------------------------------------------------------------------

export const rxHex = ref(false);
export const rxEscape = ref(false);
export const rxTimestamp = ref(false);
export const rxWrap = ref(true);
export const rxPaused = ref(false);
/** 接口区字号档位（12/14/16，受框架 mono 字形槽约束，SPEC §3.8）。 */
export const fontSize = ref<ConfigFontSize>(14);
/** 发送区开关（随配置持久化）。 */
export const sendEscape = ref(false);
export const sendCrlf = ref(false);
export const sendAppendNl = ref(false);
/** 发送历史（去重置顶，上限 50，SPEC §3.3/§3.8）。 */
export const sendHistory = ref<string[]>([]);
/** 接收区可视宽度（px），ReceivePane 在 resize 时上报（换行用）。 */
export const rxWidth = ref(0);
/** LogView.rows 的内容版本号：sync/重排版后 +1，驱动渲染。 */
export const logVersion = ref(0);

/** 字号 → mono 字形槽（框架 mono 槽固定 12/14/16px → slot 16/17/18）。 */
const MONO_SLOTS: Record<ConfigFontSize, number> = { 12: 16, 14: 17, 16: 18 };
/** 字号 → 行高（1.3×，与 text-xs/sm/base 默认行高一致）。 */
export const LINE_H: Record<ConfigFontSize, number> = { 12: 16, 14: 18, 16: 21 };

/** i18n 前缀文案快照（标签随语言切换重新取，见 applyLogFormat）。 */
export function logLabels(): LogLineLabels {
  return {
    rx: "<=",
    txManual: `[${t("source.manual")}]`,
    txMcp: `[${t("source.mcp")}]`,
    sys: "[--]",
  };
}

export const logView = new LogView(
  { hex: rxHex.value, escape: rxEscape.value, timestamp: rxTimestamp.value },
  logLabels(),
  {
    maxRows: 500,
    measure: (s) => getOps().measureText(s, MONO_SLOTS[fontSize.value]),
    wrapWidth: () => (rxWrap.value ? rxWidth.value - 12 : 0),
  },
);

/** 显示开关/语言/字号变化：全量重排版并通知渲染。 */
export function applyLogFormat(): void {
  logView.remeasure();
  logView.setFormat(
    { hex: rxHex.value, escape: rxEscape.value, timestamp: rxTimestamp.value },
    logLabels(),
  );
  logVersion.value++;
}

/** 清屏：显示行清空 + Rx/Tx 计数归零（SPEC §3.3）。 */
export function clearLog(): void {
  logView.clear(logView.lastSeenMsgId);
  if (session) {
    session.rxBytes = 0;
    session.txBytes = 0;
  }
  rxCount.value = 0;
  txCount.value = 0;
  logVersion.value++;
}

/** 追加一条 sys 消息（UI 层的连接失败/发送失败提示走这里进总线）。 */
export function sysMsg(text: string): void {
  bus.append({ dir: "sys", source: "system", payload: strToBytes(text), connId: session?.connId ?? "none" });
}

// ---------------------------------------------------------------------------
// 打开 / 关闭 / 发送
// ---------------------------------------------------------------------------

export function openSerialConnection(): boolean {
  if (!session) return false;
  const params = serialParams();
  if (params.path === "") {
    sysMsg(t("conn.noPortSelected"));
    return false;
  }
  if (!/^\d+$/.test(baud.value) || params.baudRate <= 0) {
    sysMsg(`${t("conn.baudInvalid")}: ${baud.value}`);
    return false;
  }
  try {
    session.openSerial({
      path: params.path,
      baudRate: params.baudRate,
      dataBits: params.dataBits,
      parity: params.parity,
      stopBits: params.stopBits,
      flowControl: params.flowControl,
    });
    session.setSignals({ dtr: dtr.value, rts: rts.value });
    snapshotLastConn("serial");
    return true;
  } catch (err) {
    sysMsg(`${t("sys.openFailed")}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function openNetConnection(params: NetSessionParams): boolean {
  if (!session) return false;
  try {
    session.openNet(params);
    snapshotLastConn(params.kind);
    return true;
  } catch (err) {
    sysMsg(`${t("sys.openFailed")}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** 按当前连接类型与面板参数打开（面板打开按钮入口）。 */
export function openCurrentConnection(): boolean {
  switch (connType.value) {
    case "serial":
      return openSerialConnection();
    case "tcp":
      return openNetConnection({
        kind: "tcp",
        host: tcpHost.value.trim(),
        port: Number.parseInt(tcpPort.value, 10) || 0,
        autoReconnect: tcpAutoReconnect.value,
        reconnectSec: Number.parseInt(tcpReconnectSec.value, 10) || 5,
      });
    case "tcps":
      return openNetConnection({
        kind: "tcps",
        port: Number.parseInt(tcpsPort.value, 10) || 0,
      });
    case "udp":
      return openNetConnection({
        kind: "udp",
        bindPort: Number.parseInt(udpBindPort.value, 10) || 0,
        host: udpHost.value.trim(),
        port: Number.parseInt(udpPort.value, 10) || 0,
      });
    case "ws":
      return openNetConnection({
        kind: "ws",
        url: wsUrl.value.trim(),
        autoReconnect: wsAutoReconnect.value,
        reconnectSec: Number.parseInt(wsReconnectSec.value, 10) || 5,
      });
  }
}

export function closeConnection(): void {
  if (!session) return;
  try {
    session.close();
  } catch (err) {
    sysMsg(`${t("sys.closeFailed")}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 踢除 TCP Server 客户端（面板客户端列表入口）。 */
export function kickClient(handle: number): void {
  session?.kick(handle);
}

/** 状态栏连接摘要（未连接 = ""）。 */
export function connSummary(): string {
  if (!session || connState.value === "DISCONNECTED" || connState.value === "CONNECTING") return "";
  return session.describe;
}

/**
 * 发送文本（手动来源，target 仅 tcps 指定客户端时给出）：
 * 字节组装 → session.write → 总线 tx 帧。成功后进发送历史。
 */
export function sendText(text: string, opts: SendOptions, target?: number): boolean {
  if (!session || session.state !== "CONNECTED") {
    sysMsg(t("send.notConnected"));
    return false;
  }
  let bytes: Uint8Array;
  try {
    bytes = composeSendBytes(text, opts);
  } catch (err) {
    sysMsg(`${t("send.parseFailed")}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  if (bytes.byteLength === 0) return false;
  try {
    session.write(bytes, "manual", target);
    txCount.value = session.txBytes;
    if (target === undefined) {
      const next = pushSendHistory(sendHistory.value, text);
      if (next !== sendHistory.value) sendHistory.value = next;
    }
    return true;
  } catch (err) {
    sysMsg(`${t("send.failed")}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function clearSendHistory(): void {
  sendHistory.value = [];
}

// ---------------------------------------------------------------------------
// 设置持久化（SPEC §3.8）
// ---------------------------------------------------------------------------

/** 加载时的归一化配置（回写时的底：未接 UI 的字段原样保留）。 */
let configBase: AppConfig = DEFAULT_CONFIG;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function buildConfigJson(): string {
  const cfg: AppConfig = {
    ...configBase,
    language: locale.value,
    theme: themeMode.value,
    fontSize: fontSize.value,
    terminal: { scrollbackLines: scrollbackLines.value },
    receive: {
      hex: rxHex.value,
      escape: rxEscape.value,
      timestamp: rxTimestamp.value,
      wrap: rxWrap.value,
    },
    send: {
      escape: sendEscape.value,
      crlf: sendCrlf.value,
      appendNewline: sendAppendNl.value,
    },
    lastConn: lastConn.value,
    sendHistory: sendHistory.value,
    mcp: { enabled: mcpEnabled.value, port: mcpPort.value, token: mcpToken.value },
  };
  return JSON.stringify(cfg, null, 2);
}

function persistNow(): void {
  persistTimer = null;
  if (!comAvailable) return;
  const ok = com!.cfgWrite(buildConfigJson());
  if (ok === false) sysMsg(t("settings.persistFailed"));
}

/** 受管字段变化 → 防抖回写（500ms；连发设置不至于每帧写盘）。 */
function schedulePersist(): void {
  if (!comAvailable) return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 500);
}

/** 配置导出（原生保存面板；宿主剥离 token）。结果进 sys 事件。 */
export function exportConfig(): void {
  if (!comAvailable) return;
  const raw = com!.cfgExport(buildConfigJson());
  reportCfgResult(raw, "settings.exportDone", "settings.exportCanceled");
}

/** 配置导入（原生打开面板）→ 归一化 → 灌入 → 立即回写。 */
export function importConfig(): void {
  if (!comAvailable) return;
  const raw = com!.cfgImport();
  const parsed = parseCfgResult(raw);
  if (!parsed.ok) {
    if (!parsed.canceled) sysMsg(`${t("settings.importFailed")}: ${parsed.msg ?? ""}`);
    else sysMsg(t("settings.importCanceled"));
    return;
  }
  try {
    applyConfig(normalizeConfig(JSON.parse(parsed.json ?? "{}")));
    persistNow();
    sysMsg(t("settings.importDone"));
  } catch (err) {
    sysMsg(`${t("settings.importFailed")}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type CfgResult =
  | { ok: true; path?: string; json?: string }
  | { ok: false; canceled?: boolean; msg?: string };

function parseCfgResult(raw: string | null): CfgResult {
  if (raw === null) return { ok: false, msg: "bridge unavailable" };
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (v.ok === true) return { ok: true, path: v.path as string | undefined, json: v.json as string | undefined };
    if (v.ok === false && v.canceled === true) return { ok: false, canceled: true };
    const err = v.error as { msg?: string } | undefined;
    return { ok: false, msg: err?.msg ?? "unknown" };
  } catch {
    return { ok: false, msg: "malformed host result" };
  }
}

function reportCfgResult(raw: string | null, doneKey: string, cancelKey: string): void {
  const r = parseCfgResult(raw);
  if (r.ok) sysMsg(`${t(doneKey)}${r.path ? `: ${r.path}` : ""}`);
  else if (r.canceled) sysMsg(t(cancelKey));
  else sysMsg(`${t("settings.exportFailed")}: ${r.msg ?? ""}`);
}

/** 把归一化配置灌入各响应式状态（启动加载 / 导入共用）。 */
function applyConfig(cfg: AppConfig): void {
  configBase = cfg;
  setLocale(cfg.language as Locale);
  themeMode.value = cfg.theme;
  fontSize.value = cfg.fontSize;
  setScrollbackLines(cfg.terminal.scrollbackLines);
  rxHex.value = cfg.receive.hex;
  rxEscape.value = cfg.receive.escape;
  rxTimestamp.value = cfg.receive.timestamp;
  rxWrap.value = cfg.receive.wrap;
  sendEscape.value = cfg.send.escape;
  sendCrlf.value = cfg.send.crlf;
  sendAppendNl.value = cfg.send.appendNewline;
  sendHistory.value = cfg.sendHistory;
  lastConn.value = cfg.lastConn;
  mcpEnabled.value = cfg.mcp.enabled;
  mcpPort.value = cfg.mcp.port;
  mcpToken.value = cfg.mcp.token;

  const s = cfg.lastConn.serial;
  if (s) {
    portPath.value = s.path;
    baud.value = String(s.baudRate);
    dataBits.value = String(s.dataBits);
    parity.value = s.parity;
    stopBits.value = String(s.stopBits);
    flowControl.value = s.flowControl;
    dtr.value = s.dtr;
    rts.value = s.rts;
  }
  if (cfg.lastConn.tcp) {
    tcpHost.value = cfg.lastConn.tcp.host;
    tcpPort.value = String(cfg.lastConn.tcp.port);
    tcpAutoReconnect.value = cfg.lastConn.tcp.autoReconnect;
    tcpReconnectSec.value = String(cfg.lastConn.tcp.reconnectSec);
  }
  if (cfg.lastConn.tcps) tcpsPort.value = String(cfg.lastConn.tcps.port);
  if (cfg.lastConn.udp) {
    udpBindPort.value = String(cfg.lastConn.udp.bindPort);
    udpHost.value = cfg.lastConn.udp.host;
    udpPort.value = String(cfg.lastConn.udp.port);
  }
  if (cfg.lastConn.ws) {
    wsUrl.value = cfg.lastConn.ws.url;
    wsAutoReconnect.value = cfg.lastConn.ws.autoReconnect;
    wsReconnectSec.value = String(cfg.lastConn.ws.reconnectSec);
  }
  applyLogFormat();
  // MCP 开关随配置加载（SPEC §6.1）：收发模式下立即启动（终端模式门控见
  // setUiMode / syncMcpServer）。
  syncMcpServer();
}

const lastConn = ref<LastConnConfig>({});

// 启动加载（stock 宿主 / 无 cfg 桥 → 默认配置）。
if (comAvailable) {
  const raw = com!.cfgRead();
  if (raw !== null) {
    try {
      applyConfig(normalizeConfig(JSON.parse(raw)));
    } catch {
      applyConfig(DEFAULT_CONFIG);
    }
  } else {
    applyConfig(DEFAULT_CONFIG);
  }
}

// 受管字段 → 防抖回写。
for (const source of [
  locale,
  themeMode,
  fontSize,
  scrollbackLines,
  rxHex,
  rxEscape,
  rxTimestamp,
  rxWrap,
  sendEscape,
  sendCrlf,
  sendAppendNl,
  sendHistory,
  lastConn,
  mcpEnabled,
  mcpToken,
]) {
  watch(source, schedulePersist, { deep: true });
}
// MCP 开关变化 → 立即启停（终端模式门控在 syncMcpServer 内统一判断）。
watch(mcpEnabled, syncMcpServer);
// 端口变化 → 重启 server 使新端口生效。
watch(mcpPort, () => {
  if (!mcpState.value.on) return;
  com?.mcpStop();
  mcpState.value = { on: false, clients: 0 };
  syncMcpServer();
});

// ---------------------------------------------------------------------------
// 每帧泵（app.tsx onFrame 调用）
// ---------------------------------------------------------------------------

/** 语言切换钩子（ReceivePane 注册以重取前缀文案）。 */
export const localeChangeHooks: (() => void)[] = [];

/** terminal.version 上次同步点（避免每帧 bump 渲染版本）。 */
let lastTermVersion = 0;

/**
 * 每帧：drain com 事件批（appearance → 主题，其余 → 会话）→ 计数同步 →
 * LogView 同步（暂停时不同步；恢复后从总线环形缓冲自然追上，SPEC §3.3）→
 * 终端模型版本/应答泵（DSR/DA 应答写回连接，SPEC §3.4）。
 */
export function pumpSession(nowMs: number): void {
  if (com && session) {
    const events: ComEvent[] = com.poll();
    const connEvents: ComEvent[] = [];
    for (const ev of events) {
      if (ev.t === "appearance") setSystemAppearance(ev.v);
      else if (ev.t === "mcp") mcpState.value = { on: ev.on, clients: ev.clients };
      else connEvents.push(ev);
    }
    session.poll(connEvents, nowMs);
    if (rxCount.value !== session.rxBytes) rxCount.value = session.rxBytes;
    if (txCount.value !== session.txBytes) txCount.value = session.txBytes;
    // 终端查询应答（CPR/DA）：连接在场就写回（shell 在等）。
    const responses = terminal.takeResponses();
    for (const bytes of responses) {
      try {
        session.write(bytes, "system");
      } catch {
        break; // 未连接/写入失败：丢弃应答
      }
    }
    // MCP 中继（SPEC §6.2）：命令 drain→执行→回结果；总线增量→读行 feed。
    pumpMcp();
  }
  if (terminal.version !== lastTermVersion) {
    lastTermVersion = terminal.version;
    termVersion.value++;
  }
  if (!rxPaused.value) {
    const { added, lost } = logView.sync(bus);
    if (added > 0) logVersion.value++;
    // 环形缓冲裁掉了尚未显示的帧（如暂停期间流量超容量）：记一条 sys 提示
    if (lost > 0) sysMsg(t("sys.bufferOverflow", { n: lost }));
  }
}

export type { LogRow };
