// Off-device experiment only. The production AIC entry remains main.aic.tsx.
import { hasAppFeature } from "@pocketcom/features";
import App from "./app";
import { mount } from "@pocketjs/framework";
import { setViewport } from "./layout";
import { terminal, setUiMode, uiMode, mcpEnabled, mcpPort, mcpToken, mcpState, syncMcpServer, pumpSession } from "./session";

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
setViewport(480, 272);
mount(App);
