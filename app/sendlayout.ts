// app/sendlayout.ts — 发送区选项行的流式几何（纯函数，弹层锚点与单测共用）。
// 选项行（transfer.tsx SendPane）是 flex-row gap-2 流式布局：
//   SegCtrl(92) · 转义 · <CRLF> · 追加换行 · [定向 Select 150] · [历史 Select 120] · 定时 …
// CheckRow 占位 = 14 勾选框 + 8 内距 + 标签宽（widgets.tsx CheckRow 的几何）。
// Select 在行内的 x 随语言/前序勾选框标签宽变化——弹层锚点必须复用同一累计，
// 否则弹层与控件脱节（2026-09 实测回归：弹层开在 x=380，控件实际在 587）。

/** 行内子项间距（gap-2）。 */
export const OPT_ROW_GAP = 8;
/** ASCII/HEX SegCtrl 固定宽。 */
export const OPT_SEG_W = 92;
/** 定向 Select 固定宽（tcps）。 */
export const SELECT_TARGET_W = 150;
/** 发送历史 Select 固定宽。 */
export const SELECT_HISTORY_W = 120;

export interface OptRowLabels {
  escape: string;
  crlf: string;
  appendNewline: string;
}

/** CheckRow 在 flex 行内的占位宽（measure = 标签文本宽度测量）。 */
export function checkRowW(label: string, measure: (s: string) => number): number {
  return 14 + OPT_ROW_GAP + measure(label);
}

/** 定向/历史 Select 的行内 x（相对选项行内容起点 = 面板右缘 + px-2）。
 *  SegCtrl 与三个常驻 CheckRow 是前序（CRLF 在 HEX 下仅置灰、仍占位），
 *  到第 4 个子项共 4 个 gap；历史在定向之后时再加 150 + 1 gap。 */
export function sendOptSelectX(
  labels: OptRowLabels,
  measure: (s: string) => number,
  showTarget: boolean,
): { targetX: number; historyX: number } {
  const x =
    OPT_SEG_W +
    checkRowW(labels.escape, measure) +
    checkRowW(labels.crlf, measure) +
    checkRowW(labels.appendNewline, measure) +
    OPT_ROW_GAP * 4;
  return {
    targetX: x,
    historyX: x + (showTarget ? SELECT_TARGET_W + OPT_ROW_GAP : 0),
  };
}
