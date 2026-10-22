// ASCII keyboard shares the active text field protocol; keys retain field focus.
import { hasAppFeature } from "@pocketcom/features";
import { ref } from "vue";
import { Portal, Text, View } from "@pocketjs/framework/components";
import { activeField } from "./fields";
import { viewportSize, STATUS_H } from "./layout";
import { theme } from "./theme";
import { t } from "./i18n";

const opened = hasAppFeature("ui.soft-keyboard") ? ref(false) : undefined!;
const shifted = hasAppFeature("ui.soft-keyboard") ? ref(false) : undefined!;
export const keyboardOpen = (): boolean => hasAppFeature("ui.soft-keyboard") && opened.value && activeField.value !== null;
export function closeKeyboard(): void {
  if (hasAppFeature("ui.soft-keyboard")) opened.value = false;
}
export function toggleKeyboard(): void {
  if (hasAppFeature("ui.soft-keyboard") && activeField.value) opened.value = !opened.value;
}
const HEIGHT = 164;
export function keyboardHit(x: number, y: number): boolean {
  return keyboardOpen() && x >= 0 && x < viewportSize.value.w && y >= viewportSize.value.h - STATUS_H - HEIGHT && y < viewportSize.value.h - STATUS_H;
}
export function keyboardInput(key: string): void {
  if (!hasAppFeature("ui.soft-keyboard")) return;
  const field = activeField.value;
  if (!field) return;
  if (key === "shift") shifted.value = !shifted.value;
  else if (key === "close") closeKeyboard();
  else if (key === "Backspace" || key === "Enter") field.onKey(key, { cmd: false, ctl: false, alt: false, sh: false });
  else field.onCh(key === "space" ? " " : key);
}
function KeyboardKey(props: { label: string; value: string; x: number; y: number; w: number }) {
  return <View class="absolute rounded-md" style={{ insetL: props.x, insetT: props.y, width: props.w, height: 28, bgColor: theme.value.btnBg }}
    focusable onPress={() => keyboardInput(props.value)}>
    <Text class="absolute text-xs" style={{ insetL: 0, insetT: 0, width: props.w, height: 28, lineHeight: 28, textColor: theme.value.fg }}>{props.label}</Text>
  </View>;
}
export function SoftKeyboard() {
  const rows = () => shifted.value
    ? ["!@#$%^&*()", "QWERTYUIOP", "ASDFGHJKL:", 'ZXCVBNM<>?']
    : ["1234567890", "qwertyuiop", "asdfghjkl;", "zxcvbnm,./"];
  const width = () => Math.max(1, (viewportSize.value.w - 12) / 10);
  return <View style={{ width: 0, height: 0 }}>{keyboardOpen() ? <Portal>
    <View class="absolute" debugName="softKeyboard" style={{ insetL: 0, insetT: viewportSize.value.h - STATUS_H - HEIGHT, width: viewportSize.value.w, height: HEIGHT, bgColor: theme.value.panelBg }}>
      {rows().map((row, y) => row.split("").map((ch, x) => <KeyboardKey label={ch} value={ch} x={6 + x * width()} y={4 + y * 32} w={width() - 3} />))}
      {["shift", "space", "Backspace", "Enter", "close"].map((key, x) => <KeyboardKey label={t(`keyboard.${key}`)} value={key} x={6 + x * (viewportSize.value.w - 12) / 5} y={132} w={(viewportSize.value.w - 12) / 5 - 3} />)}
    </View>
  </Portal> : null}</View>;
}
