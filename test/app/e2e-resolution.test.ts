import { expect, test } from "bun:test";
import { resolutionFlags } from "../../tools/dev-options.mjs";

test("e2e viewport overrides preserve the default and fix the requested canvas", () => {
  expect(resolutionFlags([])).toEqual([]);
  expect(resolutionFlags(["--resolution", "480x272"])).toEqual([
    "--viewport", "480x272", "--fixed",
  ]);
  expect(resolutionFlags(["--resolution", "800x480"])).toEqual([
    "--viewport", "800x480", "--fixed",
  ]);
});

test("invalid launcher arguments fail before starting the host", () => {
  for (const args of [["--resolution"], ["--resolution", "aic"], ["--resolution", "0x272"],
    ["--resolution", "480x-1"], ["--resolution", "480x272junk"],
    ["--resolution", "16385x272"], ["--unknown"],
    ["--resolution", "aic", "--unknown"]]) {
    expect(() => resolutionFlags(args)).toThrow();
  }
});
