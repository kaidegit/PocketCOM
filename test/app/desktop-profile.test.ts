import { describe, expect, test } from "bun:test";
import manifest from "../../app/pocket.json";
import { catalogEntry } from "../../vendor/pocketjs/tools/targets/index.ts";
import { validateAndResolveBuildPlan } from "../../vendor/pocketjs/framework/src/manifest/resolve.ts";

describe("PocketCOM desktop host contract", () => {
  test("the GPUI plan enables native text and input used by the launcher", () => {
    const target = catalogEntry("macos-gpui")!;
    const resolved = validateAndResolveBuildPlan(manifest, {
      target: target.contract.target,
    }, target.contract.registry());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
    expect(resolved.plan.target).toEqual({ id: "macos-app", hostAbi: 4 });
    for (const capability of ["text.layout.native", "text.glyphs.runtime", "input.text",
      "input.pointer", "input.ime", "host.clipboard"]) {
      expect(resolved.plan.features[capability]).toBe(true);
    }
  });

  test("the portable software host cannot silently disable native text", () => {
    const resolved = validateAndResolveBuildPlan(manifest, { target: "macos-app" });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("software host unexpectedly admitted the GPUI app");
    expect(resolved.diagnostics.some(d => d.message.includes("text.layout.native"))).toBe(true);
  });
});
