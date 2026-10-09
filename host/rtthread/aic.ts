#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePocketAicHostProfile, hashPocketAicHostProfile, pocketAicHostExtension, pocketAicHostRegistry } from "../../vendor/pocketjs/framework/src/manifest/aic-host.ts";
import { validateAndResolveBuildPlan } from "../../vendor/pocketjs/framework/src/manifest/resolve.ts";
import { canonicalJson } from "../../vendor/pocketjs/framework/src/manifest/plan.ts";
import { makeVariant } from "../../vendor/pocketjs/tools/pocket-pack.ts";
import { encodePocketPackage } from "../../vendor/pocketjs/contracts/spec/pocket-package.ts";
import { DEFCONFIG, parseArgs, run, contractHeader, embeddedSource, memoryReport, budgetErrors } from "./build-support";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR = join(ROOT, "vendor/pocketjs");
const MANIFEST = join(ROOT, "host/rtthread/pocket.json");
const PROFILE = join(ROOT, "host/rtthread/pocket.host.json");
const OUT = join(ROOT, "dist/aic");
const WORK = join(ROOT, ".pocket/aic");

function requireFile(path: string) {
  if (!existsSync(path)) throw new Error(`missing ${path}; initialize submodules/dependencies first`);
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.command === "build") rmSync(join(OUT, "memory-report.json"), { force: true });
  await run([process.execPath, join(VENDOR, "tools/pocket.ts"), "check", "--host-profile", PROFILE, "--manifest", MANIFEST, "--project-root", ROOT], ROOT);
  if (options.command === "check") return;

  const validated = validatePocketAicHostProfile(JSON.parse(readFileSync(PROFILE, "utf8")));
  if (!validated.ok) throw new Error(JSON.stringify(validated.diagnostics));
  const profile = validated.value;
  const manifestBytes = readFileSync(MANIFEST);
  const manifest = JSON.parse(manifestBytes.toString());
  const resolution = validateAndResolveBuildPlan(manifest, {
    target: profile.id,
    hostExtension: pocketAicHostExtension(hashPocketAicHostProfile(profile), profile.tickHz),
  }, pocketAicHostRegistry(profile));
  if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
  const plan = resolution.plan;
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const planPath = join(WORK, "plan.json");
  writeFileSync(planPath, canonicalJson(plan));
  const chars = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") for (const char of value) chars.add(char);
    else if (value && typeof value === "object") for (const child of Object.values(value)) collect(child);
  };
  for (const language of ["en", "zh-CN"]) collect(JSON.parse(readFileSync(join(ROOT, `assets/i18n/${language}.json`), "utf8")));
  await run([process.execPath, join(VENDOR, "tools/build.ts"), `--plan=${planPath}`, `--project-root=${ROOT}`, `--outdir=${WORK}`, `--hz=${profile.tickHz}`,
    `--font-regular=${join(ROOT, "assets/fonts/MiSans-Regular.ttf")}`,
    `--font-bold=${join(ROOT, "assets/fonts/MiSans-Bold.ttf")}`,
    `--extra-chars=${[...chars].sort().join("")}`,
  ], ROOT);
  // The fork's mono atlas uses its vendored JetBrains Mono, identical to our asset.
  const variant = makeVariant({
    target: profile.id, hostAbi: plan.target.hostAbi, planJson: canonicalJson(plan),
    identity: { output: plan.app.output, id: plan.app.id, title: plan.app.title },
    js: readFileSync(join(WORK, `${plan.app.output}.js`)),
    pak: readFileSync(join(WORK, `${plan.app.output}.pak`)),
  });
  const bytes = encodePocketPackage({ manifest: manifestBytes, variants: [variant] });
  const packagePath = join(OUT, `${plan.app.output}.pocket`);
  writeFileSync(packagePath, bytes);
  await run([process.execPath, join(VENDOR, "tools/pocket-pack.ts"), "verify", packagePath], ROOT);
  const generated = join(VENDOR, "hosts/aic/generated");
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, "pocketjs_aic_contract.h"), contractHeader(profile));
  writeFileSync(join(generated, "pocket_bin.c"), embeddedSource(bytes));
  console.log(`aic: package ${packagePath} (${bytes.length} bytes)`);
  if (options.command === "package") return;

  const sdk = resolve(ROOT, options.sdk ?? "vendor/luban-lite");
  requireFile(join(sdk, "SConstruct"));
  requireFile(join(sdk, `target/configs/${DEFCONFIG}`));
  requireFile(join(sdk, "application/rt-thread/pocketjs/SConscript"));
  const toolchain = process.env.RTT_EXEC_PATH ?? join(sdk, "toolchain/bin");
  requireFile(join(toolchain, process.platform === "win32" ? "riscv-none-elf-gcc.exe" : "riscv-none-elf-gcc"));
  for (const tool of ["scons", "cargo", "rustup"]) if (!Bun.which(tool)) throw new Error(`${tool} is not on PATH`);
  const channel = readFileSync(join(VENDOR, "hosts/aic/rust/rust-toolchain.toml"), "utf8").match(/channel\s*=\s*"([^"]+)"/)?.[1];
  if (!channel) throw new Error("missing AIC Rust toolchain channel");
  await run(["rustup", "run", channel, "rustc", "--version"], ROOT);
  const env = { POCKETJS_ROOT: VENDOR };
  // SDK ships a matching prebuilt bootloader, but a fresh clone lacks its
  // ignored address metadata. Generate that metadata with the SDK's own rules;
  // compiling the bootloader would overwrite the tracked prebuilt binary.
  const pack = join(sdk, "target/d12x/demo68-nor/pack");
  requireFile(join(pack, "bootloader.bin"));
  await run(["scons", "--apply-def=d12x_demo68-nor_baremetal_bootloader_defconfig"], sdk, env);
  try {
    await run(["python3", join(sdk, "tools/scripts/calc_linked_addr.py"),
      "-i", join(pack, "image_cfg.json"), "-c", join(sdk, ".config"),
      "-o", join(pack, ".image_cfg.json.tmp")], sdk, {
      ...env, PYTHONPATH: [join(sdk, "kernel/rt-thread/tools"), process.env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
    });
  } finally {
    await run(["scons", `--apply-def=${DEFCONFIG}`], sdk, env);
  }
  const images = join(sdk, "output", DEFCONFIG.replace(/_defconfig$/, ""), "images");
  await run(["scons", ...(options.scons.length ? options.scons : ["-j8"])], sdk, env);
  const poolMatch = readFileSync(join(VENDOR, "hosts/aic/port/pocketjs_heap.c"), "utf8").match(/#define POCKETJS_POOL_BYTES\s+\((\d+)U\s*\*\s*1024U\)/);
  if (!poolMatch) throw new Error("unsupported TLSF pool definition; update budget reader");
  const report = memoryReport({
    map: readFileSync(join(images, "d12x.map"), "utf8"),
    elf: readFileSync(join(images, "d12x.elf")),
    imageConfig: readFileSync(join(sdk, "target/d12x/demo68-nor/pack/image_cfg.json"), "utf8"),
    itbBytes: statSync(join(images, "d12x_os.itb")).size,
    packageBytes: bytes.length, poolBytes: Number(poolMatch[1]) * 1024,
    width: profile.display.physicalViewport[0], height: profile.display.physicalViewport[1],
  });
  const reportPath = join(OUT, "memory-report.json");
  writeFileSync(reportPath, JSON.stringify({ ...report, images, packageSha256: createHash("sha256").update(bytes).digest("hex"),
    itbSha256: createHash("sha256").update(readFileSync(join(images, "d12x_os.itb"))).digest("hex") }, null, 2) + "\n");
  console.log(`aic: images ${images}`);
  console.log(`aic: budget ${reportPath}\n  static CMA=${report.staticCmaBytes}B; package=${report.packageBytes}B\n  CMA after framebuffers=${report.cmaAfterFramebuffersBytes}B; SW after TLSF=${report.swAfterPoolBytes}B\n  OS=${report.itbBytes}/${report.osPartitionBytes}B`);
  const errors = budgetErrors(report);
  if (errors.length) throw new Error(errors.join("; "));
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(`aic: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
