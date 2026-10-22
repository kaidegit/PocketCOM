import { hasAppFeature } from "@pocketcom/features";
import type { ComNs, TransportOps } from "../bridge/com";
import { serialTransport } from "../bridge/transport-serial";
import { openTransport as tcp } from "../bridge/tcp-client";
import { openTransport as tcps } from "../bridge/tcp-server";
import { openTransport as udp } from "../bridge/udp";
import { openTransport as ws } from "../bridge/websocket";
import type { ConnKind } from "../core/session";

/** Compile-time product choices, independent of host capability detection. */
export const transportKinds: ConnKind[] = [
  ...(hasAppFeature("transport.serial") ? ["serial" as const] : []),
  ...(hasAppFeature("transport.tcp-client") ? ["tcp" as const] : []),
  ...(hasAppFeature("transport.tcp-server") ? ["tcps" as const] : []),
  ...(hasAppFeature("transport.udp") ? ["udp" as const] : []),
  ...(hasAppFeature("transport.websocket") ? ["ws" as const] : []),
  "loopback",
];
export function createTransports(ns: ComNs): TransportOps {
  return {
    ...(hasAppFeature("transport.serial") ? serialTransport(ns) : {
      serialList: () => [],
      serialOpen: () => ({ ok: false as const, code: "unsupported", msg: "transport disabled" }),
      setSignals: () => false,
    }),
    netOpen(params) {
      if (hasAppFeature("transport.tcp-client") && params.kind === "tcp") return tcp(ns, params);
      if (hasAppFeature("transport.tcp-server") && params.kind === "tcps") return tcps(ns, params);
      if (hasAppFeature("transport.udp") && params.kind === "udp") return udp(ns, params);
      if (hasAppFeature("transport.websocket") && params.kind === "ws") return ws(ns, params);
      return null;
    },
  };
}
