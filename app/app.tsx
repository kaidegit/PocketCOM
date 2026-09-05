// app/app.tsx — PocketCOM 主界面（SPEC §3.1）：左配置面板 + 右收发区 + 底部状态栏。
// 每帧（onFrame）：svc 事件分发（键盘/IME/粘贴进活跃文本域，鼠标 hover 聚焦，
// 滚轮按区路由；弹层打开时滚轮/Escape 由弹层接管）→ 会话泵
// （com.poll → 帧合流 → 总线 → 日志视图）→ 定时发送。
import { ref, watch } from "vue";
import { Text, View } from "@pocketjs/framework/components";
import { resizeViewport } from "@pocketjs/framework";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { focusNode, hitFocusable } from "@pocketjs/framework/input";
import { connectSvc, type HostEvent } from "./svc";
import { activeField, setActiveField } from "./fields";
import { theme } from "./theme";
import { PANEL_W, STATUS_H, setViewport } from "./layout";
import { routeWheel } from "./wheel";
import { LeftPanel } from "./panel";
import { ReceivePane, SendPane, pumpTimedSend } from "./transfer";
import { StatusBar } from "./statusbar";
import { PopupLayer, closePopup, popupOpen, popupWheel } from "./widgets";
import { pumpSession, refreshPorts, comAvailable } from "./session";
import { t } from "./i18n";

export default () => {
  const svc = connectSvc();
  /** 最近指针位置（滚轮按 x 分区路由：左面板 or 接收区）。 */
  const lastMouse = { x: -1, y: -1 };
  /** 弹层关闭后下一帧重新 hover 聚焦（弹层节点已卸载，焦点悬空）。 */
  const rehover = ref(false);

  watch(popupOpen, (open) => {
    if (!open) rehover.value = true;
  });

  const dispatch = (ev: HostEvent): void => {
    switch (ev.t) {
      case "hello":
      case "resize":
        setViewport(ev.w ?? 960, ev.h ?? 640);
        resizeViewport(ev.w ?? 960, ev.h ?? 640);
        break;
      case "ch":
        activeField.value?.onCh(ev.s ?? "");
        break;
      case "paste":
        activeField.value?.onPaste(ev.text ?? "");
        break;
      case "ime":
        activeField.value?.onIme(ev.s ?? "", ev.c ?? null);
        break;
      case "key": {
        const mods = { cmd: ev.cmd ?? false, alt: ev.alt ?? false, ctl: ev.ctl ?? false, sh: ev.sh ?? false };
        if (ev.k === "Escape") {
          // Escape：先收弹层；否则清 IME preedit 并借焦
          if (popupOpen()) {
            closePopup();
            break;
          }
          activeField.value?.onIme("", null);
          setActiveField(null);
          break;
        }
        activeField.value?.onKey(ev.k ?? "", mods);
        break;
      }
      case "mouse": {
        const x = ev.x ?? -1;
        const y = ev.y ?? -1;
        lastMouse.x = x;
        lastMouse.y = y;
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
        routeWheel(ev.dy ?? 0, lastMouse.x >= 0 && lastMouse.x < PANEL_W ? "panel" : "log");
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
          <View class="flex-1 flex-col">
            <ReceivePane />
            <SendPane />
          </View>
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
