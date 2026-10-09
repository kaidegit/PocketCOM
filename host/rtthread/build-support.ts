import { spawn } from "bun";
import type { PocketAicHostProfile } from "../../vendor/pocketjs/contracts/spec/aic-host.ts";
import { hashPocketAicHostProfile } from "../../vendor/pocketjs/framework/src/manifest/aic-host.ts";

export const DEFCONFIG = "d12x_demo68-nor_rt-thread_pocketjs_defconfig";

export function parseArgs(argv: string[]) {
  const [command, ...args] = argv;
  if (!["check", "package", "build"].includes(command ?? "")) {
    throw new Error("usage: bun host/rtthread/aic.ts <check|package|build> [--sdk <path>] [-- <scons args>]");
  }
  const separator = args.indexOf("--");
  const scons = separator < 0 ? [] : args.splice(separator + 1);
  if (separator >= 0) args.splice(separator, 1);
  let sdk: string | undefined;
  while (args.length) {
    const arg = args.shift();
    if (arg !== "--sdk" || sdk !== undefined) throw new Error(`unknown or duplicate option: ${arg}`);
    sdk = args.shift();
    if (!sdk || sdk.startsWith("--")) throw new Error("--sdk requires a path");
  }
  if (command !== "build" && scons.length) throw new Error("scons args require build");
  // These override the product/configuration or skip linking, invalidating the report.
  if (scons.some((arg, index) =>
    /^(--(apply-def|menuconfig|clean|dry-run|help|version)|-[chnv]|POCKETJS_ROOT=|PRJ_)/.test(arg) ||
    (!arg.startsWith("-") && !(/^\d+$/.test(arg) && ["-j", "--jobs"].includes(scons[index - 1]))))) {
    throw new Error("scons args must be build options (for example -j8 or -j 8); configuration changes/targets are not supported");
  }
  return { command: command!, sdk, scons };
}

