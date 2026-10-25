/// <reference path="../../vendor/pocketjs/framework/compiler/ambient.d.ts" />
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAppFeatures, specializeAppSource, filterFeatureResource } from "../../vendor/pocketjs/framework/compiler/app-features";
import { transformFile } from "../../vendor/pocketjs/framework/compiler/jsx-plugin";
import registry from "../../pocket.features.json";

const root = resolve(import.meta.dir, "../..");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "ui-features-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ui = Object.keys(registry.features).filter(k => k.startsWith("ui."));
const load = (name: string) => loadAppFeatures(join(root, "pocket.features.json"), name);

test("UI profiles and dependencies agree with the product registry", async () => {
  for (const name of ["desktop", "aic-diagnostic", "ui-on", "ui-off"]) {
    const features = await load(name);
    for (const key of ui) expect(features.values[key]).toBe(name === "desktop" || name === "ui-on" || (name === "aic-diagnostic" && key === "ui.soft-keyboard"));
  }
  const on = await load("ui-on"), off = await load("ui-off");
  for (const key of Object.keys(on.values).filter(k => !k.startsWith("ui."))) expect(on.values[key]).toBe(off.values[key]);
});

for (const profile of ["ui-on", "ui-off"]) test(`UI controls, modules and resources specialize: ${profile}`, async () => {
  const features = await load(profile);
  const enabled = profile === "ui-on";
  for (const [file, markers] of Object.entries({
    "app/settings-modal.tsx": ['t("settings.language")', 't("settings.theme")', 't("settings.themeSystem")', 't("settings.fontSize")'],
    "app/app.tsx": ['svc?.send', 'SoftKeyboard'],
    "app/transfer.tsx": ['t("menu.copy")', 't("menu.selectAll")'],
  })) {
    const result = await transformFile(join(root, file), await Bun.file(join(root, file)).text(), "vue-vapor", { appFeatures: features });
    for (const marker of markers) expect(result.code.includes(marker)).toBe(enabled);
  }
  const pack = filterFeatureResource(await Bun.file(join(root, "assets/i18n/en.json")).json(), features) as any;
  expect(!!pack.keyboard).toBe(enabled);
  expect(!!pack.menu?.copy).toBe(enabled);
  expect(!!pack.settings.language).toBe(enabled);
  expect(!!pack.settings.themeSystem).toBe(enabled);
  expect(!!pack.settings.fontSize).toBe(enabled);
  expect(pack.settings.historyLines).toBeTruthy();
});

// Run specialized session code in a fresh process to exercise config restoration,
// appearance events and re-export without sharing Vue module singletons.
for (const profile of ["ui-on", "ui-off"]) test(`UI config restoration and round trip: ${profile}`, async () => {
  const features = await load(profile);
  const output = join(dir, profile + ".mjs");
  const entry = join(dir, profile + ".ts");
  await Bun.write(entry, `export * from ${JSON.stringify(join(root, "app/session.ts"))}; export {locale,setLocale} from ${JSON.stringify(join(root, "app/i18n.ts"))}; export {theme,themeMode,systemAppearance,setSystemAppearance} from ${JSON.stringify(join(root, "app/theme.ts"))};`);
  const build = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm", plugins: [{ name: "ui-specialize", setup(builder) {
    builder.onLoad({ filter: /(?:app|bridge)\/.*\.ts$/ }, async ({ path }) => ({ contents: await specializeAppSource(path, await Bun.file(path).text(), features), loader: "ts" }));
    builder.onResolve({ filter: /^@pocketjs\/framework$/ }, () => ({ path: "framework", namespace: "stub" }));
    builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export const getOps=()=>({measureText:s=>s.length*8});', loader: "js" }));
  } }] });
  expect(build.success).toBe(true);
  await Bun.write(output, build.outputs[0]!);
  const child = Bun.spawnSync([process.execPath, "-e", `
    import {strict as a} from "node:assert";
    const enabled=${profile === "ui-on"}; let exported;
    globalThis.com={write:()=>true,close:()=>true,poll:()=>JSON.stringify({t:"appearance",v:"light"}),
      cfgRead:()=>JSON.stringify({version:1,language:"en",theme:"system",fontSize:16}),cfgWrite:()=>true,
      cfgExport:json=>{exported=JSON.parse(json);return '{"ok":true}'}};
    const s=await import(${JSON.stringify(output)});
    a.equal(s.locale.value,enabled?"en":"zh-CN");
    a.equal(s.themeMode.value,enabled?"system":"dark");
    a.equal(s.fontSize.value,enabled?16:14);
    a.equal(s.systemAppearance!==undefined,enabled);
    s.setSystemAppearance("light");a.equal(s.theme.value.bg,enabled?"#eef0f4":"#0e1116");
    s.setLocale("en");a.equal(s.locale.value,enabled?"en":"zh-CN");
    s.exportConfig();a.equal(exported.language,"en");a.equal(exported.theme,"system");a.equal(exported.fontSize,16);
  `], { cwd: root });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
});

