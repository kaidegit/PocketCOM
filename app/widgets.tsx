// app/widgets.tsx — PocketCOM 基础控件集（重写版）。
// 约束（AGENTS.md）：直接返回 JSX 的函数组件；无 DOM/无运行时 CSS；
// class 只用编译期字面量，颜色一律走 theme token 的 style 绑定。
// 交互模型（SPEC §4.3）：鼠标点击由宿主注入 CIRCLE 完成 press（边沿触发，
// 按住不连发）；控件 onPress 里自行处理"活跃文本域"借焦（见 app/fields.ts）。
// 下拉弹层：Portal 全屏遮罩 + 屏幕绝对坐标定位（anchor 由调用方按布局
// 常量给出），不沾父级流式布局、不被滚动视口裁剪；同屏只开一个。
import { onScopeDispose, ref } from "vue";
import { Portal, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework";
import { focusNode } from "@pocketjs/framework/input";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { virtualNow } from "@pocketjs/framework/clock";
import { theme } from "./theme";
import { STATUS_H, viewportSize } from "./layout";
import { LINE_H as FONT_LINE_H, MONO_SLOTS } from "./fontsize";
import { monoColAt } from "./textsel";
import { activeField, setActiveField, type KeyMods, type TextField as TextFieldProto } from "./fields";

/** 标准控件高（Select/SegCtrl/单行 TextField/Btn）。 */
export const CTL_H = 28;
/** 文本域行高。 */
export const FIELD_LINE_H = 18;

/** 透明色（alpha 0 = 不绘制，spec：Unset (alpha 0) colors emit nothing）。 */
const TRANSPARENT = "#00000000";

/** 等宽字体测量：按字号档位取 mono 字形槽；缓存按 槽:文本 键。 */
const measureCache = new Map<string, number>();
export function measureMono(text: string, slot: number): number {
  if (text === "") return 0;
  const key = `${slot}:${text}`;
  let w = measureCache.get(key);
  if (w === undefined) {
    w = getOps().measureText(text, slot);
    if (measureCache.size > 4096) measureCache.clear();
    measureCache.set(key, w);
  }
  return w;
}

// ---------------------------------------------------------------------------
// Hairline（1px 分隔线；无运行时 CSS，用 View 画）
// ---------------------------------------------------------------------------

export function Hairline() {
  return <View style={{ height: 1, bgColor: theme.value.panelBorder }} />;
}

// ---------------------------------------------------------------------------
// Scrollbar（仅指示用 thumb；note 应用同款模式）
// ---------------------------------------------------------------------------

export function Scrollbar(props: { scroll: () => number; total: () => number; viewH: () => number }) {
  const show = () => props.total() > props.viewH() && props.viewH() > 0;
  const thumbH = () => Math.max(24, (props.viewH() * props.viewH()) / props.total());
  const top = () => {
    const range = props.total() - props.viewH();
    return 4 + (range > 0 ? (props.scroll() / range) * (props.viewH() - thumbH() - 8) : 0);
  };
  // 隐藏 = 0 宽（Vue Vapor 组件不得返回 null，宿主 JSX 运行时会崩）
  return (
    <View
      class="absolute rounded-sm"
      style={{
        width: show() ? 3 : 0,
        insetR: 3,
        insetT: show() ? top() : 0,
        height: show() ? thumbH() : 0,
        bgColor: theme.value.scrollbar,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Btn（默认撑满父宽；父级用固定宽 View 包裹或传 width）
// ---------------------------------------------------------------------------

export function Btn(props: {
  label: () => string;
  onPress: () => void;
  disabled?: () => boolean;
  accent?: boolean | (() => boolean);
  width?: number;
  height?: number;
}) {
  const disabled = () => props.disabled?.() ?? false;
  const accent = () => (typeof props.accent === "function" ? props.accent() : (props.accent ?? false));
  return (
    <View
      class="flex-row items-center justify-center rounded-md"
      style={{
        height: props.height ?? CTL_H,
        ...(props.width !== undefined ? { width: props.width } : {}),
        bgColor: disabled() ? theme.value.inputBg : accent() ? theme.value.accent : theme.value.btnBg,
        // style diff 只增不改：border 常设，accent/disabled 时用透明色隐藏
        borderColor: accent() || disabled() ? TRANSPARENT : theme.value.panelBorder,
        borderWidth: 1,
      }}
      focusable={!disabled()}
      onPress={() => {
        if (disabled()) return;
        setActiveField(null); // 借焦：按钮按下后键盘不再进文本域
        props.onPress();
      }}
    >
      <Text
        class="text-xs font-bold"
        style={{ textColor: disabled() ? theme.value.dim : accent() ? theme.value.accentFg : theme.value.fg }}
      >
        {props.label()}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// CheckRow（复选框行；也作开关行）
// ---------------------------------------------------------------------------

export function CheckRow(props: {
  label: () => string;
  checked: () => boolean;
  onToggle: () => void;
  disabled?: () => boolean;
}) {
  const disabled = () => props.disabled?.() ?? false;
  return (
    <View
      class="flex-row items-center gap-2"
      // alpha 1/255 底色：整行（含 label 与勾选框之间的空隙）都可点
      style={{ height: 22, bgColor: "#00000001" }}
      focusable={!disabled()}
      onPress={() => {
        if (disabled()) return;
        setActiveField(null);
        props.onToggle();
      }}
    >
      <View
        class="rounded-sm items-center justify-center"
        style={{
          width: 14,
          height: 14,
          bgColor: disabled()
            ? theme.value.inputBg
            : props.checked()
              ? theme.value.accent
              : theme.value.inputBg,
          borderColor: disabled()
            ? theme.value.panelBorder
            : props.checked()
              ? theme.value.accent
              : theme.value.dim,
          borderWidth: 1,
        }}
      >
        {props.checked() && !disabled() ? (
          <Text class="text-[10] font-bold" style={{ textColor: theme.value.accentFg, lineHeight: 12 }}>
            ✓
          </Text>
        ) : null}
      </View>
      <Text class="text-xs" style={{ textColor: disabled() ? theme.value.dim : theme.value.fg }}>
        {props.label()}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// SegCtrl（分段选择，如 ASCII/HEX、收发/终端）
// ---------------------------------------------------------------------------

export interface SegOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SegCtrl(props: {
  options: SegOption[];
  value: () => string;
  onPick: (v: string) => void;
  height?: number;
}) {
  const h = () => props.height ?? CTL_H;
  return (
    <View
      class="flex-row rounded-md p-[2] gap-[2] w-full"
      style={{ height: h(), bgColor: theme.value.inputBg, borderColor: theme.value.panelBorder, borderWidth: 1 }}
    >
      {props.options.map((opt) => {
        const active = props.value() === opt.value;
        return (
          <View
            class="flex-row items-center justify-center rounded-sm"
            style={{
              height: h() - 6,
              grow: 1,
              // 非选中段也要命中整个格子：alpha 1/255 底色，视觉透明但参与命中
              bgColor: opt.disabled ? TRANSPARENT : active ? theme.value.accent : "#00000001",
            }}
            focusable={!opt.disabled}
            onPress={() => {
              if (opt.disabled) return;
              setActiveField(null);
              props.onPick(opt.value);
            }}
          >
            <Text
              class="text-xs font-bold"
              style={{ textColor: opt.disabled ? theme.value.dim : active ? theme.value.accentFg : theme.value.dim }}
            >
              {opt.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Select + 弹层（Portal 实现，见文件头注释）
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** 弹层锚点：控制框的屏幕绝对坐标（布局全是常量，由调用方计算）。 */
export interface PopupAnchor {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PopupState {
  /** 打开者（Select 实例）id，用于控制框的高亮态。 */
  id: number;
  options: SelectOption[];
  value?: string;
  anchor: PopupAnchor;
  onPick: (v: string) => void;
}

const OPTION_H = 26;
const POPUP_PAD = 4;
const POPUP_GAP = 4;
const POPUP_MAX_VISIBLE = 10;

const popup = ref<PopupState | null>(null);
const popupScroll = ref(0);
let nextSelectId = 1;

export function popupOpen(): boolean {
  return popup.value !== null;
}

export function closePopup(): void {
  popup.value = null;
  popupScroll.value = 0;
}

/** 弹层打开时接管滚轮（app.tsx 路由）。 */
export function popupWheel(dy: number): void {
  const p = popup.value;
  if (!p) return;
  const contentH = p.options.length * OPTION_H;
  const boxH = Math.min(contentH, POPUP_MAX_VISIBLE * OPTION_H);
  const max = Math.max(0, contentH - boxH);
  popupScroll.value = Math.max(0, Math.min(max, popupScroll.value - dy));
}

/** 应用根部挂载一次：弹层 + 全屏遮罩（点击空白关闭）。
 *  注意：Vue Vapor 组件不得返回 null（宿主 JSX 运行时 anchor 会崩），
 *  空态渲染 0 尺寸占位 View；Portal 子树始终由表达式子节点条件挂载。 */
export function PopupLayer() {
  return (
    <View style={{ width: 0, height: 0 }}>
      {popup.value !== null ? (
        <Portal>
          {/* 遮罩：alpha 1/255 的底色使其命中整个屏幕（只画边框/透明的节点不命中）。
              Vue Vapor Portal 的 host 是规格屏 480x272（不随桌面视口缩放），
              遮罩不能 inset 0 寄生于 host 盒子，必须按实时视口自撑尺寸，
              否则右/下方点空白收不掉弹层。 */}
          <View
            class="absolute"
            style={{
              insetT: 0,
              insetL: 0,
              width: viewportSize.value.w,
              height: viewportSize.value.h,
              bgColor: "#00000001",
            }}
            focusable
            debugName="backdrop"
            onPress={closePopup}
          />
          <PopupBox p={popup.value!} />
        </Portal>
      ) : null}
    </View>
  );
}

/** 弹层本体（仅在弹层打开时挂载，p 非空；几何在挂载时确定）。 */
function PopupBox(props: { p: PopupState }) {
  const p = props.p;
  const contentH = p.options.length * OPTION_H;
  const boxH = Math.min(contentH, POPUP_MAX_VISIBLE * OPTION_H) + POPUP_PAD * 2;
  const belowY = p.anchor.y + p.anchor.h + POPUP_GAP;
  const fitsBelow = belowY + boxH <= viewportSize.value.h - STATUS_H;
  const aboveY = p.anchor.y - POPUP_GAP - boxH;
  const y = fitsBelow || aboveY < 0 ? belowY : aboveY;
  return (
    <View
      class="absolute rounded-md"
      style={{
        insetL: p.anchor.x,
        insetT: y,
        width: p.anchor.w,
        height: boxH,
        bgColor: theme.value.popupBg,
        borderColor: theme.value.panelBorder,
        borderWidth: 1,
      }}
    >
      <View class="absolute overflow-hidden" style={{ insetT: 0, insetL: 0, insetR: 0, insetB: 0 }}>
        <View
          class="absolute"
          style={{
            insetL: POPUP_PAD,
            insetT: POPUP_PAD,
            width: p.anchor.w - POPUP_PAD * 2,
            translateY: -popupScroll.value,
          }}
        >
          {p.options.map((opt, i) => (
            <View
              class="absolute left-0 right-0 flex-row items-center px-2 rounded-sm"
              debugName={`opt:${opt.value}`}
              style={{
                insetT: i * OPTION_H,
                height: OPTION_H,
                bgColor: p.value === opt.value ? theme.value.activeBg : theme.value.popupBg,
              }}
              focusable={!opt.disabled}
              onPress={() => {
                if (opt.disabled) return;
                const cur = popup.value;
                closePopup();
                setActiveField(null);
                cur?.onPick(opt.value);
              }}
            >
              <Text class="text-xs font-mono" style={{ textColor: opt.disabled ? theme.value.dim : theme.value.fg }}>
                {opt.label}
              </Text>
            </View>
          ))}
        </View>
      </View>
      <Scrollbar scroll={() => popupScroll.value} total={() => contentH + POPUP_PAD * 2} viewH={() => boxH} />
    </View>
  );
}

export function Select(props: {
  display: () => string;
  options: () => SelectOption[];
  onPick: (v: string) => void;
  /** 当前值（弹层内高亮，可选） */
  value?: () => string;
  emptyText?: () => string;
  disabled?: () => boolean;
  /** 展开弹层时回调（先于 options 快照，可刷新列表，如串口枚举） */
  onOpen?: () => void;
  /** 控制框的屏幕绝对坐标（弹层定位用） */
  anchor: () => PopupAnchor;
}) {
  const id = nextSelectId++;
  const disabled = () => props.disabled?.() ?? false;
  const open = () => popup.value?.id === id;
  return (
    <View
      class="flex-row items-center px-2 rounded-md w-full overflow-hidden"
      debugName="select"
      style={{
        height: CTL_H,
        bgColor: theme.value.inputBg,
        borderColor: open() ? theme.value.accent : theme.value.panelBorder,
        borderWidth: 1,
      }}
      focusable={!disabled()}
      onPress={() => {
        if (disabled()) return;
        setActiveField(null);
        if (open()) {
          closePopup();
        } else {
          props.onOpen?.();
          popup.value = {
            id,
            options: props.options(),
            value: props.value?.(),
            anchor: props.anchor(),
            onPick: props.onPick,
          };
          popupScroll.value = 0;
        }
      }}
    >
      {/* 显示文本裁剪区：超长内容截断（不挤出箭头、不溢出面板） */}
      <View class="flex-1 overflow-hidden" style={{ height: CTL_H }}>
        <Text
          class="text-xs font-mono"
          style={{
            lineHeight: CTL_H,
            textColor: props.display() === "" || disabled() ? theme.value.dim : theme.value.fg,
          }}
        >
          {props.display() === "" ? (props.emptyText?.() ?? "") : props.display()}
        </Text>
      </View>
      <Text class="text-xs" style={{ textColor: theme.value.dim, paddingL: 4 }}>
        ▾
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// StatusDot（连接状态灯）
// ---------------------------------------------------------------------------

export function StatusDot(props: { color: () => string; size?: number }) {
  const s = props.size ?? 8;
  return <View class="rounded-sm" style={{ width: s, height: s, bgColor: props.color() }} />;
}

// ---------------------------------------------------------------------------
// TextField（svc 键盘/IME/粘贴驱动的自管理文本域，SPEC §4.3）
// ---------------------------------------------------------------------------

export interface TextFieldHandle {
  text(): string;
  setText(s: string): void;
  focus(): void;
  blur(): void;
}

const FIELD_PAD_X = 8;
/** 光标闪烁半周期（秒，virtualNow 单位）：实心与隐藏各占此时长。 */
const CARET_BLINK_S = 0.5;

// ---------------------------------------------------------------------------
// TextField 拖动选中（app.tsx 的 mouse 路由驱动）。引擎命中测试只有
// "点 → 节点"、没有"节点 → 矩形"，命中区矩形由调用方按布局常量给出
// （与 terminal.tsx 的 termMetrics 同一套路）；未给 selRegion 的实例不参与。
// ---------------------------------------------------------------------------

/** 屏幕绝对矩形（TextField 命中区 = 控件根盒，含 1px 边框）。 */
export interface SelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FieldSelEntry {
  region: () => SelRect | null;
  down(x: number, y: number): void;
  drag(x: number, y: number): void;
  up(): void;
}

const fieldSelEntries = new Set<FieldSelEntry>();
/** 按下沿认领的文本域：拖拽/抬起跨区仍归它（标准文本选择语义）。 */
let fieldSelDrag: FieldSelEntry | null = null;

/** app.tsx 的 mouse 路由入口。返回是否被文本域命中/接管；弹层打开时由
 *  调用方先行屏蔽（遮罩命中优先）。 */
export function textFieldMouse(x: number, y: number, down: boolean): boolean {
  if (!down) {
    const e = fieldSelDrag;
    if (e !== null) {
      fieldSelDrag = null;
      e.up();
      return true;
    }
    return false;
  }
  if (fieldSelDrag !== null) {
    fieldSelDrag.drag(x, y);
    return true;
  }
  for (const e of fieldSelEntries) {
    const r = e.region();
    if (r !== null && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
      fieldSelDrag = e;
      e.down(x, y);
      return true;
    }
  }
  return false;
}

export function TextField(props: {
  multiline?: boolean;
  initial?: string;
  placeholder?: () => string;
  height?: number;
  /** mono 字号档位（默认 14；发送区随字号设置联动，SPEC §3.8）。 */
  monoSize?: 12 | 14 | 16;
  onHandle?: (h: TextFieldHandle) => void;
  /** Cmd/Ctrl+Enter */
  onSubmit?: () => void;
  /** 单行 Enter（收到句柄，可读当前文本） */
  onEnter?: (h: TextFieldHandle) => void;
  /** 控件根盒的屏幕绝对矩形（拖动选区命中区；缺省不参与鼠标选区） */
  selRegion?: () => SelRect | null;
}) {
  const text = ref(props.initial ?? "");
  const caret = ref((props.initial ?? "").length);
  /** 拖动选区两端（text 字符索引；相等 = 无选区）。 */
  const selAnchor = ref((props.initial ?? "").length);
  const selHead = ref((props.initial ?? "").length);
  /** IME 组合串（未提交，仅显示；提交经 ch 行到达）。 */
  const preedit = ref("");
  const scrollY = ref(0);
  let node: NodeMirror | undefined;

  const bodyH = props.height ?? CTL_H;
  const lineH = FONT_LINE_H[props.monoSize ?? 14];
  const monoSlot = MONO_SLOTS[props.monoSize ?? 14];
  const padT = props.multiline ? 6 : Math.max(0, (bodyH - lineH) / 2);
  const padB = props.multiline ? 6 : 0;

  const isActive = () => activeField.value === impl;

  /** 光标闪烁态：活动后实心 CARET_BLINK_S，之后按半周期明暗交替。 */
  const caretOn = ref(true);
  let caretActAt = 0;
  /** 光标活动（聚焦/输入/移动）：立即重显并重置闪烁相位。 */
  const caretPulse = (): void => {
    caretActAt = virtualNow();
    if (!caretOn.value) caretOn.value = true;
  };
  // 每帧推进闪烁相位；仅翻转时写 ref（demand-driven 重绘不因恒定相位空转）。
  // onFrame 随组件作用域自动注销（切模式卸载 SendPane 等场景）。
  onFrame(() => {
    if (!isActive()) return;
    const on = (virtualNow() - caretActAt) % (CARET_BLINK_S * 2) < CARET_BLINK_S;
    if (on !== caretOn.value) caretOn.value = on;
  });

  /** 显示文本 = 正文 + 光标处拼接的 IME preedit。 */
  const dispText = () => {
    const p = preedit.value;
    if (p === "") return text.value;
    const c = caret.value;
    return text.value.slice(0, c) + p + text.value.slice(c);
  };
  /** 显示坐标系里的光标（preedit 之后）。 */
  const dispCaret = () => caret.value + preedit.value.length;

  const lines = () => dispText().split("\n");

  const caretLineCol = (): { line: number; col: number } => {
    const d = dispText();
    const target = Math.min(dispCaret(), d.length);
    let line = 0;
    let lineStart = 0;
    for (let i = 0; i < target; i++) {
      if (d.charCodeAt(i) === 0x0a) {
        line++;
        lineStart = i + 1;
      }
    }
    return { line, col: target - lineStart };
  };

  const caretX = () => {
    const { line, col } = caretLineCol();
    return measureMono((lines()[line] ?? "").slice(0, col), MONO_SLOTS[props.monoSize ?? 14]);
  };

  /** 多行：滚动保持光标行可见。 */
  const revealCaret = (): void => {
    if (!props.multiline) return;
    const visibleH = bodyH - padT - padB;
    const { line } = caretLineCol();
    const top = line * lineH;
    if (top < scrollY.value) scrollY.value = top;
    else if (top + lineH > scrollY.value + visibleH) scrollY.value = top + lineH - visibleH;
  };

  const setCaretClamped = (i: number) => {
    caret.value = Math.max(0, Math.min(i, text.value.length));
  };

  /** 归一化选区 [from, to)；两端相等（无选区）返回 null。 */
  const selRange = (): [number, number] | null => {
    const a = selAnchor.value;
    const b = selHead.value;
    return a === b ? null : a < b ? [a, b] : [b, a];
  };
  /** 选区收拢（消除；端点保持不动）。 */
  const collapseSelection = (): void => {
    selHead.value = selAnchor.value;
  };
  /** 有选区时删除并返回 true（退格/删除/输入替换共用）。 */
  const deleteSelection = (): boolean => {
    const r = selRange();
    if (r === null) return false;
    text.value = text.value.slice(0, r[0]) + text.value.slice(r[1]);
    caret.value = r[0];
    selAnchor.value = r[0];
    selHead.value = r[0];
    return true;
  };

  const insert = (s: string) => {
    if (s === "") return;
    deleteSelection();
    const t = text.value;
    const c = caret.value;
    text.value = t.slice(0, c) + s + t.slice(c);
    caret.value = c + s.length;
    caretPulse();
    revealCaret();
  };

  /** 屏幕坐标 → text 字符索引（命中区外/未给 selRegion 时保持光标原位）。
   *  命中区是控件根盒：内容起点 = 根盒 + 1px 边框 + 内边距；行含 scrollY。 */
  const posAt = (gx: number, gy: number): number => {
    const r = props.selRegion?.() ?? null;
    if (r === null) return caret.value;
    const ls = text.value.split("\n");
    let line = Math.floor((gy - (r.y + 1 + padT) + scrollY.value) / lineH);
    line = Math.max(0, Math.min(ls.length - 1, line));
    let start = 0;
    for (let i = 0; i < line; i++) start += ls[i]!.length + 1;
    const col = monoColAt(ls[line]!, gx - (r.x + 1 + FIELD_PAD_X), (s) => measureMono(s, monoSlot));
    return Math.min(start + col, text.value.length);
  };

  /** 鼠标按下：清 IME、光标定位到点击处、选区锚点就位（未拖动即无选区）。 */
  const selDown = (gx: number, gy: number): void => {
    preedit.value = "";
    const pos = posAt(gx, gy);
    caret.value = pos;
    selAnchor.value = pos;
    selHead.value = pos;
    setActiveField(impl);
    caretPulse();
  };

  /** 拖动：延伸选区头部，光标跟随并滚动至可见。 */
  const selDrag = (gx: number, gy: number): void => {
    const pos = posAt(gx, gy);
    if (pos === selHead.value) return;
    selHead.value = pos;
    caret.value = pos;
    caretPulse();
    revealCaret();
  };

  /** 各行选区高亮矩形（画布坐标；渲染在文字下层）。 */
  const selRects = (): { t: number; l: number; w: number }[] => {
    const r = selRange();
    if (r === null) return [];
    void text.value; // 渲染依赖
    const ls = text.value.split("\n");
    const out: { t: number; l: number; w: number }[] = [];
    let start = 0;
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i]!;
      const ls0 = start;
      const le0 = start + line.length;
      start = le0 + 1;
      const from = Math.max(r[0], ls0);
      const to = Math.min(r[1], le0);
      if (to <= from) continue;
      const x0 = measureMono(line.slice(0, from - ls0), monoSlot);
      const x1 = measureMono(line.slice(0, to - ls0), monoSlot);
      if (x1 > x0) out.push({ t: i * lineH, l: x0, w: x1 - x0 });
    }
    return out;
  };

  const lineStartBefore = (pos: number): number => {
    const t = text.value;
    let i = Math.min(pos, t.length);
    while (i > 0 && t.charCodeAt(i - 1) !== 0x0a) i--;
    return i;
  };
  const lineEndAfter = (pos: number): number => {
    const t = text.value;
    let i = Math.min(pos, t.length);
    while (i < t.length && t.charCodeAt(i) !== 0x0a) i++;
    return i;
  };

  const handleKey = (k: string, mods: KeyMods): void => {
    const t = text.value;
    const c = caret.value;
    // Cmd/Ctrl+Enter：发送（不插换行）
    if (k === "Enter" && (mods.cmd || mods.ctl)) {
      props.onSubmit?.();
      return;
    }
    switch (k) {
      case "Backspace":
        if (deleteSelection()) break;
        if (c > 0) {
          text.value = t.slice(0, c - 1) + t.slice(c);
          caret.value = c - 1;
        }
        break;
      case "Delete":
        if (deleteSelection()) break;
        if (c < t.length) text.value = t.slice(0, c) + t.slice(c + 1);
        break;
      case "Left": {
        const r = selRange();
        if (r !== null) {
          caret.value = r[0];
          collapseSelection();
        } else setCaretClamped(c - 1);
        break;
      }
      case "Right": {
        const r = selRange();
        if (r !== null) {
          caret.value = r[1];
          collapseSelection();
        } else setCaretClamped(c + 1);
        break;
      }
      case "Home":
        collapseSelection();
        caret.value = lineStartBefore(c);
        break;
      case "End":
        collapseSelection();
        caret.value = lineEndAfter(c);
        break;
      case "Up":
      case "Down": {
        if (!props.multiline) break;
        collapseSelection();
        const start = lineStartBefore(c);
        const col = c - start;
        const targetLineStart =
          k === "Up" ? lineStartBefore(start - 1) : lineEndAfter(c) < t.length ? lineEndAfter(c) + 1 : t.length;
        const targetEnd = lineEndAfter(targetLineStart);
        caret.value = Math.min(targetLineStart + col, targetEnd);
        break;
      }
      case "Enter":
        if (props.multiline) insert("\n");
        else props.onEnter?.(handle);
        break;
      default:
        break;
    }
    caretPulse();
    revealCaret();
  };

  const impl: TextFieldProto = {
    onCh: (s) => {
      preedit.value = "";
      insert(s);
    },
    onPaste: (s) => {
      preedit.value = "";
      insert(s);
    },
    onIme: (s) => {
      preedit.value = s ?? "";
      caretPulse();
    },
    onKey: (k, mods) => handleKey(k, mods),
    selectionText: () => {
      const r = selRange();
      return r === null ? null : text.value.slice(r[0], r[1]);
    },
  };

  const handle: TextFieldHandle = {
    text: () => text.value,
    setText: (s) => {
      text.value = s;
      caret.value = s.length;
      selAnchor.value = s.length;
      selHead.value = s.length;
      preedit.value = "";
      caretPulse();
      revealCaret();
    },
    focus: () => {
      setActiveField(impl);
      caretPulse();
      if (node) focusNode(node);
    },
    blur: () => {
      if (isActive()) setActiveField(null);
      preedit.value = "";
    },
  };
  props.onHandle?.(handle);

  // 拖动选中命中区注册（未给 selRegion 的实例不参与）；组件卸载时摘除，
  // 防止切连接类型/切模式后残留幽灵命中区。
  if (props.selRegion) {
    const entry: FieldSelEntry = { region: props.selRegion, down: selDown, drag: selDrag, up: () => {} };
    fieldSelEntries.add(entry);
    onScopeDispose(() => {
      fieldSelEntries.delete(entry);
      if (fieldSelDrag === entry) fieldSelDrag = null;
    });
  }

  return (
    <View
      class="relative rounded-md w-full overflow-hidden"
      style={{
        height: bodyH,
        bgColor: theme.value.inputBg,
        borderColor: isActive() ? theme.value.accent : theme.value.panelBorder,
        borderWidth: 1,
      }}
      focusable
      onPress={() => handle.focus()}
      nodeRef={(n: NodeMirror | null) => {
        node = n ?? undefined;
      }}
    >
      {/* 内容画布：行绝对定位（规避深层 flex-col 堆叠怪癖），translateY 滚动。
          选区高亮先画（在文字下层），随后占位符与各行文本。 */}
      <View class="absolute" style={{ insetL: FIELD_PAD_X, insetR: FIELD_PAD_X, insetT: padT, translateY: -scrollY.value }}>
        {selRects().map((r) => (
          <View
            class="absolute"
            style={{ insetT: r.t, insetL: r.l, width: r.w, height: lineH, bgColor: theme.value.selection }}
          />
        ))}
        {dispText() === "" ? (
          <Text
            class={
              props.monoSize === 12
                ? "absolute text-xs font-mono"
                : props.monoSize === 16
                  ? "absolute text-base font-mono"
                  : "absolute text-sm font-mono"
            }
            style={{ insetT: 0, height: lineH, lineHeight: lineH, textColor: theme.value.dim }}
          >
            {props.placeholder?.() ?? ""}
          </Text>
        ) : null}
        {lines().map((line, i) => (
          <Text
            class={
              props.monoSize === 12
                ? "absolute left-0 right-0 text-xs font-mono"
                : props.monoSize === 16
                  ? "absolute left-0 right-0 text-base font-mono"
                  : "absolute left-0 right-0 text-sm font-mono"
            }
            style={{
              insetT: i * lineH,
              height: lineH,
              lineHeight: lineH,
              textColor: theme.value.fg,
            }}
          >
            {line}
          </Text>
        ))}
        {isActive() ? (
          <View
            class="absolute"
            style={{
              width: 2,
              height: lineH - 6,
              insetT: caretLineCol().line * lineH + 3,
              insetL: caretX(),
              // 隐藏相位用透明色（style diff 只增不删，key 常设）
              bgColor: caretOn.value ? theme.value.accent : TRANSPARENT,
            }}
          />
        ) : null}
        {preedit.value !== "" ? (
          <View
            class="absolute"
            style={{
              height: 1,
              insetT: caretLineCol().line * lineH + lineH - 3,
              insetL: caretX() - measureMono(preedit.value, MONO_SLOTS[props.monoSize ?? 14]),
              width: measureMono(preedit.value, MONO_SLOTS[props.monoSize ?? 14]),
              bgColor: theme.value.accent,
            }}
          />
        ) : null}
      </View>
    </View>
  );
}