export async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(args, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${args[0]} failed with exit ${status}`);
}

export function contractHeader(profile: PocketAicHostProfile): string {
  const hash = hashPocketAicHostProfile(profile).slice("sha256:".length);
  const [w, h] = profile.display.logicalViewports[0];
  const [pw, ph] = profile.display.physicalViewport;
  if (profile.display.presentations.length !== 1 || profile.display.presentations[0] !== "native") {
    throw new Error("AIC port only supports native presentation");
  }
  return `/* Generated from PocketCOM host profile. Do not edit. */
#ifndef POCKETJS_AIC_CONTRACT_H
#define POCKETJS_AIC_CONTRACT_H
#include <stdint.h>
#define POCKETJS_AIC_CONTRACT_TARGET_ID "${profile.id}"
#define POCKETJS_AIC_CONTRACT_HOST_ABI 1
#define POCKETJS_AIC_CONTRACT_TICK_HZ ${profile.tickHz}
#define POCKETJS_AIC_CONTRACT_LOGICAL_WIDTH ${w}
#define POCKETJS_AIC_CONTRACT_LOGICAL_HEIGHT ${h}
#define POCKETJS_AIC_CONTRACT_PHYSICAL_WIDTH ${pw}
#define POCKETJS_AIC_CONTRACT_PHYSICAL_HEIGHT ${ph}
#define POCKETJS_AIC_CONTRACT_RASTER_DENSITY ${profile.display.rasterDensity}
#define POCKETJS_AIC_CONTRACT_PRESENTATION 3
static const uint8_t pocketjs_aic_contract_profile_hash[32] = {
  ${hash.match(/../g)!.map(byte => `0x${byte}`).join(", ")}
};
#endif
`;
}

export function embeddedSource(bytes: Uint8Array): string {
  const rows = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    rows.push(`  ${Array.from(bytes.subarray(offset, offset + 16), byte => `0x${byte.toString(16).padStart(2, "0")}`).join(", ")},`);
  }
  return `/* Generated PocketCOM package. Do not edit. */
#include <stdint.h>
const uint8_t pocketjs_embedded_package[] = {
${rows.join("\n")}
};
const uint32_t pocketjs_embedded_package_size = sizeof(pocketjs_embedded_package);
`;
}

/** ELF32 little-endian allocated section sizes; no external binutils required. */
export function elfSections(bytes: Uint8Array): Record<string, { address: number; size: number }> {
  if (bytes.length < 52 || bytes[0] !== 0x7f || String.fromCharCode(...bytes.subarray(1, 4)) !== "ELF" || bytes[4] !== 1 || bytes[5] !== 1) {
    throw new Error("expected ELF32 little-endian firmware");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(18, true) !== 243) throw new Error("expected RISC-V ELF");
  const offset = view.getUint32(32, true), stride = view.getUint16(46, true), count = view.getUint16(48, true), namesIndex = view.getUint16(50, true);
  if (stride < 40 || count === 0 || namesIndex >= count || offset + count * stride > bytes.length) throw new Error("invalid ELF section table");
  const namesHeader = offset + namesIndex * stride;
  const namesOffset = view.getUint32(namesHeader + 16, true), namesSize = view.getUint32(namesHeader + 20, true);
  if (namesOffset + namesSize > bytes.length) throw new Error("invalid ELF section names");
  const sections: ReturnType<typeof elfSections> = {};
  for (let i = 0; i < count; i++) {
    const base = offset + i * stride;
    if (!(view.getUint32(base + 8, true) & 2)) continue; // SHF_ALLOC
    const start = view.getUint32(base, true);
    if (start >= namesSize) throw new Error("invalid ELF section name offset");
    let end = namesOffset + start;
    while (end < namesOffset + namesSize && bytes[end] !== 0) end++;
    if (end === namesOffset + namesSize) throw new Error("unterminated ELF section name");
    const name = new TextDecoder().decode(bytes.subarray(namesOffset + start, end));
    sections[name] = { address: view.getUint32(base + 12, true), size: view.getUint32(base + 20, true) };
  }
  return sections;
}

export function memoryReport(input: {
  map: string; elf: Uint8Array; imageConfig: string; itbBytes: number;
  packageBytes: number; poolBytes: number; width: number; height: number;
}) {
  const symbol = (name: string) => {
    const match = input.map.match(new RegExp(`^\\s*0x([\\da-f]+)\\s+${name}\\s*=`, "mi"));
    if (!match) throw new Error(`missing map symbol ${name}`);
    return parseInt(match[1], 16);
  };
  const region = (name: string) => {
    const match = input.map.match(new RegExp(`^${name}\\s+0x([\\da-f]+)\\s+0x([\\da-f]+)`, "mi"));
    if (!match) throw new Error(`missing map region ${name}`);
    return { address: parseInt(match[1], 16), size: parseInt(match[2], 16) };
  };
  const embedded = input.map.match(/\.rodata\.pocketjs_embedded_package\s+0x[\da-f]+\s+0x([\da-f]+)/i);
  if (!embedded || parseInt(embedded[1], 16) !== input.packageBytes) throw new Error("linked package differs from freshly built package");
  const config = JSON.parse(input.imageConfig.replace(/\/\/[^\n]*/g, "").replace(/,\s*([}\]])/g, "$1"));
  const size = String(config["spi-nor"]?.partitions?.os?.size ?? "");
  const match = size.match(/^(\d+)([km]?)$/i);
  if (!match) throw new Error("invalid OS partition size");
  const osPartitionBytes = Number(match[1]) * ({ k: 1024, m: 1048576 }[match[2].toLowerCase()] ?? 1);
  const cma = region("PSRAM_CMA"), sw = region("PSRAM_SW");
  const cmaHeapStart = symbol("__psram_cma_heap_start"), swHeapStart = symbol("__psram_sw_heap_start");
  if (cmaHeapStart < cma.address || cmaHeapStart > cma.address + cma.size || swHeapStart < sw.address || swHeapStart > sw.address + sw.size) throw new Error("heap boundary outside PSRAM region");
  const framebufferBytes = input.width * input.height * 2 * 2;
  const sections = elfSections(input.elf);
  for (const name of [".text", ".rodata", ".data", ".bss"]) if (!sections[name]) throw new Error(`missing ELF section ${name}`);
  const cmaAvailableBytes = cma.address + cma.size - cmaHeapStart;
  const swAvailableBytes = sw.address + sw.size - swHeapStart;
  const report = {
    packageBytes: input.packageBytes, sections, cma, sw, cmaHeapStart, swHeapStart,
    staticCmaBytes: cmaHeapStart - cma.address,
    framebufferBytes, cmaAvailableBytes,
    cmaAfterFramebuffersBytes: cmaAvailableBytes - framebufferBytes,
    tlsfPoolBytes: input.poolBytes, swAvailableBytes,
    swAfterPoolBytes: swAvailableBytes - input.poolBytes,
    itbBytes: input.itbBytes, osPartitionBytes, osHeadroomBytes: osPartitionBytes - input.itbBytes,
    note: "Budgets exclude other allocations, alignment, fragmentation and driver overhead; they do not prove runtime stability.",
  };
  return report;
}

export function budgetErrors(report: ReturnType<typeof memoryReport>): string[] {
  const errors = [];
  if (report.osHeadroomBytes < 0) errors.push(`OS partition exceeded by ${-report.osHeadroomBytes} bytes`);
  if (report.cmaAfterFramebuffersBytes < 0) errors.push(`CMA framebuffer budget short by ${-report.cmaAfterFramebuffersBytes} bytes`);
  if (report.swAfterPoolBytes < 0) errors.push(`SW TLSF pool budget short by ${-report.swAfterPoolBytes} bytes`);
  return errors;
}
