/**
 * 终端模式核心（SPEC §3.4）：纯 TS 的 headless VT100/xterm 终端模型。
 * 不依赖 xterm.js（其依赖 DOM）；对齐 pyte/经典用例的子集：
 *   屏幕 = 固定 cols×rows 字符网格（每格一个字符 + 前景/背景/属性），光标、
 *   滚动区域、DECAWM 自动换行、DECOM 原点模式、备用屏（alt screen）、
 *   制表位、回滚缓冲（setScrollback 可调，0–100000，超出即时裁剪）。
 *   解析覆盖 C0、ESC、CSI（光标移动/ED/EL/IL/DL/DCH/ICH/ECH/SU/SD/SGR/
 *   DECSTBM/DECSET+DECRST/DSR/DA）、OSC/DCS 串吞掉、宽字符（wcwidth）。
 * 输入方向：keyBytes/pasteBytes 把按键映射为转义序列（xterm 风格，Backspace
 * 发 0x7F；DECCKM ?1 决定方向键 CSI/SS3 形态；?2004 括号粘贴）。
 * 应答方向：DSR/DA 等查询类序列的应答字节进 responses 队列，由 app 层取出
 * 写到连接上——这也是将来 SIGWINCH 尺寸上报的预留通道（SPEC §3.4）。
 * 颜色编码：默认色 = TERM_DEFAULT_COLOR；调色板索引 0–255 直接存值；
 * 24-bit = 0x01000000 | (r<<16)|(g<<8)|b。调色板 → RGB 映射在 app 主题层。
 */
import { strToBytes } from "./codec";

// ---------------------------------------------------------------------------
// 颜色 / 属性编码
// ---------------------------------------------------------------------------

/** 默认前景/背景哨兵（渲染层按主题取色）。 */
export const TERM_DEFAULT_COLOR = 0xffffffff;

/** 24-bit RGB 编码。 */
export function termRgb(r: number, g: number, b: number): number {
  return 0x01000000 | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

export function isTermRgb(color: number): boolean {
  return (color & 0xff000000) === 0x01000000 && color !== TERM_DEFAULT_COLOR;
}

export const CELL_BOLD = 1;
export const CELL_UNDERLINE = 2;
export const CELL_REVERSE = 4;
export const CELL_ITALIC = 8;
export const CELL_WIDE = 16;

/** 一行屏幕/回滚：text 每格一字符（宽字符后随 "\x00" 续格，渲染时跳过）。 */
export interface TermLine {
  text: string;
  fg: Uint32Array;
  bg: Uint32Array;
  flags: Uint8Array;
}

// ---------------------------------------------------------------------------
// wcwidth（Markus Kuhn 表的紧凑子集）：宽字符占 2 格，组合字符占 0 格
// ---------------------------------------------------------------------------

const ZERO_WIDTH: readonly [number, number][] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf],
  [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4],
  [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0711, 0x0711], [0x0730, 0x074a],
  [0x07a6, 0x07b0], [0x07eb, 0x07f3], [0x0816, 0x0819], [0x081b, 0x0823],
  [0x0825, 0x0827], [0x0829, 0x082d], [0x0859, 0x085b], [0x08e3, 0x0902],
  [0x093a, 0x093a], [0x093c, 0x093c], [0x0941, 0x0948], [0x094d, 0x094d],
  [0x0951, 0x0957], [0x0962, 0x0963], [0x0981, 0x0981], [0x09bc, 0x09bc],
  [0x09c1, 0x09c4], [0x09cd, 0x09cd], [0x0a01, 0x0a02], [0x0a3c, 0x0a3c],
  [0x0a41, 0x0a42], [0x0a47, 0x0a48], [0x0a4b, 0x0a4d], [0x0a70, 0x0a71],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], [0xe0100, 0xe01ef],
];

const WIDE: readonly [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4], [0x17000, 0x18aff], [0x1b000, 0x1b152],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f320], [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c], [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0], [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e], [0x1f440, 0x1f440], [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f], [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6f9],
  [0x1f910, 0x1f93e], [0x1f940, 0x1f970], [0x1f973, 0x1f976],
  [0x1f97a, 0x1f9a2], [0x1f9b0, 0x1f9b9], [0x1f9c0, 0x1f9c2],
  [0x1f9d0, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp: number, ranges: readonly [number, number][]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 字符显示宽度：0（组合）/ 1 / 2（东亚宽）。 */
export function wcwidth(cp: number): 0 | 1 | 2 {
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, WIDE)) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

type ParserState =
  | "ground"
  | "esc"
  | "esc-inter"
  | "csi-param"
  | "csi-inter"
  | "csi-ignore"
  | "osc"
  | "osc-esc"
  | "str";

interface SavedState {
  x: number;
  y: number;
  fg: number;
  bg: number;
  flags: number;
  origin: boolean;
  wrapPending: boolean;
  scrollTop: number;
  scrollBottom: number;
}

export interface TermKeyMods {
  cmd?: boolean;
  alt?: boolean;
  ctl?: boolean;
  sh?: boolean;
}

export interface TerminalOptions {
  cols?: number;
  rows?: number;
  /** 回滚行数上限（0 = 不回滚），默认 9999（SPEC §3.4）。 */
  scrollback?: number;
}

const MAX_SCROLLBACK = 100000;
const MAX_CSI_PARAMS = 32;
const MAX_PARAM_DIGITS = 8;

export class Terminal {
  cols: number;
  rows: number;
  /** 内容版本号：任何影响显示的变更 +1（app 层轮询做渲染依赖）。 */
  version = 0;

