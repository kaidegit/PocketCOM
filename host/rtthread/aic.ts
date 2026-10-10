#!/usr/bin/env bun
// AIC (D12x demo68-nor) build orchestration. Three commands over one pipeline:
//
//   check    validate manifest/profile via the fork CLI, then stop.
//   package  additionally compile JS/PAK, assemble the .pocket package, and
//            emit the C contract header + embedded package source that the
//            SDK's pocketjs SConscript consumes.
//   build    additionally drive the luban-lite SCons build and check the
//            static memory budget of the linked firmware.
//
// plus flash, which leaves that pipeline alone and pushes already-built
// images to a board in download mode with the SDK's tools/aic-isp uploader.
//
// See host/rtthread/README.md for the full flow and required tools.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validatePocketAicHostProfile,
  hashPocketAicHostProfile,
  pocketAicHostExtension,
  pocketAicHostRegistry,
} from "../../vendor/pocketjs/framework/src/manifest/aic-host.ts";
import { validateAndResolveBuildPlan } from "../../vendor/pocketjs/framework/src/manifest/resolve.ts";
import { canonicalJson } from "../../vendor/pocketjs/framework/src/manifest/plan.ts";
import { makeVariant } from "../../vendor/pocketjs/tools/pocket-pack.ts";
import { encodePocketPackage } from "../../vendor/pocketjs/contracts/spec/pocket-package.ts";
import {
  DEFCONFIG,
  parseArgs,
  run,
  contractHeader,
  embeddedSource,
  flashPlan,
  memoryReport,
  budgetErrors,
  compactBundle,
} from "./build-support";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VENDOR = join(ROOT, "vendor/pocketjs");
const MANIFEST = join(ROOT, "host/rtthread/pocket.json");
const PROFILE = join(ROOT, "host/rtthread/pocket.host.json");
const OUT = join(ROOT, "dist/aic");
const WORK = join(ROOT, ".pocket/aic");

/** Fail early with a pointing error instead of a cryptic tool failure later. */
function requireFile(path: string, hint = "initialize submodules/dependencies first") {
  if (!existsSync(path)) {
    throw new Error(`missing ${path}; ${hint}`);
  }
}

