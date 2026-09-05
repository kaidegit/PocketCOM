// test/bridge/cfg.test.ts — bridge/cfg.ts 封装语义（fake 宿主命名空间；
// 宿主侧文件 IO 见 test/host/macos/env_tests.rs）。
import { afterEach, describe, expect, test } from "bun:test";
import { connectCom } from "../../bridge/com";
import { makeNs, setHost } from "./testutil";

describe("cfg ops", () => {
  afterEach(() => {
    setHost(undefined);
  });

  test("cfgRead/cfgWrite：透传与缺方法降级", () => {
    setHost(makeNs({ cfgRead: () => '{"version":1}', cfgWrite: () => true }));
    const com = connectCom()!;
    expect(com.cfgRead()).toBe('{"version":1}');
    expect(com.cfgWrite("{}")).toBe(true);

    setHost(makeNs({ cfgRead: () => null }));
    expect(connectCom()!.cfgRead()).toBeNull();

    setHost(makeNs()); // 无 cfg op
    const degraded = connectCom()!;
    expect(degraded.cfgRead()).toBeNull();
    expect(degraded.cfgWrite("{}")).toBeNull();
  });

  test("cfgRead/cfgWrite：宿主抛错不外溢", () => {
    setHost(
      makeNs({
        cfgRead: () => {
          throw new Error("boom");
        },
        cfgWrite: () => {
          throw new Error("boom");
        },
      }),
    );
    const com = connectCom()!;
    expect(com.cfgRead()).toBeNull();
    expect(com.cfgWrite("{}")).toBe(false);
  });
});
