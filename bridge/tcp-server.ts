import type { ComNs, ComOpenResult, NetOpenParams } from "./com";
import { parseOpenResult } from "./com";

/** tcp-server wire adapter; session-only reconnect fields never reach the host. */
export function openTransport(ns: ComNs, params: NetOpenParams): ComOpenResult | null {
  if (typeof ns.tcpListen !== "function") return null;
  try {
    const json = JSON.stringify(params, (key, value) =>
      key === "kind" || key === "autoReconnect" || key === "reconnectSec" ? undefined : value);
    return parseOpenResult(ns.tcpListen(json));
  } catch {
    return { ok: false, code: "bridge-error", msg: "net op threw" };
  }
}
