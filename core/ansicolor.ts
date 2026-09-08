/**
 * 接收区 ANSI 颜色解析（SPEC §3.3「ANSI 颜色开关」）：逐消息喂入文本，
 * 剥离其中完整的 SGR（`ESC[...m`）序列并产出每字符前景色，供日志行按色渲染。
 * - 颜色编码复用 core/term.ts：TERM_DEFAULT_COLOR 哨兵 / 调色板 0–255 /
 *   24-bit RGB（termRgb）。
 * - 前景色状态跨消息持续（SGR 不逐行/逐帧复位，对齐终端语义）；
 *   行尾被截断的不完整 CSI 序列缓存到下一次 feed 续接（跨包缓冲，SPEC §3.3）。
 * - 仅解析前景色（30–37 / 90–97 / 38 / 39 / 0）；背景与加粗等属性忽略，
 *   非 SGR 的 CSI 与非 CSI 的 ESC 序列按原样保留（不吞字）。
 */
import { TERM_DEFAULT_COLOR, termRgb } from "./term";

/** 一次 feed 的解析结果：plain 为剥离 SGR 后的文本，fg 与 plain 等长（逐字符前景色）。 */
export interface AnsiFgText {
  plain: string;
  fg: Uint32Array;
}

export class AnsiFgScanner {
  private fg: number = TERM_DEFAULT_COLOR;
  /** 上一帧行尾截断的不完整 CSI 序列（含起始 ESC；下一帧续接）。 */
  private pending = "";

  feed(text: string): AnsiFgText {
    const s = this.pending + text;
    this.pending = "";
    const chars: string[] = [];
    const colors: number[] = [];
    const keep = (from: number, to: number): void => {
      for (let k = from; k < to; k++) {
        chars.push(s[k]!);
        colors.push(this.fg);
      }
    };
    let i = 0;
    while (i < s.length) {
      if (s[i] !== "\x1b") {
        chars.push(s[i]!);
        colors.push(this.fg);
        i++;
        continue;
      }
      if (i + 1 >= s.length) {
        this.pending = s.slice(i); // 孤 ESC 在帧尾截断：缓存待续
        break;
      }
      if (s[i + 1] !== "[") {
        keep(i, i + 2); // 非 CSI 的 ESC 序列（如 ESC c）：原样保留
        i += 2;
        continue;
      }
      // CSI：扫描到 0x40–0x7E 的 final byte 为止
      let j = i + 2;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) break;
        j++;
      }
      if (j >= s.length) {
        this.pending = s.slice(i); // CSI 截断：整段缓存到下一帧
        break;
      }
      if (s[j] === "m") {
        this.applySgr(s.slice(i + 2, j)); // SGR：应用前景色并剥离
      } else {
        keep(i, j + 1); // 其它 CSI（清屏/光标移动等）：原样保留
      }
      i = j + 1;
    }
    return { plain: chars.join(""), fg: Uint32Array.from(colors) };
  }

  /** SGR 参数 → 前景色。空 body / 0 / 39 复位；仅前景，背景类参数照常消费。 */
  private applySgr(body: string): void {
    if (body === "") {
      this.fg = TERM_DEFAULT_COLOR; // ESC[m == ESC[0m
      return;
    }
    const tokens = body.split(";");
    for (let i = 0; i < tokens.length; i++) {
      const parts = tokens[i]!.split(":");
      const v = Number.parseInt(parts[0]!, 10);
      if (!Number.isFinite(v)) {
        if (parts[0] === "") this.fg = TERM_DEFAULT_COLOR; // 空参数 = 0（对齐 term.ts）
        continue;
      }
      if (v === 0 || v === 39) this.fg = TERM_DEFAULT_COLOR;
      else if (v >= 30 && v <= 37) this.fg = v - 30;
      else if (v >= 90 && v <= 97) this.fg = v - 90 + 8;
      else if (v === 38 || v === 48) {
        const ext = this.extColor(parts, tokens, i);
        if (ext.color !== null && v === 38) this.fg = ext.color;
        i = ext.consumed;
      }
      // 40–47/49/100–107 背景、1/3/4/7 等属性：不影响前景
    }
  }

  /** 38/48 扩展色：分号形态 `38;5;N`/`38;2;R;G;B` 与冒号形态 `38:5:N`/
   *  `38:2:R:G:B`；返回消费到的 token 下标（背景 48 也必须消费，防止
   *  其颜色参数被误读成 SGR 码）。非法/缺参不消费。 */
  private extColor(
    parts: string[],
    tokens: string[],
    i: number,
  ): { color: number | null; consumed: number } {
    const num = (s: string | undefined): number => {
      if (s === undefined || s === "") return Number.NaN;
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) ? n : Number.NaN;
    };
    if (parts.length >= 2) {
      // 冒号形态：全部在本 token 内（对齐 term.ts extColor）
      const mode = num(parts[1]);
      if (mode === 5 && parts.length >= 3) {
        const idx = num(parts[2]);
        if (!Number.isNaN(idx)) return { color: Math.min(255, Math.max(0, idx)), consumed: i };
      } else if (mode === 2 && parts.length >= 5) {
        const r = num(parts[2]);
        const g = num(parts[3]);
        const b = num(parts[4]);
        if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
          return { color: termRgb(r, g, b), consumed: i };
        }
      }
      return { color: null, consumed: i };
    }
    // 分号形态：读取后续 token
    const mode = num(tokens[i + 1]);
    if (mode === 5) {
      const idx = num(tokens[i + 2]);
      if (!Number.isNaN(idx)) return { color: Math.min(255, Math.max(0, idx)), consumed: i + 2 };
    } else if (mode === 2) {
      const r = num(tokens[i + 2]);
      const g = num(tokens[i + 3]);
      const b = num(tokens[i + 4]);
      if (!Number.isNaN(r) && !Number.isNaN(g) && !Number.isNaN(b)) {
        return { color: termRgb(r, g, b), consumed: i + 4 };
      }
    }
    return { color: null, consumed: i };
  }
}
