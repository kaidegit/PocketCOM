// Build-orchestration helpers for host/rtthread/aic.ts, split out so the pure
// parts (argument parsing, generated C sources, ELF/map parsing, memory
// budgeting) can be unit-tested headless in test/host/rtthread/ without an SDK
// checkout. run() is the only side effect here.
import { spawn } from "bun";
import type { PocketAicHostProfile } from "../../vendor/pocketjs/contracts/spec/aic-host.ts";
import { hashPocketAicHostProfile } from "../../vendor/pocketjs/framework/src/manifest/aic-host.ts";

export const DEFCONFIG = "d12x_demo68-nor_rt-thread_pocketjs_defconfig";

export function parseArgs(argv: string[]) {
  const [command, ...args] = argv;
  if (!["check", "package", "build"].includes(command ?? "")) {
    throw new Error(
      "usage: bun host/rtthread/aic.ts <check|package|build> [--sdk <path>] [-- <scons args>]",
    );
  }

  // Split "-- <scons args>" off; everything before the separator is ours.
  const separator = args.indexOf("--");
  const scons = separator < 0 ? [] : args.splice(separator + 1);
  if (separator >= 0) args.splice(separator, 1);

  // Only --sdk belongs to us; anything else here is a typo, not a passthrough.
  let sdk: string | undefined;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg !== "--sdk" || sdk !== undefined) {
      throw new Error(`unknown or duplicate option: ${arg}`);
    }
    sdk = args.shift();
    if (!sdk || sdk.startsWith("--")) throw new Error("--sdk requires a path");
  }

  if (command !== "build" && scons.length > 0) {
    throw new Error("scons args require build");
  }

  // SCons args are forwarded verbatim, and the memory report is computed from
  // the linked images. Anything that switches configuration, cleans, dry-runs,
  // or builds an explicit target would make the report describe a build this
  // invocation did not produce — restrict args to plain build options instead.
  const changesConfiguration =
    /^(--(apply-def|menuconfig|clean|dry-run|help|version)|-[chnv]|POCKETJS_ROOT=|PRJ_)/;

  // Bare words are SCons targets; only a job count following -j/--jobs may
  // appear unflagged ("-j 4").
  const isJobCount = (arg: string, index: number) =>
    /^\d+$/.test(arg) && ["-j", "--jobs"].includes(scons[index - 1]);

  const forwardsUnwantedArg = scons.some(
    (arg, index) =>
      changesConfiguration.test(arg) ||
      (!arg.startsWith("-") && !isJobCount(arg, index)),
  );
  if (forwardsUnwantedArg) {
    throw new Error(
      "scons args must be build options (for example -j8 or -j 8); " +
      "configuration changes/targets are not supported",
    );
  }

  return { command: command!, sdk, scons };
}

/** Spawn a child with inherited stdio; a non-zero exit becomes a thrown error. */
export async function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = spawn(args, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) throw new Error(`${args[0]} failed with exit ${status}`);
}

/**
 * C contract header consumed by the AIC port (hosts/aic/port/pocketjs_host.c).
 * The guest refuses a package whose profile hash does not match its own, so
 * every field below is pinned by that hash: change the profile and both sides
 * must be regenerated together.
 */
export function contractHeader(profile: PocketAicHostProfile): string {
  // Embedded as 32 raw bytes; strip the "sha256:" scheme prefix.
  const hash = hashPocketAicHostProfile(profile).slice("sha256:".length);
  const [w, h] = profile.display.logicalViewports[0];
  const [pw, ph] = profile.display.physicalViewport;

  const presentations = profile.display.presentations;
  if (presentations.length !== 1 || presentations[0] !== "native") {
    throw new Error("AIC port only supports native presentation");
  }

  // Wire enum is the index into HOST_PRESENTATIONS; 3 = "native"
  // (vendor/pocketjs/contracts/spec/pocket-package.ts).
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

/**
 * Wrap the built package in a C source so the SDK links it straight into
 * firmware as .rodata. Hexdump layout: 16 bytes per row, one trailing comma
 * per row (C tolerates it). The size symbol is sizeof-derived, so a truncated
 * array cannot pass unnoticed.
 */
export function embeddedSource(bytes: Uint8Array): string {
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = Array.from(
      bytes.subarray(offset, offset + 16),
      byte => `0x${byte.toString(16).padStart(2, "0")}`,
    );
    rows.push(`  ${row.join(", ")},`);
  }
  return `/* Generated PocketCOM package. Do not edit. */
#include <stdint.h>
const uint8_t pocketjs_embedded_package[] = {
${rows.join("\n")}
};
const uint32_t pocketjs_embedded_package_size = sizeof(pocketjs_embedded_package);
`;
}

