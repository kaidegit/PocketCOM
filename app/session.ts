// app/session.ts — 会话接线单例：com 桥 + 消息总线 + 串口会话 + 日志视图。
// 只放装配与响应式适配（app 层逻辑）；纯逻辑都在 core/（可单测）。
// 数据流（SPEC §4.1/§4.2）：
//   宿主串口 → com.poll → SerialSession（base64 解码/帧合流/状态机）→ MessageBus
//   → LogView（格式化显示行）→ ReceivePane；发送反向经 session.write。
import { ref } from "vue";
import { getOps } from "@pocketjs/framework";
import { connectCom, type SerialPortInfo } from "../bridge/com";
import { MessageBus } from "../core/bus";
import { SerialSession } from "../core/session";
import { LogView, type LogRow } from "../core/logview";
import type { LogLineLabels } from "../core/format";
import { composeSendBytes, type SendOptions } from "../core/send";
import { strToBytes } from "../core/codec";
import type { ConnState } from "../core/connection";
import { t } from "./i18n";

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

export const session =
  com !== null
    ? new SerialSession(com, bus, {
        onStateChange: (_from, to) => {
          connState.value = to;
        },
      })
    : null;

// ---------------------------------------------------------------------------
// 串口参数（左面板状态，打开时快照进 session.open）
// ---------------------------------------------------------------------------

export const ports = ref<SerialPortInfo[]>([]);

export function refreshPorts(): void {
  ports.value = session?.ports() ?? [];
}

// ---------------------------------------------------------------------------
// 接收区状态（ReceivePane 使用）
// ---------------------------------------------------------------------------

export const rxHex = ref(false);
export const rxEscape = ref(false);
export const rxTimestamp = ref(false);
export const rxWrap = ref(true);
export const rxPaused = ref(false);
/** 接收区可视宽度（px），ReceivePane 在 resize 时上报（换行用）。 */
export const rxWidth = ref(0);
/** LogView.rows 的内容版本号：sync/重排版后 +1，驱动渲染。 */
export const logVersion = ref(0);

/** i18n 前缀文案快照（标签随语言切换重新取，见 applyLogFormat）。 */
export function logLabels(): LogLineLabels {
  return {
    rx: "<=",
    txManual: `[${t("source.manual")}]`,
    txMcp: `[${t("source.mcp")}]`,
    sys: "[--]",
  };
}

const MONO_SLOT = 17; // text-sm font-mono（fontSlotFor(14,false,mono)）

export const logView = new LogView(
  { hex: rxHex.value, escape: rxEscape.value, timestamp: rxTimestamp.value },
  logLabels(),
  {
    maxRows: 500,
    measure: (s) => getOps().measureText(s, MONO_SLOT),
    wrapWidth: () => (rxWrap.value ? rxWidth.value - 12 : 0),
  },
);

/** 显示开关/语言变化：全量重排版并通知渲染。 */
export function applyLogFormat(): void {
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

export function openConnection(params: Parameters<SerialSession["open"]>[0]): boolean {
  if (!session) return false;
  try {
    session.open(params);
    return true;
  } catch (err) {
    sysMsg(`${t("sys.openFailed")}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
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

/**
 * 发送文本（手动来源）：字节组装 → session.write → 总线 tx 帧。
 * 失败（未连接/参数非法）记 sys 事件并返回 false。
 */
export function sendText(text: string, opts: SendOptions): boolean {
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
    session.write(bytes, "manual");
    txCount.value = session.txBytes;
    return true;
  } catch (err) {
    sysMsg(`${t("send.failed")}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 每帧泵（app.tsx onFrame 调用）
// ---------------------------------------------------------------------------

/** 语言切换钩子（ReceivePane 注册以重取前缀文案）。 */
export const localeChangeHooks: (() => void)[] = [];

/**
 * 每帧：session.poll（事件批 + 合流超时）→ 计数同步 → LogView 同步
 * （暂停时不同步；恢复后从总线环形缓冲自然追上，SPEC §3.3）。
 */
export function pumpSession(nowMs: number): void {
  if (session) {
    session.poll(nowMs);
    if (rxCount.value !== session.rxBytes) rxCount.value = session.rxBytes;
    if (txCount.value !== session.txBytes) txCount.value = session.txBytes;
  }
  if (!rxPaused.value && logView.sync(bus) > 0) {
    logVersion.value++;
  }
}

export type { LogRow };