  private scrollbackLimit: number;
  private scrollback: TermLine[] = [];
  private screen: TermLine[] = [];
  private curX = 0;
  private curY = 0;
  private fg: number = TERM_DEFAULT_COLOR;
  private bg: number = TERM_DEFAULT_COLOR;
  private flags = 0;
  private autowrap = true;
  private wrapPending = false;
  private scrollTop = 0;
  private scrollBottom: number;
  private originMode = false;
  private cursorVisible = true;
  private cursorKeysApp = false;
  private bracketedPaste = false;
  private tabStops = new Set<number>();
  /** 备用屏（非空 = 当前在 alt screen）：保存主屏行 + 主屏状态。 */
  private alt: { screen: TermLine[]; saved: SavedState } | null = null;
  private savedMain: SavedState;
  private savedAlt: SavedState;
  private responses: Uint8Array[] = [];
  /** UTF-8 跨帧残余字节（多字节序列被帧边界切断时暂存）。 */
  private u8Tail: number[] = [];

  // 解析器状态
  private state: ParserState = "ground";
  private csiParams: string[] = [];
  private csiPrivate = "";
  private csiInter = "";

  constructor(opts: TerminalOptions = {}) {
    this.cols = Math.max(2, Math.floor(opts.cols ?? 80));
    this.rows = Math.max(2, Math.floor(opts.rows ?? 24));
    this.scrollbackLimit = Terminal.clampScrollback(opts.scrollback ?? 9999);
    this.scrollBottom = this.rows - 1;
    this.savedMain = this.blankSaved();
    this.savedAlt = this.blankSaved();
    for (let i = 0; i < this.rows; i++) this.screen.push(this.blankLine());
    this.resetTabStops();
  }

  private static clampScrollback(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(MAX_SCROLLBACK, Math.max(0, Math.floor(n)));
  }

  private blankSaved(): SavedState {
    return {
      x: 0,
      y: 0,
      fg: TERM_DEFAULT_COLOR,
      bg: TERM_DEFAULT_COLOR,
      flags: 0,
      origin: false,
      wrapPending: false,
      scrollTop: 0,
      scrollBottom: this.rows - 1,
    };
  }

  private blankLine(): TermLine {
    return {
      text: " ".repeat(this.cols),
      fg: new Uint32Array(this.cols).fill(TERM_DEFAULT_COLOR),
      bg: new Uint32Array(this.cols).fill(TERM_DEFAULT_COLOR),
      flags: new Uint8Array(this.cols),
    };
  }

  private resetTabStops(): void {
    this.tabStops = new Set();
    for (let x = 8; x < this.cols; x += 8) this.tabStops.add(x);
  }

  // --- 查询 API（渲染层用） ---

  /** 回滚行数（不含可见屏幕）。 */
  get scrollbackCount(): number {
    return this.scrollback.length;
  }

  get scrollbackLimitLines(): number {
    return this.scrollbackLimit;
  }

  get cursorX(): number {
    return this.curX;
  }

  get cursorY(): number {
    return this.curY;
  }

  get showCursor(): boolean {
    return this.cursorVisible;
  }

  get inAltScreen(): boolean {
    return this.alt !== null;
  }

  get cursorApplicationMode(): boolean {
    return this.cursorKeysApp;
  }

  /** 总行数 = 回滚 + 可见屏幕；index 0 = 最旧一行。 */
  get totalLines(): number {
    return this.scrollback.length + this.rows;
  }

  /** 越界返回 null。 */
  lineAt(index: number): TermLine | null {
    if (index < 0 || index >= this.totalLines) return null;
    if (index < this.scrollback.length) return this.scrollback[index]!;
    return this.screen[index - this.scrollback.length] ?? null;
  }

  // --- 回滚 / 尺寸（SPEC §3.4：回滚可调即时生效，超出新上限裁剪） ---

  setScrollback(lines: number): void {
    const next = Terminal.clampScrollback(lines);
    if (next === this.scrollbackLimit) return;
    this.scrollbackLimit = next;
    while (this.scrollback.length > this.scrollbackLimit) this.scrollback.shift();
    this.version++;
  }

  resize(cols: number, rows: number): void {
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(2, Math.floor(rows));
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    // 屏幕行：统一归一化到新宽度；增补底部空行 / 裁掉底部多余行
    // （不做 reflow，SPEC 只要求按字体度量重算行列数）
    const resized: TermLine[] = [];
    for (let i = 0; i < r; i++) {
      const line = this.screen[i] ?? this.blankLine();
      if (line.text.length > c) {
        resized.push({
          text: line.text.slice(0, c),
          fg: line.fg.slice(0, c),
          bg: line.bg.slice(0, c),
          flags: line.flags.slice(0, c),
        });
      } else if (line.text.length < c) {
        const pad = c - line.text.length;
        resized.push({
          text: line.text + " ".repeat(pad),
          fg: fillU32(line.fg, pad, TERM_DEFAULT_COLOR),
          bg: fillU32(line.bg, pad, TERM_DEFAULT_COLOR),
          flags: fillU8(line.flags, pad, 0),
        });
      } else {
        resized.push(line);
      }
    }
    this.screen = resized;
    this.scrollTop = 0;
    this.scrollBottom = r - 1;
    this.curX = Math.min(this.curX, c - 1);
    this.curY = Math.min(this.curY, r - 1);
    this.wrapPending = false;
    // SIGWINCH 钩子预留点：将来在此向 responses 队列注入尺寸上报。
    this.version++;
  }

  // --- 数据入口 ---

