// app/wheel.ts — 滚轮路由中枢：app.tsx 按指针 x 分区调用；
// 弹层打开时由弹层接管（见 app.tsx，widgets.popupWheel）。
type Region = "panel" | "log";

const handlers: Record<Region, ((dy: number) => void) | null> = { panel: null, log: null };

export function onWheel(region: Region, h: (dy: number) => void): void {
  handlers[region] = h;
}

export function routeWheel(dy: number, region: Region): void {
  handlers[region]?.(dy);
}
