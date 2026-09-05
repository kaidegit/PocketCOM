// app/terminal.tsx — 终端模式视图（SPEC §3.4）。
// 固定行列字符网格：行绝对定位（引擎怪癖规避，同 transfer.tsx 的窗口化渲染），
// 每行按 (前景, 背景, 属性) 相同的连续格子合并成 run——一个 run 一个 View+Text，
// 宽字符占 2 格（续格 "\x00" 跳过）。光标 = 光标格上的色块（先画，字符叠其上）；
// 选区 = 起止格间的半透明色块。滚动：termScroll 为视口顶行号（模块级，供
// app.tsx 的 Shift+PageUp/PageDown 共用），贴底跟随、上滚锁定。
// 键盘/粘贴不在这里处理：app.tsx 把 ch/key/paste 直发（session.sendTermBytes），
// 无本地回显；选中复制经宿主 svc copy intent（main.rs 写系统剪贴板）。
import { ref, watch } from "vue";
import { Text, View } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework";
import { Scrollbar } from "./widgets";
import { setActiveField } from "./fields";
import { LINE_H, MONO_CLASS, MONO_SLOTS } from "./fontsize";
import { theme } from "./theme";
import { t } from "./i18n";
import { PANEL_W, STATUS_H, viewportSize } from "./layout";
import { onWheel } from "./wheel";
import type { ConfigFontSize } from "../core/config";
import {
  CELL_BOLD,
  CELL_REVERSE,
  CELL_UNDERLINE,
  CELL_WIDE,
  TERM_DEFAULT_COLOR,
  isTermRgb,
  type TermLine,
} from "../core/term";
import { fontSize, terminal, termScroll, termVersion } from "./session";

/** 网格内边距（px）。 */
export const TERM_PAD_X = 8;
export const TERM_PAD_Y = 6;

// ---------------------------------------------------------------------------
// 几何（模块级：hit-test / 键盘路由也要用）
// ---------------------------------------------------------------------------

const cellWCache = new Map<ConfigFontSize, number>();

/** mono 槽宽（MiSans mono 槽内 ASCII 等宽，取 "M" 度量）。 */
export function termCellW(size: ConfigFontSize): number {
  let w = cellWCache.get(size);
  if (w === undefined) {
    w = Math.max(1, getOps().measureText("M", MONO_SLOTS[size]));
    cellWCache.set(size, w);
  }
  return w;
}

export interface TermMetrics {
  /** 网格左上角（屏幕绝对坐标）。 */
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  cellW: number;
  lineH: number;
}

export function termMetrics(): TermMetrics {
  const size = fontSize.value;
  const cellW = termCellW(size);
  const lineH = LINE_H[size];
  const availW = Math.max(0, viewportSize.value.w - PANEL_W - TERM_PAD_X * 2);
  const availH = Math.max(0, viewportSize.value.h - STATUS_H - TERM_PAD_Y * 2);
  return {
    x0: PANEL_W + TERM_PAD_X,
    y0: TERM_PAD_Y,
    cols: Math.max(2, Math.floor(availW / cellW)),
    rows: Math.max(2, Math.floor(availH / lineH)),
    cellW,
    lineH,
  };
}

/** 视口顶行号范围 [0, totalLines - rows]；贴底 = 上限。 */
export function termMaxScroll(): number {
  return Math.max(0, terminal.totalLines - terminal.rows);
}

function clampScroll(): void {
  termScroll.value = Math.max(0, Math.min(termMaxScroll(), termScroll.value));
}

// ---------------------------------------------------------------------------
// 选区（模块级状态；app.tsx 的 mouse 路由驱动）
// ---------------------------------------------------------------------------

interface TermCellRef {
  line: number;
  col: number;
}

const selAnchor = ref<TermCellRef | null>(null);
const selHead = ref<TermCellRef | null>(null);
let dragging = false;
let dragMoved = false;

function normSelection(): { a: TermCellRef; b: TermCellRef } | null {
  const a = selAnchor.value;
  const b = selHead.value;
  if (!a || !b) return null;
  const forward =
    a.line > b.line || (a.line === b.line && a.col > b.col)
      ? { a: b, b: a }
      : { a, b };
  return forward;
}

/** 屏幕坐标 → 网格（行 = 绝对行号，含回滚）。终端区外钳位到边界格。 */
function termCellAt(x: number, y: number): TermCellRef {
  const m = termMetrics();
  const col = Math.max(0, Math.min(m.cols - 1, Math.floor((x - m.x0) / m.cellW)));
  const vi = Math.max(0, Math.min(m.rows - 1, Math.floor((y - m.y0) / m.lineH)));
  const top = Math.max(0, Math.min(termScroll.value, termMaxScroll()));
  return { line: Math.min(terminal.totalLines - 1, top + vi), col };
}

/** 鼠标按下（终端区内）：借焦 + 开始选区。 */
function termMouseDown(x: number, y: number): void {
  setActiveField(null);
  dragging = true;
  dragMoved = false;
  const cell = termCellAt(x, y);
  selAnchor.value = cell;
  selHead.value = cell;
}

