// app/settings-modal.tsx — "应用配置"模态弹窗（SPEC §3.1/§3.8）。
// msgbox 形态：全屏半透明遮罩（点击丢弃）+ 居中圆角框；草稿模式：打开时
// 快照当前设置，框内修改只写草稿，"应用"一次性写回（持久化由 session.ts
// 既有 watch 自动跟随），"取消"/点遮罩/Escape 丢弃。导入/导出是即时动作，
// 导入成功后草稿重同步为导入值。
// 引擎怪癖（AGENTS.md）：Portal host 固定 480×272 → 遮罩按 viewportSize 自撑；
// 内容 absolute 定位（深层禁流式堆叠）；组件不返回 null（空态 0 尺寸占位，
// 条件子节点放表达式）。
import { ref } from "vue";
import { Portal, Text, View } from "@pocketjs/framework/components";
import {
  Btn,
  CTL_H,
  Hairline,
  Scrollbar,
  Select,
  TextField,
  closePopup,
  textFieldMouse,
  type PopupAnchor,
  type SelRect,
  type TextFieldHandle,
} from "./widgets";
import { theme, themeMode, type ThemeMode } from "./theme";
import { locale, t, type Locale } from "./i18n";
import { viewportSize } from "./layout";
import { setActiveField } from "./fields";
import { applyLogFormat, exportConfig, fontSize, historyLines, importConfig, scrollbackLines, setHistoryLines, setScrollbackLines } from "./session";
import { applyLocale } from "./locale";
import {
  BTN_Y,
  CTL_TOP_OFF,
  DIV_Y,
  IO_Y,
  LABEL_COL_W,
  MODAL_CONTENT_H,
  MODAL_PAD,
  TITLE_H,
  MODAL_ROW_H,
  modalFrame,
  modalRowY,
  type ModalFrame,
} from "./settings-modal-layout";

// ---------------------------------------------------------------------------
// 几何派生（Select 弹层锚点 / TextField 拖选命中区共用；行内偏移见
// settings-modal-layout.ts）
// ---------------------------------------------------------------------------

const BTN_GAP = 10;

// ---------------------------------------------------------------------------
// 状态（模块级单例，仿 widgets.tsx 的 popup）
// ---------------------------------------------------------------------------

const settingsOpenRef = ref(false);
const modalScroll = ref(0);

/** 草稿（打开时快照；只写草稿，"应用"才写回全局状态）。 */
const draftLocale = ref<Locale>("zh-CN");
const draftTheme = ref<ThemeMode>("dark");
const draftFontSize = ref<12 | 14 | 16>(14);

/** 行数输入框句柄（弹窗内容挂载时经 onHandle 注入）：接收区历史 / 终端回滚。 */
let historyField: TextFieldHandle | undefined;
let scrollField: TextFieldHandle | undefined;

export function settingsOpen(): boolean {
  return settingsOpenRef.value;
}

/** 打开弹窗：快照当前设置为草稿。 */
export function openSettingsModal(): void {
  closePopup();
  draftLocale.value = locale.value;
  draftTheme.value = themeMode.value;
  draftFontSize.value = fontSize.value;
  modalScroll.value = 0;
  settingsOpenRef.value = true;
}

export function closeSettingsModal(): void {
  closePopup(); // 收可能开着的下拉
  settingsOpenRef.value = false;
  modalScroll.value = 0;
  historyField = undefined;
  scrollField = undefined;
  // 卸载的输入框不得滞留活跃域（activeField 无卸载清理，悬挂会让键盘路由悬空）
  setActiveField(null);
}

/** 弹窗打开时接管滚轮（app.tsx 路由）：小视口夹取后内容超高才可滚。 */
export function modalWheel(dy: number): void {
  if (!settingsOpenRef.value) return;
  const f = modalFrame(viewportSize.value.w, viewportSize.value.h);
  const max = Math.max(0, MODAL_CONTENT_H - f.h);
  modalScroll.value = Math.max(0, Math.min(max, modalScroll.value - dy));
}