  /**
   * 送入 RX 字节流（UTF-8；跨帧被切断的多字节序列自动续接）。
   * 调用方按帧合流后的 payload 喂入即可。
   */
  feed(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const all = this.u8Tail.length > 0 ? this.u8Tail.concat(Array.from(bytes)) : Array.from(bytes);
    this.u8Tail = [];
    let i = 0;
    const n = all.length;
    let u8: number[] = [];
    while (i < n) {
      const b = all[i]!;
      if (b < 0x80) {
        u8 = [];
        this.parse(b);
        i++;
        continue;
      }
      // 多字节序列：收集完整字符
      const need = leadBytes(b);
      u8.push(b);
      i++;
      let complete = u8.length === need;
      while (!complete && i < n && u8.length < 4) {
        const nb = all[i]!;
        if ((nb & 0xc0) !== 0x80) break; // 非法续字节：按替换符处理当前累积
        u8.push(nb);
        i++;
        complete = u8.length === need;
      }
      if (complete) {
        const cp = decodeCp(u8);
        u8 = [];
        if (this.state === "ground") {
          this.writePrintable(String.fromCodePoint(cp), wcwidth(cp));
        }
        // 非地面态的非 ASCII 字节是畸形序列/OSC 内容：忽略
      } else if (this.state === "ground") {
        // 帧尾被切断的序列：暂存到下一帧（SPEC：宿主按帧送字节流）
        this.u8Tail = u8;
        u8 = [];
        break;
      } else {
        u8 = [];
      }
    }
    this.version++;
  }

  /** 测试便利入口：按 UTF-8 编码后走同一字节路径。 */
  feedString(text: string): void {
    this.feed(strToBytes(text));
  }

  // --- 打印与光标 ---

  private writePrintable(ch: string, width: 0 | 1 | 2): void {
    if (width === 0) return; // 组合字符：首版不合成，直接丢弃（HEX 视图无损）
    if (this.wrapPending && this.autowrap) {
      this.wrapPending = false;
      this.curX = 0;
      this.linefeed();
    }
    if (width === 2 && this.curX + 1 >= this.cols && this.autowrap) {
      // 宽字符在最后一列：先换行再写
      this.curX = 0;
      this.linefeed();
    }
    if (this.curX + width > this.cols) {
      // 不换行模式下放不下：丢弃
      return;
    }
    const line = this.screen[this.curY]!;
    // 写入点落在宽字符续格上：把前一个宽字符残半清掉
    if (line.text.charCodeAt(this.curX) === 0 && this.curX > 0) {
      line.text = replaceAt(line.text, this.curX - 1, " ");
      line.flags[this.curX - 1] &= ~CELL_WIDE;
    }
    this.putCell(line, this.curX, ch, width);
    if (width === 2) this.putCell(line, this.curX + 1, "\x00", 0);
    this.curX += width;
    if (this.curX >= this.cols) {
      this.curX = this.cols - 1;
      if (this.autowrap) this.wrapPending = true;
    }
  }

  private putCell(line: TermLine, x: number, ch: string, width: 0 | 1 | 2): void {
    if (x >= line.text.length) return;
    const prev = line.text.charCodeAt(x);
    if (prev === 0 && x > 0) {
      // 被覆盖的续格：清掉主格宽标记
      line.flags[x - 1] &= ~CELL_WIDE;
    } else if ((line.flags[x] & CELL_WIDE) !== 0 && x + 1 < line.text.length) {
      // 被覆盖的宽字符主格：清掉它的续格
      line.text = replaceAt(line.text, x + 1, " ");
      line.flags[x + 1] &= ~CELL_WIDE;
    }
    line.text = replaceAt(line.text, x, ch);
    line.fg[x] = this.fg;
    line.bg[x] = this.bg;
    line.flags[x] = this.flags | (width === 2 ? CELL_WIDE : 0);
  }

  /** 光标下移一行（滚出区域底则上滚）。 */
  private linefeed(): void {
    if (this.curY === this.scrollBottom) this.scrollUp(1);
    else if (this.curY < this.rows - 1) this.curY++;
  }

  private scrollUp(n: number): void {
    const top = this.scrollTop;
    const bottom = this.scrollBottom;
    for (let i = 0; i < n; i++) {
      const removed = this.screen[top]!;
      // 主屏且区域顶 = 屏幕顶：上滚行进回滚（alt 屏不进）
      if (top === 0 && this.alt === null) {
        this.scrollback.push(removed);
        while (this.scrollback.length > this.scrollbackLimit) this.scrollback.shift();
      }
      for (let y = top; y < bottom; y++) this.screen[y] = this.screen[y + 1]!;
      this.screen[bottom] = this.blankLine();
    }
  }

  private scrollDown(n: number): void {
    const top = this.scrollTop;
    const bottom = this.scrollBottom;
    for (let i = 0; i < n; i++) {
      for (let y = bottom; y > top; y--) this.screen[y] = this.screen[y - 1]!;
      this.screen[top] = this.blankLine();
    }
  }

  // --- 解析器（字节级；非 ASCII 可打印字符由 feed 直接写入地面态） ---

