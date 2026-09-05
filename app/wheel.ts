// app/wheel.ts — 滚轮路由中枢：app.tsx 按指针 x 分区调用；
// 弹层打开时由弹层接管（见 app.tsx，widgets.popupWheel）。
// M3 起 log / term 二选一：终端模式滚轮进回滚，收发模式进接收区。
type Region = "panel" | "log" | "term";

const handlers: Record<Region, ((dy: number) => void) | null> = { panel: null, log: null, term: null };

export function onWheel(region: Region, h: (dy: number) => void): void {
  handlers[region] = h;
}

export function routeWheel(dy: number, region: Region): void {
  handlers[region]?.(dy);
}
