import { expect, test } from "bun:test";
import { onWheel, routeWheel } from "../../app/wheel";

test("removing an unmounted panel's wheel handler releases its callback", () => {
  let value = 0;
  const dispose = onWheel("panel", dy => { value += dy; });
  routeWheel(3, "panel");
  expect(value).toBe(3);
  dispose();
  dispose();
  routeWheel(4, "panel");
  expect(value).toBe(3);
});

test("an old scope's cleanup does not erase a newer handler", () => {
  let value = 0;
  const old = onWheel("panel", () => { value = -1; });
  const current = onWheel("panel", dy => { value = dy; });
  old();
  routeWheel(7, "panel");
  expect(value).toBe(7);
  current();
});
