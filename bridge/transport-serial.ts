import type { ComNs, SerialOps } from "./com";
import { parseOpenResult } from "./com";
import { createSerialOps } from "./serial";

/** Product serial assembly, independently removable from the legacy full bridge API. */
export function serialTransport(ns: ComNs): SerialOps {
  return createSerialOps(ns, parseOpenResult);
}
