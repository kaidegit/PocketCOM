// Off-device experiment only. The production AIC entry remains main.aic.tsx.
import { hasAppFeature } from "@pocketcom/features";
import App from "./app";
import { transportKinds } from "./transports";
import { mount } from "@pocketjs/framework";
import { setViewport } from "./layout";
import { connType, setConnType, tcpHost, tcpsPort, udpHost, wsUrl, portPath, terminal, setUiMode, uiMode, mcpEnabled, mcpPort, mcpToken, mcpState, syncMcpServer, pumpSession } from "./session";

if (hasAppFeature("terminal")) {
  if (!terminal || typeof terminal.feed !== "function") throw new Error("terminal feature failed to initialize");
} else {
  if (terminal !== undefined) throw new Error("disabled terminal allocated a model");
  setUiMode("terminal");
  if (uiMode.value !== "transfer") throw new Error("disabled terminal mode accepted");
}
if (!hasAppFeature("mcp.server")) {
  if (mcpEnabled !== undefined || mcpPort !== undefined || mcpToken !== undefined || mcpState !== undefined)
    throw new Error("disabled MCP allocated reactive state");
  syncMcpServer();
  pumpSession(0);
}
const initialKind = connType.value;
if (!hasAppFeature("transport.serial")) {
  if (portPath !== undefined) throw new Error("disabled serial allocated parameters");
  setConnType("serial");
}
if (!hasAppFeature("transport.tcp-client")) {
  if (tcpHost !== undefined) throw new Error("disabled tcp allocated parameters");
  setConnType("tcp");
}
if (!hasAppFeature("transport.tcp-server")) {
  if (tcpsPort !== undefined) throw new Error("disabled tcps allocated parameters");
  setConnType("tcps");
}
if (!hasAppFeature("transport.udp")) {
  if (udpHost !== undefined) throw new Error("disabled udp allocated parameters");
  setConnType("udp");
}
if (!hasAppFeature("transport.websocket")) {
  if (wsUrl !== undefined) throw new Error("disabled ws allocated parameters");
  setConnType("ws");
}
if (connType.value !== initialKind || !transportKinds.includes(initialKind))
  throw new Error("disabled transport accepted by selector");
setViewport(480, 272);
mount(App);
