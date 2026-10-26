/// <reference path="../../vendor/pocketjs/framework/compiler/ambient.d.ts" />
// Exercise the actual App frame pump with an unavailable/coarse/adjusted RTC.
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

const root = resolve(import.meta.dir, "../..");
const wasmPath = join(root, "vendor/pocketjs/hosts/web/pocketjs.wasm");

for (const profile of ["aic-diagnostic", "desktop"]) {
  test.skipIf(!existsSync(wasmPath))(`serial receive uses frame time with a frozen/backward RTC: ${profile}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pocketcom-serial-clock-"));
    try {
      const features = await loadAppFeatures(join(root, "pocket.features.json"), profile);
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
import { setViewport } from ${JSON.stringify(join(root, "app/layout.ts"))};
import { bus, session, clearLog, logView, rxCount, txCount } from ${JSON.stringify(join(root, "app/session.ts"))};
setViewport(480, 272);
globalThis.dispose = mount(App);
globalThis.open = baudRate => session.openSerial({ path: "uart1", baudRate });
globalThis.send = bytes => session.write(new Uint8Array(bytes), "manual");
globalThis.reset = () => { session.close(); clearLog(); };
globalThis.state = () => {
  const texts = node => [node.text, ...node.children.flatMap(texts)].filter(Boolean);
  return { rx: rxCount.value, tx: txCount.value, rows: logView.rows.filter(r => r.dir === "rx").map(r => r.text),
    timestamps: bus.buffer.peek().filter(m => m.dir === "rx").map(m => m.ts), texts: texts(rootMirror) };
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
      const { createWasmUi } = await import(join(root, "vendor/pocketjs/hosts/web/wasm-ops.js")) as {
        createWasmUi: (bytes: ArrayBuffer) => Promise<{ ops: HostOps; tick(): void }>;
      };
      const wasm = await createWasmUi(await Bun.file(wasmPath).arrayBuffer());
      wasm.ops.loadStyles!(styles.bin);
      let pending: string | null = null;
      let wallNow = 1_793_001_600_000;
      const com = {
        serialList: () => '[{"path":"uart1","description":"UART1"}]',
        serialOpen: () => '{"handle":1}', setSignals: () => true, close: () => true,
        write: (_handle: number, bytes: Uint8Array) => {
          pending = JSON.stringify({ t: "data", h: 1, b64: Buffer.from(bytes).toString("base64") });
          return true;
        },
        poll: () => { const event = pending; pending = null; return event; },
      };
      const guest = { ui: wasm.ops, console, com, rtcNow: () => wallNow } as unknown as {
        frame(buttons: number): void;
        dispose(): void;
        open(baud: number): void;
        send(bytes: number[]): void;
        reset(): void;
        state(): { rx: number; tx: number; rows: string[]; timestamps: number[]; texts: string[] };
      };
      runInNewContext("Date.now = () => rtcNow();\n" + await build.outputs[0]!.text(), guest);
      const frame = () => { guest.frame(0); wasm.tick(); };
      try {
        frame();
        guest.open(115200);
        guest.send([97, 97, 97]); // TX/RX physical short represented by the raw host event.
        frame();
        expect(guest.state()).toMatchObject({ rx: 3, tx: 3, rows: [] });
        frame(); frame();
        expect(guest.state().rows).toEqual(["aaa"]);
        expect(guest.state().texts).toContain("aaa");
        expect(guest.state().timestamps).toEqual([wallNow]); // Calendar timestamps stay on RTC.

        guest.send([98, 98, 98]);
        frame();
        wallNow -= 60_000; // Adjusting RTC must not postpone pending RX.
        frame(); frame();
        expect(guest.state()).toMatchObject({ rx: 6, tx: 6, rows: ["aaa", "bbb"] });
        expect(guest.state().texts).toContain("bbb");

        guest.reset();
        frame();
        guest.open(300); // Keep the baud-derived silence threshold (~73 ms).
        guest.send([99, 99, 99]);
        frame();
        for (let i = 0; i < 3; i++) frame();
        expect(guest.state()).toMatchObject({ rx: 3, tx: 3, rows: [] });
        for (let i = 0; i < 3; i++) frame();
        expect(guest.state().rows).toEqual(["ccc"]);
        expect(guest.state().texts).toContain("ccc");
      } finally {
        guest.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
}
