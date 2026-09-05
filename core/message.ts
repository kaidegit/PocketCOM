/**
 * 消息模型（SPEC §3.5）+ 有界环形缓冲。
 * 纯 TS，零平台依赖。
 */
import { ParamError } from "./errors";

export type MessageDir = "rx" | "tx" | "sys";

export type MessageSource = "manual" | "mcp" | "timer" | "history" | "system";

/** 全应用统一消息（SPEC §3.5 核心数据契约）。 */
export interface Message {
  /** 单调递增 id（由 MessageBus 分配） */
  id: number;
  /** ms 时间戳 */
  ts: number;
  /** 收 / 发 / 系统事件 */
  dir: MessageDir;
  /** 来源：手动 / MCP / 定时循环 / 历史 / 系统 */
  source: MessageSource;
  /** 原始字节 */
  payload: Uint8Array;
  /** 当前连接实例 id */
  connId: string;
}

/** 追加消息时 id/ts 由总线分配。 */
export type NewMessage = Omit<Message, "id" | "ts">;

export interface RingBufferOptions {
  /** 最大帧数，默认 1000 */
  maxFrames?: number;
  /** 最大字节数（按 payload.byteLength 计），默认 256 KiB */
  maxBytes?: number;
}

export const DEFAULT_MAX_FRAMES = 1000;
export const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * 有界环形缓冲（SPEC §3.5：默认 1000 帧 / 256 KiB，溢出丢最旧帧）。
 * push 返回被逐出的最旧帧列表，调用方据此记 sys 溢出事件。
 */
export class RingBuffer {
  private queue: Message[] = [];
  private byteCount = 0;
  private readonly maxFrames: number;
  private readonly maxBytes: number;

  constructor(opts: RingBufferOptions = {}) {
    const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(maxFrames) || maxFrames <= 0) {
      throw new ParamError("PARAM_INVALID", `maxFrames must be a positive integer, got ${maxFrames}`);
    }
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new ParamError("PARAM_INVALID", `maxBytes must be a positive number, got ${maxBytes}`);
    }
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
  }

  get capacity(): number {
    return this.maxFrames;
  }

  get byteCapacity(): number {
    return this.maxBytes;
  }

  get size(): number {
    return this.queue.length;
  }

  get bytes(): number {
    return this.byteCount;
  }

  /**
   * 入帧；超过双重上限（帧数 / 字节数）时逐出最旧帧直到满足约束。
   * @returns 被逐出的帧（最旧在前），无溢出时为空数组。
   */
  push(msg: Message): Message[] {
    const evicted: Message[] = [];
    this.queue.push(msg);
    this.byteCount += msg.payload.byteLength;
    while (this.queue.length > this.maxFrames || this.byteCount > this.maxBytes) {
      const oldest = this.queue.shift();
      if (oldest === undefined) break;
      this.byteCount -= oldest.payload.byteLength;
      evicted.push(oldest);
    }
    return evicted;
  }

  /**
   * 入帧但不触发逐出（供 sys 溢出事件等系统帧使用，
   * 避免"记录溢出"本身级联逐出数据帧）。
   */
  pushUnchecked(msg: Message): void {
    this.queue.push(msg);
    this.byteCount += msg.payload.byteLength;
  }

  /** 取空缓冲（drain）。 */
  drain(): Message[] {
    const all = this.queue;
    this.queue = [];
    this.byteCount = 0;
    return all;
  }

  /** 窥视（peek），不取。返回只读视图。 */
  peek(): readonly Message[] {
    return this.queue;
  }
}
