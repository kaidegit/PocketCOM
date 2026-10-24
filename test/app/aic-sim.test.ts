import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSimDensity, resolveSimPlan, simRegistry } from "../../tools/aic-sim.ts";

test("sim registry pins the fork macos-app contract to the requested density", () => {
  const contract = simRegistry(1).targets["macos-app"];
  expect(contract.display.rasterDensity).toBe(1);
  // Same capability list as the fork host contract — native text stays
  // resolvable; only the raster density differs.
  expect(contract.capabilities).toContain("text.glyphs.baked");
  expect(contract.capabilities).toContain("text.layout.native");
});

test("resolved sim plan carries the density and keeps native text available", () => {
  for (const density of [1, 2]) {
    const plan = resolveSimPlan(density);
    expect(plan.viewport.rasterDensity).toBe(density);
    expect(plan.target.id).toBe("macos-app");
    expect(plan.features["text.layout.native"]).toBe(true);
  }
});

test("density flag validates and defaults to the AIC host profile", () => {
  // The sim default must stay anchored to whatever the board profile declares.
  const profile = JSON.parse(
    readFileSync(new URL("../../host/rtthread/pocket.host.json", import.meta.url), "utf8"),
  );
  expect(parseSimDensity([])).toBe(profile.display.rasterDensity);
  expect(parseSimDensity(["--density=1"])).toBe(1);
  for (const bad of [["--density=0"], ["--density=256"], ["--density=x"], ["--wat"]]) {
    expect(() => parseSimDensity(bad)).toThrow();
  }
});
