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
import { MONO_CLASS, TEXT_CLASS } from "../../app/fontsize";
import { PROP } from "../../vendor/pocketjs/contracts/spec/spec";

const root = resolve(import.meta.dir, "../..");
const wasmPath = join(root, "vendor/pocketjs/hosts/web/pocketjs.wasm");

test.skipIf(!existsSync(wasmPath))("receive log touch scrolling, follow-bottom and overlay boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pocketcom-receive-touch-"));
  try {
    const features = await loadAppFeatures(join(root, "pocket.features.json"), "aic-diagnostic");
    const classes = [...Object.values(MONO_CLASS), ...Object.values(TEXT_CLASS)];
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
import { openSettingsModal, closeSettingsModal } from ${JSON.stringify(join(root, "app/settings-modal.tsx"))};
import { bus, logView, sendCollapsed } from ${JSON.stringify(join(root, "app/session.ts"))};
setViewport(480, 272);
globalThis.dispose = mount(App);
let next = 0;
globalThis.append = count => {
  for (let i = 0; i < count; i++) bus.append({ dir: "rx", source: "manual", connId: "test", payload: new TextEncoder().encode("row-" + next++) });
};
globalThis.state = () => ({ rows: logView.rows.length, drawer: connectionDrawerOpen(), popup: popupOpen() });
globalThis.closeDrawer = () => { connectionPanelOpen.value = false; };
globalThis.openDrawer = () => { connectionPanelOpen.value = true; };
globalThis.settings = value => { if (value) openSettingsModal(); else closeSettingsModal(); };
globalThis.collapse = value => { sendCollapsed.value = value; };
globalThis.textAncestors = text => {
  const find = node => node.text?.includes(text) ? node : node.children.map(find).find(Boolean);
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
    const setPropBatch = wasm.ops.setPropBatch;
    if (setPropBatch) wasm.ops.setPropBatch = buffer => {
      const values = new Float64Array(buffer);
      for (let i = 0; i + 2 < values.length; i += 3) {
        if (values[i + 1] === PROP.translateY) translations.set(values[i]!, values[i + 2]!);
      }
      setPropBatch(buffer);
    };
    const guest = { ui: wasm.ops, console, TextEncoder, com: { serialList: () => "[]", serialOpen: () => '{"handle":1}', write: () => true, setSignals: () => true, close: () => true, poll: () => null } } as unknown as {
      frame: (buttons: number, analog?: number, touches?: number[], hits?: number[]) => void;
      dispose(): void;
      state(): { rows: number; drawer: boolean; popup: boolean };
      append(count: number): void;
      openDrawer(): void;
      collapse(value: boolean): void;
      settings(value: boolean): void;
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
    const canvasY = () => {
      // All currently rendered rows share the same translated canvas ancestor.
      for (let i = 0; i < 100; i++) {
        const id = guest.textAncestors("row-" + i).find(id => translations.has(id));
        if (id !== undefined) return translations.get(id)!;
      }
      throw new Error("No rendered receive canvas");
    };
    try {
      frame();
      guest.append(40); frame(); frame();
      expect(guest.state().rows).toBe(40);
      const bottom = canvasY();
      expect(bottom).toBeLessThan(0);
      drag(180, 80, 180, 130); // Finger down: reveal older rows.
      const older = canvasY();
      expect(older).toBeGreaterThan(bottom);
      guest.append(1); frame(); frame();
      expect(canvasY()).toBe(older); // New RX does not pull away from history.
      drag(80, 100, 220, 100);
      expect(canvasY()).toBe(older);
      drag(180, 48, 180, 20); // Toolbar.
      expect(canvasY()).toBe(older);
      drag(180, 200, 180, 160); // Send field.
      expect(canvasY()).toBe(older);
      for (let i = 0; i < 24; i++) drag(180, 80, 180, 130);
      expect(Math.abs(canvasY())).toBe(0); // Top clamp.
      drag(180, 80, 180, 130);
      expect(Math.abs(canvasY())).toBe(0);
      for (let i = 0; i < 24; i++) drag(180, 130, 180, 75);
      const newBottom = canvasY();
      expect(newBottom).toBeLessThan(bottom);
      drag(180, 130, 180, 75);
      expect(canvasY()).toBe(newBottom); // Bottom clamp.
      guest.append(1); frame(); frame();
      expect(canvasY()).toBeLessThan(newBottom); // Follow restored.
      const hit = down(180, 90);
      frame(180, 90, hit); frame(180, 110, hit);
      guest.openDrawer(); frame(180, 115, hit);
      const interrupted = canvasY();
      frame(180, 130, hit); frame(); frame();
      expect(canvasY()).toBe(interrupted);
      guest.closeDrawer(); frame(); frame();
      drag(180, 80, 180, 125);
      expect(canvasY()).toBeGreaterThan(interrupted);
      tap(60, 16);
      expect(guest.state().drawer).toBe(true);
      const covered = canvasY();
      drag(180, 130, 180, 75);
      expect(canvasY()).toBe(covered); // Connection drawer covers log.
      tap(130, 90);
      expect(guest.state().popup).toBe(true);
      drag(180, 130, 180, 75);
      expect(canvasY()).toBe(covered); // Dropdown covers log.
      tap(450, 140); tap(238, 22);
      expect(guest.state().drawer).toBe(false);
      guest.settings(true); frame(); frame();
      const modalY = canvasY();
      drag(180, 130, 180, 75);
      expect(canvasY()).toBe(modalY);
      guest.settings(false); frame(); frame();
      guest.collapse(true); frame(); frame();
      const expanded = canvasY();
      drag(180, 170, 180, 220); // Newly exposed receive area.
      expect(canvasY()).toBeGreaterThan(expanded);
    } finally {
      guest.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
