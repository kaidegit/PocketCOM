/**
 * 消息总线（SPEC §3.5 / §6.4）：单一事实源。
 * - append() 分配 id/ts、同步通知订阅者（错误隔离）、写入有界环形缓冲；
 *   缓冲溢出丢最旧帧属正常历史裁剪，不注入事件——消费端按 id 连续性
 *   自行检测真实丢帧（LogView / collectMcpLines）。
 * - drainForMcp() 为 MCP 侧视图：RX 帧 + 用户手动发送的 TX 帧 + sys 事件，
 *   不含 source=mcp 的帧（agent 读不到自己发的，SPEC §6.4）。
 */
import type { Message, NewMessage } from "./message";
import { RingBuffer, type RingBufferOptions } from "./message";

export type Subscriber = (msg: Message) => void;

export interface MessageBusOptions extends RingBufferOptions {
  /** 时钟注入（默认 Date.now） */
  now?: () => number;
  /** 订阅者抛异常时回调（默认静默吞掉，保证错误隔离） */
  onSubscriberError?: (err: unknown, subscriber: Subscriber) => void;
}

/** MCP 读缓冲可见性（SPEC §6.4）：agent 自己 send 的帧不回灌。 */
export function isVisibleToMcp(msg: Message): boolean {
  return msg.dir !== "tx" || msg.source !== "mcp";
}

export class MessageBus {
  private nextId = 1;
  private readonly subscribers = new Set<Subscriber>();
  private readonly now: () => number;
  private readonly onSubscriberError: ((err: unknown, subscriber: Subscriber) => void) | undefined;
  readonly buffer: RingBuffer;

  constructor(opts: MessageBusOptions = {}) {
    this.now = opts.now ?? ((): number => Date.now());
    this.onSubscriberError = opts.onSubscriberError;
    this.buffer = new RingBuffer({
      ...(opts.maxFrames !== undefined ? { maxFrames: opts.maxFrames } : {}),
      ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
    });
  }

  /** 订阅消息（同步回调），返回取消订阅函数。 */
  subscribe(sub: Subscriber): () => void {
    this.subscribers.add(sub);
    return (): void => {
      this.subscribers.delete(sub);
    };
  }

  /** 追加消息：分配 id/ts → 通知订阅者（错误隔离）→ 写入环形缓冲。
   *  缓冲超限静默丢最旧帧（正常裁剪）；丢帧可见性由消费端按 id 断档判断。 */
  append(input: NewMessage): Message {
    const msg: Message = {
      id: this.nextId++,
      ts: this.now(),
      dir: input.dir,
      source: input.source,
      payload: input.payload,
      connId: input.connId,
    };
    this.notify(msg);
    this.buffer.push(msg);
    return msg;
  }

  /**
   * MCP 读缓冲（SPEC §6.4）：默认取空（drain），返回 RX 帧 +
   * 非 mcp 来源的 TX 帧 + sys 事件；source=mcp 的帧留在缓冲外被丢弃。
   * 想窥视请用 buffer.peek() 配合 isVisibleToMcp 自行过滤。
   */
  drainForMcp(): Message[] {
    const all = this.buffer.drain();
    const visible: Message[] = [];
    for (const msg of all) {
      if (isVisibleToMcp(msg)) visible.push(msg);
    }
    return visible;
  }

  private notify(msg: Message): void {
    for (const sub of [...this.subscribers]) {
      try {
        sub(msg);
      } catch (err) {
        // 错误隔离：一个订阅者抛异常不影响其他订阅者与缓冲写入
        this.onSubscriberError?.(err, sub);
      }
    }
  }
}
