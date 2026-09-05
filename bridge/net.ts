// bridge/net.ts — `com.*` 网络桥的类型与封装（SPEC §3.2 其余连接，M2）。
// TCP Client / TCP Server / UDP / WebSocket Client；异步连接模型，建立与
// 失败经 opened/accepted/error/closed 事件回报（见 com.ts ComEvent）。
// op 结果解析（parseOpenResult）由 com.ts 注入，避免模块间运行时环。
import type { ComNs, ComOpenResult } from "./com";

/** 网络连接参数（线路参数；kind 决定宿主 op 与语义）。 */
export type NetOpenParams =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "tcps"; port: number }
  | { kind: "udp"; bindPort: number; host: string; port: number }
  | { kind: "ws"; url: string; protocols?: string[] };

export interface NetOps {
  /** 网络连接；未实现网络桥的旧宿主上为 null。 */
  netOpen(params: NetOpenParams): ComOpenResult | null;
}

/** 会话侧字段（不进线路参数，宿主 serde 只认线路字段）。 */
const SESSION_ONLY_KEYS = new Set(["kind", "autoReconnect", "reconnectSec"]);

/** 组装网络 ops；宿主缺任一网络 op 时返回 null（app 据此报桥接不可用）。 */
export function createNetOps(
  ns: ComNs,
  parseOpenResult: (raw: string) => ComOpenResult,
): NetOps | null {
  const hasNet =
    typeof ns.tcpConnect === "function" &&
    typeof ns.tcpListen === "function" &&
    typeof ns.udpBind === "function" &&
    typeof ns.wsConnect === "function";
  if (!hasNet) return null;
  return {
    netOpen(params) {
      // kind 与重连策略是会话侧字段，不进线路参数。
      const json = JSON.stringify(params, (key, value) =>
        SESSION_ONLY_KEYS.has(key) ? undefined : value,
      );
      const op =
        params.kind === "tcp"
          ? ns.tcpConnect!
          : params.kind === "tcps"
            ? ns.tcpListen!
            : params.kind === "udp"
              ? ns.udpBind!
              : ns.wsConnect!;
      try {
        return parseOpenResult(op(json));
      } catch {
        return { ok: false, code: "bridge-error", msg: "net op threw" };
      }
    },
  };
}
