/**
 * 帧合流器（SPEC §3.2，对齐 COMTool RX 分帧策略）。
 * 纯 TS，时钟由调用方注入（feed/tick 显式传 nowMs），不自己 setTimeout。
 */
import { ParamError } from "./errors";

export type FrameMode = "serial" | "network";

export interface SerialFrameParams {
  baudRate: number;
  byteSize: number;
  stopBits: number;
}

export interface FrameCoalescerOptions {
  mode: FrameMode;
  /** serial 模式必填；network 模式忽略 */
  serial?: SerialFrameParams;
  /** 帧产出回调（消费方负责拷贝如需保留） */
  onFrame: (frame: Uint8Array) => void;
}

/**
 * 单字节传输时间（ms）= 1000 / (baud / (bytesize + 2 + stopbits))（SPEC §3.2）。
 */
export function computeByteTimeMs(params: SerialFrameParams): number {
  const { baudRate, byteSize, stopBits } = params;
  if (!(baudRate > 0) || !(byteSize > 0) || !(stopBits > 0)) {
    throw new ParamError("PARAM_INVALID", "baudRate / byteSize / stopBits must be positive");
  }
  return 1000 / (baudRate / (byteSize + 2 + stopBits));
}

/**
 * 静默阈值：serial = 2 × 单字节时间；network 固定 1ms。
 */
export function computeThresholdMs(mode: FrameMode, serial?: SerialFrameParams): number {
  if (mode === "network") return 1;
  if (serial === undefined) {
    throw new ParamError("PARAM_INVALID", "serial mode requires serial params (baudRate/byteSize/stopBits)");
  }
  return 2 * computeByteTimeMs(serial);
}

/**
 * 帧合流器：feed 累积字节；两次 feed 间隔超过静默阈值时先产出已累积帧；
 * tick(nowMs) 由调用方周期调用，超时未凑满也产出。flush() 强制产出剩余字节。
 */
export class FrameCoalescer {
  readonly thresholdMs: number;
  private readonly onFrame: (frame: Uint8Array) => void;
  private buf: number[] = [];
  private lastByteAt: number | null = null;

  constructor(opts: FrameCoalescerOptions) {
    this.thresholdMs = computeThresholdMs(opts.mode, opts.serial);
    this.onFrame = opts.onFrame;
  }

  get pendingBytes(): number {
    return this.buf.length;
  }

  /**
   * 馈入一段字节（视为同一时刻到达）。
   * 与上一段间隔超过阈值时，先产出已累积帧再开始累积新帧。
   */
  feed(bytes: Uint8Array, nowMs: number): void {
    if (bytes.byteLength === 0) return;
    if (this.buf.length > 0 && this.lastByteAt !== null && nowMs - this.lastByteAt > this.thresholdMs) {
      this.emit();
    }
    for (let i = 0; i < bytes.byteLength; i++) this.buf.push(bytes[i]!);
    this.lastByteAt = nowMs;
  }

  /** 周期调用：静默超时后产出当前累积帧（未凑满也产出）。 */
  tick(nowMs: number): void {
    if (this.buf.length > 0 && this.lastByteAt !== null && nowMs - this.lastByteAt > this.thresholdMs) {
      this.emit();
    }
  }

  /** 强制产出剩余字节（如连接断开时收尾）。 */
  flush(): void {
    if (this.buf.length > 0) this.emit();
  }

  private emit(): void {
    const frame = new Uint8Array(this.buf);
    this.buf = [];
    this.onFrame(frame);
  }
}
