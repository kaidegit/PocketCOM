/// <reference path="../../vendor/pocketjs/framework/compiler/ambient.d.ts" />
// Actual shared App, Vue Vapor and native-core bounds facts (AIC touch wire).
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
import { BTN } from "../../vendor/pocketjs/contracts/spec/spec";

const root = resolve(import.meta.dir, "../..");
const wasmPath = join(root, "vendor/pocketjs/hosts/web/pocketjs.wasm");

for (const profile of ["aic-diagnostic", "ui-on", "ui-off"]) {
  test.skipIf(!existsSync(wasmPath))(`soft keyboard repeated field clicks and real touch: ${profile}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pocketcom-keyboard-touch-"));
    try {
      const features = await loadAppFeatures(join(root, "pocket.features.json"), profile);
      const enabled = features.values["ui.soft-keyboard"];
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
import { pressNode, focusNode } from "@pocketjs/framework/input";
${enabled ? `import { keyboardOpen, closeKeyboard } from ${JSON.stringify(join(root, "app/soft-keyboard.tsx"))};` : `const keyboardOpen = () => false; const closeKeyboard = () => {};`}
import { activeField, setActiveField } from ${JSON.stringify(join(root, "app/fields.ts"))};
import { connectionDrawerOpen, setViewport } from ${JSON.stringify(join(root, "app/layout.ts"))};
import { sendCollapsed } from ${JSON.stringify(join(root, "app/session.ts"))};
setViewport(480,272);
globalThis.dispose = mount(App);
const nodes = () => { const all=[]; const visit=n=>{all.push(n);n.children.forEach(visit)};visit(rootMirror);return all; };
const text = n => [n.text || "", ...n.children.map(text)].join("");
globalThis.inspect = () => nodes().filter(n=>n.focusable).map(n=>({id:n.id,name:n.debugName,text:text(n)}));
globalThis.editorView = () => ({cursorX:nodes().find(n=>n.debugName==="keyboardEditorCaret")?.domAttrs?.style?.insetL,text:text(nodes().find(n=>n.debugName==="keyboardEditor")), caret:activeField.value?.editor?.caret(), value:activeField.value?.editor?.text()});
globalThis.ancestors = id => {const ids=[];for(let n=nodes().find(n=>n.id===id);n;n=n.parent)ids.push(n.id);return ids;};
globalThis.state = () => ({open:keyboardOpen(),active:activeField.value!==null,drawer:connectionDrawerOpen()});
globalThis.close = closeKeyboard;
globalThis.blur = () => setActiveField(null);
globalThis.focus = id => focusNode(nodes().find(n=>n.id===id));
globalThis.press = id => pressNode(nodes().find(n=>n.id===id));
globalThis.collapse = () => { sendCollapsed.value = !sendCollapsed.value; };
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
        createWasmUi(bytes: ArrayBuffer): Promise<{ ops: HostOps; tick(): void }>;
      };
      const wasm = await createWasmUi(await Bun.file(wasmPath).arrayBuffer());
      wasm.ops.loadStyles!(styles.bin);
      // This core harness has no font atlas. Supply fixed metrics for caret
      // hit tests; the actual AIC package is separately checked with its fonts.
      wasm.ops.measureText = text => text.length * 8;
      let events = "";
      Object.assign(wasm.ops, { svcOpen: () => true, svcPoll: () => { const batch = events; events = ""; return batch; }, svcSend: () => {} });
      const guest = {
        ui: wasm.ops, console,
        com: { serialList: () => '[{"path":"uart1","description":"UART1"}]', write: () => true, close: () => true, poll: () => null },
      } as unknown as {
        frame(buttons: number, analog?: number, touches?: number[], hits?: number[]): void;
        dispose(): void; inspect(): { id: number; name?: string; text: string }[];
        ancestors(id: number): number[];
        editorView(): { text: string; caret: number; value: string; cursorX: number };
        state(): { open: boolean; active: boolean; drawer: boolean };
        close(): void; blur(): void; focus(id: number): void; press(id: number): void; collapse(): void;
      };
      runInNewContext(await build.outputs[0]!.text(), guest);
      const frame = (x?: number, y?: number, hit?: number, buttons = 0) => {
        guest.frame(buttons, 0, x === undefined ? [] : [x | (y! << 9)], x === undefined ? [] : [hit!]);
        wasm.tick();
      };
      const tap = (x: number, y: number) => { frame(x, y, wasm.ops.hitTestBounds!(x, y)); frame(); frame(); };
      const mouse = (x: number, y: number, down: boolean) => {
        events = JSON.stringify({ t: "mouse", x, y, d: down });
        frame(undefined, undefined, undefined, down ? BTN.CIRCLE : 0);
      };
      const point = (id: number): [number, number] => {
        // Find an actually exposed bounds-hit in this field/button subtree.
        for (let y = 4; y < 272; y += 4) for (let x = 12; x < 480; x += 8) {
          if (guest.ancestors(wasm.ops.hitTestBounds!(x, y)).includes(id)) return [x, y];
        }
        throw new Error(`not exposed: ${JSON.stringify(guest.inspect().find(n => n.id === id))}`);
      };
      const field = () => guest.inspect().find(n => n.name === "textField")!;
      const button = (text: string) => (guest.inspect().find(n => n.text === text) ?? guest.inspect().find(n => n.text === text + "▼"))!;
      try {
        frame(); frame();
        const send = field();
        expect(send).toBeDefined();
        const [x, y] = point(send.id);
        // Hold is one click, no repeat; release only focuses the first time.
        const hit = wasm.ops.hitTestBounds!(x, y);
        for (let i = 0; i < 20; i++) frame(x, y, hit);
        expect(guest.state().open).toBe(false);
        frame(); frame();
        expect(guest.state().active).toBe(true);
        expect(guest.state().open).toBe(false);
        // Drag and terminal CANCEL never count as the second click.
        frame(x, y, hit); frame(x + 30, y, hit); frame(); frame();
        expect(guest.state().open).toBe(false);
        frame(x, y, hit); guest.frame(0, 0, [(x | (y << 9) | 0x40000000) >>> 0], [0]); wasm.tick(); frame();
        expect(guest.state().open).toBe(false);
        for (let i = 0; i < 40; i++) frame(); // No double-click timeout.
        tap(x, y);
        expect(guest.state().open).toBe(enabled);
        if (enabled) {
          tap(...point(button("q").id));
          expect(field().text).toContain("q");
          expect(guest.editorView()).toMatchObject({ value: "q", caret: 1 });
          expect(guest.editorView().cursorX).toBe(17);
          expect(guest.editorView().text).toContain("发送内容");
          expect(guest.editorView().text).toContain("q");
          mouse(10, 34, true); mouse(10, 34, false);
          expect(guest.editorView().caret).toBe(0);
          mouse(400, 34, true); mouse(400, 34, false);
          expect(guest.editorView().caret).toBe(1);
          // Edit the live field from the visible preview, not a second draft.
          tap(10, 34);
          expect(guest.editorView().caret).toBe(0);
          tap(...point(button("z").id));
          expect(guest.editorView().value).toBe("zq");
          tap(...point(button("退格").id));
          expect(guest.editorView().value).toBe("q");
          tap(400, 34);
          expect(guest.editorView().caret).toBe(1);
          tap(...point(button("退格").id));
          expect(field().text).not.toContain("q");
          tap(...point(button("w").id));
          tap(...point(button("回车").id));
          expect(field().text).toContain("w");
          expect(guest.editorView().value).toBe("w\n");
          expect(guest.editorView().text).toContain("w");
          const qId = button("q").id;
          for (let i = 0; i < 3; i++) {
            tap(...point(button("大小写").id));
            expect(button("Q").id).toBe(qId);
            tap(...point(button("Q").id));
            tap(...point(button("大小写").id));
            expect(button("q").id).toBe(qId);
          }
          expect(field().text).toContain("QQQ");
          events = JSON.stringify({ t: "ch", s: "x".repeat(1000) }); frame(); frame();
          expect(guest.editorView().value.length).toBe(1005);
          expect(guest.editorView().text.length).toBeLessThan(160);
          expect(guest.editorView().cursorX).toBeLessThan(463);
          // The visible second row maps back into the long original line.
          tap(10, 54);
          const caretBeforeClose = guest.editorView().caret;
          expect(caretBeforeClose).toBeLessThan(1005);
          expect(caretBeforeClose).toBeGreaterThan(900);
          // Repeated activation is idempotent and does not steal field focus.
          guest.press(send.id); frame();
          expect(guest.state().open).toBe(true);
          tap(...point(button("收起").id));
          expect(guest.state().open).toBe(false);
          expect(guest.editorView().caret).toBe(caretBeforeClose);
          for (let i = 0; i < 10; i++) {
            tap(x, y); expect(guest.state().open).toBe(true);
            expect(button("q").id).toBe(qId); // Reuse, including after Shift.
            tap(...point(button("收起").id));
            expect(guest.state().open).toBe(false);
          }
          tap(x, y); expect(guest.state().open).toBe(true);
          guest.blur(); frame(); expect(guest.state().open).toBe(false);
          tap(x, y); expect(guest.state().open).toBe(false);
          tap(x, y); expect(guest.state().open).toBe(true);
          guest.collapse(); frame();
          expect(guest.state()).toMatchObject({ open: false, active: false });
          guest.collapse(); frame();
        }
        guest.close(); guest.blur(); frame();
        // Desktop selection route focuses before press: first click must stay closed.
        if (features.values["ui.selection"]) {
          const [mx, my] = point(field().id);
          mouse(mx, my, true); expect(guest.state().open).toBe(false);
          mouse(mx, my, false); expect(guest.state().open).toBe(false);
          mouse(mx, my, true); mouse(mx + 20, my, true); mouse(mx, my, false);
          expect(guest.state().open).toBe(false);
          mouse(mx, my, true); mouse(mx, my, false);
          expect(guest.state().open).toBe(enabled);
          guest.close(); frame();
        }
        // Settings TextFields must work above the cached connection drawer.
        tap(60, 16); expect(guest.state().drawer).toBe(true);
        // Prepare the custom-baud field via its actual Select. At this small
        // viewport its last option is below the screen; setup need not test
        // popup scrolling, so activate that option directly.
        const panHit = wasm.ops.hitTestBounds!(130, 140);
        frame(130, 140, panHit); frame(130, 100, panHit); frame(130, 55, panHit); frame(); frame();
        tap(...point(button("115200").id));
        guest.press(button("自定义…").id); frame();
        expect(guest.state().open).toBe(false); // onHandle.focus() is programmatic.
        const custom = guest.inspect().filter(n => n.name === "textField").at(-1)!;
        expect(custom.id).not.toBe(field().id);
        const [cx, cy] = point(custom.id);
        guest.blur(); frame();
        tap(cx, cy); expect(guest.state().open).toBe(false);
        tap(cx, cy); expect(guest.state().open).toBe(enabled);
        if (enabled) {
          tap(...point(button("2").id));
          expect(guest.inspect().find(n => n.id === custom.id)!.text).toContain("2");
          expect(guest.editorView().text).toContain("自定义波特率");
          expect(guest.editorView().value).toContain("2");
          const baudText = guest.editorView().value;
          tap(...point(button("回车").id));
          expect(guest.editorView().value).toBe(baudText); // Single-line Enter is not a newline.
          tap(...point(button("收起").id));
        }
        tap(130, 249); frame();
        const settingsField = guest.inspect().filter(n => n.name === "textField").at(-1)!;
        const [sx, sy] = point(settingsField.id);
        tap(sx, sy); expect(guest.state().open).toBe(false);
        tap(sx, sy); expect(guest.state().open).toBe(enabled);
        if (enabled) {
          const before = guest.inspect().find(n => n.id === settingsField.id)!.text;
          tap(...point(button("1").id));
          expect(guest.inspect().find(n => n.id === settingsField.id)!.text).not.toBe(before);
          expect(guest.editorView().text).toContain("接收区历史行数");
          tap(...point(button("收起").id));
          expect(guest.state().open).toBe(false);
        }
      } finally { guest.dispose(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30_000);
}