/** 弹窗打开时的文本域鼠标路由：只认弹窗内两个行数输入框——全局
 *  textFieldMouse 是纯几何命中，会把遮罩下方的发送框/面板输入框也认领走。
 *  抬起事件总放行，保证拖选跨出输入框后能正常释放。 */
export function settingsFieldMouse(x: number, y: number, down: boolean): boolean {
  if (!down) return textFieldMouse(x, y, false);
  for (const r of [historyFieldRegion(), scrollFieldRegion()]) {
    if (r !== null && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
      return textFieldMouse(x, y, true);
    }
  }
  return false;
}

/** 应用草稿：一次性写回全局状态（持久化由 session.ts 的 watch 自动跟随）并关闭。 */
function applyDrafts(): void {
  applyLocale(draftLocale.value);
  themeMode.value = draftTheme.value;
  fontSize.value = draftFontSize.value;
  applyLogFormat(); // 字号变化重排日志行宽
  const h = Number.parseInt((historyField?.text() ?? "").trim(), 10);
  setHistoryLines(Number.isFinite(h) ? h : 10000);
  const n = Number.parseInt((scrollField?.text() ?? "").trim(), 10);
  setScrollbackLines(Number.isFinite(n) ? n : 10000);
  closeSettingsModal();
}

/** 导入配置（即时生效）：成功后草稿重同步为导入值（未应用的其它草稿丢弃）。 */
function importAndSync(): void {
  if (importConfig()) {
    draftLocale.value = locale.value;
    draftTheme.value = themeMode.value;
    draftFontSize.value = fontSize.value;
    historyField?.setText(String(historyLines.value));
    scrollField?.setText(String(scrollbackLines.value));
  }
}

// ---------------------------------------------------------------------------
// 屏幕坐标派生（Select 弹层锚点 / TextField 拖选命中区共用）
// ---------------------------------------------------------------------------

const frame = (): ModalFrame => modalFrame(viewportSize.value.w, viewportSize.value.h);
const ctlX = (): number => frame().x + MODAL_PAD + LABEL_COL_W;
const ctlW = (): number => frame().w - MODAL_PAD * 2 - LABEL_COL_W;
const ctlAnchor = (i: number): PopupAnchor => ({
  x: ctlX(),
  y: frame().y + modalRowY(i) + CTL_TOP_OFF - modalScroll.value,
  w: ctlW(),
  h: CTL_H,
});
const historyFieldRegion = (): SelRect => ({
  x: ctlX(),
  y: frame().y + modalRowY(3) + CTL_TOP_OFF - modalScroll.value,
  w: ctlW(),
  h: CTL_H,
});
const scrollFieldRegion = (): SelRect => ({
  x: ctlX(),
  y: frame().y + modalRowY(4) + CTL_TOP_OFF - modalScroll.value,
  w: ctlW(),
  h: CTL_H,
});

// ---------------------------------------------------------------------------
// 组件（app 根部挂载一次，与 PopupLayer 平级）
// ---------------------------------------------------------------------------

export function SettingsModal() {
  return (
    <View style={{ width: 0, height: 0 }}>
      {settingsOpenRef.value ? (
        <Portal>
          {/* 遮罩：半透明变暗（msgbox 观感）+ 整屏命中（点击丢弃草稿）。
              Portal host 固定 480×272，必须按实时视口自撑宽高（同 PopupLayer）。 */}
          <View
            class="absolute"
            style={{
              insetT: 0,
              insetL: 0,
              width: viewportSize.value.w,
              height: viewportSize.value.h,
              bgColor: "#00000066",
            }}
            focusable
            debugName="settingsBackdrop"
            onPress={closeSettingsModal}
          />
          <SettingsBox />
        </Portal>
      ) : null}
    </View>
  );
}

