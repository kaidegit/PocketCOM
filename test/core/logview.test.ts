import { describe, expect, test } from "bun:test";
import { LogView, splitHardLines, type LogRow } from "../../core/logview";
import { ParamError } from "../../core/errors";
import { TERM_DEFAULT_COLOR } from "../../core/term";
import { MessageBus } from "../../core/bus";
import { strToBytes } from "../../core/codec";
import type { LogFormatOptions, LogLineLabels } from "../../core/format";
import type { NewMessage } from "../../core/message";

const LABELS: LogLineLabels = { rx: "<=", txManual: "[手动发送]", txMcp: "[MCP发送]", sys: "[SYS]" };
const FORMAT: LogFormatOptions = { hex: false, escape: false, timestamp: false, color: false };

/** 行内容的前景色分段压缩（[色, 文本] 序列；null → null）。fg 与整行 text
 *  对齐（前缀区恒默认色），内容段从前缀之后开始切（同 app 渲染侧）。 */
function fgRuns(row: LogRow): [number, string][] | null {
  if (row.fg === null) return null;
  const at = row.prefix !== "" ? row.prefixAt + row.prefix.length : 0;
  const out: [number, string][] = [];
  let start = at;
  for (let i = at + 1; i <= row.fg.length; i++) {
    if (i === row.fg.length || row.fg[i] !== row.fg[start]) {
      out.push([row.fg[start]!, row.text.slice(start, i)]);
      start = i;
    }
  }
  return out;
}

function feed(bus: MessageBus, partial: Partial<NewMessage> & { payload: Uint8Array }): void {
  bus.append({ dir: "rx", source: "system", connId: "c", ...partial });
}

