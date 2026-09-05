// test/bridge/testutil.ts — bridge 测试共享的 fake 宿主命名空间工具
// （test/core/testutil.ts 的 bridge 镜像）。

/** globalThis.com 的宿主侧形状（bridge/com.ts ComNs 的测试镜像）。 */
export interface FakeNs {
  serialList(): string;
  serialOpen(paramsJson: string): string;
  write(handle: number, bytes: Uint8Array): boolean;
  setSignals(handle: number, pinsJson: string): boolean;
  close(handle: number): boolean;
  poll(): string | null;
  tcpConnect?(paramsJson: string): string;
  tcpListen?(paramsJson: string): string;
  udpBind?(paramsJson: string): string;
  wsConnect?(paramsJson: string): string;
  cfgRead?(): string | null;
  cfgWrite?(json: string): boolean;
  cfgExport?(json: string): string;
  cfgImport?(): string;
}

export function setHost(ns: FakeNs | undefined): void {
  (globalThis as { com?: FakeNs | undefined }).com = ns;
}

/** 方法齐全的合法宿主命名空间，默认全部成功；用 overrides 覆写关注点。 */
export function makeNs(overrides: Partial<FakeNs> = {}): FakeNs {
  return {
    serialList: () => "[]",
    serialOpen: () => JSON.stringify({ handle: 1 }),
    write: () => true,
    setSignals: () => true,
    close: () => true,
    poll: () => null,
    ...overrides,
  };
}
