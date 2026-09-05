import { describe, expect, test } from "bun:test";
import { ConnectionStateMachine, TRANSITIONS, type ConnState } from "../../core/connection";
import { StateError } from "../../core/errors";

const ALL: ConnState[] = ["DISCONNECTED", "CONNECTING", "CONNECTED", "LOST"];

describe("ConnectionStateMachine 合法迁移", () => {
  test("DISCONNECTED → CONNECTING → CONNECTED → DISCONNECTED", () => {
    const sm = new ConnectionStateMachine();
    expect(sm.state).toBe("DISCONNECTED");
    sm.transition("CONNECTING");
    sm.transition("CONNECTED");
    sm.transition("DISCONNECTED");
    expect(sm.state).toBe("DISCONNECTED");
  });

  test("CONNECTED → LOST → CONNECTING（自动重连）→ CONNECTED", () => {
    const sm = new ConnectionStateMachine();
    sm.transition("CONNECTING");
    sm.transition("CONNECTED");
    sm.transition("LOST");
    expect(sm.state).toBe("LOST");
    sm.transition("CONNECTING"); // LOST → CONNECTING 自动重连迁移
    sm.transition("CONNECTED");
    expect(sm.state).toBe("CONNECTED");
  });

  test("CONNECTED → LOST → DISCONNECTED（用户关闭）", () => {
    const sm = new ConnectionStateMachine();
    sm.transition("CONNECTING");
    sm.transition("CONNECTED");
    sm.transition("LOST");
    sm.transition("DISCONNECTED");
    expect(sm.state).toBe("DISCONNECTED");
  });

  test("CONNECTING 失败回到 DISCONNECTED / 转 LOST", () => {
    const sm = new ConnectionStateMachine();
    sm.transition("CONNECTING");
    expect(sm.canTransition("DISCONNECTED")).toBe(true);
    expect(sm.canTransition("LOST")).toBe(true);
  });

  test("迁移表完整覆盖且不包含自环", () => {
    for (const from of ALL) {
      expect(TRANSITIONS[from]).toBeDefined();
      expect(TRANSITIONS[from]!.includes(from)).toBe(false);
    }
  });

  test("迁移触发 onChange(from, to)", () => {
    const log: string[] = [];
    const sm = new ConnectionStateMachine((from, to) => log.push(`${from}->${to}`));
    sm.transition("CONNECTING");
    sm.transition("CONNECTED");
    sm.transition("LOST");
    expect(log).toEqual(["DISCONNECTED->CONNECTING", "CONNECTING->CONNECTED", "CONNECTED->LOST"]);
  });
});

describe("ConnectionStateMachine 非法迁移", () => {
  test("所有非法迁移抛 StateError(STATE_ILLEGAL_TRANSITION) 且状态不变", () => {
    const sm = new ConnectionStateMachine();
    for (const to of ALL) {
      if (to === "CONNECTING") continue;
      const before = sm.state;
      expect(() => sm.transition(to)).toThrow(StateError);
      expect(sm.state).toBe(before);
    }
    sm.transition("CONNECTING");
    sm.transition("CONNECTED");
    expect(() => sm.transition("CONNECTING")).toThrow(StateError); // 无 CONNECTED → CONNECTING
  });

  test("错误码结构化", () => {
    const sm = new ConnectionStateMachine();
    try {
      sm.transition("CONNECTED");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(StateError);
      expect((err as StateError).code).toBe("STATE_ILLEGAL_TRANSITION");
    }
  });
});
