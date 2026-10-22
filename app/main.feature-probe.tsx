// Off-device experiment only. The production AIC entry remains main.aic.tsx.
import { hasAppFeature } from "@pocketcom/features";
import App from "./app";
import { mount } from "@pocketjs/framework";
import { setViewport } from "./layout";
import { terminal, setUiMode, uiMode } from "./session";

if (hasAppFeature("terminal")) {
  if (!terminal || typeof terminal.feed !== "function") throw new Error("terminal feature failed to initialize");
} else {
  if (terminal !== undefined) throw new Error("disabled terminal allocated a model");
  setUiMode("terminal");
  if (uiMode.value !== "transfer") throw new Error("disabled terminal mode accepted");
}
setViewport(480, 272);
mount(App);
