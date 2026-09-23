/**
 * 接收区日志视图（SPEC §3.3）：消息总线 → 格式化显示行。
 * - 数据源是 core 消息总线（单一事实源）：每帧 sync() 从总线环形缓冲
 *   peek 出 id > lastSeenId 的新消息；暂停 = 不 sync，恢复后自然追上
 *   （缓冲有界，追不上即丢最旧——sync 按 id 断档返回 lost，由 app 层记 sys 提示）。
 * - 显示行与原始历史有界（maxRows/maxBytes，可经 configure() 运行时调整；
 *   默认 500 行 / 256 KiB，SPEC §3.3）。
 * - hex/escape/timestamp/color 切换时用保留的最近消息全量重排版；
 *   color（ANSI 颜色转义）开启时内容剥离 SGR 序列并产出逐字符前景色
 *   （row.fg，编码同 core/term.ts），扫描状态从历史头检查点重放。
 * - 自动换行由注入的测量函数完成（app 侧 getOps().measureText），
 *   核心层保持纯 TS：无测量函数 = 不换行。
 */
import type { MessageBus } from "./bus";
import { DEFAULT_MAX_BYTES, type Message, type MessageDir } from "./message";
import { utf8Decode } from "./codec";
import { ParamError } from "./errors";
import { TERM_DEFAULT_COLOR } from "./term";
import { AnsiFgScanner } from "./ansicolor";
import { formatLogParts, formatTimestamp, type LogFormatOptions, type LogLineLabels } from "./format";

export interface LogViewOptions {
  /** 显示行上限，默认 500（SPEC §3.3：可视窗口，数据本体在总线/环形缓冲） */
  maxRows?: number;
  /** 原始历史字节预算，默认 256 KiB（含隐藏 TX）。 */
  maxBytes?: number;
  /** 是否显示 TX 行（SPEC §3.5：MCP server 未运行时接收区只显示收与
   *  系统事件，TX 行整行隐藏）；默认 true */
  showTx?: boolean;
  /** 文本宽度测量（px）；缺省不换行 */
  measure?: (text: string) => number;
  /** 换行宽度（px）；<= 0 不换行。可为响应式 getter */
  wrapWidth?: () => number;
}

/** 一条显示行（固定行高渲染，app 侧按 key/prefixKind 着色）。 */
export interface LogRow {
  key: number;
  /** 来源消息 id（同一消息可折成多行） */
  msgId: number;
  dir: MessageDir;
  /** 方向/来源前缀（首行 chunk 才有；渲染拆出来单独着色，SPEC §3.7） */
  prefix: string;
  /** 前缀在 text 中的字符下标（时间戳开启时为时间戳段长度，否则 0；
   *  渲染按 [0,prefixAt) / prefix / 其后 三段拆分着色） */
  prefixAt: number;
  /** 前缀类别（前缀着色 token 选择；续行/无前缀为 ""） */
  prefixKind: "rx" | "tx-manual" | "tx-mcp" | "sys" | "";
  text: string;
  /** 颜色转义开启时的逐字符前景色（与 text 等长，编码同 core/term.ts；
   *  TERM_DEFAULT_COLOR = 默认，渲染层取主题正文色——深色白/浅色黑）。
   *  null = 未开启颜色转义或 sys 行（渲染按方向色）。前缀区恒为默认色
   *  （渲染层按前缀类别着色）。 */
  fg: Uint32Array | null;
}

/** 带前景色的一段文本（拆行/折行的切片单位）。 */
interface FgPiece {
  text: string;
  fg: Uint32Array | null;
}

/**
 * 按硬换行拆分（`\r\n` / `\n` / `\r`，SPEC §3.3）并同步切片前景色数组：
 * 数据帧内嵌换行符必须拆成独立显示行——固定行高的行内直接渲染多行文本
 * 会溢出，与后续行重叠。帧末换行不产生多余空行；空串仍返回 [""]（保留
 * 该帧的空行占位）。
 */
function splitFgLines(text: string, fg: Uint32Array | null): FgPiece[] {
  const out: FgPiece[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n" && text[i] !== "\r") continue;
    const end = i + (text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1);
    out.push({ text: text.slice(start, i), fg: fg === null ? null : fg.subarray(start, i) });
    i = end - 1;
    start = end;
  }
  if (start < text.length || out.length === 0) {
    out.push({ text: text.slice(start), fg: fg === null ? null : fg.subarray(start) });
  }
  return out;
}

/**
 * 按硬换行拆分（`\r\n` / `\n` / `\r`，SPEC §3.3）：数据帧内嵌换行符必须拆成
 * 独立显示行——固定行高的行内直接渲染多行文本会溢出，与后续行重叠。
 * 帧末换行不产生多余空行；空串仍返回 [""]（保留该帧的空行占位）。
 */
export function splitHardLines(text: string): string[] {
  return splitFgLines(text, null).map((p) => p.text);
}