describe("LogView", () => {
  test("sync 增量：只追加新消息，重复 sync 不重复", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: strToBytes("one") });
    expect(lv.sync(bus).added).toBe(1);
    expect(lv.sync(bus).added).toBe(0);
    feed(bus, { payload: strToBytes("two") });
    expect(lv.sync(bus).added).toBe(1);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= one", "<= two"]);
  });

  test("sync 断档检测：环形缓冲裁掉未显示帧时返回 lost", () => {
    const bus = new MessageBus({ maxFrames: 2 });
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: strToBytes("1") });
    feed(bus, { payload: strToBytes("2") });
    feed(bus, { payload: strToBytes("3") }); // 逐出 id 1，未被显示
    expect(lv.sync(bus)).toEqual({ added: 2, lost: 1, changed: true });
    expect(lv.sync(bus)).toEqual({ added: 0, lost: 0, changed: false });
    feed(bus, { payload: strToBytes("4") }); // 缓冲 [3,4]
    feed(bus, { payload: strToBytes("5") }); // 缓冲 [4,5]
    // lastMsgId=3，首条新消息 id=4 连续 → 无丢帧
    expect(lv.sync(bus)).toEqual({ added: 2, lost: 0, changed: true });
  });

  test("tx 两类前缀 + sys 前缀", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { dir: "tx", source: "manual", payload: strToBytes("a") });
    feed(bus, { dir: "tx", source: "mcp", payload: strToBytes("b") });
    feed(bus, { dir: "sys", source: "system", payload: strToBytes("c") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["[手动发送] a", "[MCP发送] b", "[SYS] c"]);
    expect(lv.rows.map((r) => r.dir)).toEqual(["tx", "tx", "sys"]);
    expect(lv.rows.map((r) => r.prefixKind)).toEqual(["tx-manual", "tx-mcp", "sys"]);
    expect(lv.rows.map((r) => r.prefix)).toEqual(["[手动发送]", "[MCP发送]", "[SYS]"]);
  });

  test("MCP 未运行（rx/txManual=\"\"）：数据行无前缀，MCP 行保留标签", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, { ...LABELS, rx: "", txManual: "" });
    feed(bus, { payload: strToBytes("a") });
    feed(bus, { dir: "tx", source: "manual", payload: strToBytes("b") });
    feed(bus, { dir: "tx", source: "mcp", payload: strToBytes("c") });
    feed(bus, { dir: "sys", source: "system", payload: strToBytes("d") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["a", "b", "[MCP发送] c", "[SYS] d"]);
    expect(lv.rows.map((r) => r.prefix)).toEqual(["", "", "[MCP发送]", "[SYS]"]);
  });

  test("showTx=false：TX 行整行隐藏，重开从 entries 恢复", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { showTx: false });
    feed(bus, { payload: strToBytes("r1") });
    feed(bus, { dir: "tx", source: "manual", payload: strToBytes("t1") });
    feed(bus, { dir: "sys", source: "system", payload: strToBytes("s1") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= r1", "[SYS] s1"]);
    lv.setShowTx(true);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= r1", "[手动发送] t1", "[SYS] s1"]);
    lv.setShowTx(false);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= r1", "[SYS] s1"]);
  });

  test("showTx=false 期间隐藏行不占显示行数，added 只计可见行", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { showTx: false });
    feed(bus, { payload: strToBytes("r1") });
    expect(lv.sync(bus).added).toBe(1);
    feed(bus, { dir: "tx", source: "manual", payload: strToBytes("t1") });
    expect(lv.sync(bus).added).toBe(0); // TX 隐藏：无可见行新增
  });

  test("setFormat 重排版（hex 切换）", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: new Uint8Array([0x41, 0x0d]) });
    lv.sync(bus);
    // ASCII 非转义：帧末 \r 按硬换行拆分，不产多余空行（SPEC §3.3）
    expect(lv.rows.map((r) => r.text)).toEqual(["<= A"]);
    lv.setFormat({ ...FORMAT, hex: true }, LABELS);
    expect(lv.rows[0]!.text).toBe("<= 41 0D"); // HEX 下换行字节原样可见
    lv.setFormat({ ...FORMAT, timestamp: true }, LABELS);
    expect(lv.rows[0]!.text).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] <= A$/);
  });

  test("时间戳开启时 prefixAt 指向前缀真实下标（时间戳段之后）", () => {
    const bus = new MessageBus();
    const lv = new LogView({ ...FORMAT, timestamp: true }, LABELS);
    feed(bus, { payload: strToBytes("a") });
    feed(bus, { dir: "tx", source: "manual", payload: strToBytes("b") });
    lv.sync(bus);
    const tsLen = "[2026-09-06 12:34:15.883] ".length; // 26，与 formatTimestamp 输出一致
    expect(lv.rows[0]!.prefixAt).toBe(tsLen);
    expect(lv.rows[0]!.text.slice(0, tsLen)).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] $/);
    expect(lv.rows[0]!.text.slice(tsLen, tsLen + lv.rows[0]!.prefix.length)).toBe("<=");
    expect(lv.rows[1]!.prefixAt).toBe(tsLen);
    expect(lv.rows[1]!.text.slice(tsLen)).toBe("[手动发送] b");
    // 续行/无前缀行 prefixAt 归 0
    expect(lv.rows.every((r) => r.prefix === "" || r.prefixAt === tsLen)).toBe(true);
  });

  test("行数上限：丢最旧", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxRows: 3 });
    for (let i = 0; i < 5; i++) feed(bus, { payload: strToBytes(`m${i}`) });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= m2", "<= m3", "<= m4"]);
  });

  test("clear 后旧消息不复活，新消息继续", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: strToBytes("old") });
    lv.sync(bus);
    lv.clear(lv.lastSeenMsgId);
    expect(lv.rows.length).toBe(0);
    lv.sync(bus); // 总线里还有 old，但已见过
    expect(lv.rows.length).toBe(0);
    feed(bus, { payload: strToBytes("new") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= new"]);
  });

  test("自动换行：注入测量，按宽度折行", () => {
    // 等宽 fake：每字符 10px，宽 25px → 每行 2 字符
    const lv = new LogView(FORMAT, LABELS, {
      measure: () => 10,
      wrapWidth: () => 25,
    });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("abcdefgh") }); // "<= abcdefgh" 11 字符
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<=", " a", "bc", "de", "fg", "h"]);
    expect(lv.rows.every((r) => r.msgId === 1)).toBe(true);
    expect(lv.rows[0]!.prefixKind).toBe("rx");
    expect(lv.rows.slice(1).every((r) => r.prefixKind === "" && r.prefix === "")).toBe(true);
  });

  test("换行宽度变化后 refresh 重排", () => {
    let width = 25;
    const lv = new LogView(FORMAT, LABELS, { measure: () => 10, wrapWidth: () => width });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("abcd") });
    lv.sync(bus);
    expect(lv.rows.length).toBe(4); // "<=" " a" "bc" "d"
    width = 100;
    lv.refresh();
    expect(lv.rows.map((r) => r.text)).toEqual(["<= abcd"]);
  });

  test("无测量函数 = 不换行", () => {
    const lv = new LogView(FORMAT, LABELS, { wrapWidth: () => 10 });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("long line here") });
    lv.sync(bus);
    expect(lv.rows.length).toBe(1);
  });

  test("折行也受行数上限约束", () => {
    const lv = new LogView(FORMAT, LABELS, {
      maxRows: 4,
      measure: () => 10,
      wrapWidth: () => 20,
    });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("aaaa") });
    feed(bus, { payload: strToBytes("bbbb") });
    lv.sync(bus);
    expect(lv.rows.length).toBe(4);
  });

  test("帧内硬换行拆分为独立显示行，后续行无前缀（SPEC §3.3）", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: strToBytes("ESP-ROM:esp32s3\r\nBuild:Mar 27 2021\nwaiting\n") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= ESP-ROM:esp32s3", "Build:Mar 27 2021", "waiting"]);
    expect(lv.rows.map((r) => r.prefix)).toEqual(["<=", "", ""]);
    expect(lv.rows.map((r) => r.msgId)).toEqual([1, 1, 1]);
  });

  test("硬换行：中间空行保留、帧末换行不多空行、行内无残留控制符", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: strToBytes("a\n\nb") }); // 中间空行应显示为空行
    feed(bus, { payload: strToBytes("c\r") });    //  lone \r 也是硬换行
    feed(bus, { payload: strToBytes("\n") });     // 仅换行 → 该帧占一个空前缀行
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= a", "", "b", "<= c", "<= "]);
    expect(lv.rows.every((r) => !/[\r\n]/.test(r.text))).toBe(true);
  });

  test("硬换行与宽度折行组合：先拆行再折行", () => {
    const lv = new LogView(FORMAT, LABELS, { measure: () => 10, wrapWidth: () => 25 });
    const bus = new MessageBus();
    feed(bus, { payload: strToBytes("ab\ncde") });
    lv.sync(bus);
    // 前缀计入折行宽度：<= ab 50px 在 25px 宽下折成 "<=" " a" "b"
    expect(lv.rows.map((r) => r.text)).toEqual(["<=", " a", "b", "cd", "e"]);
  });

  test("splitHardLines 边界：空串 / 仅换行 / 混合换行符", () => {
    expect(splitHardLines("")).toEqual([""]);
    expect(splitHardLines("\n")).toEqual([""]);
    expect(splitHardLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
    expect(splitHardLines("a\n")).toEqual(["a"]);
    expect(splitHardLines("\n\n")).toEqual(["", ""]);
  });

  test("颜色转义关闭：fg 全 null，SGR 序列按原样显示", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS);
    feed(bus, { payload: strToBytes("\x1b[31mred") });
    lv.sync(bus);
    expect(lv.rows[0]!.text).toBe("<= \x1b[31mred");
    expect(lv.rows.every((r) => r.fg === null)).toBe(true);
  });

  test("颜色转义：SGR 剥离，内容默认色段为 DEFAULT 哨兵（渲染取黑/白正文色）", () => {
    const bus = new MessageBus();
    const lv = new LogView({ ...FORMAT, color: true }, LABELS);
    feed(bus, { payload: strToBytes("plain\x1b[31mred") });
    lv.sync(bus);
    expect(lv.rows[0]!.text).toBe("<= plainred");
    // 前缀 "<= " 区恒默认（渲染层按前缀类别着色）；内容默认段 = DEFAULT
    // （渲染层映射为主题正文色），分隔空格随内容段渲染
    expect(fgRuns(lv.rows[0]!)).toEqual([
      [TERM_DEFAULT_COLOR, " plain"],
      [1, "red"],
    ]);
  });

  test("颜色转义：SGR 状态跨行、跨消息持续", () => {
    const bus = new MessageBus();
    const lv = new LogView({ ...FORMAT, color: true }, LABELS);
    feed(bus, { payload: strToBytes("\x1b[32ma\nb") }); // 同帧跨硬换行
    feed(bus, { payload: strToBytes("c") }); // 跨帧仍持绿
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= a", "b", "<= c"]);
    expect(fgRuns(lv.rows[1]!)).toEqual([[2, "b"]]);
    expect(fgRuns(lv.rows[2]!)).toEqual([
      [TERM_DEFAULT_COLOR, " "],
      [2, "c"],
    ]);
  });

  test("颜色转义：帧尾截断序列缓存，下一帧续接着色", () => {
    const bus = new MessageBus();
    const lv = new LogView({ ...FORMAT, color: true }, LABELS);
    feed(bus, { payload: strToBytes("ok\x1b[3") });
    feed(bus, { payload: strToBytes("1mred") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.text)).toEqual(["<= ok", "<= red"]);
    expect(fgRuns(lv.rows[0]!)).toEqual([[TERM_DEFAULT_COLOR, " ok"]]);
    expect(fgRuns(lv.rows[1]!)).toEqual([
      [TERM_DEFAULT_COLOR, " "],
      [1, "red"],
    ]);
  });

  test("颜色转义：折行切片与 fg 对齐", () => {
    const bus = new MessageBus();
    const lv = new LogView({ ...FORMAT, color: true }, LABELS, {
      measure: () => 10,
      wrapWidth: () => 25,
    });
    feed(bus, { payload: strToBytes("aa\x1b[31mbb") }); // "<= aabb" 7 字符 → 25px 每行 2 字符
    lv.sync(bus);
    const texts = lv.rows.map((r) => r.text);
    expect(texts.join("|")).toBe("<=| a|ab|b");
    // 每段切片的 fg 与文本等长，颜色随切片保持；首段只剩前缀（内容段为空），
    // "ab" 段恰跨默认色/红色边界 → 两段
    expect(lv.rows.map((r) => fgRuns(r))).toEqual([
      [],
      [[TERM_DEFAULT_COLOR, " a"]],
      [
        [TERM_DEFAULT_COLOR, "a"],
        [1, "b"],
      ],
      [[1, "b"]],
    ]);
  });

  test("颜色转义：sys 行不参与解析不附 fg；开关切换重排版恢复", () => {
    const bus = new MessageBus();
    const lv = new LogView({ ...FORMAT, color: true }, LABELS);
    feed(bus, { payload: strToBytes("\x1b[31mr") });
    feed(bus, { dir: "sys", source: "system", payload: strToBytes("boom") });
    lv.sync(bus);
    expect(lv.rows.map((r) => r.fg === null)).toEqual([false, true]);
    lv.setFormat({ ...FORMAT, color: false }, LABELS);
    expect(lv.rows[0]!.text).toBe("<= \x1b[31mr");
    expect(lv.rows.every((r) => r.fg === null)).toBe(true);
  });
});

