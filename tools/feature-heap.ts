// Controlled product feature A/B: same shared App, AIC plan, fonts and limits.
// No firmware build, flashing, device IO or production-entry replacement.
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadAppFeatures } from "../vendor/pocketjs/framework/compiler/app-features";
import { validateAndResolveBuildPlan } from "../vendor/pocketjs/framework/src/manifest/resolve";
import { validatePocketAicHostProfile, hashPocketAicHostProfile, pocketAicHostExtension, pocketAicHostRegistry } from "../vendor/pocketjs/framework/src/manifest/aic-host";
import { canonicalJson } from "../vendor/pocketjs/framework/src/manifest/plan";
import { makeVariant } from "../vendor/pocketjs/tools/pocket-pack";
import { encodePocketPackage } from "../vendor/pocketjs/contracts/spec/pocket-package";
import { compactBundle } from "../host/rtthread/build-support";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--feature" || !["terminal", "mcp.server", "transport", "ui"].includes(args[1]!)))
  throw new Error("usage: bun tools/feature-heap.ts [--feature terminal|mcp.server|transport|ui]");
const feature = args[1] ?? "terminal";
const names = feature === "ui" ? ["ui-on", "ui-off"] : feature === "terminal" ? ["terminal-on", "terminal-off"] : feature === "transport" ? ["transport-all", "transport-serial"] : ["mcp-on", "mcp-off"];
const [onProfile, offProfile] = names as [string, string];
const out = join(root, feature === "ui" ? "dist/ui-feature-heap" : feature === "terminal" ? "dist/feature-heap" : feature === "transport" ? "dist/transport-feature-heap" : "dist/mcp-feature-heap");
mkdirSync(out, { recursive: true });
rmSync(join(out, "sources"), { recursive: true, force: true });
const sha = (data: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
async function command(args: string[], log: string) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  await Bun.write(log, stdout);
  await Bun.write(log + ".stderr", stderr);
  if (exitCode !== 0) throw new Error(`${args[1]} failed (${exitCode}); see ${log}\n${stderr.slice(-4000)}`);
  return stdout;
}
function samples(stdout: string) {
  const stages: Record<string, Record<string, number>> = {};
  for (const line of stdout.split("\n")) {
    const stage = line.match(/^\[PJS-PROBE\] (S\d[^ ]*) /)?.[1];
    if (!stage) continue;
    const values = stages[stage] ??= {};
    for (const pair of line.matchAll(/(\w+)=(\d+)(?:\/(\d+))?/g)) {
      values[pair[1]!] = Number(pair[2]);
      if (pair[3] !== undefined) values[pair[1] + "_second"] = Number(pair[3]);
    }
  }
  if (!stages["S5-steady"] || Object.values(stages).some(s => s.caps_fails || s.frames_second))
    throw new Error("probe did not complete with zero allocation/frame failures");
  return stages;
}
console.log("feature heap: preparing diagnostic package/contract (production entry unchanged)");
await command([process.execPath, "host/rtthread/aic.ts", "package"], join(out, "diagnostic-build.log"));
const profile = validatePocketAicHostProfile(await Bun.file(join(root, "host/rtthread/pocket.host.json")).json());
if (!profile.ok) throw new Error(JSON.stringify(profile.diagnostics));
const manifest = { ...await Bun.file(join(root, "host/rtthread/pocket.json")).json(), app: {
  entry: "app/main.feature-probe.tsx", output: "pocketcom-feature-probe", framework: "vue-vapor",
  viewport: { logical: [480, 272], presentation: "native" },
}};
const p = profile.value;
const resolution = validateAndResolveBuildPlan(manifest, { target: p.id, hostExtension: pocketAicHostExtension(hashPocketAicHostProfile(p), p.tickHz) }, pocketAicHostRegistry(p));
if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
const plan = resolution.plan;
const onFlags = (await loadAppFeatures(join(root, "pocket.features.json"), onProfile)).values;
const offFlags = (await loadAppFeatures(join(root, "pocket.features.json"), offProfile)).values;
const varying = feature === "ui" ? Object.keys(onFlags).filter(key => key.startsWith("ui.")) : feature === "transport" ? Object.keys(onFlags).filter(key => key.startsWith("transport.") && key !== "transport.serial") : [feature];
if (varying.some(key => !onFlags[key] || offFlags[key]) || Object.keys(onFlags).some(key => !varying.includes(key) && onFlags[key] !== offFlags[key]))
  throw new Error(`profiles must differ only in ${feature}`);