function SettingsBox() {
  const inner = (): number => frame().w - MODAL_PAD * 2;
  const halfW = (): number => Math.floor((inner() - BTN_GAP) / 2);
  return (
    <View
      class="absolute rounded-md"
      debugName="settingsModal"
      style={{
        insetL: frame().x,
        insetT: frame().y,
        width: frame().w,
        height: frame().h,
        bgColor: theme.value.popupBg,
        borderColor: theme.value.panelBorder,
        borderWidth: 1,
      }}
    >
      {/* 内容画布：行绝对定位（深层禁流式堆叠），translateY 滚动（小视口夹取时） */}
      <View class="absolute overflow-hidden" style={{ insetT: 0, insetL: 0, insetR: 0, insetB: 0 }}>
        <View class="absolute" style={{ insetL: MODAL_PAD, insetT: 0, width: inner(), translateY: -modalScroll.value }}>
          <Text
            class="absolute text-sm font-bold"
            style={{ insetL: 0, insetT: 0, height: TITLE_H, lineHeight: TITLE_H, textColor: theme.value.fg }}
          >
            {t("settings.title")}
          </Text>

          {/* 语言 */}
          <View class="absolute" style={{ insetT: modalRowY(0), insetL: 0, insetR: 0, height: MODAL_ROW_H }}>
            <Text
              class="absolute text-xs"
              style={{ insetL: 0, insetT: 0, height: MODAL_ROW_H, lineHeight: MODAL_ROW_H, textColor: theme.value.dim }}
            >
              {t("settings.language")}
            </Text>
            <View class="absolute" style={{ insetL: LABEL_COL_W, insetR: 0, insetT: CTL_TOP_OFF, height: CTL_H }}>
              <Select
                display={() => t(`settings.langName.${draftLocale.value}`)}
                value={() => draftLocale.value}
                options={() => [
                  { value: "zh-CN", label: t("settings.langName.zh-CN") },
                  { value: "en", label: t("settings.langName.en") },
                ]}
                onPick={(v) => {
                  draftLocale.value = v as Locale;
                }}
                anchor={() => ctlAnchor(0)}
              />
            </View>
          </View>

          {/* 主题（三态，跟随系统经宿主 appearance 事件） */}
          <View class="absolute" style={{ insetT: modalRowY(1), insetL: 0, insetR: 0, height: MODAL_ROW_H }}>
            <Text
              class="absolute text-xs"
              style={{ insetL: 0, insetT: 0, height: MODAL_ROW_H, lineHeight: MODAL_ROW_H, textColor: theme.value.dim }}
            >
              {t("settings.theme")}
            </Text>
            <View class="absolute" style={{ insetL: LABEL_COL_W, insetR: 0, insetT: CTL_TOP_OFF, height: CTL_H }}>
              <Select
                display={() =>
                  draftTheme.value === "light"
                    ? t("settings.themeLight")
                    : draftTheme.value === "system"
                      ? t("settings.themeSystem")
                      : t("settings.themeDark")
                }
                value={() => draftTheme.value}
                options={() => [
                  { value: "light", label: t("settings.themeLight") },
                  { value: "dark", label: t("settings.themeDark") },
                  { value: "system", label: t("settings.themeSystem") },
                ]}
                onPick={(v) => {
                  draftTheme.value = v as ThemeMode;
                }}
                anchor={() => ctlAnchor(1)}
              />
            </View>
          </View>

          {/* 字号（收发区 mono 字号，三档） */}
          <View class="absolute" style={{ insetT: modalRowY(2), insetL: 0, insetR: 0, height: MODAL_ROW_H }}>
            <Text
              class="absolute text-xs"
              style={{ insetL: 0, insetT: 0, height: MODAL_ROW_H, lineHeight: MODAL_ROW_H, textColor: theme.value.dim }}
            >
              {t("settings.fontSize")}
            </Text>
            <View class="absolute" style={{ insetL: LABEL_COL_W, insetR: 0, insetT: CTL_TOP_OFF, height: CTL_H }}>
              <Select
                display={() =>
                  draftFontSize.value === 12
                    ? t("settings.fontSizeSmall")
                    : draftFontSize.value === 16
                      ? t("settings.fontSizeLarge")
                      : t("settings.fontSizeMedium")
                }
                value={() => String(draftFontSize.value)}
                options={() => [
                  { value: "12", label: t("settings.fontSizeSmall") },
                  { value: "14", label: t("settings.fontSizeMedium") },
                  { value: "16", label: t("settings.fontSizeLarge") },
                ]}
                onPick={(v) => {
                  draftFontSize.value = Number(v) as 12 | 14 | 16;
                }}
                anchor={() => ctlAnchor(2)}
              />
            </View>
          </View>

          {/* 接收区历史行数（1–100000，应用时生效，SPEC §3.3/§3.8） */}
          <View class="absolute" style={{ insetT: modalRowY(3), insetL: 0, insetR: 0, height: MODAL_ROW_H }}>
            <Text
              class="absolute text-xs"
              style={{ insetL: 0, insetT: 0, height: MODAL_ROW_H, lineHeight: MODAL_ROW_H, textColor: theme.value.dim }}
            >
              {t("settings.historyLines")}
            </Text>
            <View class="absolute" style={{ insetL: LABEL_COL_W, insetR: 0, insetT: CTL_TOP_OFF, height: CTL_H }}>
              <TextField
                initial={String(historyLines.value)}
                selRegion={historyFieldRegion}
                onHandle={(h) => {
                  historyField = h;
                }}
              />
            </View>
          </View>

          {/* 终端回滚行数（0–100000，应用时生效，SPEC §3.4/§3.8） */}
          <View class="absolute" style={{ insetT: modalRowY(4), insetL: 0, insetR: 0, height: MODAL_ROW_H }}>
            <Text
              class="absolute text-xs"
              style={{ insetL: 0, insetT: 0, height: MODAL_ROW_H, lineHeight: MODAL_ROW_H, textColor: theme.value.dim }}
            >
              {t("settings.scrollbackLines")}
            </Text>
            <View class="absolute" style={{ insetL: LABEL_COL_W, insetR: 0, insetT: CTL_TOP_OFF, height: CTL_H }}>
              <TextField
                initial={String(scrollbackLines.value)}
                selRegion={scrollFieldRegion}
                onHandle={(h) => {
                  scrollField = h;
                }}
              />
            </View>
          </View>

          {/* 分隔线 */}
          <View class="absolute" style={{ insetT: DIV_Y, insetL: 0, insetR: 0, height: 1 }}>
            <Hairline />
          </View>

          {/* 导出 / 导入（即时动作，不经草稿）。Btn 必须显式传 width——
              absolute 父级下 flex"撑满父宽"塌缩成文字宽（引擎怪癖，实测）。 */}
          <View class="absolute" style={{ insetT: IO_Y, insetL: 0, width: halfW(), height: 30 }}>
            <Btn width={halfW()} height={30} label={() => t("settings.export")} onPress={exportConfig} />
          </View>
          <View class="absolute" style={{ insetT: IO_Y, insetR: 0, width: halfW(), height: 30 }}>
            <Btn width={halfW()} height={30} label={() => t("settings.import")} onPress={importAndSync} />
          </View>

          {/* 取消 / 应用 */}
          <View class="absolute" style={{ insetT: BTN_Y, insetL: 0, width: halfW(), height: 30 }}>
            <Btn width={halfW()} height={30} label={() => t("settings.cancel")} onPress={closeSettingsModal} />
          </View>
          <View class="absolute" style={{ insetT: BTN_Y, insetR: 0, width: halfW(), height: 30 }}>
            <Btn width={halfW()} height={30} accent label={() => t("settings.apply")} onPress={applyDrafts} />
          </View>
        </View>
      </View>
      {/* 小视口夹取（frame().h < 内容高）才显示；常态 total == viewH 隐藏 */}
      <Scrollbar scroll={() => modalScroll.value} total={() => MODAL_CONTENT_H} viewH={() => frame().h} />
    </View>
  );
}
