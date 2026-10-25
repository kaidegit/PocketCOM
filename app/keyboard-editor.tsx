// A view onto the existing active field, not another TextField or draft.
import { computed, onScopeDispose } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework";
import { createGesture } from "@pocketjs/framework/gesture";
import { activeField } from "./fields";
import { LINE_H, MONO_SLOTS } from "./fontsize";
import { t } from "./i18n";
import { theme } from "./theme";
import { EDITOR_H, EDITOR_PAD, EDITOR_TITLE_H, editorCaretAt, editorWindow } from "./keyboard-editor-layout";

let placeCaret: ((x: number, y: number) => void) | undefined;
/** Companion mouse input must not reach the field hidden behind the editor. */
export function keyboardEditorMouse(x: number, y: number, down: boolean): void {
  if (down) placeCaret?.(x, y);
}

export function KeyboardEditor(props: { width: () => number; top: () => number; opened: () => boolean }) {
  let node: NodeMirror | null = null;
  const field = () => activeField.value?.editor;
  const font = () => field()?.monoSize ?? 14;
  const lineH = () => LINE_H[font()];
  const measure = (s: string) => getOps().measureText(s, MONO_SLOTS[font()]);
  const contentWidth = () => Math.max(1, props.width() - EDITOR_PAD * 4 - 2);
  const window = computed(() => editorWindow(field()?.text() ?? "", field()?.caret() ?? 0, contentWidth(), measure));
  const move = (x: number, y: number): void => {
    const bodyTop = props.top() + EDITOR_TITLE_H;
    if (!props.opened() || x < EDITOR_PAD || x >= props.width() - EDITOR_PAD || y < bodyTop || y >= props.top() + EDITOR_H) return;
    field()?.moveCaret(editorCaretAt(window.value.rows, Math.floor((y - bodyTop - 6) / lineH()), x - EDITOR_PAD * 2 - 1, measure));
  };
  placeCaret = move;
  onScopeDispose(() => { if (placeCaret === move) placeCaret = undefined; });
  createGesture({ region: { node: () => node }, onTap: c => move(c.x, c.y) });
  return <View class="absolute" debugName="keyboardEditor" style={{ insetL: 0, insetT: 0, width: props.width(), height: EDITOR_H, bgColor: theme.value.panelBg }}>
    <Text class="absolute text-xs" style={{ insetL: EDITOR_PAD, insetT: 0, width: contentWidth(), height: EDITOR_TITLE_H, lineHeight: EDITOR_TITLE_H, textColor: theme.value.fg }}>{field()?.label?.() ?? t("keyboard.title")}</Text>
    <View class="absolute rounded-md overflow-hidden" debugName="keyboardEditorBody" nodeRef={(n: NodeMirror | null) => { node = n; }}
      style={{ insetL: EDITOR_PAD, insetT: EDITOR_TITLE_H, width: props.width() - EDITOR_PAD * 2, height: EDITOR_H - EDITOR_TITLE_H, bgColor: theme.value.inputBg, borderWidth: 1, borderColor: theme.value.accent }}>
      {[0, 1].map(row => <Text
        class={font() === 12 ? "absolute font-mono text-xs" : font() === 16 ? "absolute font-mono text-base" : "absolute font-mono text-sm"}
        style={{ insetL: EDITOR_PAD + 1, insetT: 6 + row * lineH(), width: contentWidth(), height: lineH(), lineHeight: lineH(), textColor: theme.value.fg }}
      >{window.value.rows[row]?.text ?? ""}</Text>)}
      <View class="absolute" debugName="keyboardEditorCaret" style={{ insetL: EDITOR_PAD + 1 + window.value.caretX, insetT: 9 + window.value.caretRow * lineH(), width: 2, height: lineH() - 6, bgColor: theme.value.accent }} />
    </View>
  </View>;
}
