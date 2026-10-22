// Off-device experiment only. The production AIC entry remains main.aic.tsx.
import { hasAppFeature } from "@pocketcom/features";
import App from "./app";
import { transportKinds } from "./transports";
import { mount } from "@pocketjs/framework";
import { setViewport } from "./layout";
import { locale } from "./i18n";
import { theme, systemAppearance } from "./theme";
import { fontSize } from "./session";
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
if (!hasAppFeature("ui.language-switch") && locale.value !== "zh-CN") throw new Error("disabled language switch changed locale");
if (!hasAppFeature("ui.theme-switch") && theme.value.bg !== "#0e1116") throw new Error("disabled theme switch changed theme");
if (!hasAppFeature("ui.theme-system") && systemAppearance !== undefined) throw new Error("disabled system theme allocated state");
if (!hasAppFeature("ui.font-size-switch") && fontSize.value !== 14) throw new Error("disabled font switch changed size");
setViewport(480, 272);
mount(App);
