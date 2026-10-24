/// <reference path="../../vendor/pocketjs/framework/compiler/ambient.d.ts" />
// Real Vue Vapor + core bounds hits, matching the AIC down-edge touch facts.
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
import { PROP } from "../../vendor/pocketjs/contracts/spec/spec";

const root = resolve(import.meta.dir, "../..");
const wasmPath = join(root, "vendor/pocketjs/hosts/web/pocketjs.wasm");

test.skipIf(!existsSync(wasmPath))("connection panel touch scrolling, tap arbitration and overlay boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pocketcom-panel-touch-"));
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
import { connectionDrawerOpen, connectionPanelOpen, setViewport } from ${JSON.stringify(join(root, "app/layout.ts"))};
import { popupOpen } from ${JSON.stringify(join(root, "app/widgets.tsx"))};
import { settingsOpen } from ${JSON.stringify(join(root, "app/settings-modal.tsx"))};
import { connType } from ${JSON.stringify(join(root, "app/session.ts"))};
setViewport(480, 272);
globalThis.dispose = mount(App);
globalThis.state = () => ({ drawer: connectionDrawerOpen(), popup: popupOpen(), settings: settingsOpen(), type: connType.value });
globalThis.closeDrawer = () => { connectionPanelOpen.value = false; };
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
    const translations = new Map<number, number>();
    const setProp = wasm.ops.setProp;
    wasm.ops.setProp = (id, prop, value) => {
      if (prop === PROP.translateY) translations.set(id, value);
      setProp(id, prop, value);
    };
    const guest = { ui: wasm.ops, console } as unknown as {
      frame: (buttons: number, analog?: number, touches?: number[], hits?: number[]) => void;
      dispose(): void;
      state(): { drawer: boolean; popup: boolean; settings: boolean; type: string };
      closeDrawer(): void;
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
    const down = (x: number, y: number) => wasm.ops.hitTestBounds!(x, y);
    const drag = (x0: number, y0: number, x1: number, y1: number) => {
      const hit = down(x0, y0);
      frame(x0, y0, hit);
      for (let i = 1; i <= 10; i++) frame(Math.round(x0 + (x1 - x0) * i / 10), Math.round(y0 + (y1 - y0) * i / 10), hit);
      frame(); frame();
    };
    const labelY = () => {
      const id = guest.textAncestors("连接类型").find(id => translations.has(id));
      expect(id).toBeDefined();
      return translations.get(id!)!;
    };
    try {
      frame();
      tap(60, 16);
      expect(guest.state().drawer).toBe(true);
      const initialY = labelY();
      // Starts on the connection-type Select: a drag must not open it.
      drag(130, 90, 130, 50);
      expect(labelY()).toBeLessThanOrEqual(initialY - 30); // After the pan slop.
      expect(guest.state().popup).toBe(false);
      expect(guest.state().type).toBe("serial");
      drag(130, 70, 130, 150);
      expect(labelY()).toBe(initialY); // Top boundary.
      drag(80, 90, 210, 90);
      expect(labelY()).toBe(initialY); // Horizontal movement does not pan.
      drag(130, 220, 130, 175);
      drag(130, 22, 130, 8);
      expect(labelY()).toBe(initialY); // Footer and header stay fixed.
      for (let i = 0; i < 12; i++) drag(130, 145, 130, 55);
      const bottomY = labelY();
      expect(bottomY).toBeLessThan(initialY);
      drag(130, 145, 130, 55);
      expect(labelY()).toBe(bottomY); // Bottom boundary.
      for (let i = 0; i < 12; i++) drag(130, 60, 130, 150);
      expect(labelY()).toBe(initialY);
      tap(130, 90);
      expect(guest.state().popup).toBe(true); // Ordinary taps still activate.
      drag(130, 140, 130, 60);
      expect(labelY()).toBe(initialY); // Popup occludes the panel subtree.
      tap(450, 140);
      expect(guest.state().popup).toBe(false);
      tap(238, 22);
      expect(guest.state().drawer).toBe(false);
      const hiddenY = labelY();
      drag(130, 140, 130, 60);
      expect(labelY()).toBe(hiddenY);
      tap(60, 16);
      expect(guest.state().drawer).toBe(true);
      drag(130, 140, 130, 70);
      expect(labelY()).toBe(initialY - 70); // Cached instance can pan again.
      const hit = down(130, 140);
      frame(130, 140, hit);
      frame(130, 120, hit);
      guest.closeDrawer(); frame(130, 100, hit);
      const closedY = labelY();
      frame(130, 70, hit); frame(); frame();
      expect(labelY()).toBe(closedY); // Closing cancels an in-flight pan.
      tap(60, 16);
      expect(labelY()).toBe(closedY); // Reopened drawer retains the scroll position.
      drag(130, 140, 130, 90); // Page buttons are gone; pan remains the touch path.
      expect(labelY()).toBeLessThan(closedY);
      tap(130, 249); // Footer shrank to two buttons; settings entry moved down.
      expect(guest.state().settings).toBe(true);
      const settingsY = labelY();
      drag(130, 140, 130, 60);
      expect(labelY()).toBe(settingsY);
    } finally {
      guest.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
