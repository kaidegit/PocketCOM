// ASCII keyboard shares the active text field protocol; keys retain field focus.
import { hasAppFeature } from "@pocketcom/features";
import { ref, watch } from "vue";
import { Portal, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { setProp } from "@pocketjs/framework/renderer";
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
export function SoftKeyboard() {
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
  const width = () => Math.max(1, (viewportSize.value.w - 12) / 10);
  // A key is one painted Text node. Binding the common native input props
  // avoids a View + component scope around every character on the small heap.
  const bindKey = (n: NodeMirror | null, value: () => string): void => {
    if (!n) return;
    setProp(n, "focusable", true);
    setProp(n, "onPress", () => keyboardInput(value()));
  };
  return <View style={{ width: 0, height: 0 }}>{mounted.value ? <Portal>
    <View class="absolute" debugName="softKeyboard" nodeRef={(n: NodeMirror | null) => { node = n; }} style={{ insetL: 0, insetT: keyboardOpen() ? panelTop() : viewportSize.value.h, width: viewportSize.value.w, height: KEYBOARD_H + EDITOR_H, bgColor: theme.value.panelBg }}>
      <KeyboardEditor width={() => viewportSize.value.w} top={panelTop} opened={keyboardOpen} />
      {ROWS.map((row, y) => row.split("").map((ch, x) => <Text
        class="absolute rounded-md text-xs"
        style={{ insetL: 6 + x * width(), insetT: EDITOR_H + 4 + y * 32, width: width() - 3, height: 28, lineHeight: 28, textAlign: 1, bgColor: theme.value.btnBg, textColor: theme.value.fg }}
        nodeRef={(n: NodeMirror | null) => bindKey(n, () => shifted.value ? SHIFTED_ROWS[y]![x]! : ch)}
      >{shifted.value ? SHIFTED_ROWS[y]![x]! : ch}</Text>))}
      {["shift", "space", "Backspace", "Enter", "close"].map((key, x) => <Text
        class="absolute rounded-md text-xs"
        style={{ insetL: 6 + x * (viewportSize.value.w - 12) / 5, insetT: EDITOR_H + 132, width: (viewportSize.value.w - 12) / 5 - 3, height: 28, lineHeight: 28, textAlign: 1, bgColor: theme.value.btnBg, textColor: theme.value.fg }}
        nodeRef={(n: NodeMirror | null) => bindKey(n, () => key)}
      >{t(`keyboard.${key}`)}</Text>)}
    </View>
  </Portal> : null}</View>;
}
