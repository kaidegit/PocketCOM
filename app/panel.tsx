// app/panel.tsx — 左侧连接配置面板（SPEC §3.1/§3.2），M2 重写版。
// 布局：头部（固定）+ 内容滚动区（absolute 布局表，每块 insetT 显式定位，
// 规避深层 flex-col 堆叠怪癖；同时给 Select 弹层提供精确的屏幕锚点）+
// 页脚（固定：打开/关闭按钮 + 状态灯，不随内容滚动）。
// 连接类型四类 + 串口全参数；布局表随 connType/客户端数/字段显隐动态伸缩。
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
  type SelRect,
  type TextFieldHandle,
} from "./widgets";
import { theme, themeMode, type ThemeMode } from "./theme";
import { locale, t, type Locale } from "./i18n";
import { PANEL_FOOTER_H, PANEL_HEADER_H, PANEL_W, viewportSize } from "./layout";
import { onWheel } from "./wheel";
import { setActiveField } from "./fields";
import {
  applyLogFormat,
  baud,
  clientList,
  closeConnection,
  connState,
  connType,
  dataBits,
  dtr,
  exportConfig,
  fontSize,
  flowControl,
  importConfig,
  kickClient,
  mcpEnabled,
  mcpState,
  mcpToken,
  mcpUrl,
  openCurrentConnection,
  parity,
  portPath,
  ports,
  refreshPorts,
  rts,
  scrollbackLines,
  session,
  setConnType,
  setScrollbackLines,
  setUiMode,
  stopBits,
  tcpAutoReconnect,
  tcpHost,
  tcpPort,
  tcpReconnectSec,
  tcpsPort,
  uiMode,
  udpBindPort,
  udpHost,
  udpPort,
  wsAutoReconnect,
  wsReconnectSec,
  wsUrl,
  comAvailable,
} from "./session";
import { applyLocale } from "./locale";
import { getSvc } from "./svc";

// ---------------------------------------------------------------------------
// 参数状态（串口波特率自定义输入框是面板局部 UI 状态）
// ---------------------------------------------------------------------------

const BAUD_PRESETS = ["9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600"];
const DATA_BITS = ["5", "6", "7", "8"];

const customBaudVisible = ref(false);
const customBaud = ref("115200");
let customBaudField: TextFieldHandle | undefined;

// MCP URL/token 复制反馈（M4）：1.5s 后恢复按钮文案。
const copiedKey = ref<"url" | "token" | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function copyMcp(key: "url" | "token", text: string): void {
  if (text === "") return;
  getSvc()?.send({ t: "copy", text });
  copiedKey.value = key;
  if (copyTimer !== null) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copiedKey.value = null;
  }, 1500);
}

/** token 展示（截断；未生成时为空）。 */
function tokenDisplay(): string {
  const tok = mcpToken.value;
  if (tok === "") return "—";
  return `${tok.slice(0, 12)}…${tok.slice(-4)}`;
}

/** 文本字段句柄注册表：打开连接前把未提交的输入 flush 进 session 仓库。 */
const fieldHandles = new Map<string, TextFieldHandle>();
function bindField(key: string, target: { value: string }): {
  onHandle: (h: TextFieldHandle) => void;
  onEnter: (h: TextFieldHandle) => void;
} {
  return {
    onHandle: (h) => {
      fieldHandles.set(key, h);
    },
    onEnter: (h) => {
      target.value = h.text();
    },
  };
}

function flushFields(): void {
  for (const [key, h] of fieldHandles) {
    const text = h.text();
    switch (key) {
      case "tcpHost":
        tcpHost.value = text;
        break;
      case "tcpPort":
        tcpPort.value = text;
        break;
      case "tcpReconnectSec":
        tcpReconnectSec.value = text;
        break;
      case "tcpsPort":
        tcpsPort.value = text;
        break;
      case "udpBindPort":
        udpBindPort.value = text;
        break;
      case "udpHost":
        udpHost.value = text;
        break;
      case "udpPort":
        udpPort.value = text;
        break;
      case "wsUrl":
        wsUrl.value = text;
        break;
      case "wsProtocols":
        wsProtocols.value = text;
        break;
      case "wsReconnectSec":
        wsReconnectSec.value = text;
        break;
    }
  }
}