for (const disabled of ui) test(`UI feature can be disabled independently: ${disabled}`, async () => {
  const values: Record<string, boolean> = { ...registry.profiles.desktop, [disabled]: false };
  if (disabled === "ui.selection") values["ui.context-menu"] = false;
  if (disabled === "ui.theme-switch") values["ui.theme-system"] = false;
  const file = join(dir, disabled + ".json");
  await Bun.write(file, JSON.stringify({ ...registry,
    resources: registry.resources.map(path => join(root, path)),
    features: Object.fromEntries(Object.entries(registry.features).map(([name, definition]) => [name, {
      ...definition, ...("modules" in definition ? { modules: definition.modules.map(path => join(root, path)) } : {}),
    }])), profiles: { test: values },
  }));
  const features = await loadAppFeatures(file, "test");
  for (const path of ["app/app.tsx", "app/widgets.tsx", "app/terminal.tsx", "app/settings-modal.tsx", "app/panel.tsx", "app/transfer.tsx"]) {
    const result = await transformFile(join(root, path), await Bun.file(join(root, path)).text(), "vue-vapor", { appFeatures: features });
    expect(result.code).not.toContain("hasAppFeature");
  }
});

for (const profile of ["ui-on", "ui-off"]) test(`TextField editing and soft keyboard input: ${profile}`, async () => {
  const features = await load(profile), enabled = profile === "ui-on";
  const entry = join(dir, "input-" + profile + ".ts"), output = entry + ".mjs";
  await Bun.write(entry, `export {TextField} from ${JSON.stringify(join(root, "app/widgets.tsx"))}; export * from ${JSON.stringify(join(root, "app/fields.ts"))}; ${enabled ? `export * from ${JSON.stringify(join(root, "app/soft-keyboard.tsx"))};` : ""}`);
  const build = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm", plugins: [{ name: "input-specialize", setup(builder) {
    builder.onLoad({ filter: /app\/.*\.tsx?$/ }, async ({ path }) => ({ contents: await specializeAppSource(path, await Bun.file(path).text(), features), loader: path.endsWith("tsx") ? "tsx" : "ts" }));
    builder.onResolve({ filter: /^react\/jsx/ }, () => ({ path: "jsx", namespace: "jsx-stub" }));
    builder.onLoad({ filter: /.*/, namespace: "jsx-stub" }, () => ({ contents: "export const jsxDEV=()=>({}),jsx=()=>({}),jsxs=()=>({});", loader: "js" }));
    builder.onResolve({ filter: /^@pocketjs\/framework/ }, () => ({ path: "framework", namespace: "stub" }));
    builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `export const View=()=>{},Text=()=>{},Portal=()=>{},focusNode=()=>{},setProp=()=>{},createGesture=()=>({}),onFrame=()=>{},virtualNow=()=>0,getOps=()=>({measureText:s=>s.length*8});`, loader: "js" }));
  } }] });
  expect(build.success).toBe(true);
  await Bun.write(output, build.outputs[0]!);
  const child = Bun.spawnSync([process.execPath, "-e", `
    import {strict as a} from "node:assert";
    const s=await import(${JSON.stringify(output)}); let handle; let submitted=0;
    s.TextField({multiline:true,initial:"ab",onHandle:h=>handle=h,onSubmit:()=>submitted++});
    handle.focus();const f=s.activeField.value;const mods={cmd:false,ctl:false,alt:false,sh:false};
    f.onKey("Left",mods);f.onCh("X");a.equal(handle.text(),"aXb");
    f.onPaste("Y");a.equal(handle.text(),${enabled ? '"aXYb"' : '"aXb"'});
    f.onKey("Enter",{...mods,cmd:true});a.equal(submitted,${enabled ? 1 : 0});
    if (${enabled}) {
    s.toggleKeyboard();a.equal(s.keyboardOpen(),${enabled});
    handle.setText("");s.keyboardInput("q");s.keyboardInput("space");s.keyboardInput("Enter");
    a.equal(handle.text(),${enabled ? '"q \\n"' : '""'});
    s.keyboardInput("Backspace");a.equal(handle.text(),${enabled ? '"q "' : '""'});
    a.equal(s.activeField.value,f);s.keyboardInput("close");a.equal(s.keyboardOpen(),false);
    s.openKeyboard();s.openKeyboard();a.equal(s.keyboardOpen(),${enabled});
    s.setActiveField(null);s.setActiveField(f);a.equal(s.keyboardOpen(),false);
    let other;s.TextField({onHandle:h=>other=h});other.focus();
    s.openKeyboard();a.equal(s.keyboardOpen(),${enabled});
    handle.focus();a.equal(s.keyboardOpen(),false);
    const saved=other.text();s.keyboardInput("z");a.equal(other.text(),saved);
    } else { a.equal("keyboardInput" in s, false); }
  `], { cwd: root });
  expect(child.stderr.toString()).not.toContain("error:");
  expect(child.exitCode).toBe(0);
});
