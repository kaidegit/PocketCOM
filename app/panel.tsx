// app/panel.tsx — 左侧连接配置面板（SPEC §3.1/§3.2），重写版。
// 布局：头部（固定）+ 内容滚动区（absolute 布局表，每块 insetT 显式定位，
// 规避深层 flex-col 堆叠怪癖；同时给 Select 弹层提供精确的屏幕锚点）+
// 页脚（固定：打开/关闭按钮 + 状态灯，不随内容滚动）。
// M1 只有串口可用；TCP/UDP/WS 与终端模式、MCP 共享置灰占位（文案走 i18n）。
import { computed, ref } from "vue";
import { Text, View } from "@pocketjs/framework/components";
import {
  Btn,
  CheckRow,
  Hairline,
  Scrollbar,
  SegCtrl,
  Select,
  StatusDot,
  TextField,
  closePopup,
  type PopupAnchor,
  type TextFieldHandle,
} from "./widgets";
import { theme, themeMode, type ThemeMode } from "./theme";
import { locale, t, type Locale } from "./i18n";
import { PANEL_FOOTER_H, PANEL_HEADER_H, PANEL_W, viewportSize } from "./layout";
import { onWheel } from "./wheel";
import { setActiveField } from "./fields";
import type { SerialOpenParams } from "../bridge/com";
import {
  closeConnection,
  comAvailable,
  connState,
  openConnection,
  ports,
  refreshPorts,
  session,
  sysMsg,
} from "./session";
import { applyLocale } from "./locale";

// ---------------------------------------------------------------------------
// 参数状态（打开时快照进 session.open）
// ---------------------------------------------------------------------------

const connType = ref("serial");
const portPath = ref("");
const baud = ref("115200");
const customBaudVisible = ref(false);
const customBaud = ref("115200");
const dataBits = ref("8");
const parity = ref("none");
const stopBits = ref("1");
const flowControl = ref("none");
const dtr = ref(false);
const rts = ref(false);

const BAUD_PRESETS = ["9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600"];
const DATA_BITS = ["5", "6", "7", "8"];

let customBaudField: TextFieldHandle | undefined;

/** 有效波特率字符串（自定义输入框的值打开连接时实时读取）。 */
function effectiveBaud(): string {
  if (customBaudVisible.value && customBaudField) {
    return customBaudField.text().trim() || customBaud.value;
  }
  return BAUD_PRESETS.includes(baud.value) ? baud.value : customBaud.value;
}

function stateColor(): string {
  switch (connState.value) {
    case "CONNECTED":
      return theme.value.stateConnected;
    case "CONNECTING":
      return theme.value.stateConnecting;
    case "LOST":
      return theme.value.stateLost;
    default:
      return theme.value.stateDisconnected;
  }
}

function tryOpen(): void {
  const path = portPath.value;
  if (path === "") {
    sysMsg(t("conn.noPortSelected"));
    return;
  }
  const baudText = effectiveBaud();
  const baudRate = Number.parseInt(baudText, 10);
  if (!/^\d+$/.test(baudText) || baudRate <= 0) {
    sysMsg(`${t("conn.baudInvalid")}: ${baudText}`);
    return;
  }
  const params: SerialOpenParams = {
    path,
    baudRate,
    dataBits: Number(dataBits.value) as 5 | 6 | 7 | 8,
    parity: parity.value as SerialOpenParams["parity"],
    stopBits: Number(stopBits.value) as 1 | 2,
    flowControl: flowControl.value as SerialOpenParams["flowControl"],
  };
  if (openConnection(params) && session) {
    session.setSignals({ dtr: dtr.value, rts: rts.value });
  }
}

function toggleOpen(): void {
  const s = connState.value;
  if (s === "CONNECTED") closeConnection();
  else if (s === "LOST") closeConnection(); // 确认掉线 → DISCONNECTED
  else if (s === "DISCONNECTED") tryOpen();
}

// ---------------------------------------------------------------------------
// 布局表（内容块 absolute 定位；块高固定，累计得内容总高与弹层锚点）
// ---------------------------------------------------------------------------

