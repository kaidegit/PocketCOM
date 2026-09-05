/**
 * 串口会话（SPEC §3.2 / §4.2）：IConnection 语义的 com.* 桥接实现。
 * 纯 TS：把 bridge 的 Com 契约 + 连接状态机 + 帧合流 + 消息总线接成一条
 * 数据通路，app 侧每帧调 poll() 驱动事件批与合流超时。
 *
 * 数据流：
 *   宿主 → com.poll() → {t:"data",b64} → base64 解码 → FrameCoalescer.feed
 *         → 成帧 → bus.append({dir:"rx",...})          （RX，计数 rxBytes）
 *   UI/MCP → session.write(bytes, source) → com.write → bus.append({dir:"tx",...})（txBytes）
 *   宿主 → {t:"closed"|"error"} → 合流 flush → 状态机转 LOST + sys 事件（不 crash）
 */
import type { Com, ComEvent, ComSignalPins, SerialOpenParams, SerialPortInfo } from "../bridge/com";
import { decodeBase64 } from "./base64";
import { strToBytes } from "./codec";
import { ConnectionStateMachine, type ConnState } from "./connection";
import { FrameCoalescer } from "./framing";
import { IoError, StateError } from "./errors";
import type { MessageBus } from "./bus";
import type { MessageSource } from "./message";

/** SerialOpenParams.stopBits 归一化：宿主只接受 1 / 2（com.rs）。 */
export function normalizeStopBits(v: 1 | 2 | "1" | "2" | "1.5"): 1 | 2 {
  return v === 2 || v === "2" ? 2 : 1;
}

export interface SerialSessionHooks {
  onStateChange?: (from: ConnState, to: ConnState) => void;
}

export class SerialSession {
  readonly bus: MessageBus;
  private readonly com: Com;
  private readonly sm: ConnectionStateMachine;
  private coalescer: FrameCoalescer | null = null;
  private handle: number | null = null;
  private connSeq = 0;
  /** 当前连接实例 id（对应 Message.connId，SPEC §3.5）。 */
  connId = "none";
  /** 字节计数（清屏归零由 app 侧直接改）。 */
  rxBytes = 0;
  txBytes = 0;

  constructor(com: Com, bus: MessageBus, hooks: SerialSessionHooks = {}) {
    this.com = com;
    this.bus = bus;
    this.sm = new ConnectionStateMachine((from, to) => hooks.onStateChange?.(from, to));
  }

  get state(): ConnState {
    return this.sm.state;
  }

  /** 枚举串口（macOS 仅 /dev/cu.*，宿主保证）。 */
  ports(): SerialPortInfo[] {
    return this.com.serialList();
  }

  /**
   * 打开串口：CONNECTING →（宿主 open 成功）CONNECTED + sys 事件；
   * 失败回 DISCONNECTED 并抛 IoError（code 透传宿主结构化 code）。
   */
  open(params: SerialOpenParams): void {
    if (this.sm.state === "CONNECTED" || this.sm.state === "CONNECTING") {
      throw new StateError("STATE_ILLEGAL_TRANSITION", `cannot open while ${this.sm.state}`);
    }
    this.sm.transition("CONNECTING");
    const result = this.com.serialOpen(params);
    if (!result.ok) {
      this.sm.transition("DISCONNECTED");
      // 宿主 code（param/io-error/not-found…）并入 message，结构化 code 归 IO_CONNECT_FAILED
      throw new IoError("IO_CONNECT_FAILED", `[${result.code}] ${result.msg}`);
    }
    this.handle = result.handle;
    this.connSeq += 1;
    this.connId = `serial-${this.connSeq}`;
    this.coalescer = new FrameCoalescer({
      mode: "serial",
      serial: {
        baudRate: params.baudRate,
        byteSize: params.dataBits ?? 8,
        stopBits: params.stopBits === undefined ? 1 : normalizeStopBits(params.stopBits),
      },
      onFrame: (frame) => {
        this.bus.append({ dir: "rx", source: "system", payload: frame, connId: this.connId });
      },
    });
    this.sm.transition("CONNECTED");
    this.sys(`connected: ${params.path} @ ${params.baudRate}`);
  }

