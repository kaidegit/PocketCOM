// bridge/com.ts — PocketCOM `com.*` 宿主桥接契约的 JS 侧封装（SPEC §4.2）。
// 宿主把串口能力 mount 为 globalThis.com 命名空间（host/macos/src/com.rs，
// 模式同上游 globalThis.net / globalThis.ui）；这里做 feature-detect + 类型化
// 薄封装，stock 宿主（无 com）返回 null，app/core 据此降级。
//
// 注意：getOps() 返回的是 ui 命名空间，com 是独立命名空间，直接读
// globalThis.com（与 framework detectHost 识别 ui 的机制同理）。

/** 枚举到的串口（macOS 只含 /dev/cu.*，SPEC §3.2）。 */
export interface SerialPortInfo {
  path: string;
  description: string;
  manufacturer?: string;
  vid?: number;
  pid?: number;
}

/** serialOpen 参数；除 path/baudRate 外全部可选（缺省走驱动默认）。 */
export interface SerialOpenParams {
  path: string;
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  parity?: "none" | "odd" | "even" | "mark" | "space";
  stopBits?: 1 | 2 | "1" | "2" | "1.5";
  flowControl?: "none" | "xonxoff" | "rtscts" | "dsrdtr";
}

export type SerialOpenResult =
  | { ok: true; handle: number }
  | { ok: false; code: string; msg: string };

export type ComSignalPins = { dtr?: boolean; rts?: boolean };

/** 宿主 → JS 事件（com.poll() 每 tick 一批，SPEC §4.2）。 */
export type ComEvent =
  | { t: "data"; h: number; b64: string }
  | { t: "closed"; h: number; reason: string }
  | { t: "error"; h: number; code: string; msg: string };

export interface Com {
  /** 列出本机串口；宿主枚举失败返回 []。 */
  serialList(): SerialPortInfo[];
  serialOpen(params: SerialOpenParams): SerialOpenResult;
  /** 发送字节；仅表示已排队，IO 错误经 error/closed 事件回报。 */
  write(handle: number, bytes: Uint8Array): boolean;
  setSignals(handle: number, pins: ComSignalPins): boolean;
  close(handle: number): boolean;
  /** 取并解析本 tick 的事件批（每帧调用一次）。 */
  poll(): ComEvent[];
}

interface ComNs {
  serialList(): string;
  serialOpen(paramsJson: string): string;
  write(handle: number, bytes: Uint8Array): boolean;
  setSignals(handle: number, pinsJson: string): boolean;
  close(handle: number): boolean;
  poll(): string | null;
}

/** 探测 com 桥；返回 null 表示宿主没有 mount com 命名空间。 */
export function connectCom(): Com | null {
  const ns = (globalThis as { com?: ComNs }).com;
  if (
    !ns ||
    typeof ns.serialList !== "function" ||
    typeof ns.serialOpen !== "function" ||
    typeof ns.write !== "function" ||
    typeof ns.setSignals !== "function" ||
    typeof ns.close !== "function" ||
    typeof ns.poll !== "function"
  ) {
    return null;
  }
  return {
    serialList() {
      try {
        const parsed: unknown = JSON.parse(ns.serialList());
        // 宿主枚举失败时返回结构化错误对象——对 UI 等价于"没有串口"。
        return Array.isArray(parsed) ? (parsed as SerialPortInfo[]) : [];
      } catch {
        return [];
      }
    },
    serialOpen(params) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ns.serialOpen(JSON.stringify(params)));
      } catch {
        return { ok: false, code: "bridge-error", msg: "host returned malformed json" };
      }
      const rec = parsed as { handle?: number; error?: { code?: string; msg?: string } };
      if (typeof rec?.handle === "number") return { ok: true, handle: rec.handle };
      return {
        ok: false,
        code: rec?.error?.code ?? "unknown",
        msg: rec?.error?.msg ?? "serialOpen failed",
      };
    },
    write(handle, bytes) {
      return ns.write(handle, bytes);
    },
    setSignals(handle, pins) {
      return ns.setSignals(handle, JSON.stringify(pins));
    },
    close(handle) {
      return ns.close(handle);
    },
    poll() {
      const batch = ns.poll();
      if (!batch) return [];
      const events: ComEvent[] = [];
      for (const line of batch.split("\n")) {
        if (line === "") continue;
        try {
          events.push(JSON.parse(line) as ComEvent);
        } catch {
          // 非法行是宿主 bug：跳过，不要卡死整帧（与 svc.ts 同策略）。
        }
      }
      return events;
    },
  };
}