describe("incremental log history", () => {
  test("saturation reports changes and preserves surviving row identities", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxRows: 3 });
    for (const text of ["a", "b", "c"]) { feed(bus, { payload: strToBytes(text) }); lv.sync(bus); }
    const survivor = lv.rows[1];
    feed(bus, { payload: strToBytes("LATEST") });
    expect(lv.sync(bus)).toEqual({ added: 0, lost: 0, changed: true });
    expect(lv.rows[0]).toBe(survivor);
    expect(lv.rows[2]!.text).toBe("<= LATEST");
    expect(lv.sync(bus).changed).toBe(false);
  });

  test("byte eviction can reduce rows and still notifies; hidden TX alone does not", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxBytes: 6, showTx: false });
    feed(bus, { payload: strToBytes("a\nb\nc") });
    lv.sync(bus);
    feed(bus, { payload: strToBytes("xy") });
    expect(lv.sync(bus)).toEqual({ added: -2, lost: 0, changed: true });
    feed(bus, { dir: "tx", payload: strToBytes("z") });
    expect(lv.sync(bus).changed).toBe(false);
    lv.setFormat({ ...FORMAT, hex: true }, LABELS);
    expect(lv.rows.map(r => r.text)).toEqual(["<= 78 79"]);
  });

  test("ANSI head checkpoint survives eviction, split CSI, reflow and format toggles", () => {
    const bus = new MessageBus();
    const lv = new LogView({ ...FORMAT, color: true }, { ...LABELS, rx: "" }, { maxRows: 2 });
    for (const text of ["\x1b[3", "1mred", "next"]) {
      feed(bus, { payload: strToBytes(text) }); lv.sync(bus);
    }
    const check = () => {
      expect(lv.rows.map(r => r.text)).toEqual(["red", "next"]);
      expect(lv.rows.every(r => [...r.fg!].every(c => c === 1))).toBe(true);
    };
    check(); lv.refresh(); check();
    lv.setFormat({ ...FORMAT, hex: true }, { ...LABELS, rx: "" });
    lv.setFormat({ ...FORMAT, color: true }, { ...LABELS, rx: "" }); check();
  });

  test("hidden history consumes without measuring; visibility catches up without new data", () => {
    let measures = 0;
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxBytes: 4, measure: () => { measures++; return 1; }, wrapWidth: () => 80 });
    for (const text of ["aa", "bb", "cc"]) {
      feed(bus, { payload: strToBytes(text) });
      expect(lv.sync(bus, false).changed).toBe(false);
    }
    lv.setFormat({ ...FORMAT, timestamp: true }, LABELS);
    expect(measures).toBe(0);
    expect(lv.lastSeenMsgId).toBe(3);
    expect(lv.sync(bus).changed).toBe(true);
    expect(lv.rows.length).toBe(2);
    expect(lv.rows[1]!.text.endsWith("cc")).toBe(true);
  });

  test("identical configuration preserves rows and width cache", () => {
    let measures = 0;
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { measure: () => { measures++; return 1; }, wrapWidth: () => 80 });
    feed(bus, { payload: strToBytes("abc") }); lv.sync(bus);
    const row = lv.rows[0], count = measures;
    lv.configure({ ...FORMAT }, { ...LABELS });
    expect(lv.rows[0]).toBe(row);
    lv.configure({ ...FORMAT, color: true }, LABELS, { showTx: false });
    expect(measures).toBe(count);
    lv.configure({ ...FORMAT, color: true }, LABELS, { remeasure: true });
    expect(measures).toBeGreaterThan(count);
  });

  test("oversize history frame is discarded whole", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxBytes: 3 });
    feed(bus, { payload: strToBytes("1234") }); lv.sync(bus);
    expect(lv.rows).toEqual([]);
    lv.refresh(); expect(lv.rows).toEqual([]);
    feed(bus, { payload: strToBytes("ok") });
    expect(lv.sync(bus).lost).toBe(0);
    expect(lv.rows[0]!.text).toBe("<= ok");
  });

  test("configure 运行时改 maxRows：缩小立即裁剪、放大不复活已逐出帧", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxRows: 2 });
    for (const text of ["a", "b", "c"]) { feed(bus, { payload: strToBytes(text) }); lv.sync(bus); }
    expect(lv.rows.map(r => r.text)).toEqual(["<= b", "<= c"]);
    lv.configure(FORMAT, LABELS, { maxRows: 1 });
    expect(lv.rows.map(r => r.text)).toEqual(["<= c"]);
    lv.configure(FORMAT, LABELS, { maxRows: 4 });
    expect(lv.rows.map(r => r.text)).toEqual(["<= c"]);
    for (const text of ["d", "e", "f"]) { feed(bus, { payload: strToBytes(text) }); lv.sync(bus); }
    expect(lv.rows.map(r => r.text)).toEqual(["<= c", "<= d", "<= e", "<= f"]);
  });

  test("configure 运行时改 maxBytes：超预算的旧整帧立即逐出", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxRows: 10 });
    feed(bus, { payload: strToBytes("aaaa") });
    feed(bus, { payload: strToBytes("bb") });
    lv.sync(bus);
    expect(lv.rows.map(r => r.text)).toEqual(["<= aaaa", "<= bb"]);
    lv.configure(FORMAT, LABELS, { maxBytes: 4 }); // 4+2 > 4 → 逐出 aaaa
    expect(lv.rows.map(r => r.text)).toEqual(["<= bb"]);
    lv.configure(FORMAT, LABELS, { maxBytes: 1 }); // 2 > 1 → 全逐出
    expect(lv.rows).toEqual([]);
  });

  test("configure 非法上限抛错且不改状态", () => {
    const bus = new MessageBus();
    const lv = new LogView(FORMAT, LABELS, { maxRows: 2 });
    feed(bus, { payload: strToBytes("x") }); lv.sync(bus);
    expect(() => lv.configure(FORMAT, LABELS, { maxRows: 0 })).toThrow(ParamError);
    expect(() => lv.configure(FORMAT, LABELS, { maxRows: 1.5 })).toThrow(ParamError);
    expect(() => lv.configure(FORMAT, LABELS, { maxBytes: -1 })).toThrow(ParamError);
    expect(lv.rows.map(r => r.text)).toEqual(["<= x"]);
    expect(lv.sync(bus).added).toBe(0);
  });
});

test("ANSI checkpoint retains separate TX-visible and RX-only histories", () => {
  const bus = new MessageBus();
  const lv = new LogView({ ...FORMAT, color: true }, { ...LABELS, rx: "" }, { maxRows: 1, showTx: false });
  feed(bus, { dir: "tx", payload: strToBytes("\x1b[31m") }); lv.sync(bus);
  feed(bus, { payload: strToBytes("x") }); lv.sync(bus);
  expect(lv.rows[0]!.fg![0]).toBe(TERM_DEFAULT_COLOR);
  lv.setShowTx(true);
  expect(lv.rows[0]!.fg![0]).toBe(1);
  lv.setShowTx(false);
  expect(lv.rows[0]!.fg![0]).toBe(TERM_DEFAULT_COLOR);
});
