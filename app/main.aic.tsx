// Product viewport state must match the fixed AIC host before App mounts.
import App from "./app.tsx";
import { mount } from "@pocketjs/framework";
import { setViewport } from "./layout";

setViewport(480, 272);
mount(App);
