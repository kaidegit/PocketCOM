// bridge/serial.ts — `com.*` 串口桥的类型与封装（SPEC §4.2，M1）。
// op 结果解析（parseOpenResult）由 com.ts 注入，避免模块间运行时环。
import type { ComNs, ComOpenResult } from "./com";

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

export type ComSignalPins = { dtr?: boolean; rts?: boolean };

export interface SerialOps {
  /** 列出本机串口；宿主枚举失败返回 []。 */
  serialList(): SerialPortInfo[];
  serialOpen(params: SerialOpenParams): ComOpenResult;
  /** DTR/RTS 电平（JSON 序列化后转交宿主）。 */
  setSignals(handle: number, pins: ComSignalPins): boolean;
}

/** 组装串口 ops（宿主必有 serialList/serialOpen/setSignals——connectCom 的
 *  基础探测已保证；此处只做 JSON 边界与降级）。 */
export function createSerialOps(
  ns: ComNs,
  parseOpenResult: (raw: string) => ComOpenResult,
): SerialOps {
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
      return parseOpenResult(ns.serialOpen(JSON.stringify(params)));
    },
    setSignals(handle, pins) {
      return ns.setSignals(handle, JSON.stringify(pins));
    },
  };
}
