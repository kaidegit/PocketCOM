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
  measureMono,
  type SelRect,
  type TextFieldHandle,
} from "./widgets";
import { LINE_H as FONT_LINE_H, MONO_CLASS, MONO_SLOTS } from "./fontsize";
import { monoColAt, monoXAt } from "./textsel";
import { theme } from "./theme";
import { t } from "./i18n";
import { PANEL_W, STATUS_H, viewportSize } from "./layout";
import { onWheel } from "./wheel";
import { setActiveField } from "./fields";
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

/** 日志窗滚动状态（模块级：选区命中映射也要读滚动偏移）。 */
const logScroll = ref(0);
const logStickBottom = ref(true);

/** 日志窗屏幕几何（文本行画布；与渲染结构一一对应）。 */
function logMetrics(): { x0: number; y0: number; w: number; h: number; lineH: number } {
  return {
    x0: PANEL_W,
    y0: TOOLBAR_H + 1,
    w: Math.max(0, viewportSize.value.w - PANEL_W),
    h: Math.max(0, viewportSize.value.h - STATUS_H - SEND_PANE_H - TOOLBAR_H - 1),
    lineH: FONT_LINE_H[fontSize.value],
  };
}

// 选区（模块级状态；app.tsx 的 mouse 路由驱动，语义同 terminal.tsx）
interface LogSelCell {
  row: number;
  col: number;
}

const logSelA = ref<LogSelCell | null>(null);
const logSelB = ref<LogSelCell | null>(null);
let logDragging = false;
let logDragMoved = false;

/** 屏幕坐标 → 日志格（行 = logView.rows 下标，列 = 字符下标；越界钳位）。 */
function logCellAt(x: number, y: number): LogSelCell {
  const m = logMetrics();
  const row = Math.max(0, Math.min(logView.rows.length - 1, Math.floor((y - m.y0 + logScroll.value) / m.lineH)));
  const text = logView.rows[row]?.text ?? "";
  const col = monoColAt(text, x - (m.x0 + 8), (s) => measureMono(s, MONO_SLOTS[fontSize.value]));
  return { row, col };
}

function logMouseDown(x: number, y: number): void {
  setActiveField(null); // 借焦：日志选区起手后键盘不再进文本域
  logDragging = true;
  logDragMoved = false;
  const cell = logCellAt(x, y);
  logSelA.value = cell;
  logSelB.value = cell;
}

function logMouseDrag(x: number, y: number): void {
  if (!logDragging) return;
  const cell = logCellAt(x, y);
  const a = logSelA.value;
  if (a !== null && (cell.row !== a.row || cell.col !== a.col)) {
    logDragMoved = true;
    logSelB.value = cell;
  }
}

function logMouseUp(): void {
  if (!logDragging) return;
  logDragging = false;
  if (!logDragMoved) {
    logSelA.value = null;
    logSelB.value = null;
  }
}

/** 日志区鼠标事件统一入口（app.tsx 路由）：d=true 的连续事件区分按下与拖拽。
 *  返回是否命中/接管（按下沿只在窗内起手；抬起沿只在有拖拽时消费）。 */
export function logMouse(x: number, y: number, down: boolean): boolean {
  if (down) {
    if (logDragging) {
      logMouseDrag(x, y);
      return true;
    }
    const m = logMetrics();
    if (x < m.x0 || x >= m.x0 + m.w || y < m.y0 || y >= m.y0 + m.h) return false;
    logMouseDown(x, y);
    return true;
  }
  if (logDragging) {
    logMouseUp();
    return true;
  }
  return false;
}

export function logHasSelection(): boolean {
  const a = logSelA.value;
  const b = logSelB.value;
  return a !== null && b !== null && (a.row !== b.row || a.col !== b.col);
}

/** 选中文本（row.text 按行列切片，行间 \n；无选区返回 ""）。 */
export function logSelectionText(): string {
  const a = logSelA.value;
  const b = logSelB.value;
  if (a === null || b === null) return "";
  const fwd =
    a.row > b.row || (a.row === b.row && a.col > b.col)
      ? { a: b, b: a }
      : { a, b };
  if (fwd.a.row === fwd.b.row && fwd.a.col === fwd.b.col) return "";
  const out: string[] = [];
  for (let r = fwd.a.row; r <= fwd.b.row; r++) {
    const text = logView.rows[r]?.text ?? "";
    const from = r === fwd.a.row ? fwd.a.col : 0;
    const to = r === fwd.b.row ? Math.min(fwd.b.col, text.length) : text.length;
    out.push(text.slice(from, to));
  }
  return out.join("\n");
}