/** SHA-256 hex digest of a buffer, for the build receipt in the report. */
function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function main() {
  const options = parseArgs(Bun.argv.slice(2));

  // --- Flash already-built images; no manifest validation or SDK build. ---
  // The board must be in download mode (hold the download key PA1 while
  // powering up); everything about the transfer itself — port, baud rates,
  // --verify, --reset — is aic-isp's business and forwarded verbatim.
  if (options.command === "flash") {
    const sdk = resolve(ROOT, options.sdk ?? "vendor/luban-lite");
    requireFile(join(sdk, "tools/aic-isp/Cargo.toml"));
    const productName = DEFCONFIG.replace(/_defconfig$/, "");
    const images = join(sdk, "output", productName, "images");
    const imageConfig = join(sdk, "target/d12x/demo68-nor/pack/image_cfg.json");
    requireFile(imageConfig);
    const plan = flashPlan(readFileSync(imageConfig, "utf8"), options.all ? "all" : "app");
    for (const entry of plan) {
      requireFile(join(images, entry.file), "run npm run build:aic to produce it");
    }

    // Prefer the repo's prebuilt uploader, then a previous cargo build; build
    // it once from source otherwise (serialport is its only dependency).
    const exe = process.platform === "win32" ? "aic-isp.exe" : "aic-isp";
    const ispDir = join(sdk, "tools/aic-isp");
    let isp = [join(ispDir, "bin", exe), join(ispDir, "target/release", exe)].find(existsSync);
    if (!isp) {
      if (!Bun.which("cargo")) throw new Error("cargo is not on PATH; needed to build tools/aic-isp");
      console.log("aic: building tools/aic-isp (first run only)");
      await run(["cargo", "build", "--release"], ispDir);
      isp = join(ispDir, "target/release", exe);
    }

    const binArgs = plan.flatMap(entry => [
      "--bin", `${join(images, entry.file)}@0x${entry.offset.toString(16)}`,
    ]);
    console.log(
      `aic: flash ` +
      plan.map(e => `${e.file} -> ${e.partition}@0x${e.offset.toString(16)}`).join(", "),
    );
    await run([isp, ...binArgs, ...options.isp], ROOT);
    return;
  }

  // Drop the previous report up front so a failed build cannot leave stale
  // budget numbers next to the new firmware.
  if (options.command === "build") {
    rmSync(join(OUT, "memory-report.json"), { force: true });
  }

  // --- Phase 1: manifest/profile validation. "check" stops here. ---
  await run([
    process.execPath,
    join(VENDOR, "tools/pocket.ts"),
    "check",
    "--host-profile", PROFILE,
    "--manifest", MANIFEST,
    "--project-root", ROOT,
  ], ROOT);
  if (options.command === "check") return;

  const profileJson = JSON.parse(readFileSync(PROFILE, "utf8"));
  const validated = validatePocketAicHostProfile(profileJson);
  if (!validated.ok) throw new Error(JSON.stringify(validated.diagnostics));
  const profile = validated.value;

  const manifestBytes = readFileSync(MANIFEST);
  const manifest = JSON.parse(manifestBytes.toString());

  // Resolve the build plan pinned to this exact profile: the AIC host
  // extension carries the profile hash + tick rate into the package contract.
  const resolution = validateAndResolveBuildPlan(
    manifest,
    {
      target: profile.id,
      hostExtension: pocketAicHostExtension(
        hashPocketAicHostProfile(profile),
        profile.tickHz,
      ),
    },
    pocketAicHostRegistry(profile),
  );
  if (!resolution.ok) throw new Error(JSON.stringify(resolution.diagnostics));
  const plan = resolution.plan;

  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const planPath = join(WORK, "plan.json");
  writeFileSync(planPath, canonicalJson(plan));

  // Extra glyphs for the baked font atlas: every character appearing in any
  // i18n string value. The atlas only carries these — unbaked text falls back
  // to a replacement glyph (SPEC §5.4) — so this must cover all UI copy.
  const chars = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      for (const char of value) chars.add(char);
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) collect(child);
    }
  };
  for (const language of ["en", "zh-CN"]) {
    const strings = JSON.parse(readFileSync(join(ROOT, `assets/i18n/${language}.json`), "utf8"));
    collect(strings);
  }

  // --- Phase 2: compile the app and assemble the .pocket package. ---
  await run([
    process.execPath,
    join(VENDOR, "tools/build.ts"),
    `--plan=${planPath}`,
    `--project-root=${ROOT}`,
    `--outdir=${WORK}`,
    `--hz=${profile.tickHz}`,
    `--font-regular=${join(ROOT, "assets/fonts/MiSans-Regular.ttf")}`,
    `--font-bold=${join(ROOT, "assets/fonts/MiSans-Bold.ttf")}`,
    `--extra-chars=${[...chars].sort().join("")}`,
  ], ROOT);

  // QuickJS compiles the complete IIFE before running module initialization.
  // Compact only this target to reduce parser/atom allocations; desktop stays unchanged.
  const compactJs = await compactBundle(join(WORK, `${plan.app.output}.js`), join(WORK, "compact"));
  // The fork's mono atlas uses its vendored JetBrains Mono, identical to our asset.
  const variant = makeVariant({
    target: profile.id,
    hostAbi: plan.target.hostAbi,
    planJson: canonicalJson(plan),
    identity: {
      output: plan.app.output,
      id: plan.app.id,
      title: plan.app.title,
    },
    js: readFileSync(compactJs),
    pak: readFileSync(join(WORK, `${plan.app.output}.pak`)),
  });

  const bytes = encodePocketPackage({ manifest: manifestBytes, variants: [variant] });
  const packagePath = join(OUT, `${plan.app.output}.pocket`);
  writeFileSync(packagePath, bytes);
  await run(
    [process.execPath, join(VENDOR, "tools/pocket-pack.ts"), "verify", packagePath],
    ROOT,
  );

  // C inputs for the SDK's pocketjs SConscript, written into the fork's
  // ignored generated/ directory (shared across products — see README).
  const generated = join(VENDOR, "hosts/aic/generated");
  mkdirSync(generated, { recursive: true });
  writeFileSync(join(generated, "pocketjs_aic_contract.h"), contractHeader(profile));
  writeFileSync(join(generated, "pocket_bin.c"), embeddedSource(bytes));
  console.log(`aic: package ${packagePath} (${bytes.length} bytes)`);
  if (options.command === "package") return;

  // --- Phase 3: firmware build in the luban-lite SDK checkout. ---
  const sdk = resolve(ROOT, options.sdk ?? "vendor/luban-lite");
  requireFile(join(sdk, "SConstruct"));
  requireFile(join(sdk, `target/configs/${DEFCONFIG}`));
  requireFile(join(sdk, "application/rt-thread/pocketjs/SConscript"));

  // Toolchain: follow the SDK's RTT_EXEC_PATH convention; never download one.
  const toolchain = process.env.RTT_EXEC_PATH ?? join(sdk, "toolchain/bin");
  const gccName = process.platform === "win32" ? "riscv-none-elf-gcc.exe" : "riscv-none-elf-gcc";
  requireFile(join(toolchain, gccName));
  for (const tool of ["scons", "cargo", "rustup"]) {
    if (!Bun.which(tool)) throw new Error(`${tool} is not on PATH`);
  }

  // Fail fast if the fork's pinned toolchain channel is not installed,
  // instead of after SCons has spent minutes reaching the Rust guest crate.
  const toolchainToml = readFileSync(join(VENDOR, "hosts/aic/rust/rust-toolchain.toml"), "utf8");
  const channel = toolchainToml.match(/channel\s*=\s*"([^"]+)"/)?.[1];
  if (!channel) throw new Error("missing AIC Rust toolchain channel");
  await run(["rustup", "run", channel, "rustc", "--version"], ROOT);

  const env = { POCKETJS_ROOT: VENDOR };

  // SDK ships a matching prebuilt bootloader, but a fresh clone lacks its
  // ignored address metadata. Generate that metadata with the SDK's own rules;
  // compiling the bootloader would overwrite the tracked prebuilt binary.
  const pack = join(sdk, "target/d12x/demo68-nor/pack");
  requireFile(join(pack, "bootloader.bin"));
  await run(
    ["scons", "--apply-def=d12x_demo68-nor_baremetal_bootloader_defconfig"],
    sdk,
    env,
  );
  try {
    await run(
      [
        "python3",
        join(sdk, "tools/scripts/calc_linked_addr.py"),
        "-i", join(pack, "image_cfg.json"),
        "-c", join(sdk, ".config"),
        "-o", join(pack, ".image_cfg.json.tmp"),
      ],
      sdk,
      {
        ...env,
        PYTHONPATH: [
          join(sdk, "kernel/rt-thread/tools"),
          process.env.PYTHONPATH,
        ].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
      },
    );
  } finally {
    // Back to the product defconfig for the real build below, even if the
    // metadata step failed.
    await run(["scons", `--apply-def=${DEFCONFIG}`], sdk, env);
  }

  const productName = DEFCONFIG.replace(/_defconfig$/, "");
  const images = join(sdk, "output", productName, "images");
  const sconsArgs = options.scons.length > 0 ? options.scons : ["-j8"];
  await run(["scons", ...sconsArgs], sdk, env);

  const itbPath = join(images, "d12x_os.itb");
  const imageConfigPath = join(sdk, "target/d12x/demo68-nor/pack/image_cfg.json");

  // The guest heap quota lives as a -D flag in the fork's SConscript; read it
  // so the budget tracks the source instead of duplicating the constant here.
  const sconscript = readFileSync(join(VENDOR, "hosts/aic/SConscript"), "utf8");
  const limitMatch = sconscript.match(/CONFIG_POCKETJS_GUEST_HEAP_LIMIT='\s*'\s*(\d+)/);
  if (!limitMatch) throw new Error("unsupported guest heap limit definition; update budget reader");
  const guestHeapLimitBytes = Number(limitMatch[1]);

  // The XIP firmware offset is what the SDK just linked against; the .config
  // in the checkout reflects the product defconfig this build applied.
  const sdkConfig = readFileSync(join(sdk, ".config"), "utf8");
  const xipOffsetMatch = sdkConfig.match(/^CONFIG_AIC_XIP_FW_OFFSET=(0x[\da-f]+)$/m);
  if (!xipOffsetMatch) {
    throw new Error("CONFIG_AIC_XIP_FW_OFFSET missing; the product defconfig must enable XIP");
  }
  const xipFwOffset = Number(xipOffsetMatch[1]);

  const report = memoryReport({
    map: readFileSync(join(images, "d12x.map"), "utf8"),
    elf: readFileSync(join(images, "d12x.elf")),
    imageConfig: readFileSync(imageConfigPath, "utf8"),
    its: readFileSync(join(images, "d12x_os.its"), "utf8"),
    itbBytes: statSync(itbPath).size,
    packageBytes: bytes.length,
    guestHeapLimitBytes,
    xipFwOffset,
    width: profile.display.physicalViewport[0],
    height: profile.display.physicalViewport[1],
  });

  const reportPath = join(OUT, "memory-report.json");
  const reportJson = {
    ...report,
    images,
    packageSha256: sha256(bytes),
    itbSha256: sha256(readFileSync(itbPath)),
  };
  writeFileSync(reportPath, JSON.stringify(reportJson, null, 2) + "\n");

  console.log(`aic: images ${images}`);
  console.log(
    `aic: budget ${reportPath}\n` +
      `  XIP flash sections=${report.xip.flashSectionBytes}B @0x${report.xip.flashLoadAddress.toString(16)};` +
      ` package=${report.packageBytes}B\n` +
      `  CMA after framebuffers=${report.cmaAfterFramebuffersBytes}B;` +
      ` SW after guest+reserve=${report.swAfterReservesBytes}B\n` +
      `  OS=${report.itbBytes}/${report.osPartitionBytes}B`,
  );
  const errors = budgetErrors(report);
  if (errors.length > 0) throw new Error(errors.join("; "));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`aic: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
