#!/usr/bin/env bun
// aic-sim.ts — compile the desktop app with an AIC-faithful baked font atlas.
//
// The stock desktop plan bakes the compiler's default fonts at the macos-app
// raster density (2) because CoreText renders the UI there. This variant
// re-resolves app/pocket.json against the fork's macos-app contract
// (tools/macos-gpui-profile.ts, single source of truth) with rasterDensity
// pinned to the AIC host profile — so the sim follows board changes — and
// bakes MiSans from assets/fonts, the same fonts, charset collection, density
// and atlas metrics the board package builds with. Render it through
// `node tools/dev.mjs --baked-text` (baked GLYPH_RUN path, no CoreText).
// Fidelity limits (no RGB565 quantization, no panel pixel pitch) live in
// docs/e2e.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
  type PlatformContractRegistry,
} from "../vendor/pocketjs/contracts/spec/platforms.ts";
import { MACOS_GPUI_CONTRACTS } from "../vendor/pocketjs/tools/macos-gpui-profile.ts";
import { validatePocketAicHostProfile } from "../vendor/pocketjs/framework/src/manifest/aic-host.ts";
import { validateAndResolveBuildPlan } from "../vendor/pocketjs/framework/src/manifest/resolve.ts";
import { canonicalJson, type ResolvedBuildPlan } from "../vendor/pocketjs/framework/src/manifest/plan.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, "app/pocket.json");
const AIC_PROFILE = join(ROOT, "host/rtthread/pocket.host.json");
const WORK = join(ROOT, ".pocket/aic-sim");

/** The fork's macos-app contract with the display raster density replaced. */
export function simRegistry(density: number): PlatformContractRegistry {
  const contract = MACOS_GPUI_CONTRACTS.targets["macos-app"];
  return definePlatformContractRegistry(
    POCKET_CAPABILITIES,
    defineTargetRegistry({
      "macos-app": {
        ...contract,
        display: { ...contract.display, rasterDensity: density },
      },
    }),
  );
}

/** Resolve the desktop manifest against the density-pinned contract. */
export function resolveSimPlan(density: number): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    JSON.parse(readFileSync(MANIFEST, "utf8")),
    { target: "macos-app" },
    simRegistry(density),
  );
  if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
  return resolution.plan;
}

/** Density default: the board profile keeps the sim anchored to the panel. */
export function parseSimDensity(args: readonly string[]): number {
  for (const a of args) {
    if (!a.startsWith("--density=")) {
      throw new Error(`usage: bun tools/aic-sim.ts [--density=N] (unknown ${a})`);
    }
  }
  const flags = args.filter(a => a.startsWith("--density="));
  if (flags.length === 0) {
    const profile = validatePocketAicHostProfile(JSON.parse(readFileSync(AIC_PROFILE, "utf8")));
    if (!profile.ok) throw new Error(JSON.stringify(profile.diagnostics));
    return profile.value.display.rasterDensity;
  }
  const value = Number(flags[flags.length - 1]!.slice("--density=".length));
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new Error("--density wants an integer from 1 through 255");
  }
  return value;
}

if (import.meta.main) {
  const density = parseSimDensity(process.argv.slice(2));
  for (const file of [MANIFEST, AIC_PROFILE, join(ROOT, "pocket.features.json"),
    join(ROOT, "assets/fonts/MiSans-Regular.ttf"), join(ROOT, "assets/fonts/MiSans-Bold.ttf")]) {
    if (!existsSync(file)) throw new Error(`missing ${file}; initialize submodules/dependencies first`);
  }
  const plan = resolveSimPlan(density);
  mkdirSync(WORK, { recursive: true });
  const planPath = join(WORK, "plan.json");
  writeFileSync(planPath, canonicalJson(plan));

  // Same font and charset wiring as the AIC package build (host/rtthread/aic.ts):
  // MiSans regular/bold slots, mono stays the fork's vendored JetBrains Mono,
  // and build.ts collects the i18n resource characters per the app profile.
  const child = Bun.spawn([
    process.execPath,
    join(ROOT, "vendor/pocketjs/tools/build.ts"),
    `--plan=${planPath}`,
    `--project-root=${ROOT}`,
    `--outdir=${WORK}`,
    `--app-features=${join(ROOT, "pocket.features.json")}`, "--app-profile=desktop",
    `--font-regular=${join(ROOT, "assets/fonts/MiSans-Regular.ttf")}`,
    `--font-bold=${join(ROOT, "assets/fonts/MiSans-Bold.ttf")}`,
  ], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) process.exit(status);
  console.log(
    `aic-sim: ${plan.app.output} baked at rasterDensity ${density} → ${WORK}\n` +
      `aic-sim: run with: node tools/dev.mjs --baked-text [--resolution 480x272] -- <host flags…>`,
  );
}
