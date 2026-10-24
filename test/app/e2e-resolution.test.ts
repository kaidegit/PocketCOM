import { expect, test } from "bun:test";
import { launcherFlags } from "../../tools/dev-options.mjs";

test("launcher flags preserve the default, fix the canvas, and switch to baked glyphs", () => {
  expect(launcherFlags([])).toEqual({ bakedText: false, viewportFlags: [] });
  expect(launcherFlags(["--resolution", "480x272"])).toEqual({
    bakedText: false,
    viewportFlags: ["--viewport", "480x272", "--fixed"],
  });
  expect(launcherFlags(["--resolution", "800x480"])).toEqual({
    bakedText: false,
    viewportFlags: ["--viewport", "800x480", "--fixed"],
  });
  expect(launcherFlags(["--baked-text"])).toEqual({ bakedText: true, viewportFlags: [] });
  // Order-free combination for board-size baked-font simulation.
  expect(launcherFlags(["--baked-text", "--resolution", "480x272"])).toEqual({
    bakedText: true,
    viewportFlags: ["--viewport", "480x272", "--fixed"],
  });
  expect(launcherFlags(["--resolution", "480x272", "--baked-text"])).toEqual({
    bakedText: true,
    viewportFlags: ["--viewport", "480x272", "--fixed"],
  });
});

test("invalid launcher arguments fail before starting the host", () => {
  for (const args of [["--resolution"], ["--resolution", "aic"], ["--resolution", "0x272"],
    ["--resolution", "480x-1"], ["--resolution", "480x272junk"],
    ["--resolution", "16385x272"], ["--unknown"], ["--baked-text", "--unknown"],
    ["--resolution", "aic", "--unknown"]]) {
    expect(() => launcherFlags(args)).toThrow();
  }
});