  private parse(b: number): void {
    switch (this.state) {
      case "ground":
        if (b === 0x1b) this.state = "esc";
        else if (b < 0x20 || b === 0x7f) this.execControl(b);
        else this.writePrintable(String.fromCharCode(b), 1);
        break;
      case "esc":
        if (b === 0x1b) break; // 重复 ESC 重启
        if (b === 0x5b) {
          // '[' CSI：进入参数收集
          this.csiParams = [];
          this.csiPrivate = "";
          this.csiInter = "";
          this.state = "csi-param";
          break;
        }
        if (b === 0x5d) {
          // ']' OSC（标题等）：吞到 BEL/ST
          this.state = "osc";
          break;
        }
        if (b === 0x50 || b === 0x58 || b === 0x5e || b === 0x5f) {
          // DCS / SOS / PM / APC：吞到 ST
          this.state = "str";
          break;
        }
        if (b >= 0x20 && b <= 0x2f) {
          this.csiInter = String.fromCharCode(b);
          this.state = "esc-inter";
          break;
        }
        this.state = "ground";
        this.dispatchEsc(b);
        break;
      case "esc-inter":
        if (b >= 0x20 && b <= 0x2f) {
          this.csiInter += String.fromCharCode(b);
          break;
        }
        this.state = "ground";
        this.csiInter = "";
        // 字符集指定（ESC ( X 等）与其余带中间字节的序列：忽略
        break;
      case "csi-param":
        this.csiParamByte(b);
        break;
      case "csi-inter":
        if (b >= 0x20 && b <= 0x2f) {
          this.csiInter += String.fromCharCode(b);
          break;
        }
        if (b >= 0x40 && b <= 0x7e) {
          this.state = "ground";
          // 带中间字节的 CSI（DECSCUSR " q" 等）：忽略
          this.csiInter = "";
          break;
        }
        if (b === 0x1b) this.state = "esc";
        else if (b < 0x20) this.execControl(b);
        break;
      case "csi-ignore":
        if (b >= 0x40 && b <= 0x7e) this.state = "ground";
        else if (b === 0x1b) this.state = "esc";
        break;
      case "osc":
        if (b === 0x07) {
          this.state = "ground";
        } else if (b === 0x1b) {
          this.state = "osc-esc";
        }
        break;
      case "osc-esc":
        if (b === 0x5c) {
          this.state = "ground"; // ST：OSC 结束
        } else {
          // 非 ST：当作新 ESC 序列开始（罕见，容忍）
          this.state = "esc";
          this.parse(b);
        }
        break;
      case "str":
        // DCS/SOS/PM/APC：吞到 ST（ESC \）
        if (b === 0x1b) this.state = "osc-esc";
        break;
    }
  }

  private csiParamByte(b: number): void {
    if (b >= 0x30 && b <= 0x39) {
      // 数字：追加到当前参数 token
      if (this.csiParams.length === 0) this.csiParams.push("");
      const last = this.csiParams[this.csiParams.length - 1]!;
      if (last.length < MAX_PARAM_DIGITS && this.csiParams.length <= MAX_CSI_PARAMS) {
        this.csiParams[this.csiParams.length - 1] = last + String.fromCharCode(b);
      }
      return;
    }
    if (b === 0x3b || b === 0x3a) {
      // ';' 新参数；':' 子参数归入同一 token（38:5:N 形态）
      if (b === 0x3a && this.csiParams.length > 0) {
        const last = this.csiParams[this.csiParams.length - 1]!;
        if (last.length < MAX_PARAM_DIGITS * 4) {
          this.csiParams[this.csiParams.length - 1] = last + ":";
        }
      } else if (this.csiParams.length < MAX_CSI_PARAMS) {
        this.csiParams.push("");
      }
      return;
    }
    if (b === 0x3f || b === 0x3c || b === 0x3e || b === 0x3d) {
      // 私有前缀（? < = >）只在参数区开头有效
      if (this.csiParams.length === 0) this.csiPrivate = String.fromCharCode(b);
      return;
    }
    if (b >= 0x20 && b <= 0x2f) {
      this.csiInter = String.fromCharCode(b);
      this.state = "csi-inter";
      return;
    }
    if (b >= 0x40 && b <= 0x7e) {
      this.state = "ground";
      if (this.csiInter !== "") {
        // 带中间字节的 CSI（DECSCUSR 等）：忽略
        this.csiInter = "";
        return;
      }
      this.dispatchCsi(String.fromCharCode(b));
      return;
    }
    if (b === 0x1b) {
      this.state = "esc";
      return;
    }
    if (b < 0x20) this.execControl(b);
    // >0x7f 忽略
  }

  private execControl(b: number): void {
    switch (b) {
      case 0x07: // BEL
        break;
      case 0x08: // BS
        if (this.curX > 0) this.curX--;
        this.wrapPending = false;
        break;
      case 0x09: // HT
        this.tabForward();
        break;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this.linefeed();
        break;
      case 0x0d: // CR
        this.curX = 0;
        this.wrapPending = false;
        break;
      default:
        break; // 其余 C0 忽略
    }
  }

  private tabForward(): void {
    this.wrapPending = false;
    for (let x = this.curX + 1; x < this.cols; x++) {
      if (this.tabStops.has(x)) {
        this.curX = x;
        return;
      }
    }
    this.curX = this.cols - 1;
  }

  private tabBackward(): void {
    this.wrapPending = false;
    for (let x = this.curX - 1; x >= 0; x--) {
      if (this.tabStops.has(x)) {
        this.curX = x;
        return;
      }
    }
    this.curX = 0;
  }

  // --- ESC 分发 ---

  private dispatchEsc(final: number): void {
    switch (final) {
      case 0x37: // '7' DECSC
        this.saveCursor();
        break;
      case 0x38: // '8' DECRC
        this.restoreCursor();
        break;
      case 0x44: // 'D' IND
        this.linefeed();
        break;
      case 0x4d: // 'M' RI
        if (this.curY === this.scrollTop) this.scrollDown(1);
        else if (this.curY > 0) this.curY--;
        break;
      case 0x45: // 'E' NEL
        this.curX = 0;
        this.linefeed();
        break;
      case 0x48: // 'H' HTS
        this.tabStops.add(this.curX);
        break;
      case 0x63: // 'c' RIS
        this.fullReset();
        break;
      case 0x5a: // 'Z' DECID → 应答 DA（兼容旧终端识别）
        this.pushResponse("\x1b[?1;2c");
        break;
      default:
        break; // = > ( ) 等忽略
    }
  }

