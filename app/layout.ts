// app/layout.ts — 窗口级布局常量与视口状态（svc hello/resize 驱动）。
import { ref } from "vue";

/** 左配置面板宽（SPEC §3.1：260–320px 固定宽）。 */
export const PANEL_W = 272;
/** 底部状态栏高。 */
export const STATUS_H = 28;
/** 左面板头部（标题区）高。 */
export const PANEL_HEADER_H = 46;
/** 左面板底部（打开/关闭 + 状态）高，含顶部 1px 分隔线。 */
export const PANEL_FOOTER_H = 72;

/** 逻辑视口（宿主 hello/resize 事件更新）。 */
export const viewportSize = ref({ w: 960, h: 640 });

export function setViewport(w: number, h: number): void {
  viewportSize.value = { w, h };
}
