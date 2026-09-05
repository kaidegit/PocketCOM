/**
 * 统一会话（SPEC §3.2 / §4.2）：IConnection 语义的 com.* 桥接实现。
 * 纯 TS：把 bridge 的 Com 契约 + 连接状态机 + 帧合流 + 消息总线接成一条
 * 数据通路。M2 起覆盖全部连接类型——串口（同步打开）与 TCP/TCP-Server/UDP/WS
 * （异步打开：CONNECTING 等 `opened` 事件转 CONNECTED）。
 *
 * 数据流：
 *   宿主 → com.poll() → {t:"data",b64} → base64 解码 → FrameCoalescer.feed
 *         → 成帧 → bus.append({dir:"rx",...})          （RX，计数 rxBytes）
 *   UI/MCP → session.write(bytes, source) → com.write → bus.append({dir:"tx",...})（txBytes）
 *   宿主 → {t:"closed"|"error"} → 合流 flush → 状态机转 LOST + sys 事件（不 crash）
 *
 * 事件批由调用方注入：app 每帧 drain 一次 com.poll()（appearance 事件在
 * app 层拦截），把其余事件交给 handleEvents（单条连接，句柄过滤即可路由）。
 */
import type { Com, ComEvent, ComSignalPins, NetOpenParams, SerialOpenParams, SerialPortInfo } from "../bridge/com";
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

export type ConnKind = "serial" | NetOpenParams["kind"];

/** 网络打开参数 = 线路参数 + 会话侧重连策略（重连只存在于核心层）。 */
export type NetSessionParams = NetOpenParams & {
  autoReconnect?: boolean;
  reconnectSec?: number;
};

/** TCP Server 已接入的客户端（句柄 + 对端地址）。 */
export interface ClientInfo {
  handle: number;
  addr: string;
}

export interface SessionHooks {
  onStateChange?: (from: ConnState, to: ConnState) => void;
  /** 客户端列表变化（TCP Server 接入/断开/踢除）——UI 需要刷新时用。 */
  onClientsChange?: () => void;
}

export class ComSession {
  readonly bus: MessageBus;
  private readonly com: Com;
  private readonly sm: ConnectionStateMachine;
  private coalescer: FrameCoalescer | null = null;
  /** 本连接自身的宿主句柄（tcps = 监听句柄）。 */
  private handle: number | null = null;
  private connSeq = 0;
  /** 当前连接实例 id（对应 Message.connId，SPEC §3.5）。 */
  connId = "none";
  /** 当前连接类型（未连接 = null）。 */
  kind: ConnKind | null = null;
  /** 打开时生成的人读摘要（状态栏展示，如 "tcp 127.0.0.1:9000"）。 */
  describe = "";
  /** 字节计数（清屏归零由 app 侧直接改）。 */
  rxBytes = 0;
  txBytes = 0;
  /** TCP Server 已接入客户端。 */
  private clients = new Map<number, string>();

  // 自动重连（仅 tcp/ws，SPEC §3.2）：掉线后按间隔重试。
  private lastNet: { params: NetSessionParams; kind: NetOpenParams["kind"] } | null = null;
  private reconnectAtMs: number | null = null;

  constructor(com: Com, bus: MessageBus, hooks: SessionHooks = {}) {
    this.com = com;
    this.bus = bus;
    this.hooks = hooks;
    this.sm = new ConnectionStateMachine((from, to) => hooks.onStateChange?.(from, to));
  }

  private hooks: SessionHooks;

  get state(): ConnState {
    return this.sm.state;
  }

  /** TCP Server 客户端列表快照。 */
  clientsInfo(): ClientInfo[] {
    return [...this.clients].map(([handle, addr]) => ({ handle, addr }));
  }

  /** 枚举串口（macOS 仅 /dev/cu.*，宿主保证）。 */
  ports(): SerialPortInfo[] {
    return this.com.serialList();
  }