  private saveCursor(): void {
    const cur = this.blankSaved();
    cur.x = this.curX;
    cur.y = this.curY;
    cur.fg = this.fg;
    cur.bg = this.bg;
    cur.flags = this.flags;
    cur.origin = this.originMode;
    cur.wrapPending = this.wrapPending;
    cur.scrollTop = this.scrollTop;
    cur.scrollBottom = this.scrollBottom;
    if (this.alt !== null) this.savedAlt = cur;
    else this.savedMain = cur;
  }

  private restoreCursor(): void {
    const cur = this.alt !== null ? this.savedAlt : this.savedMain;
    this.curX = Math.min(cur.x, this.cols - 1);
    this.curY = Math.min(cur.y, this.rows - 1);
    this.fg = cur.fg;
    this.bg = cur.bg;
    this.flags = cur.flags;
    this.originMode = cur.origin;
    this.wrapPending = false;
    this.scrollTop = Math.min(cur.scrollTop, this.rows - 1);
    this.scrollBottom = Math.max(this.scrollTop, Math.min(cur.scrollBottom, this.rows - 1));
    if (this.originMode && (this.curY < this.scrollTop || this.curY > this.scrollBottom)) {
      this.curY = this.scrollTop;
    }
  }

  private fullReset(): void {
    this.fg = TERM_DEFAULT_COLOR;
    this.bg = TERM_DEFAULT_COLOR;
    this.flags = 0;
    this.autowrap = true;
    this.wrapPending = false;
    this.originMode = false;
    this.cursorVisible = true;
    this.cursorKeysApp = false;
    this.bracketedPaste = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
    this.curX = 0;
    this.curY = 0;
    if (this.alt !== null) this.leaveAltScreen();
    this.screen = [];
    for (let i = 0; i < this.rows; i++) this.screen.push(this.blankLine());
    this.resetTabStops();
    this.savedMain = this.blankSaved();
    this.savedAlt = this.blankSaved();
  }

  // --- CSI 分发 ---

  private param(i: number, def: number): number {
    const raw = this.csiParams[i];
    if (raw === undefined) return def;
    const head = raw.split(":")[0]!;
    if (head === "") return def;
    const v = Number.parseInt(head, 10);
    if (!Number.isFinite(v)) return def;
    return v;
  }

  private dispatchCsi(final: string): void {
    const priv = this.csiPrivate;
    this.csiPrivate = "";
    switch (final) {
      case "A":
        this.moveCursorUp(this.param(0, 1));
        break;
      case "B":
        this.moveCursorDown(this.param(0, 1));
        break;
      case "C":
        this.curX = Math.min(this.cols - 1, this.curX + this.param(0, 1));
        break;
      case "D":
        this.curX = Math.max(0, this.curX - this.param(0, 1));
        break;
      case "E": // CNL
        this.moveCursorDown(this.param(0, 1));
        this.curX = 0;
        break;
      case "F": // CPL
        this.moveCursorUp(this.param(0, 1));
        this.curX = 0;
        break;
      case "G": // CHA
        this.curX = Math.max(0, Math.min(this.cols - 1, this.param(0, 1) - 1));
        break;
      case "H":
      case "f": { // CUP / HVP
        const row = this.param(0, 1) - 1;
        const col = this.param(1, 1) - 1;
        this.curX = Math.max(0, Math.min(this.cols - 1, col));
        if (this.originMode) {
          this.curY = Math.max(this.scrollTop, Math.min(this.scrollBottom, this.scrollTop + row));
        } else {
          this.curY = Math.max(0, Math.min(this.rows - 1, row));
        }
        this.wrapPending = false;
        break;
      }
      case "J":
        this.eraseDisplay(this.param(0, 0));
        break;
      case "K":
        this.eraseLine(this.param(0, 0));
        break;
      case "L": // IL
        if (this.inRegion()) this.insertLines(this.param(0, 1));
        break;
      case "M": // DL
        if (this.inRegion()) this.deleteLines(this.param(0, 1));
        break;
      case "P": // DCH
        if (this.inRegion()) this.deleteChars(this.param(0, 1));
        break;
      case "@": // ICH
        if (this.inRegion()) this.insertChars(this.param(0, 1));
        break;
      case "X": // ECH
        this.eraseChars(this.param(0, 1));
        break;
      case "S": // SU
        this.scrollUp(this.param(0, 1));
        break;
      case "T": // SD
        this.scrollDown(this.param(0, 1));
        break;
      case "Z": // CBT
        for (let i = 0; i < this.param(0, 1); i++) this.tabBackward();
        break;
      case "m": // SGR
        this.dispatchSgr();
        break;
      case "r": { // DECSTBM
        const top = this.param(0, 1) - 1;
        const bottom = this.param(1, this.rows) - 1;
        const t = Math.max(0, Math.min(this.rows - 2, top));
        const btm = Math.max(t + 1, Math.min(this.rows - 1, bottom));
        this.scrollTop = t;
        this.scrollBottom = btm;
        this.curX = 0;
        this.curY = this.originMode ? this.scrollTop : 0;
        this.wrapPending = false;
        break;
      }
      case "h":
      case "l":
        this.dispatchMode(final === "h", priv === "?");
        break;
      case "s": // SCOSC
        this.saveCursor();
        break;
      case "u": // SCORC
        this.restoreCursor();
        break;
      case "n": { // DSR
        const n = this.param(0, -1);
        if (n === 5) {
          this.pushResponse("\x1b[0n");
        } else if (n === 6) {
          const row = (this.originMode ? this.curY - this.scrollTop : this.curY) + 1;
          this.pushResponse(`\x1b[${row};${this.curX + 1}R`);
        }
        break;
      }
      case "c": // DA（无 private 前缀）
        if (priv === "") this.pushResponse("\x1b[?1;2c");
        break;
      case "g": // TBC
        if (this.param(0, 0) === 0) this.tabStops.delete(this.curX);
        else this.tabStops.clear();
        break;
      default:
        break; // q t 等忽略
    }
  }

