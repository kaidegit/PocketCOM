/**
 * 连接状态机 + 统一连接接口 IConnection（SPEC §3.2 / §4.2）。
 * 纯 TS，接口只定义形态，实现由宿主层（bridge 契约之下）提供。
 */
import { PocketError, StateError } from "./errors";

export type ConnState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "LOST";

/** 合法迁移表：含 LOST → CONNECTING 自动重连迁移；不在表内的迁移抛 StateError。 */
export const TRANSITIONS: Readonly<Record<ConnState, readonly ConnState[]>> = {
  DISCONNECTED: ["CONNECTING"],
  CONNECTING: ["CONNECTED", "DISCONNECTED", "LOST"],
  CONNECTED: ["DISCONNECTED", "LOST"],
  LOST: ["CONNECTING", "DISCONNECTED"],
};

export class ConnectionStateMachine {
  private currentState: ConnState = "DISCONNECTED";
  private readonly onChange: ((from: ConnState, to: ConnState) => void) | undefined;

  constructor(onChange?: (from: ConnState, to: ConnState) => void) {
    this.onChange = onChange;
  }

  get state(): ConnState {
    return this.currentState;
  }

  canTransition(to: ConnState): boolean {
    return (TRANSITIONS[this.currentState] as readonly ConnState[]).includes(to);
  }

  /** 非法迁移抛 StateError（code = STATE_ILLEGAL_TRANSITION）。 */
  transition(to: ConnState): void {
    if (!this.canTransition(to)) {
      throw new StateError(
        "STATE_ILLEGAL_TRANSITION",
        `illegal connection state transition: ${this.currentState} -> ${to}`,
      );
    }
    const from = this.currentState;
    this.currentState = to;
    this.onChange?.(from, to);
  }
}

/**
 * 统一连接句柄抽象（SPEC §4.2）：四类连接（串口/TCP/UDP/WS）对核心层
 * 暴露同一接口，对齐 COMTool 的 COMM 基类设计。
 */
export interface IConnection {
  /** 连接实例 id（对应 Message.connId） */
  readonly id: string;
  /** 写出原始字节；宿主侧串行化（SPEC §6.5） */
  write(bytes: Uint8Array): void | Promise<void>;
  /** 关闭连接 */
  close(): void;
  /** 注册数据回调（宿主在 tick 边界成批投递原始字节） */
  onData(cb: (bytes: Uint8Array) => void): void;
  /** 注册对端断开/关闭回调 */
  onClosed(cb: (reason: string) => void): void;
  /** 注册错误回调（IO 异常 → 状态机转 LOST，不 crash） */
  onError(cb: (err: PocketError) => void): void;
}