const results: Record<string, any> = {};
for (const name of names) {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const planPath = join(dir, "plan.json");
  await Bun.write(planPath, canonicalJson(plan));
  const features = await loadAppFeatures(join(root, "pocket.features.json"), name);
  console.log(`feature heap: building ${name}`);
  await command([process.execPath, "vendor/pocketjs/tools/build.ts", `--plan=${planPath}`, `--project-root=${root}`, `--outdir=${dir}`,
    `--app-features=${features.file}`, `--app-profile=${name}`, `--hz=${p.tickHz}`,
    `--font-regular=${join(root, "assets/fonts/MiSans-Regular.ttf")}`, `--font-bold=${join(root, "assets/fonts/MiSans-Bold.ttf")}`], join(dir, "build.log"));
  const receipt = await Bun.file(join(dir, `${plan.app.output}.features.json`)).json();
  const parser = join(root, "core/term.ts"), view = join(root, "app/terminal.tsx");
  for (const module of [parser, view]) {
    if (receipt.modules.includes(module) !== features.values.terminal) throw new Error(`feature module graph mismatch: ${name} ${module}`);
  }
  if (receipt.modules.includes(join(root, "core/mcp.ts")) !== features.values["mcp.server"])
    throw new Error(`MCP module graph mismatch: ${name}`);
  for (const [name, definition] of Object.entries(features.definitions)) {
    if (!name.startsWith("transport.") && !name.startsWith("ui.")) continue;
    for (const module of definition.modules ?? []) {
      if (receipt.modules.includes(join(root, module)) !== features.values[name])
        throw new Error(`transport module graph mismatch: ${name} ${module}`);
    }
  }
  const compact = await compactBundle(join(dir, `${plan.app.output}.js`), join(dir, "compact"));
  const js = new Uint8Array(await Bun.file(compact).arrayBuffer());
  const pak = new Uint8Array(await Bun.file(join(dir, `${plan.app.output}.pak`)).arrayBuffer());
  const bytes = encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [makeVariant({
    target: p.id, hostAbi: plan.target.hostAbi, planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title }, js, pak,
  })] });
  const packagePath = join(dir, `${plan.app.output}.pocket`);
  await Bun.write(packagePath, bytes);
  const runs = [];
  for (let i = 1; i <= 3; i++) {
    console.log(`feature heap: probing ${name} ${i}/3`);
    const stdout = await command([process.execPath, "host/rtthread/probe.ts", packagePath, "--turns", "120"], join(dir, `probe-${i}.log`));
    runs.push(samples(stdout));
  }
  results[name] = { fingerprint: features.fingerprint, values: features.values, packageSha256: sha(bytes), jsBytes: js.length, pakBytes: pak.length,
    excludedModules: receipt.excludedModules, modules: receipt.modules, runs };
}
const comparison: Record<string, any> = {};
for (const stage of Object.keys(results[onProfile].runs[0])) {
  comparison[stage] = {};
  for (const metric of ["caps_live", "caps_peak", "js", "guest_live", "guest_peak", "obj", "atoms", "shape"]) {
    const median = (profile: string) => results[profile].runs.map((run: any) => run[stage][metric]).sort((a: number, b: number) => a-b)[1];
    const on = median(onProfile), off = median(offProfile);
    if (on !== undefined && off !== undefined) comparison[stage][metric] = { on, off, saved: on - off, percent: (on - off) / on * 100 };
  }
}
const version = await command(["git", "rev-parse", "HEAD"], join(out, "repository-revision.txt"));
const vendorVersion = await command(["git", "-C", "vendor/pocketjs", "rev-parse", "HEAD"], join(out, "pocketjs-revision.txt"));
await command(["git", "diff", "--binary"], join(out, "repository.patch"));
await command(["git", "-C", "vendor/pocketjs", "diff", "--binary"], join(out, "pocketjs.patch"));
// Preserve changed/new implementation files as well as tracked patches.
const sourceHashes: Record<string, string> = {};
for (const [directory, prefix] of [[root, ""], [join(root, "vendor/pocketjs"), "vendor/pocketjs/"]] as const) {
  const listing = await command(["git", "-C", directory, "ls-files", "-m", "--others", "--exclude-standard"],
    join(out, prefix ? "pocketjs-changed-files.txt" : "repository-changed-files.txt"));
  for (const file of new Set(listing.trim().split("\n"))) {
    if (!/\.(ts|tsx|json|md)$/.test(file)) continue;
    const content = new Uint8Array(await Bun.file(join(directory, file)).arrayBuffer());
    sourceHashes[prefix + file] = sha(content);
    await Bun.write(join(out, "sources", prefix, file + ".source"), content);
  }
}
const report = { feature, profiles: names, measuredAt: new Date().toISOString(), repositoryRevision: version.trim(), pocketjsRevision: vendorVersion.trim(), bun: Bun.version,
  sourceHashes,
  configSha256: sha(await Bun.file(join(root, "pocket.features.json")).text()), planHash: plan.planHash,
  conditions: { viewport: [480,272], jsLimit: 5*1024*1024, capsBudget: "unlimited", turns: 120, repetitions: 3,
    workload: "shared App idle, no com bridge: left panel + bridge unavailable state; terminal view not mounted", native: "64-bit malloc probe, excludes RT-Thread/WiFi/TLSF" },
  results, comparison };
await Bun.write(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(comparison, null, 2));
console.log(`feature heap: report ${join(out, "report.json")}`);
