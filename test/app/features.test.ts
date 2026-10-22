/// <reference path="../../vendor/pocketjs/framework/compiler/ambient.d.ts" />
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAppFeatures, specializeAppSource, filterFeatureResource } from "../../vendor/pocketjs/framework/compiler/app-features";
import { transformFile } from "../../vendor/pocketjs/framework/compiler/jsx-plugin";
import registry from "../../pocket.features.json";

const root = resolve(import.meta.dir, "../..");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "pocketcom-features-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const load = (profile: string) => loadAppFeatures(join(root, "pocket.features.json"), profile);
async function config(value: unknown) {
  const file = join(dir, "features.json");
  await Bun.write(file, JSON.stringify(value));
  return file;
}

describe("product features", () => {
  test("public CLI accepts the product profile and rejects an unknown profile", () => {
    const args = [process.execPath, join(root, "vendor/pocketjs/tools/pocket.ts"), "check",
      "--target", "macos-gpui", "--manifest", "app/pocket.json", "--project-root", root,
      "--app-features", "pocket.features.json", "--app-profile"];
    const valid = Bun.spawnSync([...args, "desktop"], { cwd: root });
    expect(valid.exitCode).toBe(0);
    expect(valid.stdout.toString()).toContain("ResolvedBuildPlan");
    const invalid = Bun.spawnSync([...args, "missing-profile"], { cwd: root });
    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.stderr.toString()).toContain("unknown profile");
  });

  test("registry rejects missing, unknown, nonboolean flags and dependency cycles", async () => {
    for (const flags of [{}, { terminal: true, typo: false }, { terminal: 1 }]) {
      await expect(loadAppFeatures(await config({ ...registry, profiles: { bad: flags } }), "bad")).rejects.toThrow();
    }
    await expect(loadAppFeatures(await config({ ...registry, features: { terminal: { requires: ["typo"] } } }), "desktop")).rejects.toThrow("unknown dependency");
    await expect(loadAppFeatures(await config({ ...registry, features: { terminal: { requires: ["terminal"] } }, profiles: { desktop: { terminal: true } } }), "desktop")).rejects.toThrow("cyclic");
    await expect(loadAppFeatures(await config({ ...registry, features: { terminal: { requires: ["base"] }, base: {} }, profiles: { bad: { terminal: true, base: false } } }), "bad")).rejects.toThrow("requires base");
  });

  test("planned catalog entries cannot become effective switches", async () => {
    const declared = {
      version: 1, module: "test/features", features: { live: {}, future: { status: "planned" } },
      profiles: { test: { live: true } },
    };
    const planned = await loadAppFeatures(await config(declared), "test");
    expect(planned.definitions.future?.status).toBe("planned");
    expect(planned.values).toEqual({ live: true });
    expect(planned.disabledModules.size).toBe(0);
    await expect(specializeAppSource(join(dir, "planned.ts"),
      'import {hasAppFeature} from "test/features"; export const value=hasAppFeature("future");', planned))
      .rejects.toThrow("only planned, not integrated");
    for (const flag of [false, true]) {
      await expect(loadAppFeatures(await config({ ...declared, profiles: { test: { live: true, future: flag } } }), "test"))
        .rejects.toThrow("planned feature cannot be configured");
    }
    for (const future of [{ status: "typo" }, { status: "planned", modules: [] }, { status: "planned", i18n: [] }])
      await expect(loadAppFeatures(await config({ ...declared, features: { live: {}, future } }), "test")).rejects.toThrow();
    await expect(loadAppFeatures(await config({ ...declared, features: { ...declared.features, live: { requires: ["future"] } } }), "test"))
      .rejects.toThrow("requires planned feature");
  });

  test("product profiles expose only integrated features", async () => {
    for (const profile of Object.keys(registry.profiles)) {
      const product = await load(profile);
      expect(Object.keys(product.values)).toEqual(["terminal", "mcp.server"]);
      for (const [name, definition] of Object.entries(product.definitions)) if (definition.status === "planned") {
        expect(product.values).not.toHaveProperty(name);
        expect(definition.modules).toBeUndefined();
        expect(definition.i18n).toBeUndefined();
      }
    }
  });

  test("folds aliases before Vapor, collects only live styles/text and isolates warm caches", async () => {
    const source = `import {hasAppFeature as feature} from "@pocketcom/features";
      import {View, Text} from "@pocketjs/framework/components";
      export default () => <View>{feature("terminal") ? <Text class="text-2xl">終端專屬</Text> : <Text class="text-xs">base</Text>}</View>;`;
    for (const profile of ["terminal-on", "terminal-off", "terminal-on", "terminal-off"]) {
      const result = await transformFile(join(dir, "view.tsx"), source, "vue-vapor", { appFeatures: await load(profile) });
      expect(result.code.includes("終端專屬")).toBe(profile === "terminal-on");
      expect(result.textCodepoints.has("終".codePointAt(0)!)).toBe(profile === "terminal-on");
      expect(result.classStrings.includes("text-2xl")).toBe(profile === "terminal-on");
      expect(result.code).not.toContain("hasAppFeature");
    }
  });

  test("respects shadowing, rejects dynamic names and escaping feature function", async () => {
    const off = await load("terminal-off");
    const output = await specializeAppSource(join(dir, "shadow.ts"), `import {hasAppFeature as f} from "@pocketcom/features";
      export const enabled=f("terminal"); export function local(f: (s:string)=>boolean) { return f("terminal"); }`, off);
    expect(output).toContain("enabled = false");
    expect(output).toContain('return f("terminal")');
    for (const expr of ['f(name)', 'f("typo")', 'f']) {
      await expect(specializeAppSource(join(dir, "bad.ts"), `import {hasAppFeature as f} from "@pocketcom/features"; export const value=${expr};`, off)).rejects.toThrow();
    }
  });

  test("disabled module removal preserves dependency evaluation and rejects side effects or live references", async () => {
    const feature = join(dir, "optional.ts");
    const dep = join(dir, "dep.ts");
    await Bun.write(dep, 'globalThis.effect = true;');
    const file = await config({ version: 1, module: "test/features", features: { optional: { modules: ["optional.ts"] } }, profiles: { off: { optional: false } } });
    const off = await loadAppFeatures(file, "off");
    await Bun.write(feature, 'import "./dep"; export function optional() { return 1; }');
    const output = await specializeAppSource(join(dir, "main.ts"), 'import {optional} from "./optional"; export const base=1;', off);
    expect(output).toContain(dep);
    expect(off.excluded.has(feature)).toBe(true);
    await expect(specializeAppSource(join(dir, "main.ts"), 'import {optional} from "./optional"; export const value=optional();', off)).rejects.toThrow("still referenced");
    await Bun.write(feature, 'register(); export const optional = 1;');
    await expect(specializeAppSource(join(dir, "main.ts"), 'import {optional} from "./optional";', off)).rejects.toThrow("top-level effects");
  });

  test("rejects hoisted declarations instead of changing their scope", async () => {
    const off = await load("terminal-off");
    for (const body of ["var x = 1;", "{ var x = 1; }", "{ function x() {} }"])
      await expect(specializeAppSource(join(dir, "hoist.ts"),
        `import {hasAppFeature as f} from "@pocketcom/features"; if (f("terminal")) ${body}`, off)).rejects.toThrow("hoisted");
  });

  test("real session excludes parser, RX subscription and response pump", async () => {
    const off = await load("terminal-off");
    const path = join(root, "app/session.ts");
    const code = await specializeAppSource(path, await Bun.file(path).text(), off);
    expect(code).not.toContain("new Terminal");
    expect(code).not.toContain("bus.subscribe");
    expect(code).not.toContain("takeResponses");
    expect(off.excluded.has(join(root, "core/term.ts"))).toBe(true);
    const on = await specializeAppSource(path, await Bun.file(path).text(), await load("terminal-on"));
    expect(on).toContain("new Terminal");
    expect(on).toContain("bus.subscribe");
    expect(on).toContain("takeResponses");
  });

  test("MCP profiles remove executor, state, watchers, UI and labels before compilation", async () => {
    expect(registry.profiles.desktop["mcp.server"]).toBe(true);
    expect(registry.profiles["aic-diagnostic"]["mcp.server"]).toBe(false);
    expect(registry.profiles["mcp-on"].terminal).toBe(registry.profiles["mcp-off"].terminal);
    for (const profile of ["mcp-off", "mcp-on", "mcp-off"]) {
      const features = await load(profile);
      const enabled = features.values["mcp.server"];
      const path = join(root, "app/session.ts");
      const code = await specializeAppSource(path, await Bun.file(path).text(), features);
      for (const marker of ["executeMcpCommand", "parseMcpCommands", "collectMcpLines", "shouldMcpRun", "watch(mcpEnabled", "watch(mcpPort", "com.mcpCmds", "com.mcpStart"])
        expect(code.includes(marker)).toBe(enabled);
      expect(features.excluded.has(join(root, "core/mcp.ts"))).toBe(!enabled);
      for (const file of ["app/panel.tsx", "app/statusbar.tsx"]) {
        const result = await transformFile(join(root, file), await Bun.file(join(root, file)).text(), "vue-vapor", { appFeatures: features });
        expect(result.code.includes(file.includes("panel") ? 't("mcp.toggle")' : 't("mcp.off")')).toBe(enabled);
      }
      const pack = { mcp: { toggle: "MCP", terminalHint: "hint" }, source: { manual: "manual", mcp: "MCP", sys: "SYS" } };
      expect(filterFeatureResource(pack, features)).toEqual(enabled
        ? { mcp: { toggle: "MCP", terminalHint: "hint" }, source: { manual: "manual", mcp: "MCP", sys: "SYS" } }
        : { source: { sys: "SYS" } });
    }
  });

  test("disabled MCP ignores persisted enablement and host events while preserving configuration", async () => {
    const features = await load("mcp-off");
    const output = join(dir, "mcp-off-session.mjs");
    const sessionPath = join(root, "app/session.ts");
    const build = await Bun.build({
      entrypoints: [sessionPath], target: "bun", format: "esm",
      plugins: [{ name: "specialized-session", setup(builder) {
        builder.onLoad({ filter: /app\/session\.ts$/ }, async () => ({
          contents: await specializeAppSource(sessionPath, await Bun.file(sessionPath).text(), features), loader: "ts",
        }));
        builder.onResolve({ filter: /^@pocketjs\/framework$/ }, () => ({ path: "framework", namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: 'export const getOps = () => ({measureText: s => s.length * 8});', loader: "js",
        }));
      } }],
    });
    expect(build.success).toBe(true);
    await Bun.write(output, build.outputs[0]!);
    const script = `
      import { strict as assert } from "node:assert";
      const mcp = {enabled:true,port:8123,token:"persisted-token"};
      let exported;
      const forbidden = () => { throw new Error("disabled MCP called host"); };
      globalThis.com = {
        serialList: () => "[]", serialOpen: () => "{}", write: () => true,
        setSignals: () => true, close: () => true,
        poll: () => JSON.stringify({t:"mcp",on:true,clients:2}),
        cfgRead: () => JSON.stringify({version:1,mcp}), cfgWrite: () => true,
        cfgExport: json => { exported=JSON.parse(json); return '{"ok":true}'; },
        mcpStart: forbidden, mcpStop: forbidden, mcpCmds: forbidden,
        mcpResults: forbidden, mcpFeed: forbidden,
      };
      const s = await import(${JSON.stringify(output)});
      assert.equal(s.comAvailable,true);
      for (const key of ["mcpEnabled","mcpPort","mcpToken","mcpState"]) assert.equal(s[key],undefined);
      s.syncMcpServer(); s.setUiMode("transfer"); s.pumpSession(0);
      assert.equal(s.logLabels().rx,""); assert.equal(s.logLabels().txMcp,"");
      s.exportConfig(); assert.deepEqual(exported.mcp,mcp);
    `;
    const child = Bun.spawnSync([process.execPath, "-e", script], { cwd: root });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  });

  test("dictionary filtering keeps shared labels and agrees with profile identity", async () => {
    const on = await load("terminal-on"), off = await load("terminal-off");
    expect(on.fingerprint).not.toBe(off.fingerprint);
    const pack = { terminal: { hint: "terminal" }, "settings.scrollbackLines": "scroll", settings: { scrollbackLines: "scroll", language: "language" }, app: { title: "PocketCOM" } };
    expect(filterFeatureResource(pack, on)).toEqual(pack);
    expect(filterFeatureResource(pack, off)).toEqual({ settings: { language: "language" }, app: { title: "PocketCOM" } });
  });
});