  private moveCursorUp(n: number): void {
    const top = this.originMode ? this.scrollTop : 0;
    this.curY = Math.max(top, this.curY - n);
  }

  private moveCursorDown(n: number): void {
    const bottom = this.originMode ? this.scrollBottom : this.rows - 1;
    this.curY = Math.min(bottom, this.curY + n);
  }

  private inRegion(): boolean {
    return this.curY >= this.scrollTop && this.curY <= this.scrollBottom;
  }

  private insertLines(n: number): void {
    const count = Math.min(n, this.scrollBottom - this.curY + 1);
    for (let i = 0; i < count; i++) {
      for (let y = this.scrollBottom; y > this.curY; y--) this.screen[y] = this.screen[y - 1]!;
      this.screen[this.curY] = this.blankLine();
    }
  }

  private deleteLines(n: number): void {
    const count = Math.min(n, this.scrollBottom - this.curY + 1);
    for (let i = 0; i < count; i++) {
      for (let y = this.curY; y < this.scrollBottom; y++) this.screen[y] = this.screen[y + 1]!;
      this.screen[this.scrollBottom] = this.blankLine();
    }
  }

  private insertChars(n: number): void {
    const line = this.screen[this.curY]!;
    const count = Math.min(n, this.cols - this.curX);
    line.text =
      line.text.slice(0, this.curX) + " ".repeat(count) + line.text.slice(this.curX, this.cols - count);
    line.fg = shiftRight(line.fg, this.curX, count, TERM_DEFAULT_COLOR);
    line.bg = shiftRight(line.bg, this.curX, count, TERM_DEFAULT_COLOR);
    line.flags = shiftRight(line.flags, this.curX, count, 0);
  }

  private deleteChars(n: number): void {
    const line = this.screen[this.curY]!;
    const count = Math.min(n, this.cols - this.curX);
    line.text =
      line.text.slice(0, this.curX) + line.text.slice(this.curX + count) + " ".repeat(count);
    for (let x = this.curX; x < this.cols; x++) {
      const src = x + count;
      if (src < this.cols) {
        line.fg[x] = line.fg[src]!;
        line.bg[x] = line.bg[src]!;
        line.flags[x] = line.flags[src]!;
      } else {
        line.fg[x] = TERM_DEFAULT_COLOR;
        line.bg[x] = this.bg; // BCE
        line.flags[x] = 0;
      }
    }
  }