/** 拖拽延伸选区。 */
export function termMouseDrag(x: number, y: number): void {
  if (!dragging) return;
  const cell = termCellAt(x, y);
  const a = selAnchor.value;
  if (a && (cell.line !== a.line || cell.col !== a.col)) {
    dragMoved = true;
    selHead.value = cell;
  }
}

/** 抬起：未拖动（单击）清除选区。 */
export function termMouseUp(): void {
  if (!dragging) return;
  dragging = false;
  if (!dragMoved) {
    selAnchor.value = null;
    selHead.value = null;
  }
}

/** 终端区鼠标事件统一入口（app.tsx 路由）：d=true 的连续事件区分按下与拖拽。 */
export function termMouseMove(x: number, y: number, down: boolean): void {
  if (down) {
    if (dragging) termMouseDrag(x, y);
    else termMouseDown(x, y);
  } else {
    termMouseUp();
  }
}

export function termHasSelection(): boolean {
  return normSelection() !== null;
}

/** 选区文本（每行去尾部空格，行间 \n；宽字符续格跳过）。 */
export function termSelectionText(): string {
  const sel = normSelection();
  if (!sel) return "";
  const out: string[] = [];
  for (let line = sel.a.line; line <= sel.b.line; line++) {
    const l = terminal.lineAt(line);
    if (!l) continue;
    const from = line === sel.a.line ? sel.a.col : 0;
    const to = line === sel.b.line ? sel.b.col + 1 : Math.min(terminal.cols, l.text.length);
    let s = "";
    for (let i = from; i < to && i < l.text.length; i++) {
      const ch = l.text.charAt(i);
      if (ch !== "\x00") s += ch;
    }
    if (to >= Math.min(terminal.cols, l.text.length)) s = s.replace(/[ ]+$/, "");
    out.push(s);
  }
  return out.join("\n");
}

/** Shift+PageUp/PageDown 本地滚动（±rows 行；普通 PageUp 直发远端）。 */
export function termScrollPage(pages: number): void {
  const m = termMetrics();
  termScroll.value = Math.max(0, Math.min(termMaxScroll(), termScroll.value + pages * m.rows));
}

// ---------------------------------------------------------------------------
// 调色板映射与 run 组装
// ---------------------------------------------------------------------------

const TRANSPARENT = "#00000000";

