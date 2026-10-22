// Shared ANSI color encoding; independent of the terminal parser.
/** 默认前景/背景哨兵（渲染层按主题取色）。 */
export const TERM_DEFAULT_COLOR = 0xffffffff;

/** 24-bit RGB 编码。 */
export function termRgb(r: number, g: number, b: number): number {
  return 0x01000000 | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

export function isTermRgb(color: number): boolean {
  return (color & 0xff000000) === 0x01000000 && color !== TERM_DEFAULT_COLOR;
}
