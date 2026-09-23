// app/settings-modal-layout.ts — "应用配置"弹窗几何（纯函数，无框架依赖，
// 供 settings-modal.tsx 与 headless 单测共用；同 sendlayout.ts 的拆分模式）。

/** 弹窗宽（夹取后不超视口）。 */
export const MODAL_W = 400;
/** 弹窗与视口边缘最小留白。 */
export const MODAL_MARGIN = 8;

/** 内容内边距（画布左右）。 */
export const MODAL_PAD = 16;
export const TITLE_H = 24;
const ROW0_Y = 40;
/** 设置行高（label 与控件同行、垂直居中）。 */
export const MODAL_ROW_H = 34;
const ROW_GAP = 10;
/** 行内 label 列宽（右侧为控件区）。 */
export const LABEL_COL_W = 110;
/** 控件在行内垂直居中偏移 =(MODAL_ROW_H 34 - 控件高 28)/ 2。 */
export const CTL_TOP_OFF = 3;

/** 行 i 的画布内顶偏移：0 语言 / 1 主题 / 2 字号 / 3 接收区历史行数 / 4 回滚行数。 */
export function modalRowY(i: number): number {
  return ROW0_Y + i * (MODAL_ROW_H + ROW_GAP);
}

export const DIV_Y = modalRowY(4) + MODAL_ROW_H + 12;
export const IO_Y = DIV_Y + 1 + 12;
export const BTN_Y = IO_Y + 30 + 12;
/** 弹窗内容总高（标题 + 5 行 + 分隔线 + 导入导出 + 按钮 + 底 padding）。 */
export const MODAL_CONTENT_H = BTN_Y + 30 + MODAL_PAD;

export interface ModalFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 弹窗框几何（纯函数）：宽 MODAL_W、高按内容，居中并按边距夹取到视口内
 *  （嵌入式 480×272 等小视口下缩到视口内，内容走内部滚动）。 */
export function modalFrame(vw: number, vh: number): ModalFrame {
  const w = Math.min(MODAL_W, Math.max(0, vw - MODAL_MARGIN * 2));
  const h = Math.min(MODAL_CONTENT_H, Math.max(0, vh - MODAL_MARGIN * 2));
  return { x: Math.floor((vw - w) / 2), y: Math.floor((vh - h) / 2), w, h };
}