/** 单元格颜色值 → CSS 色（DEFAULT → 主题终端色；调色板/RGB 见 core/term.ts）。 */
function cellColor(c: number, fallback: string): string {
  if (c === TERM_DEFAULT_COLOR) return fallback;
  if (isTermRgb(c)) {
    const r = (c >> 16) & 0xff;
    const g = (c >> 8) & 0xff;
    const b = c & 0xff;
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }
  const pal = theme.value.termPalette;
  if (c < 16) return pal[c] ?? fallback;
  if (c < 232) {
    // 6×6×6 色立方（16–231，xterm 公式）
    const n = c - 16;
    const comp = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    const r = comp(Math.floor(n / 36));
    const g = comp(Math.floor((n % 36) / 6));
    const b = comp(n % 6);
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }
  // 灰阶（232–255）
  const gray = 8 + (c - 232) * 10;
  const hex = gray.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

interface TermRun {
  /** x（px，相对行左缘）。 */
  x: number;
  w: number;
  text: string;
  fg: string;
  bg: string;
  underline: boolean;
}

const STYLE_MASK = CELL_BOLD | CELL_UNDERLINE | CELL_REVERSE;

/** 一行格子 → 渲染 runs（属性相同的连续格合并；宽字符占 2 格宽）。 */
function rowRuns(line: TermLine, limit: number, cellW: number): TermRun[] {
  const runs: TermRun[] = [];
  let start = -1;
  let end = -1;
  let key = "";
  let text = "";
  const flush = (): void => {
    if (start < 0) return;
    const parts = key.split("|");
    const fgRaw = Number.parseInt(parts[0]!, 10);
    const bgRaw = Number.parseInt(parts[1]!, 10);
    const flags = Number.parseInt(parts[2]!, 10);
    const reverse = (flags & CELL_REVERSE) !== 0;
    let fg = fgRaw;
    let bg = bgRaw;
    if (reverse) {
      fg = bgRaw;
      bg = fgRaw;
    }
    runs.push({
      x: start * cellW,
      w: (end - start) * cellW,
      text,
      fg: cellColor(fg, reverse ? theme.value.termBg : theme.value.termFg),
      bg:
        bg === TERM_DEFAULT_COLOR && !reverse
          ? TRANSPARENT
          : cellColor(bg, reverse ? theme.value.termFg : theme.value.termBg),
      underline: (flags & CELL_UNDERLINE) !== 0,
    });
    start = -1;
    text = "";
  };
  for (let i = 0; i < limit; i++) {
    const ch = line.text.charAt(i);
    if (ch === "\x00") continue; // 宽字符续格
    const k = `${line.fg[i]}|${line.bg[i]}|${line.flags[i]! & STYLE_MASK}`;
    if (start < 0 || k !== key) {
      flush();
      key = k;
      start = i;
    }
    text += ch;
    end = i + ((line.flags[i]! & CELL_WIDE) !== 0 ? 2 : 1);
  }
  flush();
  return runs;
}

// ---------------------------------------------------------------------------
// TerminalView
// ---------------------------------------------------------------------------

const stickBottom = ref(true);

export function TerminalView() {
  const syncGeometry = (): void => {
    const m = termMetrics();
    terminal.resize(m.cols, m.rows);
    clampScroll();
  };
  watch(viewportSize, syncGeometry);
  watch(fontSize, syncGeometry);
  syncGeometry();

  onWheel("term", (dy) => {
    const lineH = LINE_H[fontSize.value];
    termScroll.value = Math.max(
      0,
      Math.min(termMaxScroll(), termScroll.value - Math.round(dy / lineH)),
    );
    stickBottom.value = termScroll.value >= termMaxScroll();
  });

  // 新数据：贴底跟随，否则锁定（滚动锁定，SPEC §3.3 同语义）
  watch(termVersion, () => {
    if (stickBottom.value) termScroll.value = termMaxScroll();
    else clampScroll();
  });

  const topLine = (): number => Math.max(0, Math.min(termScroll.value, termMaxScroll()));

  const visibleLines = (): { abs: number; y: number }[] => {
    void termVersion.value; // 渲染依赖：终端内容变化
    void termScroll.value;
    const m = termMetrics();
    const top = topLine();
    const out: { abs: number; y: number }[] = [];
    for (let i = 0; i < m.rows; i++) {
      const abs = top + i;
      if (abs >= terminal.totalLines) break;
      out.push({ abs, y: TERM_PAD_Y + i * m.lineH });
    }
    return out;
  };

  const screenBlank = (): boolean => {
    void termVersion.value;
    if (terminal.scrollbackCount > 0) return false;
    for (let y = 0; y < terminal.rows; y++) {
      const line = terminal.lineAt(terminal.scrollbackCount + y);
      if (line && line.text.trim() !== "") return false;
    }
    return true;
  };

  const renderLine = (abs: number, y: number) => {
    const m = termMetrics();
    const line = terminal.lineAt(abs);
    if (!line) return null;
    const limit = Math.min(m.cols, line.text.length);
    const runs = rowRuns(line, limit, m.cellW);
    const sel = normSelection();
    const selRect = (): { x: number; w: number } | null => {
      if (!sel || abs < sel.a.line || abs > sel.b.line) return null;
      const from = abs === sel.a.line ? sel.a.col : 0;
      const to = abs === sel.b.line ? Math.min(sel.b.col + 1, m.cols) : m.cols;
      if (to <= from) return null;
      return { x: TERM_PAD_X + from * m.cellW, w: (to - from) * m.cellW };
    };
    const rect = selRect();
    const cursorAbs = terminal.scrollbackCount + terminal.cursorY;
    const showCursor = terminal.showCursor && abs === cursorAbs;
    return (
      <View class="absolute left-0 right-0" style={{ insetT: y, height: m.lineH }}>
        {rect !== null ? (
          <View
            class="absolute"
            style={{
              insetL: rect.x,
              insetT: 0,
              width: rect.w,
              height: m.lineH,
              bgColor: theme.value.termSelection,
            }}
          />
        ) : null}
        {showCursor ? (
          <View
            class="absolute"
            style={{
              insetL: TERM_PAD_X + terminal.cursorX * m.cellW,
              insetT: 0,
              width: m.cellW,
              height: m.lineH,
              bgColor: theme.value.termCursor,
            }}
          />
        ) : null}
        {runs.map((run) => (
          <View
            class="absolute"
            style={{
              insetL: TERM_PAD_X + run.x,
              insetT: 0,
              width: run.w,
              height: m.lineH,
              bgColor: run.bg,
            }}
          >
            <Text
              class={
                fontSize.value === 12
                  ? "absolute left-0 text-xs font-mono"
                  : fontSize.value === 16
                    ? "absolute left-0 text-base font-mono"
                    : "absolute left-0 text-sm font-mono"
              }
              style={{ insetT: 0, height: m.lineH, lineHeight: m.lineH, textColor: run.fg }}
            >
              {run.text}
            </Text>
            {run.underline ? (
              <View
                class="absolute"
                style={{ insetL: 0, insetR: 0, insetB: 0, height: 1, bgColor: run.fg }}
              />
            ) : null}
          </View>
        ))}
      </View>
    );
  };

  return (
    <View
      class="relative flex-1 overflow-hidden"
      style={{ bgColor: theme.value.termBg }}
      focusable
      onPress={() => setActiveField(null)}
    >
      {screenBlank() ? (
        <View class="absolute inset-0 flex-row items-center justify-center">
          <Text class={MONO_CLASS[fontSize.value]} style={{ textColor: theme.value.dim }}>
            {t("terminal.hint")}
          </Text>
        </View>
      ) : null}
      {visibleLines().map(({ abs, y }) => renderLine(abs, y))}
      <Scrollbar
        scroll={() => topLine()}
        total={() => terminal.totalLines * LINE_H[fontSize.value]}
        viewH={() => termMetrics().rows * LINE_H[fontSize.value]}
      />
    </View>
  );
}
