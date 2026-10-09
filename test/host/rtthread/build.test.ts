import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFCONFIG,
  parseArgs,
  run,
  contractHeader,
  embeddedSource,
  elfSections,
  memoryReport,
  budgetErrors,
} from "../../../host/rtthread/build-support";
import {
  validatePocketAicHostProfile,
  hashPocketAicHostProfile,
} from "../../../vendor/pocketjs/framework/src/manifest/aic-host.ts";

const profileSource = readFileSync(
  new URL("../../../host/rtthread/pocket.host.json", import.meta.url),
  "utf8",
);
const validation = validatePocketAicHostProfile(JSON.parse(profileSource));
if (!validation.ok) throw new Error("invalid product profile");
const profile = validation.value;

// Minimal but structurally real ELF32 little-endian image with the RISC-V
// machine id: 52-byte ELF header, section header table right after it, and a
// .shstrtab holding the four section names the memory report looks up.
//
//   bytes [0..5]   e_ident: 0x7f "ELF", ELFCLASS32, ELFDATA2LSB
//   half  [18]     e_machine = EM_RISCV (243)
//   word  [32]     e_shoff — section headers start at 64
//   half  [46..50] e_shentsize=40, e_shnum=6, e_shstrndx=1
function fixtureElf() {
  const bytes = new Uint8Array(512);
  bytes.set([0x7f, 69, 76, 70, 1, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(18, 243, true);
  view.setUint32(32, 64, true);
  view.setUint16(46, 40, true);
  view.setUint16(48, 6, true);
  view.setUint16(50, 1, true);

  // .shstrtab contents; the table below references names by byte offset.
  const names = new TextEncoder().encode("\0.shstrtab\0.text\0.rodata\0.data\0.bss\0");
  bytes.set(names, 320);
  // shstrtab is section 1: sh_offset=320, sh_size=names.length (fields +16/+20).
  view.setUint32(64 + 40 + 16, 320, true);
  view.setUint32(64 + 40 + 20, names.length, true);

  // Sections 2-5 are the allocated ones; section 0 stays the zero null entry.
  // Per header: [section index, sh_name offset, sh_addr, sh_size].
  const allocSections = [
    [2, 11, 0x40000000, 0x100000], // .text
    [3, 17, 0x40100000, 0x180000], // .rodata
    [4, 25, 0x40280000, 0x1000], // .data
    [5, 31, 0x40281000, 0x1000], // .bss
  ];
  for (const [i, name, address, size] of allocSections) {
    const header = 64 + i * 40;
    view.setUint32(header, name, true);
    view.setUint32(header + 8, 2, true); // sh_flags = SHF_ALLOC
    view.setUint32(header + 12, address, true);
    view.setUint32(header + 20, size, true);
  }
  return bytes;
}

// Map/image-config fixture mirroring a real SDK link: PSRAM_CMA holds the
// inline package (.rodata, size must equal packageBytes) plus the CMA heap
// start; PSRAM_SW starts exactly at its heap start; the OS partition is
// "3072k" behind a JSONC comment the SDK writes.
const input = {
  map: [
    "PSRAM_CMA 0x40000000 0x00380000",
    "PSRAM_SW 0x40380000 0x00480000",
    " .rodata.pocketjs_embedded_package",
    " 0x40100000 0x100000 generated/pocket_bin.o",
    " 0x40282000 __psram_cma_heap_start = .",
    " 0x40380000 __psram_sw_heap_start = .",
  ].join("\n") + "\n",
  elf: fixtureElf(),
  imageConfig: `{"spi-nor": {"partitions": {"os": {"size": "3072k"},},},} // SDK comment\n`,
  itbBytes: 0x282000,
  packageBytes: 0x100000,
  poolBytes: 4150 * 1024,
  width: 480,
  height: 272,
};

describe("AIC build orchestration", () => {
  test("defaults and SDK/SCons forwarding", () => {
    expect(parseArgs(["build"])).toEqual({
      command: "build",
      sdk: undefined,
      scons: [],
    });
    expect(parseArgs(["build", "--sdk", "/tmp/sdk with spaces", "--", "-j4", "-Q"])).toEqual({
      command: "build",
      sdk: "/tmp/sdk with spaces",
      scons: ["-j4", "-Q"],
    });
    expect(parseArgs(["build", "--", "-j", "4"]).scons).toEqual(["-j", "4"]);
    expect(DEFCONFIG).toBe("d12x_demo68-nor_rt-thread_pocketjs_defconfig");

    expect(() => parseArgs(["check", "--", "-j8"])).toThrow("require build");
    expect(() => parseArgs(["build", "--sdk"])).toThrow("requires a path");
    expect(() => parseArgs(["build", "--", "--clean"])).toThrow();
    expect(() => parseArgs(["build", "--typo"])).toThrow();
  });

  test("subprocess failure is propagated", async () => {
    const failing = run([process.execPath, "-e", "process.exit(7)"], process.cwd());
    await expect(failing).rejects.toThrow("exit 7");
  });

  test("firmware contract matches profile hash and geometry", () => {
    const header = contractHeader(profile);
    expect(header).toContain('TARGET_ID "aic-d12x-demo68"');
    expect(header).toContain("LOGICAL_WIDTH 480");
    expect(header).toContain("PHYSICAL_HEIGHT 272");
    expect(header).toContain("TICK_HZ 60");
    expect(header).toContain("PRESENTATION 3");

    // The embedded hash bytes must reassemble into the profile hash verbatim.
    const hashBytes = [...header.matchAll(/0x([\da-f]{2})/g)].map(match => match[1]).join("");
    expect(`sha256:${hashBytes}`).toBe(hashPocketAicHostProfile(profile));
  });

  test("binary embedding preserves every byte including NUL and high bits", () => {
    const source = embeddedSource(Uint8Array.from({ length: 256 }, (_, i) => i));
    const bytes = [...source.matchAll(/0x([\da-f]{2})/g)].map(match => parseInt(match[1], 16));
    expect(bytes).toEqual(Array.from({ length: 256 }, (_, i) => i));
    expect(source).toContain("sizeof(pocketjs_embedded_package)");
  });
});

describe("AIC memory admission", () => {
  test("accounts for static CMA, both framebuffers, TLSF and flash", () => {
    const report = memoryReport(input);
    expect(report.staticCmaBytes).toBe(0x282000);
    expect(report.framebufferBytes).toBe(522240);
    expect(report.swAfterPoolBytes).toBe(458 * 1024);
    expect(report.osHeadroomBytes).toBe(0x300000 - input.itbBytes);
    expect(report.sections[".rodata"]).toEqual({ address: 0x40100000, size: 0x180000 });
    expect(budgetErrors(report)).toEqual([]);
  });

  test("reports independent flash/CMA/SW shortfalls", () => {
    // Push every budget negative at once; the map edit moves the CMA heap
    // start so CMA after framebuffers goes negative too.
    const report = memoryReport({
      ...input,
      itbBytes: 0x300001, // OS partition exceeded
      poolBytes: 0x480001, // SW pool budget exceeded
      map: input.map.replace("0x40282000", "0x40370000"),
    });
    expect(budgetErrors(report)).toHaveLength(3);
  });

  test("rejects stale package, absent symbols and incompatible ELF", () => {
    expect(() => memoryReport({ ...input, packageBytes: 100 })).toThrow("linked package differs");
    expect(() =>
      memoryReport({ ...input, map: input.map.replace("__psram_sw_heap_start", "other") })
    ).toThrow("missing map symbol");
    expect(() => elfSections(new Uint8Array(52))).toThrow("expected ELF32");

    // e_shoff past the buffer end must trip the section-table sanity check.
    const malformed = fixtureElf();
    new DataView(malformed.buffer).setUint32(32, 500, true);
    expect(() => elfSections(malformed)).toThrow("invalid ELF section table");
  });
});
