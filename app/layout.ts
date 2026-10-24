// app/layout.ts — 窗口级布局常量与视口状态（svc hello/resize 驱动）。
import { computed, ref } from "vue";
import { workspaceGeometry } from "./workspace-layout";
export { PANEL_W, STATUS_H } from "./workspace-layout";

/** 左面板头部（标题区）高。 */
export const PANEL_HEADER_H = 46;
/** 左面板底部（打开/关闭 + 应用配置）高，含顶部 1px 分隔线。连接状态只在
 *  主页底部状态栏显示（SPEC §3.1），面板页脚不再重复。 */
export const PANEL_FOOTER_H = 82;

/** 逻辑视口（宿主 hello/resize 事件更新）。 */
export const viewportSize = ref({ w: 960, h: 640 });
export const workspace = computed(() => workspaceGeometry(viewportSize.value.w, viewportSize.value.h));
export const connectionPanelOpen = ref(false);
export const connectionDrawerOpen = (): boolean => workspace.value.compact && connectionPanelOpen.value;

export function setViewport(w: number, h: number): void {
  viewportSize.value = { w, h };
  if (!workspace.value.compact) connectionPanelOpen.value = false;
}
