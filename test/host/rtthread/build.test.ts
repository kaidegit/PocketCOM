import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import {
  compactBundle,
  DEFCONFIG,
  parseArgs,
  run,
  contractHeader,
  embeddedSource,
  elfSections,
  flashPlan,
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
  // Per header: [section index, sh_name offset, sh_addr, sh_size]. Under XIP
  // text and rodata sit in the 0x60000000 flash window; data and bss in PSRAM.
  const allocSections = [
    [2, 11, 0x60100800, 0x100000], // .text
    [3, 17, 0x60200000, 0x180000], // .rodata
    [4, 25, 0x40000000, 0x1000], // .data
    [5, 31, 0x40001000, 0x1000], // .bss
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

// Map/ITS/image-config fixture mirroring the XIP link: text+rodata execute
// from the flash window (rodata carries the inline package, size must equal
// packageBytes), PSRAM_CMA holds data/bss plus the framebuffer CMA heap, the
// unified system heap fills PSRAM_SW, and the OS partition stays "3072k"
// behind a JSONC comment the SDK writes. The XIP load address is the window
// base plus the os partition offset (0x100000) plus the 0x800 ITB header.
const input = {
  map: [
    "PSRAM_CMA 0x40000000 0x00100000",
    "PSRAM_SW 0x40100000 0x00700000",
    " .rodata.pocketjs_embedded_package",
    " 0x60200000 0x100000 generated/pocket_bin.o",
    " 0x40020000 __psram_cma_heap_start = .",
    " 0x40100200 __psram_sw_heap_start = .",
  ].join("\n") + "\n",
  elf: fixtureElf(),
  imageConfig: `{"spi-nor": {"partitions": {"spl": {"size": "512k"}, "env": {"size": "128k"},` +
    ` "env_r": {"size": "128k"}, "userid": {"size": "256k"}, "os": {"size": "3072k"},` +
    ` "os_r": {"size": "3072k"}},},} // SDK comment\n`,
  its: [
    "seg0 {",
    'data = /incbin/("./seg0.bin");',
    "load = <0x60100800>;",
    "entry = <0x60100800>;",
    "};",
    "seg1 {",
    "load = <0x40000000>;",
    "};",
  ].join("\n") + "\n",
  itbBytes: 0x282000,
  packageBytes: 0x100000,
  guestHeapLimitBytes: 5242880,
  xipFwOffset: 0x100800,
  width: 480,
  height: 272,
};

describe("AIC build orchestration", () => {
  test("defaults and SDK/SCons forwarding", () => {
    expect(parseArgs(["build"])).toEqual({
      command: "build",
      sdk: undefined,
      scons: [],
      all: false,
      isp: [],
    });
    expect(parseArgs(["build", "--sdk", "/tmp/sdk with spaces", "--", "-j4", "-Q"])).toEqual({
      command: "build",
      sdk: "/tmp/sdk with spaces",
      scons: ["-j4", "-Q"],
      all: false,
      isp: [],
    });
    expect(parseArgs(["build", "--", "-j", "4"]).scons).toEqual(["-j", "4"]);
    expect(DEFCONFIG).toBe("d12x_demo68-nor_rt-thread_pocketjs_defconfig");

    expect(() => parseArgs(["check", "--", "-j8"])).toThrow("require build");
    expect(() => parseArgs(["build", "--sdk"])).toThrow("requires a path");
    expect(() => parseArgs(["build", "--", "--clean"])).toThrow();
    expect(() => parseArgs(["build", "--typo"])).toThrow();
    // --all only means something to flash; elsewhere it is a typo.
    expect(() => parseArgs(["build", "--all"])).toThrow("unknown or duplicate");
  });

  test("flash args: --all plus verbatim aic-isp passthrough", () => {
    expect(parseArgs(["flash"])).toEqual({
      command: "flash",
      sdk: undefined,
      scons: [],
      all: false,
      isp: [],
    });
    expect(
      parseArgs(["flash", "--all", "-p", "/dev/cu.usbserial-X", "-b", "115200", "--verify", "--reset"]),
    ).toEqual({
      command: "flash",
      sdk: undefined,
      scons: [],
      all: true,
      isp: ["-p", "/dev/cu.usbserial-X", "-b", "115200", "--verify", "--reset"],
    });
    expect(parseArgs(["flash", "--sdk", "/tmp/sdk", "--all"]).sdk).toBe("/tmp/sdk");

    expect(() => parseArgs(["flash", "--all", "--all"])).toThrow("duplicate option: --all");
    expect(() => parseArgs(["flash", "--sdk", "/a", "--sdk", "/b"])).toThrow("duplicate option: --sdk");
    expect(() => parseArgs(["flash", "--sdk"])).toThrow("requires a path");
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
  test("accounts for XIP flash sections, framebuffers and the unified heap", () => {
    const report = memoryReport(input);
    expect(report.staticCmaBytes).toBe(0x20000);
    expect(report.framebufferBytes).toBe(522240);
    expect(report.cmaAfterFramebuffersBytes).toBe(0x100000 - 0x20000 - 522240);
    expect(report.xip).toMatchObject({
      fwOffsetBytes: 0x100800,
      flashLoadAddress: 0x60100800,
      flashSectionBytes: 0x100000 + 0x180000,
      ramSectionBytes: 0x2000,
    });
    // 0x700000 region minus the 0x200 min-heap stub, minus guest quota and
    // the fixed system reserve.
    expect(report.swAfterReservesBytes)
      .toBe(0x700000 - 0x200 - 5242880 - (384 * 1024 + 256 * 1024));
    expect(report.osHeadroomBytes).toBe(0x300000 - input.itbBytes);
    expect(report.sections[".rodata"]).toEqual({ address: 0x60200000, size: 0x180000 });
    expect(budgetErrors(report)).toEqual([]);
  });

  test("reports independent flash/CMA/SW shortfalls", () => {
    // Push every budget negative at once; the map edit moves the CMA heap
    // start so CMA after framebuffers goes negative too.
    const report = memoryReport({
      ...input,
      itbBytes: 0x300001, // OS partition exceeded
      guestHeapLimitBytes: 0x700001, // SW unified heap budget exceeded
      map: input.map.replace("0x40020000", "0x40081000"),
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

  test("rejects a non-XIP link and mismatched XIP addresses", () => {
    const psramElf = fixtureElf();
    {
      // Relink the fixture into PSRAM copy-mode addresses.
      const view = new DataView(psramElf.buffer);
      const move = (index: number, address: number) =>
        view.setUint32(64 + index * 40 + 12, address, true);
      move(2, 0x40000000); // .text
      move(3, 0x40100000); // .rodata
      expect(() => memoryReport({ ...input, elf: psramElf }))
        .toThrow("not XIP-linked");
    }

    // An XIP segment loading somewhere other than window+offset is a
    // misconfigured XIP_FW_OFFSET.
    const wrongLoad = input.its.replace(/0x60100800/g, "0x60100900");
    expect(() => memoryReport({ ...input, its: wrongLoad }))
      .toThrow("does not match window+offset");

    // Offset that disagrees with the os partition start plus the ITB header
    // would execute different flash bytes than the linker assumed.
    expect(() =>
      memoryReport({
        ...input,
        its: input.its.replace(/0x60100800/g, "0x60100900"),
        xipFwOffset: 0x100900,
      })
    ).toThrow("plus the 2048-byte ITB header");
  });
});

describe("AIC flash plan", () => {
  // Partition table + target components mirroring the d12x demo68-nor pack
  // config, JSONC comments and trailing commas included. Offsets accumulate
  // in declaration order: spl@0, env@0x80000, env_r@0xA0000, userid@0xC0000,
  // os@0x100000. The former "data" partition is gone; the spare tail is
  // unmapped.
  const imageConfig = `{
    "spi-nor": { // Device, name matches image:info:media:type
        "size": "16m",
        "partitions": {
            "spl":    { "size": "512k" },
            "env":    { "size": "128k" },
            "env_r":  { "size": "128k" },
            "userid": { "size": "256k" },
            "os":     { "size": "3072k" },
            "os_r":   { "size": "3072k" },
        },
    },
    "image": {
        "target": { // Image components which will be burn to partitions
            "spl": { "file": "bootloader.aic", "attr": ["mtd", "required"], "part": ["spl"] },
            "env": { "file": "env.bin", "attr": ["mtd", "optional"], "part": ["env"] },
            "os":  { "file": "d12x_os.itb", "attr": ["mtd", "required"], "part": ["os"] },
        },
    },
  }
  `;

  test("app is the os component at its accumulated offset", () => {
    expect(flashPlan(imageConfig, "app")).toEqual([
      { partition: "os", file: "d12x_os.itb", offset: 0x100000 },
    ]);
  });

  test("all prepends the spl bootloader at offset zero", () => {
    expect(flashPlan(imageConfig, "all")).toEqual([
      { partition: "spl", file: "bootloader.aic", offset: 0 },
      { partition: "os", file: "d12x_os.itb", offset: 0x100000 },
    ]);
  });

  test("rejects a missing table and a partition without a component", () => {
    expect(() => flashPlan("{}", "app")).toThrow("no spi-nor partition table");
    expect(() => flashPlan('{"spi-nor":{"partitions":{"os":{"size":"1m"}}}}', "app"))
      .toThrow("no target components");

    // The spl partition is programmed but nothing declares its file.
    const unbootable = imageConfig.replace(/^\s*"spl": \{ "file"[^\n]*\n/m, "");
    expect(() => flashPlan(unbootable, "all")).toThrow("no component for partition spl");

    // Size suffixes must parse; a bare number or missing size is an error.
    expect(() =>
      flashPlan(imageConfig.replace('"512k"', '"512x"'), "all"),
    ).toThrow("invalid size for partition spl");
  });
});


describe("AIC bundle compaction", () => {
  test("preserves host property names, callbacks and Unicode with deterministic output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pocketcom-compact-"));
    try {
      const entry = join(dir, "app.js");
      const source = `(() => {
        const longApplicationLabel = "串口调试";
        const hostContract = { serialOpen: () => longApplicationLabel };
        globalThis.frame = () => hostContract.serialOpen();
      })();`;
      writeFileSync(entry, source);
      const first = readFileSync(await compactBundle(entry, join(dir, "one")), "utf8");
      const second = readFileSync(await compactBundle(entry, join(dir, "two")), "utf8");
      expect(first).toBe(second);
      expect(first.length).toBeLessThan(source.length);
      expect(first).toContain("serialOpen");
      const context: { frame?: () => string } = {};
      runInNewContext(first, context);
      expect(context.frame?.()).toBe("串口调试");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("propagates invalid bundle errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pocketcom-compact-"));
    try {
      const entry = join(dir, "broken.js");
      writeFileSync(entry, "(() => {");
      await expect(compactBundle(entry, join(dir, "out"))).rejects.toThrow("AIC compaction failed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
