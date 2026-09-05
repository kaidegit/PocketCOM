// app/transfer.tsx — 右侧收发区：接收日志窗 + 发送区（SPEC §3.1/§3.3）。
// 接收区：窗口化渲染（行高随字号档位，可视窗口 ± 过扫描），滚动锁定贴底，
// 暂停 = 停止从总线同步（数据继续入总线），清屏归零计数。
// 发送区：ASCII/HEX 互转、转义/CRLF/追加换行、定时循环、发送历史（M2 持久化）、
// TCP Server 多客户端定向/广播发送（M2）。
import { onUnmounted, ref, watch } from "vue";
import { Text, View } from "@pocketjs/framework/components";
import { virtualNow } from "@pocketjs/framework/clock";
import {
  Btn,
  CheckRow,
  Hairline,
  Scrollbar,
  SegCtrl,
  Select,
  TextField,
  type TextFieldHandle,
} from "./widgets";
import { LINE_H as FONT_LINE_H, MONO_CLASS } from "./fontsize";
import { theme } from "./theme";
import { t } from "./i18n";
import { PANEL_W, STATUS_H, viewportSize } from "./layout";
import { onWheel } from "./wheel";
import { convertInputText, type SendOptions } from "../core/send";
import type { PopupAnchor } from "./widgets";
import type { LogRow } from "../core/logview";
import {
  applyLogFormat,
  clearLog,
  clearSendHistory,
  clientList,
  connState,
  fontSize,
  logView,
  logVersion,
  rxEscape,
  rxHex,
  rxPaused,
  rxTimestamp,
  rxWidth,
  rxWrap,
  sendHistory,
  sendText,
  session,
} from "./session";

/** 接收区工具栏高。 */
const TOOLBAR_H = 34;
/** 发送区总高：1 分隔线 + 8 上 padding + 24 选项行 + 6 间距 + 56 输入行 + 8 下 padding。 */
export const SEND_PANE_H = 103;

const TOOLBAR_CTL_H = 22;

function dirColor(dir: LogRow["dir"]): string {
  if (dir === "rx") return theme.value.rx;
  if (dir === "tx") return theme.value.tx;
  return theme.value.sys;
}

function prefixColor(kind: LogRow["prefixKind"]): string {
  switch (kind) {
    case "rx":
      return theme.value.rx;
    case "tx-mcp":
      return theme.value.prefixMcp;
    case "tx-manual":
      return theme.value.prefixManual;
    default:
      return theme.value.prefixSys;
  }
}

// ---------------------------------------------------------------------------
// 接收区
// ---------------------------------------------------------------------------