  private eraseChars(n: number): void {
    const line = this.screen[this.curY]!;
    const count = Math.min(n, this.cols - this.curX);
    line.text = line.text.slice(0, this.curX) + " ".repeat(count) + line.text.slice(this.curX + count);
    for (let x = this.curX; x < this.curX + count; x++) {
      line.fg[x] = TERM_DEFAULT_COLOR;
      line.bg[x] = this.bg;
      line.flags[x] = 0;
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 3) {
      this.scrollback = [];
      this.eraseDisplay(2);
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.curY + 1; y < this.rows; y++) this.screen[y] = this.blankLine();
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.curY; y++) this.screen[y] = this.blankLine();
    } else if (mode === 2) {
      for (let y = 0; y < this.rows; y++) this.screen[y] = this.blankLine();
    }
  }

  private eraseLine(mode: number): void {
    const line = this.screen[this.curY]!;
    const from = mode === 0 ? this.curX : 0;
    const to = mode === 1 ? this.curX : this.cols - 1;
    const count = to - from + 1;
    line.text = line.text.slice(0, from) + " ".repeat(count) + line.text.slice(to + 1);
    for (let x = from; x <= to; x++) {
      line.fg[x] = TERM_DEFAULT_COLOR;
      line.bg[x] = this.bg; // BCE
      line.flags[x] = 0;
    }
  }

  // --- SGR ---

  private dispatchSgr(): void {
    if (this.csiParams.length === 0) {
      this.resetAttrs();
      return;
    }
    const params = this.csiParams;
    for (let i = 0; i < params.length; i++) {
      const token = params[i] ?? "";
      if (token === "") {
        this.resetAttrs();
        continue;
      }
      const parts = token.split(":");
      const v = Number.parseInt(parts[0]!, 10);
      if (!Number.isFinite(v)) continue;
      switch (v) {
        case 0:
          this.resetAttrs();
          break;
        case 1:
          this.flags |= CELL_BOLD;
          break;
        case 3:
          this.flags |= CELL_ITALIC;
          break;
        case 4:
          this.flags |= CELL_UNDERLINE;
          break;
        case 7:
          this.flags |= CELL_REVERSE;
          break;
        case 21:
        case 22:
          this.flags &= ~CELL_BOLD;
          break;
        case 23:
          this.flags &= ~CELL_ITALIC;
          break;
        case 24:
          this.flags &= ~CELL_UNDERLINE;
          break;
        case 27:
          this.flags &= ~CELL_REVERSE;
          break;
        case 30:
        case 31:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
          this.fg = v - 30;
          break;
        case 38:
        case 48: {
          const color = this.extColor(i, parts);
          if (color !== null) {
            if (v === 38) this.fg = color.color;
            else this.bg = color.color;
            i = color.consumed;
          }
          break;
        }
        case 39:
          this.fg = TERM_DEFAULT_COLOR;
          break;
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
          this.bg = v - 40;
          break;
        case 49:
          this.bg = TERM_DEFAULT_COLOR;
          break;
        case 90:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 97:
          this.fg = v - 90 + 8;
          break;
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
          this.bg = v - 100 + 8;
          break;
        default:
          break;
      }
    }
  }

  /** 38/48 扩展色：分号形态 `38;5;N` / `38;2;R;G;B` 与冒号形态 `38:5:N`。 */
  private extColor(i: number, parts: string[]): { color: number; consumed: number } | null {
    if (parts.length >= 2) {
      // 冒号形态：全部在本 token 内
      const mode = Number.parseInt(parts[1]!, 10);
      if (mode === 5 && parts.length >= 3) {
        const idx = Number.parseInt(parts[2]!, 10);
        if (Number.isFinite(idx)) return { color: Math.min(255, Math.max(0, idx)), consumed: i };
      } else if (mode === 2 && parts.length >= 5) {
        const r = Number.parseInt(parts[2]!, 10);
        const g = Number.parseInt(parts[3]!, 10);
        const b = Number.parseInt(parts[4]!, 10);
        if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
          return { color: termRgb(r, g, b), consumed: i };
        }
      }
      return null;
    }
    // 分号形态：读取后续 token
    const mode = this.param(i + 1, -1);
    if (mode === 5) {
      const idx = this.param(i + 2, -1);
      if (idx < 0) return null;
      return { color: Math.min(255, idx), consumed: i + 2 };
    }
    if (mode === 2) {
      const r = this.param(i + 2, -1);
      const g = this.param(i + 3, -1);
      const b = this.param(i + 4, -1);
      if (r < 0 || g < 0 || b < 0) return null;
      return { color: termRgb(r, g, b), consumed: i + 4 };
    }
    return null;
  }

  private resetAttrs(): void {
    this.fg = TERM_DEFAULT_COLOR;
    this.bg = TERM_DEFAULT_COLOR;
    this.flags = 0;
  }

  // --- DECSET / DECRST ---

  private dispatchMode(set: boolean, priv: boolean): void {
    if (!priv) return; // ANSI 模式（IRM 等）：忽略
    const n = this.param(0, -1);
    switch (n) {
      case 1: // DECCKM
        this.cursorKeysApp = set;
        break;
      case 6: // DECOM
        this.originMode = set;
        this.curX = 0;
        this.curY = set ? this.scrollTop : 0;
        break;
      case 7: // DECAWM
        this.autowrap = set;
        if (!set) this.wrapPending = false;
        break;
      case 25: // 光标可见
        this.cursorVisible = set;
        break;
      case 47: // 备用屏（不清屏）
        if (set && this.alt === null) this.enterAltScreen();
        else if (!set && this.alt !== null) this.leaveAltScreen();
        break;
      case 1047: // 备用屏（进入清屏——新屏本身即空）
        if (set && this.alt === null) this.enterAltScreen();
        else if (!set && this.alt !== null) this.leaveAltScreen();
        break;
      case 1049: // 备用屏 + 存光标 + 清屏
        if (set && this.alt === null) {
          this.saveCursor();
          this.enterAltScreen();
        } else if (!set && this.alt !== null) {
          this.leaveAltScreen();
          this.restoreCursor();
        }
        break;
      case 2004: // 括号粘贴
        this.bracketedPaste = set;
        break;
      default:
        break;
    }
  }

  private enterAltScreen(): void {
    this.alt = { screen: this.screen, saved: this.currentSaved() };
    this.screen = [];
    for (let i = 0; i < this.rows; i++) this.screen.push(this.blankLine());
    this.curX = 0;
    this.curY = 0;
    this.wrapPending = false;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;
  }

  private leaveAltScreen(): void {
    const saved = this.alt?.saved;
    if (this.alt) this.screen = this.alt.screen;
    this.alt = null;
    if (saved) {
      this.curX = Math.min(saved.x, this.cols - 1);
      this.curY = Math.min(saved.y, this.rows - 1);
      this.fg = saved.fg;
      this.bg = saved.bg;
      this.flags = saved.flags;
      this.originMode = saved.origin;
      this.wrapPending = false;
      this.scrollTop = Math.min(saved.scrollTop, this.rows - 1);
      this.scrollBottom = Math.max(this.scrollTop, Math.min(saved.scrollBottom, this.rows - 1));
    }
  }

  private currentSaved(): SavedState {
    return {
      x: this.curX,
      y: this.curY,
      fg: this.fg,
      bg: this.bg,
      flags: this.flags,
      origin: this.originMode,
      wrapPending: this.wrapPending,
      scrollTop: this.scrollTop,
      scrollBottom: this.scrollBottom,
    };
  }

  private pushResponse(text: string): void {
    this.responses.push(strToBytes(text));
  }

  /** 取走应答字节（DSR/DA 等），app 层负责写到当前连接（SPEC §3.4 钩子通道）。 */
  takeResponses(): Uint8Array[] {
    const out = this.responses;
    this.responses = [];
    return out;
  }

  // --- 输入编码（按键/粘贴 → 字节，SPEC §3.4） ---

  /**
   * 按键 → 待发送字节。返回 null = 该键不产生输出（交给 UI）。
   * 形态对齐 xterm：方向键 CSI A–D（DECCKM 应用态用 SS3）、Home/End CSI H/F、
   * PageUp/PageDown/Insert/Delete CSI n~、F1–F4 SS3 P–S、F5+ CSI n~；
   * Backspace 发 0x7F，Enter 发 0x0D，Ctrl+字母发控制码，Alt 前缀 ESC。
   */
  keyBytes(key: string, mods: TermKeyMods = {}): Uint8Array | null {
    if (key.length === 1) {
      const code = key.charCodeAt(0);
      if (mods.ctl) {
        const ctrl = ctrlCode(code);
        if (ctrl !== null) return bytesOf(mods.alt ? [0x1b, ctrl] : [ctrl]);
      }
      if (mods.alt) return bytesOf([0x1b, code]);
      return bytesOf([code]);
    }
    switch (key) {
      case "Enter":
        return bytesOf(mods.alt ? [0x1b, 0x0d] : [0x0d]);
      case "Backspace":
        return bytesOf(mods.alt ? [0x1b, 0x7f] : [0x7f]);
      case "Tab":
        return bytesOf(mods.sh ? [0x1b, 0x5b, 0x5a] : [0x09]);
      case "Escape":
        return bytesOf([0x1b]);
      case "Up":
      case "Down":
      case "Right":
      case "Left": {
        const ch = { Up: "A", Down: "B", Right: "C", Left: "D" }[key]!;
        return this.cursorKeysApp
          ? bytesOf([0x1b, 0x4f, ch.charCodeAt(0)])
          : bytesOf([0x1b, 0x5b, ch.charCodeAt(0)]);
      }
      case "Home":
      case "End": {
        const ch = key === "Home" ? "H" : "F";
        return this.cursorKeysApp
          ? bytesOf([0x1b, 0x4f, ch.charCodeAt(0)])
          : bytesOf([0x1b, 0x5b, ch.charCodeAt(0)]);
      }
      case "Insert":
        return tilde(2);
      case "Delete":
        return tilde(3);
      case "PageUp":
        return tilde(5);
      case "PageDown":
        return tilde(6);
      case "F1":
        return bytesOf([0x1b, 0x4f, 0x50]);
      case "F2":
        return bytesOf([0x1b, 0x4f, 0x51]);
      case "F3":
        return bytesOf([0x1b, 0x4f, 0x52]);
      case "F4":
        return bytesOf([0x1b, 0x4f, 0x53]);
      case "F5":
        return tilde(15);
      case "F6":
        return tilde(17);
      case "F7":
        return tilde(18);
      case "F8":
        return tilde(19);
      case "F9":
        return tilde(20);
      case "F10":
        return tilde(21);
      case "F11":
        return tilde(23);
      case "F12":
        return tilde(24);
      default:
        return null;
    }
  }

  /** 文本（粘贴/输入法提交）→ 待发送字节；?2004 开启时包括号粘贴标记。 */
  pasteBytes(text: string): Uint8Array {
    const body = strToBytes(text);
    if (!this.bracketedPaste || body.byteLength === 0) return body;
    const head = strToBytes("\x1b[200~");
    const tail = strToBytes("\x1b[201~");
    const out = new Uint8Array(head.byteLength + body.byteLength + tail.byteLength);
    out.set(head, 0);
    out.set(body, head.byteLength);
    out.set(tail, head.byteLength + body.byteLength);
    return out;
  }

  /** 测试便利：当前屏幕文本（每行去尾部空白）。 */
  screenText(): string {
    const out: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      out.push((this.screen[y]!.text as string).replace(/[ ]+$/, ""));
    }
    return out.join("\n");
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function leadBytes(b: number): number {
  if ((b & 0xe0) === 0xc0) return 2;
  if ((b & 0xf0) === 0xe0) return 3;
  if ((b & 0xf8) === 0xf0) return 4;
  return 1;
}

