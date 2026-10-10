// Product viewport state must match the fixed AIC host before the minimal board UI mounts.
import AicApp from "./aic.tsx";
import { mount } from "@pocketjs/framework";
import { setViewport } from "./layout";

setViewport(480, 272);
mount(AicApp);