export class LogView {
  rows: LogRow[] = [];
  private entries: Message[] = [];
  private retainedBytes = 0;
  private headAll = new AnsiFgScanner();
  private headRx = new AnsiFgScanner();
  private colorize = new AnsiFgScanner();
  private deferred = false;
  private dirty = false;
  private layoutWidth = 0;
  private lastMsgId = 0;
  private rowSeq = 0;
  private format: LogFormatOptions;
  private labels: LogLineLabels;
  private showTx: boolean;
  private maxRows: number;
  private maxBytes: number;
  private readonly measure?: (text: string) => number;
  private readonly wrapWidth?: () => number;
  private widthCache = new Map<string, number>();

  constructor(format: LogFormatOptions, labels: LogLineLabels, opts: LogViewOptions = {}) {
    this.format = format;
    this.labels = labels;
    this.showTx = opts.showTx ?? true;
    this.maxRows = opts.maxRows ?? 500;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(this.maxRows) || this.maxRows <= 0 || !Number.isFinite(this.maxBytes) || this.maxBytes <= 0) {
      throw new ParamError("PARAM_INVALID", "log history limits must be positive (maxRows integer)");
    }
    this.measure = opts.measure;
    this.wrapWidth = opts.wrapWidth;
    this.layoutWidth = this.wrapWidth?.() ?? 0;
  }

  /** 显示开关或前缀文案变化：全量重排版保留的消息。 */
  setFormat(format: LogFormatOptions, labels: LogLineLabels): void {
    this.configure(format, labels);
  }

  /** 一次提交显示设置与历史上限；只有度量语义改变才清字符宽度缓存。
   *  上限缩小立即裁剪历史（不可逆，SPEC §3.3/§3.8）。 */
  configure(format: LogFormatOptions, labels: LogLineLabels,
    opts: { showTx?: boolean; remeasure?: boolean; maxRows?: number; maxBytes?: number } = {}): void {
    if (opts.maxRows !== undefined && (!Number.isInteger(opts.maxRows) || opts.maxRows <= 0)) {
      throw new ParamError("PARAM_INVALID", "log history limits must be positive (maxRows integer)");
    }
    if (opts.maxBytes !== undefined && (!Number.isFinite(opts.maxBytes) || opts.maxBytes <= 0)) {
      throw new ParamError("PARAM_INVALID", "log history limits must be positive (maxBytes)");
    }
    const limitsChanged = (opts.maxRows !== undefined && opts.maxRows !== this.maxRows)
      || (opts.maxBytes !== undefined && opts.maxBytes !== this.maxBytes);
    const changed = (Object.keys(format) as (keyof LogFormatOptions)[]).some(k => format[k] !== this.format[k])
      || (Object.keys(labels) as (keyof LogLineLabels)[]).some(k => labels[k] !== this.labels[k])
      || (opts.showTx !== undefined && opts.showTx !== this.showTx)
      || opts.remeasure || limitsChanged || this.layoutWidth !== (this.wrapWidth?.() ?? 0);
    if (!changed) return;
    this.format = { ...format };
    this.labels = { ...labels };
    if (opts.showTx !== undefined) this.showTx = opts.showTx;
    if (opts.remeasure) this.widthCache.clear();
    if (opts.maxRows !== undefined) this.maxRows = opts.maxRows;
    if (opts.maxBytes !== undefined) this.maxBytes = opts.maxBytes;
    if (limitsChanged) this.trim();
    this.rebuild();
  }

  /** TX 行显隐切换（MCP server 启停联动，SPEC §3.5）：全量重排版；
   *  隐藏期间消息仍进 entries，重开即恢复。 */
  setShowTx(show: boolean): void {
    if (show === this.showTx) return;
    this.showTx = show;
    this.rebuild();
  }

  /** 视口宽度变化等：全量重排版（换行结果可能变化）。 */
  refresh(): void {
    this.rebuild();
  }

  /** 测量函数语义变化（如字号切换）：宽度缓存随之失效，清缓存并重排版。 */
  remeasure(): void {
    this.widthCache.clear();
    this.rebuild();
  }

  /**
   * 从总线同步新消息（每帧调用）。返回行数净增量 added、内容变化 changed 与
   * 因环形缓冲裁剪而未能显示的帧数 lost（id 断档，如暂停期间流量
   * 超过缓冲容量）。
   * 不清空已见 id：清屏用 clear()。
   */
  sync(bus: MessageBus, visible = true): { added: number; lost: number; changed: boolean } {
    this.deferred = !visible;
    const before = this.rows.length;
    const first = this.rows[0];
    const last = this.rows[this.rows.length - 1];
    let lost = 0;
    let seen = false;
    for (const msg of bus.buffer.peek()) {
      if (msg.id <= this.lastMsgId) continue;
      if (!seen) lost = Math.max(0, msg.id - this.lastMsgId - 1);
      seen = true;
      this.lastMsgId = msg.id;
      this.entries.push(msg);
      this.retainedBytes += msg.payload.byteLength;
      this.trim();
      if (this.deferred || this.dirty || msg.payload.byteLength > this.maxBytes) this.dirty = true;
      else this.appendRows(msg);
    }
    if (visible && this.dirty) this.rebuild();
    const changed = visible && (first !== this.rows[0] || last !== this.rows[this.rows.length - 1]);
    return { added: this.rows.length - before, lost, changed };
  }

  /** 清屏：丢全部行；upToMsgId 通常为当前 lastMsgId，防止旧消息重新出现。 */
  clear(upToMsgId?: number): void {
    this.rows = [];
    this.entries = [];
    this.retainedBytes = 0;
    this.headAll = new AnsiFgScanner();
    this.headRx = new AnsiFgScanner();
    this.colorize = new AnsiFgScanner();
    this.dirty = false;
    this.widthCache.clear();
    if (upToMsgId !== undefined) this.lastMsgId = Math.max(this.lastMsgId, upToMsgId);
  }

  get lastSeenMsgId(): number {
    return this.lastMsgId;
  }

  private trim(): void {
    let count = 0;
    while (this.entries.length - count > this.maxRows || this.retainedBytes > this.maxBytes) {
      const msg = this.entries[count++]!;
      this.retainedBytes -= msg.payload.byteLength;
      if (msg.dir !== "sys") {
        const text = utf8Decode(msg.payload);
        this.headAll.feed(text, false);
        if (msg.dir !== "tx") this.headRx.feed(text, false);
      }
    }
    if (count) {
      this.entries.splice(0, count);
      const oldest = this.entries[0]?.id ?? Infinity;
      this.rows = this.rows.filter(row => row.msgId >= oldest);
    }
  }

  private rebuild(): void {
    if (this.deferred) { this.dirty = true; return; }
    this.rows = [];
    this.layoutWidth = this.wrapWidth?.() ?? 0;
    this.colorize = (this.showTx ? this.headAll : this.headRx).clone();
    for (const msg of this.entries) this.appendRows(msg);
    this.dirty = false;
  }

  private appendRows(msg: Message): void {
    if (!this.showTx && msg.dir === "tx") return;
    const rows = this.rows;
    const colorize = this.format.color ? this.colorize : null;
    const { ts, prefix, content } = formatLogParts(msg, this.format, this.labels);
    const prefixKind: LogRow["prefixKind"] =
      msg.dir === "rx" ? "rx" : msg.dir === "sys" ? "sys" : msg.source === "mcp" ? "tx-mcp" : "tx-manual";
    const head = prefix === "" ? ts : `${ts}${prefix} `;
    // 前缀在行内的真实下标：时间戳段 `[YYYY-MM-DD HH:MM:SS.mmm] ` 恒为
    // formatTimestamp 长度 + 3（左右括号 + 分隔空格），与拼行一致
    const prefixAt = this.format.timestamp && prefix !== "" ? formatTimestamp(msg.ts).length + 3 : 0;
    const parse = colorize !== null && msg.dir !== "sys"
      ? (this.format.hex || this.format.escape ? new AnsiFgScanner() : colorize).feed(content) : null;
    const line = head + (parse !== null ? parse.plain : content);
    let fg: Uint32Array | null = null;
    if (parse !== null) {
      // 时间戳/前缀区恒默认色（渲染层按前缀类别着色），内容区用解析结果
      fg = new Uint32Array(line.length).fill(TERM_DEFAULT_COLOR);
      fg.set(parse.fg, head.length);
    }
    let first = true;
    // 先按硬换行拆行（帧内嵌 \r\n/\n/\r），再对每条逻辑行做宽度折行；
    // 拆分/折行出的后续行均无方向前缀（SPEC §3.3/§3.7）
    for (const piece of splitFgLines(line, fg)) {
      for (const chunk of this.wrap(piece.text, piece.fg)) {
        rows.push({
          key: this.rowSeq++,
          msgId: msg.id,
          dir: msg.dir,
          prefix: first ? prefix : "",
          prefixAt: first ? prefixAt : 0,
          prefixKind: first ? prefixKind : "",
          text: chunk.text,
          fg: chunk.fg,
        });
        first = false;
      }
    }
    // 行数上限兜底（换行可能使行数超过消息数上限）
    if (rows.length > this.maxRows) rows.splice(0, rows.length - this.maxRows);
    this.rows = rows;
  }

  /** 贪心按字符折行；无测量或宽度非法时不折行。宽度缓存按字符；
   *  前景色数组随切片同步切分（子数组共享底层缓冲，不拷贝）。 */
  private wrap(text: string, fg: Uint32Array | null): FgPiece[] {
    const width = this.wrapWidth?.() ?? 0;
    if (!this.measure || width <= 0) return [{ text, fg }];
    const out: FgPiece[] = [];
    let current = "";
    let currentW = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      let w = this.widthCache.get(ch);
      if (w === undefined) {
        w = this.measure(ch);
        this.widthCache.set(ch, w);
      }
      if (currentW + w > width && current !== "") {
        out.push({ text: current, fg: fg === null ? null : fg.subarray(start, i) });
        current = ch;
        currentW = w;
        start = i;
      } else {
        current += ch;
        currentW += w;
      }
    }
    out.push({ text: current, fg: fg === null ? null : fg.subarray(start) });
    return out;
  }
}