function decodeCp(seq: number[]): number {
  const need = leadBytes(seq[0]!);
  let cp = seq[0]! & (0xff >> (need + 1));
  for (let k = 1; k < need; k++) cp = (cp << 6) | (seq[k]! & 0x3f);
  return cp;
}

function ctrlCode(code: number): number | null {
  if (code >= 0x61 && code <= 0x7a) return code - 0x60; // a-z → 0x01–0x1A
  if (code >= 0x41 && code <= 0x5a) return code - 0x40; // A-Z
  switch (code) {
    case 0x40: // @
    case 0x20: // Space
      return 0x00;
    case 0x5b: // [
      return 0x1b;
    case 0x5c: // \
      return 0x1c;
    case 0x5d: // ]
      return 0x1d;
    case 0x5e: // ^
      return 0x1e;
    case 0x5f: // _
      return 0x1f;
    default:
      return null;
  }
}

function bytesOf(codes: number[]): Uint8Array {
  return new Uint8Array(codes);
}

function tilde(n: number): Uint8Array {
  return bytesOf([0x1b, 0x5b, ...strToBytes(String(n)), 0x7e]);
}

function replaceAt(text: string, x: number, ch: string): string {
  return text.slice(0, x) + ch + text.slice(x + 1);
}

function fillU32(src: Uint32Array, pad: number, fill: number): Uint32Array {
  const out = new Uint32Array(src.length + pad);
  out.set(src);
  out.fill(fill, src.length);
  return out;
}

function fillU8(src: Uint8Array, pad: number, fill: number): Uint8Array {
  const out = new Uint8Array(src.length + pad);
  out.set(src);
  out.fill(fill, src.length);
  return out;
}

function shiftRight<T extends Uint32Array | Uint8Array>(src: T, at: number, count: number, fill: number): T {
  const out = src.slice() as T;
  for (let x = out.length - 1; x >= at + count; x--) out[x] = out[x - count]!;
  for (let x = at; x < Math.min(out.length, at + count); x++) out[x] = fill;
  return out;
}
