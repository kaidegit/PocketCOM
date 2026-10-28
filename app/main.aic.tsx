// Product viewport state must match the fixed AIC host before the shared UI mounts for board memory profiling.
import { installTsPerf, perfBegin, perfEnd } from "./perf";
import App from "./app.tsx";
import { mount } from "@pocketjs/framework";
import { setViewport } from "./layout";

setViewport(480, 272);
const finishPerf = installTsPerf();
const mounted = perfBegin("mount");
try { mount(App); } finally { perfEnd(mounted); }
finishPerf?.();
