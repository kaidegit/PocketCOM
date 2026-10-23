import { describe, expect, test } from "bun:test";
import { workspaceGeometry } from "../../app/workspace-layout";
import { connectionDrawerOpen, connectionPanelOpen, setViewport, workspace } from "../../app/layout";

describe("shared workspace geometry", () => {
  test("keeps desktop content bounds and the 272px sidebar", () => {
    expect(workspaceGeometry(960, 640)).toEqual({ compact: false, x: 272, y: 0, w: 688, h: 612, drawerW: 272 });
    expect(workspaceGeometry(720, 480).compact).toBe(false);
  });

  test("gives the 480x272 workspace the full width beneath its action bar", () => {
    expect(workspaceGeometry(480, 272)).toEqual({ compact: true, x: 0, y: 32, w: 480, h: 212, drawerW: 272 });
    expect(workspaceGeometry(719, 480).compact).toBe(true);
  });

  test("never produces negative content or drawer extents", () => {
    for (const [w, h] of [[0, 0], [120, 30], [240, 180], [720, 20]]) {
      const g = workspaceGeometry(w!, h!);
      expect(g.w).toBeGreaterThanOrEqual(0);
      expect(g.h).toBeGreaterThanOrEqual(0);
      expect(g.drawerW).toBeLessThanOrEqual(w!);
    }
  });

  test("closes a compact drawer on return to wide layout and does not reopen it", () => {
    setViewport(480, 272);
    connectionPanelOpen.value = true;
    expect(connectionDrawerOpen()).toBe(true);
    expect(workspace.value.x).toBe(0);
    setViewport(960, 640);
    expect(connectionPanelOpen.value).toBe(false);
    expect(connectionDrawerOpen()).toBe(false);
    setViewport(480, 272);
    expect(connectionDrawerOpen()).toBe(false);
    setViewport(960, 640);
  });
});