  /**
   * 用户主动关闭：CONNECTED 时 flush 合流残余 → 关闭句柄 → DISCONNECTED + sys 事件；
   * LOST（已掉线待确认）时仅确认掉线，不重复关闭句柄。
   */
  close(): void {
    if (this.sm.state === "LOST") {
      this.sm.transition("DISCONNECTED");
      this.sys("acknowledged");
      return;
    }
    if (this.sm.state !== "CONNECTED") {
      throw new StateError("STATE_ILLEGAL_TRANSITION", `cannot close while ${this.sm.state}`);
    }
    this.coalescer?.flush();
    this.coalescer = null;
    if (this.handle !== null) this.com.close(this.handle);
    this.handle = null;
    this.sm.transition("DISCONNECTED");
    this.sys("closed by user");
  }

  /**
   * 发送字节：先写宿主（失败抛 IoError 不入总线），成功入总线（dir:"tx"）。
   * source 标记来源（手动/MCP/定时器，SPEC §3.5）。
   */
  write(bytes: Uint8Array, source: MessageSource): void {
    if (this.sm.state !== "CONNECTED" || this.handle === null) {
      throw new StateError("STATE_ILLEGAL_TRANSITION", `cannot write while ${this.sm.state}`);
    }
    if (!this.com.write(this.handle, bytes)) {
      throw new IoError("IO_WRITE_FAILED", "host rejected write");
    }
    this.txBytes += bytes.byteLength;
    this.bus.append({ dir: "tx", source, payload: bytes, connId: this.connId });
  }

  /** DTR/RTS 电平（连接前后均可切换，SPEC §3.2）；未连接时静默忽略。 */
  setSignals(pins: ComSignalPins): void {
    if (this.handle !== null) this.com.setSignals(this.handle, pins);
  }

  /**
   * 每帧调用：drain 宿主事件批 → 解码喂合流；驱动合流静默超时；
   * closed/error 事件收尾转 LOST（SPEC §5.1：连接类错误不 crash）。
   */
  poll(nowMs: number): void {
    for (const ev of this.com.poll()) {
      this.handleEvent(ev, nowMs);
    }
    this.coalescer?.tick(nowMs);
  }

  private handleEvent(ev: ComEvent, nowMs: number): void {
    if (ev.h !== this.handle) return; // 已关闭句柄的迟到事件
    switch (ev.t) {
      case "data": {
        let bytes: Uint8Array;
        try {
          bytes = decodeBase64(ev.b64);
        } catch {
          break; // malformed 宿主事件：丢帧不crash（与 svc.ts 同策略）
        }
        this.rxBytes += bytes.byteLength;
        this.coalescer?.feed(bytes, nowMs);
        break;
      }
      case "error":
        this.sys(`error: ${ev.code}: ${ev.msg}`);
        // closed 事件紧随其后做状态收尾；error 单独到达（宿主 bug）时也在此收尾
        break;
      case "closed":
        this.terminate(`connection lost: ${ev.reason}`);
        break;
    }
  }

  /** 断线收尾：flush 残余帧 → 释放句柄 → LOST + sys 事件。 */
  private terminate(reason: string): void {
    this.coalescer?.flush();
    this.coalescer = null;
    this.handle = null;
    if (this.sm.state === "CONNECTED") {
      this.sm.transition("LOST");
      this.sys(reason);
    } else if (this.sm.state === "CONNECTING") {
      this.sm.transition("DISCONNECTED");
      this.sys(reason);
    }
    // DISCONNECTED/LOST 状态下的迟到 closed：忽略
  }

  /** sys 事件入总线（连接/断开/错误，SPEC §3.5）。 */
  private sys(text: string): void {
    this.bus.append({
      dir: "sys",
      source: "system",
      payload: strToBytes(text),
      connId: this.connId,
    });
  }
}