/**
 * Allocated section names/addresses/sizes read straight from an ELF32
 * little-endian binary — enough for the memory report without requiring
 * binutils on the build machine. Throws on anything that is not the RISC-V
 * firmware we expect rather than producing a partial report.
 */
export function elfSections(bytes: Uint8Array): Record<string, { address: number; size: number }> {
  // e_ident: 0x7f "ELF" magic, EI_CLASS = 32-bit, EI_DATA = little-endian.
  const magic = bytes[0] === 0x7f && String.fromCharCode(...bytes.subarray(1, 4)) === "ELF";
  const ident32Le = bytes[4] === 1 && bytes[5] === 1;
  if (bytes.length < 52 || !magic || !ident32Le) {
    throw new Error("expected ELF32 little-endian firmware");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(18, true) !== 243) {
    throw new Error("expected RISC-V ELF"); // e_machine = EM_RISCV
  }

  // Section header table location: e_shoff / e_shentsize / e_shnum / e_shstrndx.
  const shoff = view.getUint32(32, true);
  const shentsize = view.getUint16(46, true);
  const shnum = view.getUint16(48, true);
  const shstrndx = view.getUint16(50, true);

  // 40 = sizeof(Elf32_Shdr); the whole table must sit inside the file.
  const tableFits = shoff + shnum * shentsize <= bytes.length;
  if (shentsize < 40 || shnum === 0 || shstrndx >= shnum || !tableFits) {
    throw new Error("invalid ELF section table");
  }

  // Section names live in the string table section shstrndx
  // (sh_offset at +16, sh_size at +20 of its header).
  const strtabHeader = shoff + shstrndx * shentsize;
  const strtabOffset = view.getUint32(strtabHeader + 16, true);
  const strtabSize = view.getUint32(strtabHeader + 20, true);
  const strtabEnd = strtabOffset + strtabSize;
  if (strtabEnd > bytes.length) {
    throw new Error("invalid ELF section names");
  }

  const sections: ReturnType<typeof elfSections> = {};
  for (let i = 0; i < shnum; i++) {
    const header = shoff + i * shentsize;
    if (!(view.getUint32(header + 8, true) & 0x2)) continue; // sh_flags & SHF_ALLOC

    const nameOffset = view.getUint32(header, true); // sh_name, offset into the string table
    if (nameOffset >= strtabSize) throw new Error("invalid ELF section name offset");

    let nameEnd = strtabOffset + nameOffset;
    while (nameEnd < strtabEnd && bytes[nameEnd] !== 0) nameEnd++;
    if (nameEnd === strtabEnd) throw new Error("unterminated ELF section name");

    const name = new TextDecoder().decode(bytes.subarray(strtabOffset + nameOffset, nameEnd));
    sections[name] = {
      address: view.getUint32(header + 12, true), // sh_addr
      size: view.getUint32(header + 20, true), // sh_size
    };
  }
  return sections;
}

/**
 * Static memory budget of the freshly linked firmware. The SDK map supplies
 * PSRAM region/heap boundaries and the inline package size, the ELF supplies
 * section sizes, and the SDK image config supplies the OS partition size.
 * Every input must come from the same build — the checks below fail loudly
 * rather than let the report describe a stale link.
 */
