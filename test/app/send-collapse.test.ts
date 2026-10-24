/// <reference path="../../vendor/pocketjs/framework/compiler/ambient.d.ts" />
// Real Vue Vapor + core bounds hits：状态栏发送区折叠按钮（SPEC §3.3）。
// Build the optional core first: (cd vendor/pocketjs && bun tools/wasm.ts).
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { loadAppFeatures } from "../../vendor/pocketjs/framework/compiler/app-features";
import { jsxPlugin, transformFile } from "../../vendor/pocketjs/framework/compiler/jsx-plugin";
import { compileClasses, generateStylesModule } from "../../vendor/pocketjs/framework/compiler/tailwind";
import type { HostOps } from "../../vendor/pocketjs/framework/src/host";

const root = resolve(import.meta.dir, "../..");
const wasmPath = join(root, "vendor/pocketjs/hosts/web/pocketjs.wasm");

test.skipIf(!existsSync(wasmPath))("status-bar button collapses and restores the send pane", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pocketcom-send-collapse-"));
  try {
    const features = await loadAppFeatures(join(root, "pocket.features.json"), "aic-diagnostic");
    const classes: string[] = [];
    for (const file of new Bun.Glob("app/*.tsx").scanSync({ cwd: root })) {
      const path = join(root, file);
      classes.push(...(await transformFile(path, await Bun.file(path).text(), "vue-vapor")).classStrings);
    }
    const styles = compileClasses(classes);
    const entry = join(dir, "main.tsx");
    await Bun.write(entry, `
import App from ${JSON.stringify(join(root, "app/app.tsx"))};
import { mount } from "@pocketjs/framework";
import { rootMirror } from ${JSON.stringify(join(root, "vendor/pocketjs/framework/src/native-tree.ts"))};
import { setViewport } from ${JSON.stringify(join(root, "app/layout.ts"))};
import { sendCollapsed } from ${JSON.stringify(join(root, "app/session.ts"))};
setViewport(480, 272);
globalThis.dispose = mount(App);
globalThis.state = () => ({ collapsed: sendCollapsed.value });
globalThis.textAncestors = text => {
  const find = node => node.text === text ? node : node.children.map(find).find(Boolean);
  const ids = [];
  for (let node = find(rootMirror); node; node = node.parent) ids.push(node.id);
  return ids;
};
`);
    const build = await Bun.build({
      entrypoints: [entry], format: "iife", target: "browser", conditions: ["browser"],
      define: {
        "process.env.NODE_ENV": '"production"', document: "globalThis.__pocketDocument",
        __POCKET_TARGET__: '""', __POCKET_HOST_ABI__: "0", __POCKET_FEATURES__: "{}", __POCKET_PIXEL_RATIO__: "1",
      },
      plugins: [jsxPlugin("vue-vapor", { entry, appFeatures: features, generatedStyles: generateStylesModule(styles) })],
    });
    expect(build.success).toBe(true);
    // JS binding shared by the browser and native-core golden harness.
    const binding = join(root, "vendor/pocketjs/hosts/web/wasm-ops.js");
    const { createWasmUi } = await import(binding) as {
      createWasmUi: (bytes: ArrayBuffer) => Promise<{ ops: HostOps; tick(): void }>;
    };
    const wasm = await createWasmUi(await Bun.file(wasmPath).arrayBuffer());
    wasm.ops.loadStyles!(styles.bin);
    // app.tsx 主区受 comAvailable 门控：vm 全局注入最小 com 命名空间
    // （connectCom 探测六个基础 op；cfgRead=null → 默认配置展开态）。
    const com = {
      serialList: () => "[]",
      serialOpen: () => '{"error":{"code":"mock","msg":"no serial in test"}}',
      setSignals: () => true,
      write: () => true,
      close: () => true,
      poll: () => null,
      cfgRead: () => null,
      cfgWrite: () => true,
    };
    const guest = { ui: wasm.ops, console, com } as unknown as {
      frame: (buttons: number, analog?: number, touches?: number[], hits?: number[]) => void;
      dispose(): void;
      state(): { collapsed: boolean };
      textAncestors(text: string): number[];
    };
    runInNewContext(await build.outputs[0]!.text(), guest);
    const frame = (x?: number, y?: number, hit?: number) => {
      guest.frame(0, 0, x === undefined ? [] : [x | (y! << 9)], x === undefined ? [] : [hit!]);
      wasm.tick();
    };
    const tap = (x: number, y: number) => {
      frame(x, y, wasm.ops.hitTestBounds!(x, y)); frame(); frame();
    };
    // 480×272 窄屏：状态栏 y 244..272，折叠按钮 48×22、右缘 px-3 → 中心 (444, 258)。
    const BTN = { x: 444, y: 258 };
    try {
      frame();
      // 展开态：发送按钮与 ▼ 图标在，接收区空态在。
      expect(guest.state().collapsed).toBe(false);
      expect(guest.textAncestors("发送").length).toBeGreaterThan(0);
      expect(guest.textAncestors("▼").length).toBeGreaterThan(0);
      expect(guest.textAncestors("（暂无数据）").length).toBeGreaterThan(0);
      tap(BTN.x, BTN.y);
      // 收起态：发送区内容卸载（不可见即不可命中），图标翻转为 ▲，接收区仍在。
      expect(guest.state().collapsed).toBe(true);
      expect(guest.textAncestors("发送").length).toBe(0);
      expect(guest.textAncestors("▼").length).toBe(0);
      expect(guest.textAncestors("▲").length).toBeGreaterThan(0);
      expect(guest.textAncestors("（暂无数据）").length).toBeGreaterThan(0);
      tap(BTN.x, BTN.y);
      // 再展开：发送区恢复。
      expect(guest.state().collapsed).toBe(false);
      expect(guest.textAncestors("发送").length).toBeGreaterThan(0);
      expect(guest.textAncestors("▼").length).toBeGreaterThan(0);
    } finally {
      guest.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
