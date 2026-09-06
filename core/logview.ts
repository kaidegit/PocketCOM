/**
 * 接收区日志视图（SPEC §3.3）：消息总线 → 格式化显示行。
 * - 数据源是 core 消息总线（单一事实源）：每帧 sync() 从总线环形缓冲
 *   peek 出 id > lastSeenId 的新消息；暂停 = 不 sync，恢复后自然追上
 *   （缓冲有界，追不上即丢最旧——sync 按 id 断档返回 lost，由 app 层记 sys 提示）。
 * - 显示行有界（默认 500 行），溢出丢最旧。
 * - hex/escape/timestamp 切换时用保留的最近消息全量重排版。
 * - 自动换行由注入的测量函数完成（app 侧 getOps().measureText），
 *   核心层保持纯 TS：无测量函数 = 不换行。
 */
import type { MessageBus } from "./bus";
import type { Message, MessageDir } from "./message";
import { formatLogText, messagePrefix, type LogFormatOptions, type LogLineLabels } from "./format";

export interface LogViewOptions {
  /** 显示行上限，默认 500（SPEC §3.3：可视窗口，数据本体在总线/环形缓冲） */
  maxRows?: number;
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
  /** 前缀类别（前缀着色 token 选择；续行/无前缀为 ""） */
  prefixKind: "rx" | "tx-manual" | "tx-mcp" | "sys" | "";
  text: string;
}

export class LogView {
  rows: LogRow[] = [];
  private entries: Message[] = [];
  private lastMsgId = 0;
  private rowSeq = 0;
  private format: LogFormatOptions;
  private labels: LogLineLabels;
  private readonly maxRows: number;
  private readonly measure?: (text: string) => number;
  private readonly wrapWidth?: () => number;
  private widthCache = new Map<string, number>();

  constructor(format: LogFormatOptions, labels: LogLineLabels, opts: LogViewOptions = {}) {
    this.format = format;
    this.labels = labels;
    this.maxRows = opts.maxRows ?? 500;
    this.measure = opts.measure;
    this.wrapWidth = opts.wrapWidth;
  }

  /** 显示开关或前缀文案变化：全量重排版保留的消息。 */
  setFormat(format: LogFormatOptions, labels: LogLineLabels): void {
    this.format = format;
    this.labels = labels;
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
   * 从总线同步新消息（每帧调用）。返回本次新增行数 added 与
   * 因环形缓冲裁剪而未能显示的帧数 lost（id 断档，如暂停期间流量
   * 超过缓冲容量）。
   * 不清空已见 id：清屏用 clear()。
   */
  sync(bus: MessageBus): { added: number; lost: number } {
    const pending: Message[] = [];
    for (const msg of bus.buffer.peek()) {
      if (msg.id > this.lastMsgId) pending.push(msg);
    }
    if (pending.length === 0) return { added: 0, lost: 0 };
    // 首条新消息 id 前出现断档 = 有帧在被显示前就被环形缓冲裁掉（真实丢帧）
    const lost = Math.max(0, pending[0]!.id - this.lastMsgId - 1);
    const before = this.rows.length;
    for (const msg of pending) {
      this.lastMsgId = Math.max(this.lastMsgId, msg.id);
      this.entries.push(msg);
    }
    this.trim();
    this.rebuild();
    return { added: this.rows.length - before, lost };
  }

  /** 清屏：丢全部行；upToMsgId 通常为当前 lastMsgId，防止旧消息重新出现。 */
  clear(upToMsgId?: number): void {
    this.rows = [];
    this.entries = [];
    this.widthCache.clear();
    if (upToMsgId !== undefined) this.lastMsgId = Math.max(this.lastMsgId, upToMsgId);
  }

  get lastSeenMsgId(): number {
    return this.lastMsgId;
  }

  private trim(): void {
    while (this.entries.length > this.maxRows) this.entries.shift();
  }

  private rebuild(): void {
    const rows: LogRow[] = [];
    for (const msg of this.entries) {
      const prefix = messagePrefix(msg, this.labels);
      const prefixKind: LogRow["prefixKind"] =
        msg.dir === "rx" ? "rx" : msg.dir === "sys" ? "sys" : msg.source === "mcp" ? "tx-mcp" : "tx-manual";
      const line = formatLogText(msg, this.format, this.labels);
      let first = true;
      for (const chunk of this.wrap(line)) {
        rows.push({
          key: this.rowSeq++,
          msgId: msg.id,
          dir: msg.dir,
          prefix: first ? prefix : "",
          prefixKind: first ? prefixKind : "",
          text: chunk,
        });
        first = false;
      }
    }
    // 行数上限兜底（换行可能使行数超过消息数上限）
    if (rows.length > this.maxRows) rows.splice(0, rows.length - this.maxRows);
    this.rows = rows;
  }

  /** 贪心按字符折行；无测量或宽度非法时不折行。宽度缓存按字符。 */
  private wrap(text: string): string[] {
    const width = this.wrapWidth?.() ?? 0;
    if (!this.measure || width <= 0) return [text];
    const out: string[] = [];
    let current = "";
    let currentW = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      let w = this.widthCache.get(ch);
      if (w === undefined) {
        w = this.measure(ch);
        this.widthCache.set(ch, w);
      }
      if (currentW + w > width && current !== "") {
        out.push(current);
        current = ch;
        currentW = w;
      } else {
        current += ch;
        currentW += w;
      }
    }
    out.push(current);
    return out;
  }
}