const PAD_X = 12;
const PAD_TOP = 10;
const PAD_BOTTOM = 10;
const LABEL_H = 16;
const LABEL_GAP = 4;
const CTL_H = 28;
const FIELD_H = LABEL_H + LABEL_GAP + CTL_H;
const BLOCK_GAP = 10;
const SECTION_GAP = 12;
const CHECK_H = 26;
const CUSTOM_H = 6 + CTL_H;
const PAIR_GAP = 8;

const CONTENT_W = PANEL_W - PAD_X * 2;
const PAIR_W = Math.floor((CONTENT_W - PAIR_GAP) / 2);

/** 内容块 id → 顶部偏移，以及内容总高（自定义波特率展开时伸缩）。 */
const layoutInfo = computed(() => {
  const top: Record<string, number> = {};
  let y = PAD_TOP;
  const put = (id: string, h: number, gapAfter: number): void => {
    top[id] = y;
    y += h + gapAfter;
  };
  put("connType", FIELD_H, BLOCK_GAP);
  put("port", FIELD_H, BLOCK_GAP);
  put("baud", FIELD_H + (customBaudVisible.value ? CUSTOM_H : 0), BLOCK_GAP);
  put("pair1", FIELD_H, BLOCK_GAP);
  put("pair2", FIELD_H, BLOCK_GAP);
  put("signals", CHECK_H, SECTION_GAP);
  put("div1", 1, SECTION_GAP);
  put("mode", FIELD_H, SECTION_GAP);
  put("div2", 1, SECTION_GAP);
  put("mcp", CHECK_H, SECTION_GAP);
  put("div3", 1, SECTION_GAP);
  put("language", FIELD_H, BLOCK_GAP);
  put("theme", FIELD_H, 0);
  return { top, total: y + PAD_BOTTOM };
});