export const wsProtocols = ref("");

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
  flushFields();
  if (customBaudVisible.value && customBaudField) {
    baud.value = customBaudField.text().trim() || "115200";
  }
  openCurrentConnection();
}

function toggleOpen(): void {
  const s = connState.value;
  if (s === "CONNECTED" || s === "LOST" || s === "CONNECTING") closeConnection();
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
const CLIENT_ROW_H = 24;

const CONTENT_W = PANEL_W - PAD_X * 2;
const PAIR_W = Math.floor((CONTENT_W - PAIR_GAP) / 2);

/** 面板内容滚动偏移（模块级：文本框选区命中区也要读）。 */
const panelScroll = ref(0);

/** 文本框拖动选区命中区（屏幕绝对坐标）：控件顶 = 面板内容坐标 ctlTop，
 *  随面板滚动平移。x/w 为相对面板的偏移与宽（配对字段各占半宽）。 */
function ctlRegion(ctlTop: number, xOff = 0, w = CONTENT_W): () => SelRect | null {
  return () => ({
    x: PAD_X + xOff,
    y: PANEL_HEADER_H + 1 + ctlTop - panelScroll.value,
    w,
    h: CTL_H,
  });
}

/** label + 控件的标准字段块：控件顶 = 块顶 + LABEL_H + LABEL_GAP。 */
function fieldRegion(blockTop: number, xOff = 0, w = CONTENT_W): () => SelRect | null {
  return ctlRegion(blockTop + LABEL_H + LABEL_GAP, xOff, w);
}

const isSerial = computed(() => connType.value === "serial");
const withReconnect = computed(
  () =>
    (connType.value === "tcp" && tcpAutoReconnect.value) ||
    (connType.value === "ws" && wsAutoReconnect.value),
);

/** 内容块 id → 顶部偏移，以及内容总高（随 connType/客户端列表/字段显隐伸缩）。 */
const layoutInfo = computed(() => {
  const top: Record<string, number> = {};
  let y = PAD_TOP;
  const put = (id: string, h: number, gapAfter: number): void => {
    top[id] = y;
    y += h + gapAfter;
  };
  put("connType", FIELD_H, BLOCK_GAP);
  if (isSerial.value) {
    put("port", FIELD_H, BLOCK_GAP);
    put("baud", FIELD_H + (customBaudVisible.value ? CUSTOM_H : 0), BLOCK_GAP);
    put("pair1", FIELD_H, BLOCK_GAP);
    put("pair2", FIELD_H, BLOCK_GAP);
    put("signals", CHECK_H, SECTION_GAP);
  } else if (connType.value === "tcp") {
    put("tcpHost", FIELD_H, BLOCK_GAP);
    put("tcpPort", FIELD_H, SECTION_GAP);
    put("tcpReconnect", CHECK_H, withReconnect.value ? 0 : SECTION_GAP);
  } else if (connType.value === "tcps") {
    put("tcpsPort", FIELD_H, SECTION_GAP);
    if (clientList.value.length > 0) {
      put("clients", clientList.value.length * CLIENT_ROW_H, SECTION_GAP);
    }
  } else if (connType.value === "udp") {
    put("udpHost", FIELD_H, BLOCK_GAP);
    put("udpPair", FIELD_H, SECTION_GAP);
  } else if (connType.value === "ws") {
    put("wsUrl", FIELD_H, BLOCK_GAP);
    put("wsProtocols", FIELD_H, BLOCK_GAP);
    put("wsReconnect", CHECK_H, withReconnect.value ? 0 : SECTION_GAP);
  } else if (connType.value === "loopback") {
    // 回环：无参数块，直接落到下方通用设置区
  }
  if (withReconnect.value) {
    put("reconnectSec", CUSTOM_H, SECTION_GAP);
  }
  put("div1", 1, SECTION_GAP);
  put("mode", FIELD_H, SECTION_GAP);
  put("div2", 1, SECTION_GAP);
  put("mcp", CHECK_H, mcpEnabled.value ? BLOCK_GAP : SECTION_GAP);
  if (mcpEnabled.value) {
    put("mcpUrl", FIELD_H, BLOCK_GAP);
    put("mcpToken", FIELD_H, uiMode.value === "terminal" ? BLOCK_GAP : SECTION_GAP);
    if (uiMode.value === "terminal") {
      put("mcpHint", 16, SECTION_GAP);
    }
  }
  put("div3", 1, SECTION_GAP);
  put("language", FIELD_H, BLOCK_GAP);
  put("theme", FIELD_H, BLOCK_GAP);
  put("fontSize", FIELD_H, BLOCK_GAP);
  put("scrollback", FIELD_H, BLOCK_GAP);
  put("cfgBtns", 30, 0);
  return { top, total: y + PAD_BOTTOM };
});

export function LeftPanel() {
  const viewH = () => Math.max(0, viewportSize.value.h - PANEL_HEADER_H - 1 - PANEL_FOOTER_H);
  const maxScroll = () => Math.max(0, layoutInfo.value.total - viewH());

  onWheel("panel", (dy) => {
    closePopup(); // 滚动使锚点失效：先收弹层
    panelScroll.value = Math.max(0, Math.min(maxScroll(), panelScroll.value - dy));
  });

  /** 控制框屏幕锚点（弹层定位用）：面板从 (0,0) 开始，头部固定高。 */
  const anchor = (blockId: string, x: number, w: number, ctlH = CTL_H): (() => PopupAnchor) => {
    return () => ({
      x,
      y: PANEL_HEADER_H + 1 + (layoutInfo.value.top[blockId] ?? 0) + LABEL_H + LABEL_GAP - panelScroll.value,
      w,
      h: ctlH,
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
          style={{ insetT: 0, height: layoutInfo.value.total, translateY: -panelScroll.value }}
        >
          {/* 连接类型 */}
          <View class="absolute" style={{ insetT: top("connType"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("conn.type")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <Select
                display={() => {
                  const k = connType.value;
                  const key = k === "tcp" ? "tcpClient" : k === "tcps" ? "tcpServer" : k === "ws" ? "wsClient" : k;
                  return t(`conn.${key}`);
                }}
                value={() => connType.value}
                options={() => [
                  { value: "serial", label: t("conn.serial") },
                  { value: "tcp", label: t("conn.tcpClient") },
                  { value: "tcps", label: t("conn.tcpServer") },
                  { value: "udp", label: t("conn.udp") },
                  { value: "ws", label: t("conn.wsClient") },
                  { value: "loopback", label: t("conn.loopback") },
                ]}
                onPick={(v) => {
                  closePopup();
                  setConnType(v as typeof connType.value);
                }}
                anchor={anchor("connType", PAD_X, CONTENT_W)}
              />
            </View>
          </View>

          {/* ---- 串口参数 ---- */}
          {isSerial.value ? (
            <SerialBlocks
              top={top}
              anchor={anchor}
              customBaudVisible={customBaudVisible}
              customBaud={customBaud}
              setCustomBaudField={(h) => {
                customBaudField = h;
              }}
              readCustomBaud={() => customBaudField?.text().trim() || ""}
            />
          ) : null}

          {/* ---- TCP Client ---- */}
          {connType.value === "tcp" ? (
            <View>
              {fieldBlock(
                top("tcpHost"),
                () => t("conn.host"),
                <TextField
                  initial={tcpHost.value}
                  placeholder={() => "127.0.0.1"}
                  selRegion={fieldRegion(top("tcpHost"))}
                  {...bindField("tcpHost", tcpHost)}
                />,
              )}
              {fieldBlock(
                top("tcpPort"),
                () => t("conn.remotePort"),
                <TextField initial={tcpPort.value} selRegion={fieldRegion(top("tcpPort"))} {...bindField("tcpPort", tcpPort)} />,
              )}
              <View
                class="absolute"
                style={{ insetT: top("tcpReconnect"), insetL: PAD_X, width: CONTENT_W, height: CHECK_H }}
              >
                <CheckRow
                  label={() => t("conn.autoReconnect")}
                  checked={() => tcpAutoReconnect.value}
                  onToggle={() => {
                    tcpAutoReconnect.value = !tcpAutoReconnect.value;
                  }}
                />
              </View>
            </View>
          ) : null}

          {/* ---- TCP Server ---- */}
          {connType.value === "tcps" ? (
            <View>
              {fieldBlock(
                top("tcpsPort"),
                () => t("conn.listenPort"),
                <TextField initial={tcpsPort.value} selRegion={fieldRegion(top("tcpsPort"))} {...bindField("tcpsPort", tcpsPort)} />,
              )}
              {clientList.value.length > 0 ? (
                <View
                  class="absolute"
                  style={{ insetT: top("clients"), insetL: PAD_X, width: CONTENT_W, height: clientList.value.length * CLIENT_ROW_H }}
                >
                  {clientList.value.map((c, i) => (
                    <View
                      class="absolute flex-row items-center gap-2"
                      style={{ insetT: i * CLIENT_ROW_H, width: CONTENT_W, height: CLIENT_ROW_H }}
                    >
                      <Text class="flex-1 text-xs font-mono" style={{ textColor: theme.value.fg }}>
                        {c.addr}
                      </Text>
                      <View style={{ width: 52, height: 20 }}>
                        <Btn
                          width={52}
                          height={20}
                          label={() => t("conn.kick")}
                          onPress={() => kickClient(c.handle)}
                        />
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          {/* ---- UDP ---- */}
          {connType.value === "udp" ? (
            <View>
              {fieldBlock(
                top("udpHost"),
                () => t("conn.targetHost"),
                <TextField
                  initial={udpHost.value}
                  placeholder={() => "127.0.0.1"}
                  selRegion={fieldRegion(top("udpHost"))}
                  {...bindField("udpHost", udpHost)}
                />,
              )}
              <View class="absolute" style={{ insetT: top("udpPair"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
                <View class="absolute" style={{ insetL: 0, insetT: 0, width: PAIR_W, height: FIELD_H }}>
                  <FieldLabel text={() => t("conn.localPort")} />
                  <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
                    <TextField
                      initial={udpBindPort.value}
                      selRegion={fieldRegion(top("udpPair"), 0, PAIR_W)}
                      {...bindField("udpBindPort", udpBindPort)}
                    />
                  </View>
                </View>
                <View class="absolute" style={{ insetL: PAIR_W + PAIR_GAP, insetT: 0, width: PAIR_W, height: FIELD_H }}>
                  <FieldLabel text={() => t("conn.remotePort")} />
                  <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
                    <TextField
                      initial={udpPort.value}
                      selRegion={fieldRegion(top("udpPair"), PAIR_W + PAIR_GAP, PAIR_W)}
                      {...bindField("udpPort", udpPort)}
                    />
                  </View>
                </View>
              </View>
            </View>
          ) : null}

          {/* ---- WebSocket Client ---- */}
          {connType.value === "ws" ? (
            <View>
              {fieldBlock(
                top("wsUrl"),
                () => t("conn.wsUrl"),
                <TextField
                  initial={wsUrl.value}
                  placeholder={() => "ws://127.0.0.1:8080"}
                  selRegion={fieldRegion(top("wsUrl"))}
                  {...bindField("wsUrl", wsUrl)}
                />,
              )}
              {fieldBlock(
                top("wsProtocols"),
                () => t("conn.wsProtocols"),
                <TextField initial={wsProtocols.value} selRegion={fieldRegion(top("wsProtocols"))} {...bindField("wsProtocols", wsProtocols)} />,
              )}
              <View
                class="absolute"
                style={{ insetT: top("wsReconnect"), insetL: PAD_X, width: CONTENT_W, height: CHECK_H }}
              >
                <CheckRow
                  label={() => t("conn.autoReconnect")}
                  checked={() => wsAutoReconnect.value}
                  onToggle={() => {
                    wsAutoReconnect.value = !wsAutoReconnect.value;
                  }}
                />
              </View>
            </View>
          ) : null}

          {/* 重连间隔（tcp/ws 勾选自动重连后展开） */}
          {withReconnect.value ? (
            <View
              class="absolute"
              style={{ insetT: top("reconnectSec"), insetL: PAD_X, width: CONTENT_W, height: CUSTOM_H }}
            >
              <View class="absolute left-0 right-0" style={{ insetT: 6, height: CTL_H }}>
                <TextField
                  initial={connType.value === "tcp" ? tcpReconnectSec.value : wsReconnectSec.value}
                  selRegion={ctlRegion(top("reconnectSec") + 6)}
                  {...(connType.value === "tcp"
                    ? bindField("tcpReconnectSec", tcpReconnectSec)
                    : bindField("wsReconnectSec", wsReconnectSec))}
                />
              </View>
            </View>
          ) : null}

          {/* 分隔线 */}
          <View class="absolute" style={{ insetT: top("div1"), insetL: PAD_X, width: CONTENT_W, height: 1 }}>
            <Hairline />
          </View>

          {/* 模式开关（收发 / 终端，M3；切换不断开连接） */}
          <View class="absolute" style={{ insetT: top("mode"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("panel.mode")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <SegCtrl
                options={[
                  { value: "transfer", label: t("mode.transfer") },
                  { value: "terminal", label: t("mode.terminal") },
                ]}
                value={() => uiMode.value}
                onPick={(v) => {
                  if (v === "terminal" || v === "transfer") {
                    setActiveField(null);
                    setUiMode(v);
                  }
                }}
              />
            </View>
          </View>

          {/* 分隔线 */}
          <View class="absolute" style={{ insetT: top("div2"), insetL: PAD_X, width: CONTENT_W, height: 1 }}>
            <Hairline />
          </View>

          {/* MCP 共享开关（M4，SPEC §6.1）：仅收发模式运行，终端模式自动停服 */}
          <View class="absolute" style={{ insetT: top("mcp"), insetL: PAD_X, width: CONTENT_W, height: CHECK_H }}>
            <CheckRow
              label={() => t("mcp.toggle")}
              checked={() => mcpEnabled.value}
              disabled={() => !comAvailable}
              onToggle={() => {
                mcpEnabled.value = !mcpEnabled.value;
              }}
            />
          </View>

          {/* 开启后：URL + token（可复制，SPEC §6.1） */}
          {mcpEnabled.value ? (
            <View>
              <McpInfoRow top={top("mcpUrl")} label={() => t("mcp.url")} value={mcpUrl} copyKey="url" />
              <McpInfoRow top={top("mcpToken")} label={() => t("mcp.token")} value={tokenDisplay} copyKey="token" />
              {uiMode.value === "terminal" ? (
                <View
                  class="absolute"
                  style={{ insetT: top("mcpHint"), insetL: PAD_X, width: CONTENT_W, height: 16 }}
                >
                  <Text class="text-xs" style={{ textColor: theme.value.dim, lineHeight: 16 }}>
                    {t("mcp.terminalHint")}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

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

          {/* 主题（三态，跟随系统经宿主 appearance 事件） */}
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
                  { value: "system", label: t("settings.themeSystem") },
                ]}
                onPick={(v) => {
                  themeMode.value = v as ThemeMode;
                }}
                anchor={anchor("theme", PAD_X, CONTENT_W)}
              />
            </View>
          </View>

          {/* 字号（收发区 mono 字号，三档） */}
          <View class="absolute" style={{ insetT: top("fontSize"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("settings.fontSize")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <Select
                display={() =>
                  fontSize.value === 12
                    ? t("settings.fontSizeSmall")
                    : fontSize.value === 16
                      ? t("settings.fontSizeLarge")
                      : t("settings.fontSizeMedium")
                }
                value={() => String(fontSize.value)}
                options={() => [
                  { value: "12", label: t("settings.fontSizeSmall") },
                  { value: "14", label: t("settings.fontSizeMedium") },
                  { value: "16", label: t("settings.fontSizeLarge") },
                ]}
                onPick={(v) => {
                  fontSize.value = Number(v) as 12 | 14 | 16;
                  applyLogFormat();
                }}
                anchor={anchor("fontSize", PAD_X, CONTENT_W)}
              />
            </View>
          </View>

          {/* 终端回滚行数（0–100000，修改即时生效，SPEC §3.4） */}
          <View class="absolute" style={{ insetT: top("scrollback"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
            <FieldLabel text={() => t("settings.scrollbackLines")} />
            <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
              <TextField
                initial={String(scrollbackLines.value)}
                selRegion={fieldRegion(top("scrollback"))}
                onEnter={(h) => {
                  const n = Number.parseInt(h.text().trim(), 10);
                  setScrollbackLines(Number.isFinite(n) ? n : 9999);
                }}
              />
            </View>
          </View>

          {/* 配置导出 / 导入 */}
          <View class="absolute flex-row gap-2" style={{ insetT: top("cfgBtns"), insetL: PAD_X, width: CONTENT_W, height: 30 }}>
            <View class="flex-1" style={{ height: 30 }}>
              <Btn width={PAIR_W} height={30} label={() => t("settings.export")} onPress={exportConfig} />
            </View>
            <View style={{ width: PAIR_W, height: 30 }}>
              <Btn width={PAIR_W} height={30} label={() => t("settings.import")} onPress={importConfig} />
            </View>
          </View>
        </View>
        <Scrollbar scroll={() => panelScroll.value} total={() => layoutInfo.value.total} viewH={viewH} />
      </View>
      <Hairline />

      {/* 页脚（固定）：打开/关闭 + 状态灯 */}
      <View class="relative" style={{ height: PANEL_FOOTER_H - 1 }}>
        <View class="absolute" style={{ insetL: PAD_X, insetR: PAD_X, insetT: 10, height: 30 }}>
          <Btn
            width={CONTENT_W}
            height={30}
            accent={() => connState.value !== "CONNECTED" && connState.value !== "CONNECTING"}
            label={() =>
              connState.value === "CONNECTED"
                ? t("conn.close")
                : connState.value === "LOST"
                  ? t("conn.ackLost")
                  : connState.value === "CONNECTING"
                    ? t("conn.cancel")
                    : t("conn.open")
            }
            disabled={() => !comAvailable}
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

/** 串口参数块（port/baud/pairs/signals），布局 id 与主布局表一致。 */
function SerialBlocks(props: {
  top: (id: string) => number;
  anchor: (blockId: string, x: number, w: number) => () => PopupAnchor;
  customBaudVisible: typeof customBaudVisible;
  customBaud: typeof customBaud;
  setCustomBaudField: (h: TextFieldHandle | undefined) => void;
  readCustomBaud: () => string;
}) {
  const effectiveBaud = (): string => {
    if (props.customBaudVisible.value) {
      return props.readCustomBaud() || props.customBaud.value;
    }
    return BAUD_PRESETS.includes(baud.value) ? baud.value : props.customBaud.value;
  };
  return (
    <View>
      {/* 端口（展开选择器时自动刷新，无独立刷新按钮） */}
      <View class="absolute" style={{ insetT: props.top("port"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
        <FieldLabel text={() => t("conn.port")} />
        <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
          <Select
            display={() => portPath.value}
            emptyText={() => (ports.value.length === 0 ? t("conn.noPorts") : t("conn.noPortSelected"))}
            options={() =>
              ports.value.map((p) => ({
                value: p.path,
                label: `${p.path}${p.description ? " — " + p.description : ""}`,
              }))
            }
            onPick={(v) => {
              portPath.value = v;
            }}
            onOpen={refreshPorts}
            disabled={() => !comAvailable}
            anchor={props.anchor("port", PAD_X, CONTENT_W)}
          />
        </View>
      </View>

      {/* 波特率（自定义展开输入框） */}
      <View
        class="absolute"
        style={{
          insetT: props.top("baud"),
          insetL: PAD_X,
          width: CONTENT_W,
          height: FIELD_H + (props.customBaudVisible.value ? CUSTOM_H : 0),
        }}
      >
        <FieldLabel text={() => t("conn.baudRate")} />
        <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
          <Select
            display={() => effectiveBaud()}
            value={() => (props.customBaudVisible.value ? "__custom__" : baud.value)}
            options={() => [
              ...BAUD_PRESETS.map((b) => ({ value: b, label: b })),
              { value: "__custom__", label: t("conn.custom") },
            ]}
            onPick={(v) => {
              if (v === "__custom__") {
                props.customBaudVisible.value = true;
              } else {
                baud.value = v;
                props.customBaudVisible.value = false;
              }
            }}
            anchor={props.anchor("baud", PAD_X, CONTENT_W)}
          />
        </View>
        {props.customBaudVisible.value ? (
          <View class="absolute left-0 right-0" style={{ insetT: FIELD_H + 6, height: CTL_H }}>
            <TextField
              initial={props.customBaud.value}
              selRegion={ctlRegion(props.top("baud") + FIELD_H + 6)}
              onHandle={(h) => {
                props.setCustomBaudField(h);
                h.focus(); // 选"自定义…"后直接可输入
              }}
              onEnter={(h) => {
                props.customBaud.value = h.text().trim() || "115200";
              }}
            />
          </View>
        ) : null}
      </View>

      {/* 数据位 | 校验 */}
      <View class="absolute" style={{ insetT: props.top("pair1"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
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
              anchor={props.anchor("pair1", PAD_X, PAIR_W)}
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
              anchor={props.anchor("pair1", PAD_X + PAIR_W + PAIR_GAP, PAIR_W)}
            />
          </View>
        </View>
      </View>

      {/* 停止位 | 流控 */}
      <View class="absolute" style={{ insetT: props.top("pair2"), insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
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
              anchor={props.anchor("pair2", PAD_X, PAIR_W)}
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
              anchor={props.anchor("pair2", PAD_X + PAIR_W + PAIR_GAP, PAIR_W)}
            />
          </View>
        </View>
      </View>

      {/* DTR / RTS */}
      <View
        class="absolute flex-row items-center gap-3"
        style={{ insetT: props.top("signals"), insetL: PAD_X, width: CONTENT_W, height: CHECK_H }}
      >
        <CheckRow
          label={() => t("conn.dtr")}
          checked={() => dtr.value}
          onToggle={() => {
            dtr.value = !dtr.value;
            applySignals();
          }}
        />
        <CheckRow
          label={() => t("conn.rts")}
          checked={() => rts.value}
          onToggle={() => {
            rts.value = !rts.value;
            applySignals();
          }}
        />
      </View>
    </View>
  );
}

/** 通用字段块：label + 控件区。以表达式调用内联（Vue JSX 的组件 children
 *  走 slot 通道，这里必须传渲染结果而非 JSX 子节点）。 */
function fieldBlock(top: number, label: () => string, control: ReturnType<typeof Text>) {
  return (
    <View class="absolute" style={{ insetT: top, insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
      <FieldLabel text={label} />
      <View class="absolute left-0 right-0" style={{ insetT: LABEL_H + LABEL_GAP, height: CTL_H }}>
        {control}
      </View>
    </View>
  );
}

/** MCP URL/token 信息行：label + mono 值 + 复制按钮（M4，SPEC §6.1）。 */
function McpInfoRow(props: {
  top: number;
  label: () => string;
  value: () => string;
  copyKey: "url" | "token";
}) {
  return (
    <View class="absolute" style={{ insetT: props.top, insetL: PAD_X, width: CONTENT_W, height: FIELD_H }}>
      <FieldLabel text={props.label} />
      <Text
        class="absolute text-xs font-mono"
        style={{ insetL: 0, insetT: LABEL_H + LABEL_GAP, width: CONTENT_W - 60, height: 22, lineHeight: 22, textColor: theme.value.fg }}
      >
        {props.value()}
      </Text>
      <View class="absolute" style={{ insetR: 0, insetT: LABEL_H + LABEL_GAP, width: 52, height: 22 }}>
        <Btn
          width={52}
          height={22}
          label={() => (copiedKey.value === props.copyKey ? t("mcp.copied") : t("mcp.copy"))}
          onPress={() => {
            copyMcp(props.copyKey, props.copyKey === "url" ? mcpUrl() : mcpToken.value);
          }}
        />
      </View>
    </View>
  );
}

function applySignals(): void {
  session?.setSignals({ dtr: dtr.value, rts: rts.value });
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
