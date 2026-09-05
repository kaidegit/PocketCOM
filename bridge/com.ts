// bridge/com.ts — PocketCOM `com.*` 宿主桥接契约的 JS 侧枢纽（SPEC §4.2）。
// 宿主把串口/网络/配置能力 mount 为 globalThis.com 命名空间（host/macos/src/
// com.rs + com_serial/com_tcp/com_udp/com_ws/com_env.rs，模式同上游
// globalThis.net / globalThis.ui）；这里做 feature-detect + 组装各协议的
// 类型化薄封装（serial.ts / net.ts / cfg.ts），stock 宿主（无 com）返回
// null，app/core 据此降级。
//
// 注意：getOps() 返回的是 ui 命名空间，com 是独立命名空间，直接读
// globalThis.com（与 framework detectHost 识别 ui 的机制同理）。
import { createCfgOps, type CfgOps } from "./cfg";
import { createNetOps, type NetOpenParams } from "./net";
import {
  createSerialOps,
  type ComSignalPins,
  type SerialOpenParams,
  type SerialPortInfo,
} from "./serial";

export type { CfgOps } from "./cfg";
export type { NetOpenParams, NetOps } from "./net";
export type {
  ComSignalPins,
  SerialOpenParams,
  SerialPortInfo,
  SerialOps,
} from "./serial";

export type ComOpenResult =
  | { ok: true; handle: number }
  | { ok: false; code: string; msg: string };

/** 宿主 → JS 事件（com.poll() 每 tick 一批，SPEC §4.2）。
 * opened/accepted 为 M2 网络语义；appearance 为 M2 跟随系统主题语义。 */
export type ComEvent =
  | { t: "data"; h: number; b64: string }
  | { t: "closed"; h: number; reason: string }
  | { t: "error"; h: number; code: string; msg: string }
  | { t: "opened"; h: number; addr: string }
  | { t: "accepted"; h: number; c: number; addr: string }
  | { t: "appearance"; v: "light" | "dark" };

export interface Com {
  /** 列出本机串口；宿主枚举失败返回 []。 */
  serialList(): SerialPortInfo[];
  serialOpen(params: SerialOpenParams): ComOpenResult;
  /** 网络连接（M2）；未实现网络桥的旧宿主上为 null。 */
  netOpen(params: NetOpenParams): ComOpenResult | null;
  /** 发送字节；仅表示已排队，IO 错误经 error/closed 事件回报。
   *  tcps 监听句柄 = 向全部已接入客户端广播（宿主语义）。 */
  write(handle: number, bytes: Uint8Array): boolean;
  setSignals(handle: number, pins: ComSignalPins): boolean;
  close(handle: number): boolean;
  /** 取并解析本 tick 的事件批（每帧调用一次；串口+网络+外观共用一条流）。 */
  poll(): ComEvent[];
  /** 配置文件全文（不存在返回 null）；未实现 cfg 的宿主上为 null。 */
  cfgRead(): string | null;
  /** 原子写配置文件（0600）；返回是否成功。 */
  cfgWrite(json: string): boolean | null;
  /** 导出配置（原生保存面板；宿主剥离 mcp.token）。返回宿主结果 JSON 原文。 */
  cfgExport(json: string): string | null;
  /** 导入配置（原生打开面板）。返回宿主结果 JSON 原文。 */
  cfgImport(): string | null;
}

/** 宿主命名空间的原始形状（globalThis.com）。网络/cfg op 可选：旧宿主
 *  只有串口，特性探测见 connectCom。 */
export interface ComNs {
  serialList(): string;
  serialOpen(paramsJson: string): string;
  write(handle: number, bytes: Uint8Array): boolean;
  setSignals(handle: number, pinsJson: string): boolean;
  close(handle: number): boolean;
  poll(): string | null;
  tcpConnect?(paramsJson: string): string;
  tcpListen?(paramsJson: string): string;
  udpBind?(paramsJson: string): string;
  wsConnect?(paramsJson: string): string;
  cfgRead?(): string | null;
  cfgWrite?(json: string): boolean;
  cfgExport?(json: string): string;
  cfgImport?(): string;
}

/** op 结果 JSON（{"handle":N} 或 {"error":{code,msg}}）→ 类型化结果。
 *  serial/net 共用同一结果形状（宿主 com.rs 约定）。 */
export function parseOpenResult(raw: string): ComOpenResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "bridge-error", msg: "host returned malformed json" };
  }
  const rec = parsed as { handle?: number; error?: { code?: string; msg?: string } };
  if (typeof rec?.handle === "number") return { ok: true, handle: rec.handle };
  return {
    ok: false,
    code: rec?.error?.code ?? "unknown",
    msg: rec?.error?.msg ?? "open failed",
  };
}

/** 探测 com 桥；返回 null 表示宿主没有 mount com 命名空间（六个串口基础
 *  op 缺一即判 stock 宿主）。网络/cfg 桥可选缺失，对应方法降级为 null。 */
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
  const net = createNetOps(ns, parseOpenResult);
  const cfg = createCfgOps(ns);
  return {
    ...createSerialOps(ns, parseOpenResult),
    netOpen(params) {
      return net === null ? null : net.netOpen(params);
    },
    write(handle, bytes) {
      return ns.write(handle, bytes);
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
    cfgRead() {
      return cfg === null ? null : cfg.cfgRead();
    },
    cfgWrite(json) {
      return cfg === null ? null : cfg.cfgWrite(json);
    },
    cfgExport(json) {
      return cfg === null ? null : cfg.cfgExport(json);
    },
    cfgImport() {
      return cfg === null ? null : cfg.cfgImport();
    },
  };
}