export function LeftPanel() {
  const scroll = ref(0);

  const viewH = () => Math.max(0, viewportSize.value.h - PANEL_HEADER_H - 1 - PANEL_FOOTER_H);
  const maxScroll = () => Math.max(0, layoutInfo.value.total - viewH());

  onWheel("panel", (dy) => {
    closePopup(); // 滚动使锚点失效：先收弹层
    scroll.value = Math.max(0, Math.min(maxScroll(), scroll.value - dy));
  });

  /** 控制框屏幕锚点（弹层定位用）：面板从 (0,0) 开始，头部固定高。 */
  const anchor = (blockId: string, x: number, w: number): (() => PopupAnchor) => {
    return () => ({
      x,
      y: PANEL_HEADER_H + 1 + (layoutInfo.value.top[blockId] ?? 0) + LABEL_H + LABEL_GAP - scroll.value,
      w,
      h: CTL_H,
    });
  };

  const top = (id: string): number => layoutInfo.value.top[id] ?? 0;

  return (
    <View class="flex-col" style={{ width: PANEL_W, bgColor: theme.value.panelBg }}>
      {/* 头部：标题 */}
      <View class="relative" style={{ height: PANEL_HEADER_H }}>
        <Text
          class="absolute text-base font-bold"
          style={{ insetL: PAD_X, insetT: 8, height: 20, lineHeight: 20, textColor: theme.value.fg }}
        >
          {t("app.title")}
        </Text>
        <Text
          class="absolute text-xs"
          style={{ insetL: PAD_X, insetT: 28, height: 14, lineHeight: 14, textColor: theme.value.dim }}
        >
          {t("app.subtitle")}
        </Text>
      </View>
      <Hairline />

      {/* 内容滚动区 */}
      <View class="relative flex-1 overflow-hidden">
        <View
          class="absolute left-0 right-0"
          style={{ insetT: 0, height: layoutInfo.value.total, translateY: -scroll.value }}
        >
          {/* 连接类型 */}
          <View class="absolute" style={{ insetT: top("connType"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("conn.type")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <Select
                display={() => t("conn.serial")}
                options={() => [
                  { value: "serial", label: t("conn.serial") },
                  { value: "tcp", label: `${t("conn.tcpClient")} · ${t("roadmap.m2")}`, disabled: true },
                  { value: "tcps", label: `${t("conn.tcpServer")} · ${t("roadmap.m2")}`, disabled: true },
                  { value: "udp", label: `${t("conn.udp")} · ${t("roadmap.m2")}`, disabled: true },
                  { value: "ws", label: `${t("conn.wsClient")} · ${t("roadmap.m2")}`, disabled: true },
                ]}
                onPick={(v) => {
                  connType.value = v;
                }}
                anchor={anchor("connType", PAD_X, CONTENT_W)}
              />
            </View>
          </View>

          {/* 端口（label 行右侧内嵌刷新图标按钮；控制框只显示路径，描述留在弹层选项里） */}
          <View class="absolute" style={{ insetT: top("port"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("conn.port")} />
            <View
              class="absolute flex-row items-center justify-center"
              debugName="refreshPorts"
              style={{ insetR: 0, insetT: 0, width: 20, height: 16, bgColor: "#00000001" }}
              focusable
              onPress={() => {
                setActiveField(null);
                refreshPorts();
              }}
            >
              <Text class="text-xs" style={{ textColor: theme.value.dim, lineHeight: 16 }}>
                ⟳
              </Text>
            </View>
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <Select
                display={() => portPath.value}
                emptyText={() => t("conn.noPorts")}
                options={() =>
                  ports.value.map((p) => ({
                    value: p.path,
                    label: `${p.path}${p.description ? " — " + p.description : ""}`,
                  }))
                }
                onPick={(v) => {
                  portPath.value = v;
                }}
                disabled={() => !comAvailable}
                anchor={anchor("port", PAD_X, CONTENT_W)}
              />
            </View>
          </View>

          {/* 波特率（自定义展开输入框） */}
          <View
            class="absolute"
            style={{
              insetT: top("baud"),
              insetL: PAD_X,
              width: CONTENT_W,
              height: FIELD_H + (customBaudVisible.value ? CUSTOM_H : 0),
            }}
          >
            <FieldLabel text={() => t("conn.baudRate")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <Select
                display={() => effectiveBaud()}
                value={() => (customBaudVisible.value ? "__custom__" : baud.value)}
                options={() => [
                  ...BAUD_PRESETS.map((b) => ({ value: b, label: b })),
                  { value: "__custom__", label: t("conn.custom") },
                ]}
                onPick={(v) => {
                  if (v === "__custom__") {
                    customBaudVisible.value = true;
                  } else {
                    baud.value = v;
                    customBaudVisible.value = false;
                  }
                }}
                anchor={anchor("baud", PAD_X, CONTENT_W)}
              />
            </View>
            {customBaudVisible.value ? (
              <View class="absolute left-0 right-0" style={{ insetT: FIELD_H + 6, height: CTL_H }}>
                <TextField
                  initial={customBaud.value}
                  onHandle={(h) => {
                    customBaudField = h;
                    h.focus(); // 选"自定义…"后直接可输入
                  }}
                  onEnter={(h) => {
                    customBaud.value = h.text().trim() || "115200";
                  }}
                />
              </View>
            ) : null}
          </View>

          {/* 数据位 | 校验 */}
          <View class="absolute" style={{ insetT: top("pair1"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <View class="absolute" style={{ insetL: 0, insetT: 0, width: PAIR_W, height: FIELD_H }}>
              <FieldLabel text={() => t("conn.dataBits")} />
              <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
                <Select
                  display={() => dataBits.value}
                  value={() => dataBits.value}
                  options={() => DATA_BITS.map((b) => ({ value: b, label: b }))}
                  onPick={(v) => {
                    dataBits.value = v;
                  }}
                  anchor={anchor("pair1", PAD_X, PAIR_W)}
                />
              </View>
            </View>
            <View class="absolute" style={{ insetL: PAIR_W + PAIR_GAP, insetT: 0, width: PAIR_W, height: FIELD_H }}>
              <FieldLabel text={() => t("conn.parity")} />
              <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
                <Select
                  display={() => t(`conn.parityOpt.${parity.value}`)}
                  value={() => parity.value}
                  options={() => [
                    { value: "none", label: t("conn.parityOpt.none") },
                    { value: "odd", label: t("conn.parityOpt.odd") },
                    { value: "even", label: t("conn.parityOpt.even") },
                    { value: "mark", label: `${t("conn.parityOpt.mark")} · ${t("conn.unsupported")}`, disabled: true },
                    { value: "space", label: `${t("conn.parityOpt.space")} · ${t("conn.unsupported")}`, disabled: true },
                  ]}
                  onPick={(v) => {
                    parity.value = v;
                  }}
                  anchor={anchor("pair1", PAD_X + PAIR_W + PAIR_GAP, PAIR_W)}
                />
              </View>
            </View>
          </View>

          {/* 停止位 | 流控 */}
          <View class="absolute" style={{ insetT: top("pair2"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <View class="absolute" style={{ insetL: 0, insetT: 0, width: PAIR_W, height: FIELD_H }}>
              <FieldLabel text={() => t("conn.stopBits")} />
              <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
                <Select
                  display={() => t(`conn.stopBitsOpt.${stopBits.value}`)}
                  value={() => stopBits.value}
                  options={() => [
                    { value: "1", label: t("conn.stopBitsOpt.1") },
                    { value: "1.5", label: `${t("conn.stopBitsOpt.15")} · ${t("conn.unsupported")}`, disabled: true },
                    { value: "2", label: t("conn.stopBitsOpt.2") },
                  ]}
                  onPick={(v) => {
                    stopBits.value = v;
                  }}
                  anchor={anchor("pair2", PAD_X, PAIR_W)}
                />
              </View>
            </View>
            <View class="absolute" style={{ insetL: PAIR_W + PAIR_GAP, insetT: 0, width: PAIR_W, height: FIELD_H }}>
              <FieldLabel text={() => t("conn.flowControl")} />
              <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
                <Select
                  display={() => t(`conn.flow.${flowControl.value}`)}
                  value={() => flowControl.value}
                  options={() => [
                    { value: "none", label: t("conn.flow.none") },
                    { value: "xonxoff", label: t("conn.flow.xonxoff") },
                    { value: "rtscts", label: t("conn.flow.rtscts") },
                    { value: "dsrdtr", label: t("conn.flow.dsrdtr") },
                  ]}
                  onPick={(v) => {
                    flowControl.value = v;
                  }}
                  anchor={anchor("pair2", PAD_X + PAIR_W + PAIR_GAP, PAIR_W)}
                />
              </View>
            </View>
          </View>

          {/* DTR / RTS */}
          <View
            class="absolute flex-row items-center gap-3"
            style={{ insetT: top("signals"), insetL: PAD_X, width: CONTENT_W, height: CHECK_H }}
          >
            <CheckRow
              label={() => t("conn.dtr")}
              checked={() => dtr.value}
              onToggle={() => {
                dtr.value = !dtr.value;
                session?.setSignals({ dtr: dtr.value, rts: rts.value });
              }}
            />
            <CheckRow
              label={() => t("conn.rts")}
              checked={() => rts.value}
              onToggle={() => {
                rts.value = !rts.value;
                session?.setSignals({ dtr: dtr.value, rts: rts.value });
              }}
            />
          </View>

          {/* 分隔线 */}
          <View class="absolute" style={{ insetT: top("div1"), insetL: PAD_X, width: CONTENT_W, height: 1 }}>
            <Hairline />
          </View>

          {/* 模式开关（终端 M3 置灰） */}
          <View class="absolute" style={{ insetT: top("mode"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("panel.mode")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <SegCtrl
                options={[
                  { value: "transfer", label: t("mode.transfer") },
                  { value: "terminal", label: `${t("mode.terminal")} · ${t("roadmap.m3")}`, disabled: true },
                ]}
                value={() => "transfer"}
                onPick={() => {
                  /* M1 固定收发模式 */
                }}
              />
            </View>
          </View>

          {/* 分隔线 */}
          <View class="absolute" style={{ insetT: top("div2"), insetL: PAD_X, width: CONTENT_W, height: 1 }}>
            <Hairline />
          </View>

          {/* MCP 共享开关（M4 置灰占位） */}
          <View class="absolute" style={{ insetT: top("mcp"), insetL: PAD_X, width: CONTENT_W, height: CHECK_H }}>
            <CheckRow
              label={() => `${t("mcp.toggle")} · ${t("roadmap.m4")}`}
              checked={() => false}
              disabled={() => true}
              onToggle={() => {
                /* M4 */
              }}
            />
          </View>

          {/* 分隔线 */}
          <View class="absolute" style={{ insetT: top("div3"), insetL: PAD_X, width: CONTENT_W, height: 1 }}>
            <Hairline />
          </View>

          {/* 语言 */}
          <View class="absolute" style={{ insetT: top("language"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("settings.language")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <Select
                display={() => t(`settings.langName.${locale.value}`)}
                value={() => locale.value}
                options={() => [
                  { value: "zh-CN", label: t("settings.langName.zh-CN") },
                  { value: "en", label: t("settings.langName.en") },
                ]}
                onPick={(v) => {
                  applyLocale(v as Locale);
                }}
                anchor={anchor("language", PAD_X, CONTENT_W)}
              />
            </View>
          </View>

          {/* 主题（跟随系统暂无宿主通道，按深色处理） */}
          <View class="absolute" style={{ insetT: top("theme"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("settings.theme")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <Select
                display={() =>
                  themeMode.value === "light"
                    ? t("settings.themeLight")
                    : themeMode.value === "system"
                      ? t("settings.themeSystem")
                      : t("settings.themeDark")
                }
                value={() => themeMode.value}
                options={() => [
                  { value: "light", label: t("settings.themeLight") },
                  { value: "dark", label: t("settings.themeDark") },
                  { value: "system", label: `${t("settings.themeSystem")} · ${t("roadmap.m2")}`, disabled: true },
                ]}
                onPick={(v) => {
                  themeMode.value = v as ThemeMode;
                }}
                anchor={anchor("theme", PAD_X, CONTENT_W)}
              />
            </View>
          </View>
        </View>
        <Scrollbar scroll={() => scroll.value} total={() => layoutInfo.value.total} viewH={viewH} />
      </View>
      <Hairline />

      {/* 页脚（固定）：打开/关闭 + 状态灯 */}
      <View class="relative" style={{ height: PANEL_FOOTER_H - 1 }}>
        <View class="absolute" style={{ insetL: PAD_X, insetR: PAD_X, insetT: 10, height: 30 }}>
          <Btn
            width={CONTENT_W}
            height={30}
            accent={() => connState.value !== "CONNECTED"}
            label={() =>
              connState.value === "CONNECTED"
                ? t("conn.close")
                : connState.value === "LOST"
                  ? t("conn.ackLost")
                  : t("conn.open")
            }
            disabled={() => !comAvailable || connState.value === "CONNECTING"}
            onPress={toggleOpen}
          />
        </View>
        <View class="absolute flex-row items-center gap-2" style={{ insetL: PAD_X, insetT: 48, height: 16 }}>
          <StatusDot color={stateColor} size={8} />
          <Text class="text-xs" style={{ textColor: stateColor(), lineHeight: 16 }}>
            {t(`conn.status.${connState.value.toLowerCase()}`)}
          </Text>
        </View>
      </View>
    </View>
  );
}

function FieldLabel(props: { text: () => string }) {
  return (
    <Text
      class="absolute text-xs"
      style={{ insetL: 0, insetT: 0, height: LABEL_H, lineHeight: LABEL_H, textColor: theme.value.dim }}
    >
      {props.text()}
    </Text>
  );
}