  /**
   * 打开串口：CONNECTING →（宿主 open 成功）CONNECTED + sys 事件；
   * 失败回 DISCONNECTED 并抛 IoError（code 透传宿主结构化 code）。
   */
  openSerial(params: SerialOpenParams): void {
    this.assertIdle("open");
    this.sm.transition("CONNECTING");
    const result = this.com.serialOpen(params);
    if (!result.ok) {
      this.sm.transition("DISCONNECTED");
      // 宿主 code（param/io-error/not-found…）并入 message，结构化 code 归 IO_CONNECT_FAILED
      throw new IoError("IO_CONNECT_FAILED", `[${result.code}] ${result.msg}`);
    }
    this.adopt("serial", result.handle, `serial ${params.path} @ ${params.baudRate}`);
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
   * 打开网络连接（异步）：CONNECTING →（宿主 opened 事件）CONNECTED；
   * 打开失败（参数/立即拒绝）回 DISCONNECTED 并抛 IoError；连接期失败经
   * error/closed 事件转 LOST（不 crash，SPEC §5.1）。
   * tcps：CONNECTED = 正在监听；客户端接入经 accepted 事件入 clients。
   */
  openNet(params: NetSessionParams): void {
    this.assertIdle("open");
    const { kind } = params;
    this.sm.transition("CONNECTING");
    const result = this.com.netOpen(params);
    if (result === null) {
      this.sm.transition("DISCONNECTED");
      throw new IoError("IO_CONNECT_FAILED", "host has no net bridge (com.netOpen unavailable)");
    }
    if (!result.ok) {
      this.sm.transition("DISCONNECTED");
      throw new IoError("IO_CONNECT_FAILED", `[${result.code}] ${result.msg}`);
    }
    this.lastNet = { params, kind };
    this.reconnectAtMs = null;
    this.adopt(kind, result.handle, describeNet(params));
    this.coalescer = new FrameCoalescer({
      mode: "network",
      onFrame: (frame) => {
        this.bus.append({ dir: "rx", source: "system", payload: frame, connId: this.connId });
      },
    });
    // 状态停在 CONNECTING，等 opened 事件转 CONNECTED。
  }

  /**
   * 用户主动关闭：CONNECTED 时 flush 合流残余 → 关闭句柄 → DISCONNECTED + sys
   * 事件；LOST（已掉线待确认）时仅确认掉线；CONNECTING（网络连接中）取消连接。
   * tcps：只关监听句柄（宿主会一并断开全部客户端）。
   */
  close(): void {
    if (this.sm.state === "LOST") {
      this.sm.transition("DISCONNECTED");
      this.sys("acknowledged");
      this.reconnectAtMs = null;
      return;
    }
    if (this.sm.state !== "CONNECTED" && this.sm.state !== "CONNECTING") {
      throw new StateError("STATE_ILLEGAL_TRANSITION", `cannot close while ${this.sm.state}`);
    }
    this.coalescer?.flush();
    this.coalescer = null;
    if (this.handle !== null) this.com.close(this.handle);
    this.handle = null;
    this.kind = null;
    this.lastNet = null;
    this.reconnectAtMs = null;
    this.clients.clear();
    this.hooks.onClientsChange?.();
    this.sm.transition("DISCONNECTED");
    this.sys("closed by user");
  }

  /**
   * 发送字节：先写宿主（失败抛 IoError 不入总线），成功入总线（dir:"tx"）。
   * source 标记来源（手动/MCP/定时器，SPEC §3.5）。tcps：target 缺省 = 广播
   * （写监听句柄，宿主扇出），target = 指定客户端句柄。
   */
  write(bytes: Uint8Array, source: MessageSource, target?: number): void {
    if (this.sm.state !== "CONNECTED" || this.handle === null) {
      throw new StateError("STATE_ILLEGAL_TRANSITION", `cannot write while ${this.sm.state}`);
    }
    const handle = target ?? this.handle;
    if (!this.com.write(handle, bytes)) {
      throw new IoError("IO_WRITE_FAILED", "host rejected write");
    }
    this.txBytes += bytes.byteLength;
    this.bus.append({ dir: "tx", source, payload: bytes, connId: this.connId });
  }

  /** 踢除 TCP Server 客户端（宿主主动关闭 → 无 closed 事件，本地直接摘除）。 */
  kick(clientHandle: number): void {
    if (this.kind !== "tcps") return;
    const addr = this.clients.get(clientHandle);
    if (this.com.close(clientHandle)) {
      this.clients.delete(clientHandle);
      this.hooks.onClientsChange?.();
      this.sys(`client kicked: ${addr ?? clientHandle}`);
    }
  }

  /** DTR/RTS 电平（连接前后均可切换，SPEC §3.2）；未连接时静默忽略。 */
  setSignals(pins: ComSignalPins): void {
    if (this.handle !== null && this.kind === "serial") this.com.setSignals(this.handle, pins);
  }

  /**
   * 每帧调用：处理注入的事件批 + 驱动合流静默超时 + 自动重连到点重开。
   * closed/error 事件收尾转 LOST（SPEC §5.1：连接类错误不 crash）。
   */
  poll(events: ComEvent[], nowMs: number): void {
    for (const ev of events) {
      this.handleEvent(ev, nowMs);
    }
    this.coalescer?.tick(nowMs);
    if (
      this.reconnectAtMs !== null &&
      this.sm.state === "LOST" &&
      nowMs >= this.reconnectAtMs
    ) {
      this.reconnectAtMs = null;
      this.reconnect(nowMs);
    }
  }

  private handleEvent(ev: ComEvent, nowMs: number): void {
    if (ev.t === "appearance") return; // app 层已拦截路由给主题；会话只认连接事件
    const known =
      ev.h === this.handle || (this.kind === "tcps" && this.clients.has(ev.h));
    if (!known) return; // 已关闭句柄的迟到事件 / 未知句柄
    switch (ev.t) {
      case "opened":
        // 异步连接建立（tcps = 监听就绪）。打开已被用户取消（handle 清空）则忽略。
        if (ev.h !== this.handle || this.sm.state !== "CONNECTING") break;
        this.sm.transition("CONNECTED");
        this.sys(ev.h === this.handle && this.kind === "tcps" ? `listening on ${ev.addr}` : `connected: ${ev.addr}`);
        break;
      case "accepted":
        if (this.kind !== "tcps" || ev.h !== this.handle) break;
        this.clients.set(ev.c, ev.addr);
        this.hooks.onClientsChange?.();
        this.sys(`client connected: ${ev.addr}`);
        break;
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
        // closed 事件紧随其后做状态收尾；error 单独到达（宿主 bug）时也在此收尾
        this.sys(`error: ${ev.code}: ${ev.msg}`);
        break;
      case "closed":
        if (this.kind === "tcps" && ev.h !== this.handle) {
          this.clients.delete(ev.h);
          this.hooks.onClientsChange?.();
          this.sys(`client disconnected: ${ev.reason}`);
          break;
        }
        this.terminate(`connection lost: ${ev.reason}`, nowMs);
        break;
    }
  }

  /**
   * 断线收尾：flush 残余帧 → 释放句柄 → LOST + sys 事件。
   * LOST 后按重连策略到点重开（poll 驱动）；用户 close() 则清策略。
   */
  private terminate(reason: string, nowMs: number): void {
    this.coalescer?.flush();
    this.coalescer = null;
    this.handle = null;
    if (this.sm.state === "CONNECTED") {
      this.sm.transition("LOST");
      this.sys(reason);
      this.scheduleReconnect(nowMs);
    } else if (this.sm.state === "CONNECTING") {
      this.sm.transition("LOST");
      this.sys(reason);
      this.scheduleReconnect(nowMs);
    } else if (this.sm.state === "LOST") {
      this.sys(reason);
    }
    this.clients.clear();
    this.hooks.onClientsChange?.();
    // DISCONNECTED 状态下的迟到 closed：忽略
  }

  private scheduleReconnect(nowMs: number): void {
    const last = this.lastNet;
    if (!last || !last.params.autoReconnect) {
      this.reconnectAtMs = null;
      return;
    }
    const sec = Math.max(1, last.params.reconnectSec ?? 5);
    this.reconnectAtMs = nowMs + sec * 1000;
  }

  /** 到点重开：LOST → CONNECTING；同步失败回 DISCONNECTED 并停止重试。 */
  private reconnect(_nowMs: number): void {
    const last = this.lastNet;
    if (!last) return;
    this.sm.transition("CONNECTING");
    const result = this.com.netOpen(last.params);
    if (result === null || !result.ok) {
      this.sm.transition("DISCONNECTED");
      this.lastNet = null;
      this.sys(result && !result.ok ? `reconnect failed: ${result.msg}` : "reconnect failed");
      return;
    }
    this.adopt(last.kind, result.handle, describeNet(last.params));
    this.coalescer = new FrameCoalescer({
      mode: "network",
      onFrame: (frame) => {
        this.bus.append({ dir: "rx", source: "system", payload: frame, connId: this.connId });
      },
    });
    this.sys("reconnecting…");
  }

  /** 打开成功后的公共收尾：句柄/connId/类型/描述/客户端表复位。 */
  private adopt(kind: ConnKind, handle: number, describe: string): void {
    this.connSeq += 1;
    this.connId = `${kind}-${this.connSeq}`;
    this.handle = handle;
    this.kind = kind;
    this.describe = describe;
    this.clients.clear();
  }

  private assertIdle(op: string): void {
    if (this.sm.state === "CONNECTED" || this.sm.state === "CONNECTING") {
      throw new StateError("STATE_ILLEGAL_TRANSITION", `cannot ${op} while ${this.sm.state}`);
    }
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

/** 网络连接的人读摘要（状态栏 / sys 文案共用）。 */
export function describeNet(params: NetSessionParams): string {
  switch (params.kind) {
    case "tcp":
      return `tcp ${params.host}:${params.port}`;
    case "tcps":
      return `tcp-server :${params.port}`;
    case "udp":
      return `udp :${params.bindPort} → ${params.host}:${params.port}`;
    case "ws":
      return `ws ${params.url}`;
  }
}