export function ReceivePane() {
  const scroll = ref(0);
  const stickBottom = ref(true);

  const lineH = () => FONT_LINE_H[fontSize.value];

  const viewH = () => Math.max(0, viewportSize.value.h - STATUS_H - SEND_PANE_H - TOOLBAR_H - 1);
  const maxScroll = () => Math.max(0, logView.rows.length * lineH() - viewH());

  // 新数据：贴底跟随；否则保持（滚动锁定，SPEC §3.3）
  watch(logVersion, () => {
    if (stickBottom.value) scroll.value = maxScroll();
  });
  // 字号变化：保持贴底语义
  watch(fontSize, () => {
    if (stickBottom.value) scroll.value = maxScroll();
  });

  // 视口变化：上报换行宽度 + 重排
  const reportWidth = () => {
    rxWidth.value = Math.max(0, viewportSize.value.w - PANEL_W - 16);
  };
  watch(viewportSize, () => {
    reportWidth();
    if (rxWrap.value) {
      logView.refresh();
      logVersion.value++;
    }
  });
  reportWidth();

  onWheel("log", (dy) => {
    scroll.value = Math.max(0, Math.min(maxScroll(), scroll.value - dy));
    stickBottom.value = scroll.value >= maxScroll() - 1;
  });

  const visibleRows = (): { row: LogRow; index: number }[] => {
    void logVersion.value; // 依赖：行内容/数量变化
    const from = Math.max(0, Math.floor(scroll.value / lineH()) - 3);
    const to = Math.min(logView.rows.length, Math.ceil((scroll.value + viewH()) / lineH()) + 3);
    const out: { row: LogRow; index: number }[] = [];
    for (let i = from; i < to; i++) out.push({ row: logView.rows[i]!, index: i });
    return out;
  };

  return (
    <View class="flex-col" style={{ height: viewportSize.value.h - STATUS_H - SEND_PANE_H }}>
      {/* 工具栏：ASCII/HEX · 转义 · 时间戳 · 自动换行 ‖ 暂停 · 清屏 */}
      <View class="flex-row items-center gap-2 px-2" style={{ height: TOOLBAR_H }}>
        <View style={{ width: 92, height: TOOLBAR_CTL_H }}>
          <SegCtrl
            height={TOOLBAR_CTL_H}
            options={[
              { value: "ascii", label: t("receive.ascii") },
              { value: "hex", label: t("receive.hex") },
            ]}
            value={() => (rxHex.value ? "hex" : "ascii")}
            onPick={(v) => {
              rxHex.value = v === "hex";
              applyLogFormat();
            }}
          />
        </View>
        <CheckRow
          label={() => t("receive.escape")}
          checked={() => rxEscape.value}
          onToggle={() => {
            rxEscape.value = !rxEscape.value;
            applyLogFormat();
          }}
        />
        <CheckRow
          label={() => t("receive.timestamp")}
          checked={() => rxTimestamp.value}
          onToggle={() => {
            rxTimestamp.value = !rxTimestamp.value;
            applyLogFormat();
          }}
        />
        <CheckRow
          label={() => t("receive.wrap")}
          checked={() => rxWrap.value}
          onToggle={() => {
            rxWrap.value = !rxWrap.value;
            applyLogFormat();
          }}
        />
        <View class="flex-1" />
        <Btn
          width={48}
          height={TOOLBAR_CTL_H}
          label={() => (rxPaused.value ? t("receive.resume") : t("receive.pause"))}
          onPress={() => {
            rxPaused.value = !rxPaused.value;
          }}
        />
        <Btn width={48} height={TOOLBAR_CTL_H} label={() => t("receive.clear")} onPress={clearLog} />
      </View>
      <Hairline />

      {/* 日志视窗：未变换裁剪 + 平移画布（IM 契约），只挂可视切片 */}
      <View class="relative flex-1 overflow-hidden" style={{ bgColor: theme.value.inputBg }}>
        {logView.rows.length === 0 ? (
          <View class="absolute inset-0 flex-row items-center justify-center">
            <Text class={MONO_CLASS[fontSize.value]} style={{ textColor: theme.value.dim }}>
              {t("receive.empty")}
            </Text>
          </View>
        ) : null}
        <View
          class="absolute left-0 right-0"
          style={{ height: logView.rows.length * lineH() + 8, translateY: -scroll.value }}
        >
          {visibleRows().map(({ row, index }) => (
            <View
              class="absolute left-0 right-0 flex-row px-2"
              style={{ insetT: index * lineH(), height: lineH() }}
            >
              {row.prefix !== "" ? (
                <Text
                  class={MONO_CLASS[fontSize.value]}
                  style={{ textColor: prefixColor(row.prefixKind), lineHeight: lineH(), height: lineH() }}
                >
                  {row.prefix}
                </Text>
              ) : null}
              <Text
                class={MONO_CLASS[fontSize.value]}
                style={{ textColor: dirColor(row.dir), lineHeight: lineH(), height: lineH() }}
              >
                {row.prefix !== "" ? row.text.slice(row.prefix.length) : row.text}
              </Text>
            </View>
          ))}
        </View>
        <Scrollbar
          scroll={() => scroll.value}
          total={() => logView.rows.length * lineH() + 8}
          viewH={viewH}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 发送区
// ---------------------------------------------------------------------------

const timedPumpers: (() => void)[] = [];
/** app.tsx 每帧调用：驱动定时循环发送（帧基时钟）。 */
export function pumpTimedSend(): void {
  for (const p of timedPumpers) p();
}/** 发送历史选项的显示截断。 */
function historyLabel(s: string): string {
  const one = s.replace(/\n/g, "⏎");
  return one.length > 28 ? `${one.slice(0, 27)}…` : one;
}

export function SendPane() {
  const inputMode = ref<"ascii" | "hex">("ascii");
  const escape = ref(false);
  const crlf = ref(false);
  const appendNl = ref(false);
  const timed = ref(false);
  /** tcps 定向发送目标："broadcast" 或客户端句柄字符串。 */
  const target = ref("broadcast");
  let field: TextFieldHandle | undefined;
  let intervalField: TextFieldHandle | undefined;
  let lastTimedAt = 0;

  const readIntervalMs = (): number => {
    const raw = intervalField?.text().trim() ?? "300";
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? n : 300;
  };

  const sendOpts = (): SendOptions => ({
    hex: inputMode.value === "hex",
    escape: escape.value,
    crlf: crlf.value,
    appendNewline: appendNl.value,
  });

  const doSend = (): void => {
    if (!field) return;
    const t = target.value;
    const targetHandle = t === "broadcast" ? undefined : Number.parseInt(t, 10);
    sendText(field.text(), sendOpts(), targetHandle);
  };

  // 定时循环发送（默认 300ms 可配，SPEC §3.3）；SendPane 卸载（切终端模式）
  // 时摘除 pumper，避免闭包泄漏
  const timedPump = (): void => {
    if (!timed.value || !session || session.state !== "CONNECTED" || !field) return;
    const now = virtualNow();
    if (lastTimedAt === 0 || (now - lastTimedAt) * 1000 >= readIntervalMs()) {
      lastTimedAt = now;
      doSend();
    }
  };
  timedPumpers.push(timedPump);
  onUnmounted(() => {
    const i = timedPumpers.indexOf(timedPump);
    if (i >= 0) timedPumpers.splice(i, 1);
  });

  // ASCII/HEX 切换：内容互转（SPEC §3.3）；互转失败保留原文，发送时再校验
  watch(inputMode, (next, prev) => {
    if (!field) return;
    try {
      field.setText(convertInputText(field.text(), prev, escape.value));
    } catch {
      /* 保留原文 */
    }
  });

  // tcps 客户端列表变化：目标失效回广播
  watch(clientList, (list) => {
    if (target.value !== "broadcast" && !list.some((c) => String(c.handle) === target.value)) {
      target.value = "broadcast";
    }
  });

  const isTcpServer = () =>
    connState.value === "CONNECTED" && session !== null && session.kind === "tcps";

  const showTarget = () => isTcpServer() && clientList.value.length > 0;
  const showHistory = () => sendHistory.value.length > 0;
  /** 选项行内下拉锚点：y 固定（发送区顶部行），x 按固定宽度前缀累计。 */
  const anchorAt = (x: number, w: number) => (): PopupAnchor => ({
    x,
    y: viewportSize.value.h - STATUS_H - SEND_PANE_H + 1 + 8,
    w,
    h: TOOLBAR_CTL_H,
  });
  const targetAnchor = () => anchorAt(PANEL_W + 108, 150);
  const historyAnchor = () => anchorAt(PANEL_W + 108 + (showTarget() ? 158 : 0), 120);

  function targetLabel(): string {
    const sel = target.value;
    if (sel === "broadcast") return t("send.broadcast");
    const c = clientList.value.find((x) => String(x.handle) === sel);
    return c ? historyLabel(c.addr) : t("send.broadcast");
  }

  return (
    <View class="flex-col" style={{ height: SEND_PANE_H }}>
      <Hairline />
      <View class="flex-col flex-1 px-2" style={{ paddingT: 8, gap: 6 }}>
        {/* 选项行：ASCII/HEX · 转义 · <CRLF> · 追加换行 ‖ 历史 · 定时 + 间隔 */}
        <View class="flex-row items-center gap-2" style={{ height: TOOLBAR_CTL_H }}>
          <View style={{ width: 92, height: TOOLBAR_CTL_H }}>
            <SegCtrl
              height={TOOLBAR_CTL_H}
              options={[
                { value: "ascii", label: t("send.ascii") },
                { value: "hex", label: t("send.hex") },
              ]}
              value={() => inputMode.value}
              onPick={(v) => {
                inputMode.value = v as "ascii" | "hex";
              }}
            />
          </View>
          <CheckRow
            label={() => t("send.escape")}
            checked={() => escape.value}
            onToggle={() => (escape.value = !escape.value)}
          />
          <CheckRow
            label={() => t("send.crlf")}
            checked={() => crlf.value}
            disabled={() => inputMode.value === "hex"}
            onToggle={() => (crlf.value = !crlf.value)}
          />
          <CheckRow
            label={() => t("send.appendNewline")}
            checked={() => appendNl.value}
            onToggle={() => (appendNl.value = !appendNl.value)}
          />
          {/* TCP Server：定向/广播（紧跟 SegCtrl 的固定宽度前缀，锚点可算） */}
          {showTarget() ? (
            <View style={{ width: 150, height: TOOLBAR_CTL_H }}>
              <Select
                display={() => targetLabel()}
                value={() => target.value}
                options={() => [
                  { value: "broadcast", label: t("send.broadcast") },
                  ...clientList.value.map((c) => ({
                    value: String(c.handle),
                    label: historyLabel(c.addr),
                  })),
                ]}
                onPick={(v) => {
                  target.value = v;
                }}
                anchor={targetAnchor()}
              />
            </View>
          ) : null}
          {/* 发送历史（去重置顶，持久化，可清空，SPEC §3.3/§3.8） */}
          {showHistory() ? (
            <View style={{ width: 120, height: TOOLBAR_CTL_H }}>
              <Select
                display={() => t("send.history")}
                options={() => [
                  ...sendHistory.value.map((s) => ({ value: s, label: historyLabel(s) })),
                  { value: "__clear__", label: t("send.historyClear") },
                ]}
                onPick={(v) => {
                  if (v === "__clear__") {
                    clearSendHistory();
                  } else {
                    field?.setText(v);
                  }
                }}
                anchor={historyAnchor()}
              />
            </View>
          ) : null}
          <CheckRow
            label={() => t("send.timedSend")}
            checked={() => timed.value}
            onToggle={() => {
              timed.value = !timed.value;
              lastTimedAt = 0;
            }}
          />
          {timed.value ? (
            <View style={{ width: 60, height: TOOLBAR_CTL_H }}>
              <TextField
                height={TOOLBAR_CTL_H}
                initial="300"
                onHandle={(h) => {
                  intervalField = h;
                  h.focus(); // 勾选定时后直接可输入间隔
                }}
                onEnter={() => {
                  // Enter 提交间隔值（读值经 readIntervalMs 惰性发生）
                }}
              />
            </View>
          ) : null}
          {timed.value ? (
            <Text class="text-xs" style={{ textColor: theme.value.dim }}>
              {t("send.intervalUnit")}
            </Text>
          ) : null}
        </View>

        {/* 输入框（多行，Cmd/Ctrl+Enter 发送）+ 发送按钮 */}
        <View class="flex-row gap-2" style={{ height: 56 }}>
          <View class="flex-1" style={{ height: 56 }}>
            <TextField
              multiline
              height={56}
              monoSize={fontSize.value}
              placeholder={() => t("send.placeholder")}
              onHandle={(h) => {
                field = h;
              }}
              onSubmit={doSend}
            />
          </View>
          <View style={{ width: 64, height: 56 }}>
            <Btn width={64} height={56} accent label={() => t("send.send")} onPress={doSend} />
          </View>
        </View>
      </View>
    </View>
  );
}
