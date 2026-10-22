import type { ComNs, ComOpenResult, NetOpenParams } from "./com";
import { parseOpenResult } from "./com";

/** udp wire adapter; session-only reconnect fields never reach the host. */
export function openTransport(ns: ComNs, params: NetOpenParams): ComOpenResult | null {
  if (typeof ns.udpBind !== "function") return null;
  try {
    const json = JSON.stringify(params, (key, value) =>
      key === "kind" || key === "autoReconnect" || key === "reconnectSec" ? undefined : value);
    return parseOpenResult(ns.udpBind(json));
  } catch {
    return { ok: false, code: "bridge-error", msg: "net op threw" };
  }
}
