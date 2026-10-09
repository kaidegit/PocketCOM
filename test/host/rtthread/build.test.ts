import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFCONFIG, parseArgs, run, contractHeader, embeddedSource, elfSections, memoryReport, budgetErrors } from "../../../host/rtthread/build-support";
import { validatePocketAicHostProfile, hashPocketAicHostProfile } from "../../../vendor/pocketjs/framework/src/manifest/aic-host.ts";

const validation = validatePocketAicHostProfile(JSON.parse(readFileSync(new URL("../../../host/rtthread/pocket.host.json", import.meta.url), "utf8")));
if (!validation.ok) throw new Error("invalid product profile");
const profile = validation.value;

// Small ELF fixture with real ELF32 header/section layout and RISC-V machine id.
function fixtureElf() {
  const bytes = new Uint8Array(512);
  bytes.set([0x7f, 69, 76, 70, 1, 1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(18, 243, true);
  view.setUint32(32, 64, true);
  view.setUint16(46, 40, true);
  view.setUint16(48, 6, true);
  view.setUint16(50, 1, true);
  const names = new TextEncoder().encode("\0.shstrtab\0.text\0.rodata\0.data\0.bss\0");
  bytes.set(names, 320);
  view.setUint32(64 + 40 + 16, 320, true);
  view.setUint32(64 + 40 + 20, names.length, true);
  for (const [i, name, address, size] of [[2, 11, 0x40000000, 0x100000], [3, 17, 0x40100000, 0x180000], [4, 25, 0x40280000, 0x1000], [5, 31, 0x40281000, 0x1000]]) {
    const offset = 64 + i * 40;
    view.setUint32(offset, name, true);
    view.setUint32(offset + 8, 2, true);
    view.setUint32(offset + 12, address, true);
    view.setUint32(offset + 20, size, true);
  }
  return bytes;
}
const input = {
  map: `PSRAM_CMA 0x40000000 0x00380000\nPSRAM_SW 0x40380000 0x00480000\n .rodata.pocketjs_embedded_package\n 0x40100000 0x100000 generated/pocket_bin.o\n 0x40282000 __psram_cma_heap_start = .\n 0x40380000 __psram_sw_heap_start = .\n`,
  elf: fixtureElf(), imageConfig: `{"spi-nor": {"partitions": {"os": {"size": "3072k"},},},} // SDK comment\n`,
  itbBytes: 0x282000, packageBytes: 0x100000, poolBytes: 4150 * 1024, width: 480, height: 272,
};

describe("AIC build orchestration", () => {
  test("defaults and SDK/SCons forwarding", () => {
    expect(parseArgs(["build"])).toEqual({ command: "build", sdk: undefined, scons: [] });
    expect(parseArgs(["build", "--sdk", "/tmp/sdk with spaces", "--", "-j4", "-Q"])).toEqual({ command: "build", sdk: "/tmp/sdk with spaces", scons: ["-j4", "-Q"] });
    expect(parseArgs(["build", "--", "-j", "4"]).scons).toEqual(["-j", "4"]);
    expect(DEFCONFIG).toBe("d12x_demo68-nor_rt-thread_pocketjs_defconfig");
    expect(() => parseArgs(["check", "--", "-j8"])).toThrow("require build");
    expect(() => parseArgs(["build", "--sdk"])).toThrow("requires a path");
    expect(() => parseArgs(["build", "--", "--clean"])).toThrow();
    expect(() => parseArgs(["build", "--typo"])).toThrow();
  });
  test("subprocess failure is propagated", async () => {
    await expect(run([process.execPath, "-e", "process.exit(7)"], process.cwd())).rejects.toThrow("exit 7");
  });
  test("firmware contract matches profile hash and geometry", () => {
    const header = contractHeader(profile);
    expect(header).toContain('TARGET_ID "aic-d12x-demo68"');
    expect(header).toContain("LOGICAL_WIDTH 480");
    expect(header).toContain("PHYSICAL_HEIGHT 272");
    expect(header).toContain("TICK_HZ 60");
    expect(header).toContain("PRESENTATION 3");
    const hash = [...header.matchAll(/0x([\da-f]{2})/g)].map(match => match[1]).join("");
    expect(`sha256:${hash}`).toBe(hashPocketAicHostProfile(profile));
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
    const report = memoryReport({ ...input, itbBytes: 0x300001, poolBytes: 0x480001,
      map: input.map.replace("0x40282000", "0x40370000") });
    expect(budgetErrors(report)).toHaveLength(3);
  });
  test("rejects stale package, absent symbols and incompatible ELF", () => {
    expect(() => memoryReport({ ...input, packageBytes: 100 })).toThrow("linked package differs");
    expect(() => memoryReport({ ...input, map: input.map.replace("__psram_sw_heap_start", "other") })).toThrow("missing map symbol");
    expect(() => elfSections(new Uint8Array(52))).toThrow("expected ELF32");
    const malformed = fixtureElf();
    new DataView(malformed.buffer).setUint32(32, 500, true);
    expect(() => elfSections(malformed)).toThrow("invalid ELF section table");
  });
});
