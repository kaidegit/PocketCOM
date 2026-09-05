// app/fontsize.ts — 字号档位的框架约束常量（SPEC §3.8 字体大小）。
// PocketJS 的 mono 字形槽只支持 12/14/16px（fontSlotFor mono 表：
// px 12/14/16 → slot 16/17/18），因此字号是三档选择而非任意值。
import type { ConfigFontSize } from "../core/config";

/** 档位 → mono 字形槽 id（measureText 用）。 */
export const MONO_SLOTS: Record<ConfigFontSize, number> = { 12: 16, 14: 17, 16: 18 };

/** 档位 → 行高（1.3×，对齐 text-xs/sm/base 的默认行高）。 */
export const LINE_H: Record<ConfigFontSize, number> = { 12: 16, 14: 18, 16: 21 };

/** 档位 → Tailwind 字面量 class（整体三元切换，禁止拼接）。 */
export const MONO_CLASS: Record<ConfigFontSize, string> = {
  12: "text-xs font-mono",
  14: "text-sm font-mono",
  16: "text-base font-mono",
};
