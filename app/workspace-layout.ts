// Shared window geometry, independent of Vue and host APIs.
export const PANEL_W = 272;
export const STATUS_H = 28;
export const NARROW_BREAKPOINT = 720;
export const NARROW_HEADER_H = 32;

export function workspaceGeometry(w: number, h: number) {
  const compact = w < NARROW_BREAKPOINT;
  const x = compact ? 0 : PANEL_W;
  const y = compact ? NARROW_HEADER_H : 0;
  return {
    compact, x, y,
    w: Math.max(0, w - x),
    h: Math.max(0, h - STATUS_H - y),
    drawerW: Math.max(0, Math.min(PANEL_W, w)),
  };
}
