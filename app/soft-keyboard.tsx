import { perfBegin, perfEnd } from "./perf";
// ASCII keyboard shares the active text field protocol; keys retain field focus.
import { hasAppFeature } from "@pocketcom/features";
import { onScopeDispose, ref, shallowRef, watch, watchEffect } from "vue";
import { Portal, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createTextNode, detachNode, insertNode, replaceText, setProp } from "@pocketjs/framework/renderer";
import { activeField } from "./fields";
import { viewportSize, STATUS_H } from "./layout";
import { theme } from "./theme";
import { t } from "./i18n";
import { KeyboardEditor } from "./keyboard-editor";
import { EDITOR_H, KEYBOARD_H } from "./keyboard-editor-layout";
export { keyboardEditorMouse } from "./keyboard-editor";

const opened = hasAppFeature("ui.soft-keyboard") ? ref(false) : undefined!;
const shifted = hasAppFeature("ui.soft-keyboard") ? ref(false) : undefined!;
// Synchronous: even blur + refocus in one tick must forget the old target.
if (hasAppFeature("ui.soft-keyboard")) watch(activeField, closeKeyboard, { flush: "sync" });
export const keyboardOpen = (): boolean => hasAppFeature("ui.soft-keyboard") && opened.value && activeField.value !== null;
export function openKeyboard(): void {
  if (hasAppFeature("ui.soft-keyboard") && activeField.value) opened.value = true;
}
export function closeKeyboard(): void {
  if (hasAppFeature("ui.soft-keyboard")) opened.value = false;
}
export function toggleKeyboard(): void {
  if (hasAppFeature("ui.soft-keyboard") && activeField.value) opened.value = !opened.value;
}
const panelTop = () => Math.max(0, viewportSize.value.h - STATUS_H - KEYBOARD_H - EDITOR_H);
export function keyboardHit(x: number, y: number): boolean {
  return keyboardOpen() && x >= 0 && x < viewportSize.value.w && y >= panelTop() && y < viewportSize.value.h - STATUS_H;
}
export function keyboardInput(key: string): void {
  if (!hasAppFeature("ui.soft-keyboard")) return;
  if (!keyboardOpen()) return;
  const field = activeField.value;
  if (!field) return;
  if (key === "shift") shifted.value = !shifted.value;
  else if (key === "close") closeKeyboard();
  else if (key === "Backspace" || key === "Enter") field.onKey(key, { cmd: false, ctl: false, alt: false, sh: false });
  else field.onCh(key === "space" ? " " : key);
}
// Create keys once on first use and reuse them to bound repeated-open peaks.
const ROWS = ["1234567890", "qwertyuiop", "asdfghjkl;", "zxcvbnm,./"];
const SHIFTED_ROWS = ["!@#$%^&*()", "QWERTYUIOP", "ASDFGHJKL:", 'ZXCVBNM<>?'];
/** The fixed keyboard needs no per-key Vapor list scopes or prop effects.
 * Keep one Text primitive and one press handler per key; two shared effects
 * update geometry/theme and labels. Renderer nodes retain ordinary input and
 * tree cleanup semantics, including when the component is unmounted. */
function KeyboardKeys() {
  const __tsPerf1=perfBegin("create.KeyboardKeys");
  try {
  const host = shallowRef<NodeMirror | null>(null);
  const keys: NodeMirror[] = [];
  const actions = ["shift", "space", "Backspace", "Enter", "close"];
  const value = (i: number): string => i < 40
    ? (shifted.value ? SHIFTED_ROWS : ROWS)[Math.floor(i / 10)]![i % 10]!
    : actions[i - 40]!;
  watchEffect(() => {
  const __tsPerf2=perfBegin("effect.KeyboardKeys.1");
  try {
    const parent = host.value;
    if (!parent) return;
    if (keys.length === 0) {
      for (let i = 0; i < 45; i++) {
        const key = createTextNode("");
        setProp(key, "class", "absolute rounded-md text-xs");
        setProp(key, "focusable", true);
        setProp(key, "onPress", () => keyboardInput(value(i)));
        insertNode(parent, key);
        keys.push(key);
      }
    }
    const rowWidth = viewportSize.value.w - 12;
    const colors = theme.value;
    for (let i = 0; i < keys.length; i++) {
      const columns = i < 40 ? 10 : 5;
      const x = i < 40 ? i % 10 : i - 40;
      const top = i < 40 ? 4 + Math.floor(i / 10) * 32 : 132;
      const key = keys[i]!;
      setProp(key, "style", {
        insetL: 6 + x * rowWidth / columns, insetT: top,
        width: Math.max(1, rowWidth / columns) - 3, height: 28,
        lineHeight: 28, textAlign: 1, bgColor: colors.btnBg, textColor: colors.fg,
      }, key.domAttrs?.style);
    }

  } finally { perfEnd(__tsPerf2); }
});
  watchEffect(() => {
  const __tsPerf3=perfBegin("effect.KeyboardKeys.2");
  try {
    if (!host.value) return;
    for (let i = 0; i < keys.length; i++) {
      const label = i < 40 ? value(i) : t(`keyboard.${actions[i - 40]}`);
      if (keys[i]!.text !== label) replaceText(keys[i]!, label);
    }

  } finally { perfEnd(__tsPerf3); }
});
  onScopeDispose(() => {
    for (const key of keys) if (key.parent) detachNode(key.parent, key);
    keys.length = 0;
  });
  // The full class literal is also compiled for the manually-created keys.
  return <View class="absolute rounded-md text-xs" nodeRef={(n: NodeMirror | null) => { host.value = n; }}
    style={{ insetL: 0, insetT: EDITOR_H, width: viewportSize.value.w, height: KEYBOARD_H }} />;

  } finally { perfEnd(__tsPerf1); }
}

export function SoftKeyboard() {
  const __tsPerf4=perfBegin("create.SoftKeyboard");
  try {
  const mounted = ref(false);
  let node: NodeMirror | null = null;
  let raised = false;
  onFrame(() => {
    // Portal hosts are siblings. Raise the persistent host itself so drawers
    // and modals created later cannot cover the keyboard on subsequent use.
    if (!raised && node?.parent) {
      setProp(node.parent, "style", { zIndex: 1001 });
      raised = true;
    }
  });
  watch(keyboardOpen, open => { if (open) mounted.value = true; }, { flush: "sync" });
  return <View style={{ width: 0, height: 0 }}>{mounted.value ? <Portal>
    <View class="absolute" debugName="softKeyboard" nodeRef={(n: NodeMirror | null) => { node = n; }} style={{ insetL: 0, insetT: keyboardOpen() ? panelTop() : viewportSize.value.h, width: viewportSize.value.w, height: KEYBOARD_H + EDITOR_H, bgColor: theme.value.panelBg }}>
      <KeyboardEditor width={() => viewportSize.value.w} top={panelTop} opened={keyboardOpen} />
      <KeyboardKeys />
    </View>
  </Portal> : null}</View>;

  } finally { perfEnd(__tsPerf4); }
}
