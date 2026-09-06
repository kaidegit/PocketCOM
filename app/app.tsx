// app/app.tsx — PocketCOM 主界面（SPEC §3.1）：左配置面板 + 右主区 + 底部状态栏。
// 每帧（onFrame）：svc 事件分发（键盘/IME/粘贴：终端模式无活跃文本域时直发
// 连接——按键直发无本地回显（SPEC §3.4），否则进活跃文本域；鼠标 hover 聚焦，
// 终端区/文本域/日志区驱动拖动选区；滚轮按区路由；弹层打开时滚轮/Escape 由
// 弹层接管）→ 会话泵（com.poll → 帧合流 → 总线 → 日志视图/终端模型 → 查询
// 应答）→ 定时发送。
import { ref, watch } from "vue";
import { Text, View } from "@pocketjs/framework/components";
import { resizeViewport } from "@pocketjs/framework";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { focusNode, hitFocusable } from "@pocketjs/framework/input";
import { connectSvc, type HostEvent } from "./svc";
import { activeField, setActiveField } from "./fields";
import { theme } from "./theme";
import { PANEL_W, STATUS_H, setViewport, viewportSize } from "./layout";
import { routeWheel } from "./wheel";
import { LeftPanel } from "./panel";
import { ReceivePane, SendPane, logHasSelection, logMouse, logSelectionText, pumpTimedSend } from "./transfer";
import { TerminalView, termHasSelection, termMouseMove, termScrollPage, termSelectionText } from "./terminal";
import { StatusBar } from "./statusbar";
import { PopupLayer, closePopup, popupOpen, popupWheel, textFieldMouse } from "./widgets";
import { pumpSession, refreshPorts, comAvailable, sendTermBytes, terminal, uiMode } from "./session";
import { t } from "./i18n";
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

export default () => {
  const svc = connectSvc();
  /** 最近指针位置（滚轮按 x 分区路由：左面板 or 右区）。 */
  const lastMouse = { x: -1, y: -1 };
  /** 弹层关闭后下一帧重新 hover 聚焦（弹层节点已卸载，焦点悬空）。 */
  const rehover = ref(false);
  watch(popupOpen, (open) => {
    if (!open) rehover.value = true;
  });

  /** 终端模式且键盘/粘贴应直发（无活跃文本域 = 终端持有键盘）。 */
  const termWantsKeys = (): boolean =>
    uiMode.value === "terminal" && !popupOpen() && activeField.value === null;

  const dispatch = (ev: HostEvent): void => {
    switch (ev.t) {
      case "hello":
      case "resize":
        setViewport(ev.w ?? 960, ev.h ?? 640);
        resizeViewport(ev.w ?? 960, ev.h ?? 640);
        break;
      case "ch":
        if (termWantsKeys()) {
          sendTermBytes(strToBytes(ev.s ?? ""));
          break;
        }
        activeField.value?.onCh(ev.s ?? "");
        break;
      case "paste":
        if (termWantsKeys()) {
          sendTermBytes(terminal.pasteBytes(ev.text ?? ""));
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
          // Escape：先收弹层；终端直发态发给远端；否则清 IME preedit 并借焦
          if (popupOpen()) {
            closePopup();
            break;
          }
          if (termWantsKeys()) {
            sendTermBytes(terminal.keyBytes("Escape")!);
            break;
          }
          activeField.value?.onIme("", null);
          setActiveField(null);
          break;
        }
        // 选中复制：宿主 Cmd+C 以 "Copy" 键行到达。优先级：终端选区 >
        // 活跃文本域选区 > 接收区日志选区；都没有则原样走后续按键路由。
        if (k === "Copy") {
          if (uiMode.value === "terminal" && termHasSelection()) {
            svc?.send({ t: "copy", text: termSelectionText() });
            break;
          }
          const fieldSel = activeField.value?.selectionText?.() ?? null;
          if (fieldSel !== null && fieldSel !== "") {
            svc?.send({ t: "copy", text: fieldSel });
            break;
          }
          if (uiMode.value === "transfer" && logHasSelection()) {
            svc?.send({ t: "copy", text: logSelectionText() });
            break;
          }
        }
        if (termWantsKeys()) {
          // Shift+PageUp/PageDown 本地滚动回滚；其余按键直发（SPEC §3.4）
          if (k === "PageUp" && mods.sh) {
            termScrollPage(-1);
            break;
          }
          if (k === "PageDown" && mods.sh) {
            termScrollPage(1);
            break;
          }
          const bytes = terminal.keyBytes(k ?? "", { alt: mods.alt, ctl: mods.ctl, sh: mods.sh });
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
        const inTermArea =
          uiMode.value === "terminal" &&
          !popupOpen() &&
          x >= PANEL_W &&
          y < viewportSize.value.h - STATUS_H;
        if (inTermArea) {
          // 终端区：按下/拖动/抬起驱动选区与借焦；hover 聚焦照常——网格根
          // View 是 focusable 命中体，CIRCLE press 落到它（借焦清文本域），
          // 避免按下事件落到陈旧焦点控件上。
          termMouseMove(x, y, down);
          focusNode(hitFocusable(x, y));
          break;
        }
        // 文本选区路由：文本域（发送框/面板输入框）→ 接收区日志。拖拽期间
        // 由按下时认领的一方接管（跨区不换目标）；右键与弹层打开时不参与。
        if (!popupOpen() && ev.b !== 2) {
          if (textFieldMouse(x, y, down)) {
            focusNode(hitFocusable(x, y));
            break;
          }
          if (uiMode.value === "transfer" && logMouse(x, y, down)) {
            focusNode(hitFocusable(x, y));
            break;
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
        const region =
          lastMouse.x >= 0 && lastMouse.x < PANEL_W
            ? "panel"
            : uiMode.value === "terminal"
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
    pumpSession(Date.now());
    pumpTimedSend();
  });

  refreshPorts();

  return (
    <View class="w-full h-full flex-row" style={{ bgColor: theme.value.bg }}>
      <LeftPanel />
      <View class="flex-1 flex-col">
        {comAvailable ? (
          uiMode.value === "terminal" ? (
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
      {/* 下拉弹层（Portal 全屏遮罩，同屏只开一个） */}
      <PopupLayer />
    </View>
  );
};
