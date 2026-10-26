import { hasAppFeature } from "@pocketcom/features";
// app/app.tsx — PocketCOM 主界面（SPEC §3.1）：左配置面板 + 右主区 + 底部状态栏。
// 每帧（onFrame）：svc 事件分发（键盘/IME/粘贴：终端模式无活跃文本域时直发
// 连接——按键直发无本地回显（SPEC §3.4），否则进活跃文本域；鼠标 hover 聚焦，
// 终端区/文本域/日志区驱动拖动选区；滚轮按区路由；弹层打开时滚轮/Escape 由
// 弹层接管）→ 会话泵（com.poll → 帧合流 → 总线 → 日志视图/终端模型 → 查询
// 应答）→ 定时发送。
import { ref, watch } from "vue";
import { Portal, Text, View } from "@pocketjs/framework/components";
import { resizeViewport } from "@pocketjs/framework";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { virtualNow } from "@pocketjs/framework/clock";
import { focusNode, hitFocusable } from "@pocketjs/framework/input";
import { connectSvc, type HostEvent } from "./svc";
import { activeField, setActiveField } from "./fields";
import { theme } from "./theme";
import { PANEL_W, STATUS_H, connectionDrawerOpen, connectionPanelOpen, setViewport, viewportSize, workspace } from "./layout";
import { NARROW_BREAKPOINT } from "./workspace-layout";
import { routeWheel } from "./wheel";
import { LeftPanel } from "./panel";
import { ReceivePane, SendPane, logContextMenu, logHasSelection, logMouse, logSelectionText, pumpTimedSend } from "./transfer";
import { TerminalView, termHasSelection, termMouseMove, termScrollPage, termSelectionText } from "./terminal";
import { StatusBar } from "./statusbar";
import { Btn, PopupLayer, closePopup, popupOpen, popupWheel, textFieldMouse } from "./widgets";
import { SettingsModal, closeSettingsModal, modalWheel, settingsFieldMouse, settingsOpen } from "./settings-modal";
import { pumpSession, refreshPorts, comAvailable, sendTermBytes, terminal, uiMode } from "./session";
import { t } from "./i18n";
import { SoftKeyboard, closeKeyboard, keyboardOpen, keyboardHit, keyboardEditorMouse } from "./soft-keyboard";
import { strToBytes } from "../core/codec";

/** svc 键名别名：小写/口语名 → 控件层 Pascal 名（宿主 --key 脚本与
 *  cmd-chord 路径送原始小写；真机 on_key_down 路径已归一化）。 */
const KEY_ALIAS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  escape: "Escape",
  tab: "Tab",
};

/** 任一浮层打开（下拉弹层 / 设置模态弹窗）：键盘/鼠标/滚轮路由的总门控。 */
const overlayOpen = (): boolean => popupOpen() || settingsOpen() || connectionDrawerOpen();

// Create once on first use: remounting faster than idle GC exceeds the AIC budget.
// Off-screen placement keeps the cached panel out of rendering and hit testing.
function ConnectionDrawer(props: { onClose: () => void }) {
  return (
    <Portal>
      <View class="absolute" style={{ insetL: connectionDrawerOpen() ? 0 : viewportSize.value.w, insetT: 0, width: viewportSize.value.w, height: viewportSize.value.h }}>
        <View class="absolute" focusable onPress={() => props.onClose()}
          style={{ insetL: 0, insetT: 0, width: viewportSize.value.w, height: viewportSize.value.h, bgColor: "#00000080" }} />
        <View class="absolute overflow-hidden"
          style={{ insetL: 0, insetT: 0, width: workspace.value.drawerW, height: viewportSize.value.h, bgColor: theme.value.panelBg }}>
          <LeftPanel onClose={() => props.onClose()} />
        </View>
      </View>
    </Portal>
  );
}

