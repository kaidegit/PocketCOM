// app/fields.ts — 文本输入焦点路由（svc companion 方言，SPEC §4.3）。
// 桌面宿主把键盘/IME/粘贴以 JSON 行逐 tick 投递；guest 侧维护"当前活跃
// 文本域"，ch/key/paste/ime 事件只分发给活跃域。鼠标点击由宿主注入
// CIRCLE 完成 press，TextField 在 onPress 里把自己设为活跃域；
// 其余控件（按钮/下拉）在 onPress 里清活跃域（借焦）。
import { ref } from "vue";

/** 键修饰位（svc key 行的 cmd/alt/ctl/sh）。 */
export interface KeyMods {
  cmd: boolean;
  alt: boolean;
  ctl: boolean;
  sh: boolean;
}

/** 文本域协议：实现者通常是 app/widgets.tsx 的 TextField。 */
export interface TextField {
  onCh(s: string): void;
  onKey(k: string, mods: KeyMods): void;
  onPaste(text: string): void;
  onIme(s: string, caret: number | null): void;
}

/** 当前活跃文本域（响应式：TextField 用它画聚焦边框）。 */
export const activeField = ref<TextField | null>(null);

export function setActiveField(field: TextField | null): void {
  activeField.value = field;
}