export function memoryReport(input: {
  map: string;
  elf: Uint8Array;
  imageConfig: string;
  itbBytes: number;
  packageBytes: number;
  poolBytes: number;
  width: number;
  height: number;
}) {
  // ld map lookups: linker symbols and memory regions.
  const symbol = (name: string) => {
    // Example line: " 0x40282000 __psram_cma_heap_start = ."
    const pattern = new RegExp(`^\\s*0x([\\da-f]+)\\s+${name}\\s*=`, "mi");
    const match = input.map.match(pattern);
    if (!match) throw new Error(`missing map symbol ${name}`);
    return parseInt(match[1], 16);
  };
  const region = (name: string) => {
    // Example line: "PSRAM_CMA 0x40000000 0x00380000"
    const pattern = new RegExp(`^${name}\\s+0x([\\da-f]+)\\s+0x([\\da-f]+)`, "mi");
    const match = input.map.match(pattern);
    if (!match) throw new Error(`missing map region ${name}`);
    return { address: parseInt(match[1], 16), size: parseInt(match[2], 16) };
  };

  // The linked .rodata slot for the embedded package must equal the freshly
  // built package in size, else the map comes from an older link.
  const embeddedPackage = /\.rodata\.pocketjs_embedded_package\s+0x[\da-f]+\s+0x([\da-f]+)/i;
  const embedded = input.map.match(embeddedPackage);
  const linkedPackageBytes = embedded ? parseInt(embedded[1], 16) : NaN;
  if (linkedPackageBytes !== input.packageBytes) {
    throw new Error("linked package differs from freshly built package");
  }

  // The SDK writes the partition table as JSONC: strip // comments and
  // trailing commas before parsing, then decode the size suffix ("3072k").
  const withoutComments = input.imageConfig.replace(/\/\/[^\n]*/g, "");
  const config = JSON.parse(withoutComments.replace(/,\s*([}\]])/g, "$1"));
  const partitionSize = String(config["spi-nor"]?.partitions?.os?.size ?? "");

  const sizeParts = partitionSize.match(/^(\d+)([km]?)$/i);
  if (!sizeParts) throw new Error("invalid OS partition size");
  const unitBytes = { k: 1024, m: 1048576 }[sizeParts[2].toLowerCase()] ?? 1;
  const osPartitionBytes = Number(sizeParts[1]) * unitBytes;

  // Both heaps are placed by the linker inside a PSRAM region; each boundary
  // symbol must land within its own region or the map layout changed.
  const cma = region("PSRAM_CMA");
  const sw = region("PSRAM_SW");
  const cmaHeapStart = symbol("__psram_cma_heap_start");
  const swHeapStart = symbol("__psram_sw_heap_start");

  const cmaHeapInside = cmaHeapStart >= cma.address && cmaHeapStart <= cma.address + cma.size;
  const swHeapInside = swHeapStart >= sw.address && swHeapStart <= sw.address + sw.size;
  if (!cmaHeapInside || !swHeapInside) {
    throw new Error("heap boundary outside PSRAM region");
  }

  // The double RGB565 framebuffer (2 bytes/px) is the first charge on CMA;
  // the host TLSF pool is the first charge on SW.
  const framebufferBytes = input.width * input.height * 2 * 2;

  const sections = elfSections(input.elf);
  for (const name of [".text", ".rodata", ".data", ".bss"]) {
    if (!sections[name]) throw new Error(`missing ELF section ${name}`);
  }

  const cmaAvailableBytes = cma.address + cma.size - cmaHeapStart;
  const swAvailableBytes = sw.address + sw.size - swHeapStart;

  return {
    packageBytes: input.packageBytes,
    sections,
    cma,
    sw,
    cmaHeapStart,
    swHeapStart,
    staticCmaBytes: cmaHeapStart - cma.address,
    framebufferBytes,
    cmaAvailableBytes,
    cmaAfterFramebuffersBytes: cmaAvailableBytes - framebufferBytes,
    tlsfPoolBytes: input.poolBytes,
    swAvailableBytes,
    swAfterPoolBytes: swAvailableBytes - input.poolBytes,
    itbBytes: input.itbBytes,
    osPartitionBytes,
    osHeadroomBytes: osPartitionBytes - input.itbBytes,
    note:
      "Budgets exclude other allocations, alignment, fragmentation and driver overhead; " +
      "they do not prove runtime stability.",
  };
}

/** Headrooms that must fail the build, phrased for the error line. */
export function budgetErrors(report: ReturnType<typeof memoryReport>): string[] {
  const errors: string[] = [];
  if (report.osHeadroomBytes < 0) {
    errors.push(`OS partition exceeded by ${-report.osHeadroomBytes} bytes`);
  }
  if (report.cmaAfterFramebuffersBytes < 0) {
    errors.push(`CMA framebuffer budget short by ${-report.cmaAfterFramebuffersBytes} bytes`);
  }
  if (report.swAfterPoolBytes < 0) {
    errors.push(`SW TLSF pool budget short by ${-report.swAfterPoolBytes} bytes`);
  }
  return errors;
}