export default () => {
  const svc = connectSvc();
  const drawerMounted = ref(false);
  watch(() => workspace.value.compact, (compact) => { if (!compact) drawerMounted.value = false; });
  /** 最近指针位置（滚轮按 x 分区路由：左面板 or 右区）。 */
  const lastMouse = { x: -1, y: -1 };
  /** 弹层关闭后下一帧重新 hover 聚焦（弹层节点已卸载，焦点悬空）。 */
  const rehover = ref(false);
  const closeConnections = (): void => {
    closePopup();
    setActiveField(null);
    connectionPanelOpen.value = false;
  };
  const openConnections = (): void => {
    closePopup();
    if (hasAppFeature("ui.soft-keyboard")) closeKeyboard();
    setActiveField(null);
    drawerMounted.value = true;
    connectionPanelOpen.value = true;
  };
  watch(overlayOpen, (open) => {
    if (!open) rehover.value = true;
  });

  /** 终端模式且键盘/粘贴应直发（无活跃文本域 = 终端持有键盘）。 */
  const termWantsKeys = (): boolean =>
    hasAppFeature("terminal") && uiMode.value === "terminal" && !overlayOpen() && activeField.value === null;

  const dispatch = (ev: HostEvent): void => {
    switch (ev.t) {
      case "hello":
      case "resize":
        closePopup();
        if (workspace.value.compact !== ((ev.w ?? 960) < NARROW_BREAKPOINT)) setActiveField(null);
        setViewport(ev.w ?? 960, ev.h ?? 640);
        resizeViewport(ev.w ?? 960, ev.h ?? 640);
        break;
      case "ch":
        if (hasAppFeature("terminal") && termWantsKeys()) {
          sendTermBytes(strToBytes(ev.s ?? ""));
          break;
        }
        activeField.value?.onCh(ev.s ?? "");
        break;
      case "paste":
        if (!hasAppFeature("ui.clipboard")) break;
        if (hasAppFeature("terminal") && termWantsKeys()) {
          sendTermBytes(terminal!.pasteBytes(ev.text ?? ""));
          break;
        }
        activeField.value?.onPaste(ev.text ?? "");
        break;
      case "ime":
        activeField.value?.onIme(ev.s ?? "", ev.c ?? null);
        break;
      case "key": {
        const mods = { cmd: ev.cmd ?? false, alt: ev.alt ?? false, ctl: ev.ctl ?? false, sh: ev.sh ?? false };
        // 键名归一化：宿主 cmd-chord 与 --key 脚本路径送小写原始名（真机
        // on_key_down 路径才做 Pascal 化）；svc 是 app 级协议，统一在这里收敛。
        const k = KEY_ALIAS[(ev.k ?? "").toLowerCase()] ?? ev.k;
        if (k === "Escape") {
          if (hasAppFeature("ui.soft-keyboard") && keyboardOpen()) {
            closeKeyboard();
            break;
          }
          // Escape：先收下拉弹层，再收设置弹窗（丢弃草稿）；终端直发态发给
          // 远端；否则清 IME preedit 并借焦
          if (popupOpen()) {
            closePopup();
            break;
          }
          if (settingsOpen()) {
            closeSettingsModal();
            break;
          }
          if (connectionDrawerOpen()) {
            closeConnections();
            break;
          }
          if (hasAppFeature("terminal") && termWantsKeys()) {
            sendTermBytes(terminal!.keyBytes("Escape")!);
            break;
          }
          activeField.value?.onIme("", null);
          setActiveField(null);
          break;
        }
        // 选中复制：宿主 Cmd+C 以 "Copy" 键行到达。优先级：终端选区 >
        // 活跃文本域选区 > 接收区日志选区；都没有则原样走后续按键路由。
        if (hasAppFeature("ui.clipboard") && hasAppFeature("ui.shortcuts") && k === "Copy") {
          if (hasAppFeature("terminal") && !overlayOpen() && uiMode.value === "terminal" && termHasSelection()) {
            svc?.send({ t: "copy", text: termSelectionText() });
            break;
          }
          const fieldSel = activeField.value?.selectionText?.() ?? null;
          if (fieldSel !== null && fieldSel !== "") {
            svc?.send({ t: "copy", text: fieldSel });
            break;
          }
          if (!overlayOpen() && uiMode.value === "transfer" && logHasSelection()) {
            svc?.send({ t: "copy", text: logSelectionText() });
            break;
          }
        }
        if (hasAppFeature("terminal") && termWantsKeys()) {
          // Shift+PageUp/PageDown 本地滚动回滚；其余按键直发（SPEC §3.4）
          if (hasAppFeature("ui.shortcuts") && k === "PageUp" && mods.sh) {
            termScrollPage(-1);
            break;
          }
          if (hasAppFeature("ui.shortcuts") && k === "PageDown" && mods.sh) {
            termScrollPage(1);
            break;
          }
          const bytes = terminal!.keyBytes(k ?? "", { alt: mods.alt, ctl: mods.ctl, sh: mods.sh });
          if (bytes) sendTermBytes(bytes);
          break;
        }
        activeField.value?.onKey(k ?? "", mods);
        break;
      }
      case "mouse": {
        const x = ev.x ?? -1;
        const y = ev.y ?? -1;
        lastMouse.x = x;
        lastMouse.y = y;
        const down = ev.d ?? false;
        if (hasAppFeature("ui.soft-keyboard") && keyboardHit(x, y)) {
          keyboardEditorMouse(x, y, down);
          focusNode(hitFocusable(x, y));
          break;
        }
        const inTermArea =
          hasAppFeature("terminal") && uiMode.value === "terminal" &&
          !overlayOpen() &&
          x >= workspace.value.x && y >= workspace.value.y &&
          y < viewportSize.value.h - STATUS_H;
        // 右键：不参与选区/焦点路由。终端模式 = 有选区时按下即复制；收发
        // 模式 = 接收区弹上下文菜单（复制/全选）。浮层打开时忽略。
        if (ev.b === 2) {
          if (!hasAppFeature("ui.context-menu")) break;
          if (down && !overlayOpen()) {
            if (hasAppFeature("terminal") && inTermArea) {
              if (hasAppFeature("ui.clipboard") && termHasSelection()) svc?.send({ t: "copy", text: termSelectionText() });
            } else if (uiMode.value === "transfer") {
              logContextMenu(x, y);
            }
          }
          break;
        }
        if (hasAppFeature("terminal") && inTermArea) {
          // 终端区：按下/拖动/抬起驱动选区与借焦；hover 聚焦照常——网格根
          // View 是 focusable 命中体，CIRCLE press 落到它（借焦清文本域），
          // 避免按下事件落到陈旧焦点控件上。
          if (hasAppFeature("ui.selection")) termMouseMove(x, y, down);
          focusNode(hitFocusable(x, y));
          break;
        }
        // 文本选区路由：文本域（发送框/面板输入框）→ 接收区日志。拖拽期间
        // 由按下时认领的一方接管（跨区不换目标）；下拉弹层打开时不参与。
        // 设置弹窗打开时只认弹窗内的回滚行数输入框——textFieldMouse 是纯
        // 几何命中，会把遮罩下方的输入框也认领走。
        if (hasAppFeature("ui.selection") && !popupOpen()) {
          if (settingsOpen()) {
            if (settingsFieldMouse(x, y, down)) {
              focusNode(hitFocusable(x, y));
              break;
            }
          } else {
            if (textFieldMouse(x, y, down)) {
              focusNode(hitFocusable(x, y));
              break;
            }
            if (!connectionDrawerOpen() && uiMode.value === "transfer" && logMouse(x, y, down)) {
              focusNode(hitFocusable(x, y));
              break;
            }
          }
        }
        // 悬停聚焦始终跟随指针（点击 press 由宿主注入 CIRCLE 完成，不再
        // pressNode）。落空时必须清焦点：否则点在空白处会触发"上一次
        // 聚焦的控件"（CIRCLE 发到陈旧焦点上）。
        focusNode(hitFocusable(x, y));
        break;
      }
      case "scroll": {
        if (popupOpen()) {
          popupWheel(ev.dy ?? 0);
          break;
        }
        if (settingsOpen()) {
          modalWheel(ev.dy ?? 0);
          break;
        }
        if (connectionDrawerOpen()) {
          routeWheel(ev.dy ?? 0, "panel");
          break;
        }
        const region =
          !workspace.value.compact && lastMouse.x >= 0 && lastMouse.x < PANEL_W
            ? "panel"
            : hasAppFeature("terminal") && uiMode.value === "terminal"
              ? "term"
              : "log";
        routeWheel(ev.dy ?? 0, region);
        break;
      }
    }
  };

  onFrame(() => {
    if (svc) {
      for (const ev of svc.poll()) dispatch(ev);
    }
    if (rehover.value) {
      rehover.value = false;
      if (lastMouse.x >= 0) {
        focusNode(hitFocusable(lastMouse.x, lastMouse.y));
      }
    }
    // AIC has no reliable wall clock without RTC. Silence/reconnect deadlines
    // follow frame time; MessageBus keeps its calendar timestamp source.
    pumpSession(virtualNow() * 1000);
    pumpTimedSend();
  });

  refreshPorts();

  return (
    <View class="w-full h-full flex-row" style={{ bgColor: theme.value.bg }}>
      {!workspace.value.compact ? <LeftPanel /> : null}
      <View class="flex-1 flex-col">
        {workspace.value.compact ? (
          <View class="relative" style={{ height: workspace.value.y, bgColor: theme.value.panelBg }}>
            <View class="absolute" style={{ insetL: 8, insetT: 4, width: 104, height: 24 }}>
              <Btn width={104} height={24} label={() => t("panel.connections")} onPress={openConnections} />
            </View>
            <Text class="absolute text-sm font-bold" style={{ insetL: 124, insetT: 7, textColor: theme.value.fg }}>
              {t("app.title")}
            </Text>
          </View>
        ) : null}
        {comAvailable ? (
          hasAppFeature("terminal") && uiMode.value === "terminal" ? (
            <TerminalView />
          ) : (
            <View class="flex-1 flex-col">
              <ReceivePane />
              <SendPane />
            </View>
          )
        ) : (
          <View class="flex-1 flex-col items-center justify-center gap-2">
            <Text class="text-base" style={{ textColor: theme.value.fg }}>
              {t("app.title")}
            </Text>
            <Text class="text-sm" style={{ textColor: theme.value.dim }}>
              {t("conn.bridgeUnavailable")}
            </Text>
          </View>
        )}
        <StatusBar height={STATUS_H} />
      </View>
      {workspace.value.compact && drawerMounted.value ? <ConnectionDrawer onClose={closeConnections} /> : null}
      {/* 下拉弹层（Portal 全屏遮罩，同屏只开一个） */}
      <PopupLayer />
      {/* "应用配置"设置模态弹窗（Portal 全屏遮罩，草稿模式） */}
      <SettingsModal />
      {hasAppFeature("ui.soft-keyboard") ? <SoftKeyboard /> : null}
    </View>
  );
};
