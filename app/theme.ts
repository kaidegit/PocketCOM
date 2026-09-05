// app/theme.ts — 设计令牌（SPEC §3.7）。
// 深色/浅色双套令牌（三态模式：浅色/深色/跟随系统，跟随系统暂无宿主
// 外观读取通道，先按深色处理）；样式一律经 theme token 的 style 绑定，
// 禁止拼接 class 片段。
import { computed, ref } from "vue";

export type ThemeMode = "dark" | "light" | "system";

/** 主题令牌表（SPEC §3.7：bg/fg/border/accent/rx/tx/source 前缀着色/状态灯）。 */
export interface ThemeTokens {
  /** 窗口底色（右侧主区） */
  bg: string;
  /** 左面板/状态栏底色 */
  panelBg: string;
  /** 分隔线/边框 */
  panelBorder: string;
  /** 输入框/日志井底色 */
  inputBg: string;
  /** 正文 */
  fg: string;
  /** 次要文字 */
  dim: string;
  /** 强调色（主按钮/聚焦边框/选中项） */
  accent: string;
  /** 强调色上的文字 */
  accentFg: string;
  /** 普通按钮底色 */
  btnBg: string;
  /** 选中行底色（下拉项高亮等） */
  activeBg: string;
  /** 弹层底色 */
  popupBg: string;
  /** 滚动条 thumb */
  scrollbar: string;
  /** RX 行文字色 */
  rx: string;
  /** TX 行文字色 */
  tx: string;
  /** sys 行文字色 */
  sys: string;
  /** 来源前缀着色（manual / mcp / sys，SPEC §3.7） */
  prefixManual: string;
  prefixMcp: string;
  prefixSys: string;
  /** 连接状态灯四态（灰/黄/绿/橙，SPEC §3.1） */
  stateDisconnected: string;
  stateConnecting: string;
  stateConnected: string;
  stateLost: string;
}

const dark: ThemeTokens = {
  bg: "#0e1116",
  panelBg: "#151a22",
  panelBorder: "#262e3b",
  inputBg: "#0a0d12",
  fg: "#d8dee9",
  dim: "#7d8695",
  accent: "#4c8dff",
  accentFg: "#ffffff",
  btnBg: "#212834",
  activeBg: "#2c3850",
  popupBg: "#1a212c",
  scrollbar: "#3a4356",
  rx: "#6ee7a0",
  tx: "#7ab8ff",
  sys: "#8a93a3",
  prefixManual: "#e5b567",
  prefixMcp: "#c9a6ff",
  prefixSys: "#8a93a3",
  stateDisconnected: "#5c6470",
  stateConnecting: "#e5b545",
  stateConnected: "#3fce7a",
  stateLost: "#f07b4d",
};

const light: ThemeTokens = {
  bg: "#eef0f4",
  panelBg: "#ffffff",
  panelBorder: "#d8dde6",
  inputBg: "#f3f5f9",
  fg: "#23272e",
  dim: "#6b7280",
  accent: "#2f6fdd",
  accentFg: "#ffffff",
  btnBg: "#e7ebf2",
  activeBg: "#d4e2fa",
  popupBg: "#ffffff",
  scrollbar: "#c3cad6",
  rx: "#14803c",
  tx: "#0b5bd7",
  sys: "#6b7280",
  prefixManual: "#b45309",
  prefixMcp: "#8347d9",
  prefixSys: "#6b7280",
  stateDisconnected: "#9aa1ad",
  stateConnecting: "#b58a12",
  stateConnected: "#189a52",
  stateLost: "#d9632c",
};

const THEMES: Record<Exclude<ThemeMode, "system">, ThemeTokens> = { dark, light };

/** 主题模式（跟随系统暂按深色处理，M2 接宿主外观读取后放开）。 */
export const themeMode = ref<ThemeMode>("dark");

/** 当前生效令牌。 */
export const theme = computed<ThemeTokens>(() => THEMES[themeMode.value === "light" ? "light" : "dark"]);