/** 第 index 行的选区高亮矩形（行内 px；无交叠返回 null）。 */
function logSelRect(row: LogRow, index: number): { x: number; w: number } | null {
  const a = logSelA.value;
  const b = logSelB.value;
  if (a === null || b === null) return null;
  const fwd =
    a.row > b.row || (a.row === b.row && a.col > b.col)
      ? { a: b, b: a }
      : { a, b };
  if (index < fwd.a.row || index > fwd.b.row) return null;
  if (fwd.a.row === fwd.b.row && fwd.a.col === fwd.b.col) return null;
  const text = row.text;
  const from = index === fwd.a.row ? fwd.a.col : 0;
  const to = index === fwd.b.row ? Math.min(fwd.b.col, text.length) : text.length;
  if (to <= from) return null;
  const measure = (s: string): number => measureMono(s, MONO_SLOTS[fontSize.value]);
  const x = monoXAt(text, from, measure);
  const w = monoXAt(text, to, measure) - x;
  return w > 0 ? { x, w } : null;
}

export function ReceivePane() {
  const lineH = () => FONT_LINE_H[fontSize.value];

  const viewH = () => Math.max(0, viewportSize.value.h - STATUS_H - SEND_PANE_H - TOOLBAR_H - 1);
  const maxScroll = () => Math.max(0, logView.rows.length * lineH() - viewH());

  // 新数据：贴底跟随；否则保持（滚动锁定，SPEC §3.3）
  watch(logVersion, () => {
    if (logStickBottom.value) logScroll.value = maxScroll();
  });
  // 字号变化：保持贴底语义
  watch(fontSize, () => {
    if (logStickBottom.value) logScroll.value = maxScroll();
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
    logScroll.value = Math.max(0, Math.min(maxScroll(), logScroll.value - dy));
    logStickBottom.value = logScroll.value >= maxScroll() - 1;
  });

  // 空态切换（rows 非响应式，需显式依赖 logVersion，否则数据到达后空态不消失）
  const showEmpty = (): boolean => {
    void logVersion.value;
    return logView.rows.length === 0;
  };

  const visibleRows = (): { row: LogRow; index: number }[] => {
    void logVersion.value; // 依赖：行内容/数量变化
    const from = Math.max(0, Math.floor(logScroll.value / lineH()) - 3);
    const to = Math.min(logView.rows.length, Math.ceil((logScroll.value + viewH()) / lineH()) + 3);
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

      {/* 日志视窗：未变换裁剪 + 平移画布（IM 契约），只挂可视切片。
          行结构：外层块只放 absolute 子层（选区高亮在下、文本层在上），
          文本层自己承担 px-2 的内边距 —— 高亮与文字共用同一坐标基准。 */}
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
          style={{ height: logView.rows.length * lineH() + 8, translateY: -logScroll.value }}
        >
          {visibleRows().map(({ row, index }) => {
            const rect = logSelRect(row, index);
            return (
              <View class="absolute left-0 right-0" style={{ insetT: index * lineH(), height: lineH() }}>
                {rect !== null ? (
                  <View
                    class="absolute"
                    style={{
                      insetL: 8 + rect.x,
                      insetT: 0,
                      width: rect.w,
                      height: lineH(),
                      bgColor: theme.value.selection,
                    }}
                  />
                ) : null}
                <View class="absolute flex-row" style={{ insetL: 8, insetR: 8, insetT: 0 }}>
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
              </View>
            );
          })}
        </View>
        <Scrollbar
          scroll={() => logScroll.value}
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

  /** 发送输入框命中区（拖动选区）：布局 1 分隔线 + 8 paddingT + 22 选项行 +
   *  6 间距 → 输入行；flex-1 宽 = 行宽 - 发送按钮 64 - gap 8。 */
  const sendFieldRegion = (): SelRect | null => {
    const vp = viewportSize.value;
    return {
      x: PANEL_W + 8,
      y: vp.h - STATUS_H - SEND_PANE_H + 1 + 8 + TOOLBAR_CTL_H + 6,
      w: Math.max(0, vp.w - PANEL_W - 16 - 64 - 8),
      h: 56,
    };
  };

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
              selRegion={sendFieldRegion}
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
