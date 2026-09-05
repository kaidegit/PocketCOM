import { describe, expect, test } from "bun:test";
import {
  CELL_BOLD,
  CELL_REVERSE,
  CELL_UNDERLINE,
  CELL_WIDE,
  TERM_DEFAULT_COLOR,
  Terminal,
  isTermRgb,
  termRgb,
  wcwidth,
} from "../../core/term";

function lineText(t: Terminal, row: number): string {
  return (t.lineAt(t.scrollbackCount + row)!.text as string)
    .replace(/\x00/g, "") // 宽字符续格不参与文本比较
    .replace(/[ ]+$/, "");
}

function cellText(line: { text: string }, col: number): string {
  return line.text.charAt(col);
}

describe("wcwidth", () => {
  test("ASCII = 1，CJK = 2，组合字符 = 0", () => {
    expect(wcwidth(0x41)).toBe(1);
    expect(wcwidth(0x4e2d)).toBe(2); // 中
    expect(wcwidth(0xac00)).toBe(2); // 가
    expect(wcwidth(0x0301)).toBe(0); // combining acute
    expect(wcwidth(0xff21)).toBe(2); // Ａ fullwidth
  });
});

describe("打印与光标", () => {
  test("纯文本写入与光标推进", () => {
    const t = new Terminal({ cols: 10, rows: 4 });
    t.feedString("hello");
    expect(lineText(t, 0)).toBe("hello");
    expect(t.cursorX).toBe(5);
    expect(t.cursorY).toBe(0);
  });

  test("CR + LF 换行", () => {
    const t = new Terminal({ cols: 10, rows: 4 });
    t.feedString("ab\ncd");
    expect(lineText(t, 0)).toBe("ab"); // LF 只下移，不回车
    expect(t.cursorX).toBe(4);
    t.feedString("\rcd"); // CR 只回车：旧 "cd"（col2-3）仍在
    expect(lineText(t, 1)).toBe("cdcd");
    expect(t.cursorX).toBe(2);
  });

  test("自动换行：写满一行后待换（wrapPending），下一字符落地新行", () => {
    const t = new Terminal({ cols: 4, rows: 3 });
    t.feedString("abcd");
    expect(t.cursorX).toBe(3); // 停在最后一列，wrapPending
    expect(lineText(t, 0)).toBe("abcd");
    t.feedString("e");
    expect(lineText(t, 1)).toBe("e");
    expect(t.cursorX).toBe(1);
  });

  test("DECAWM 关闭：最后一列覆盖不换行", () => {
    const t = new Terminal({ cols: 4, rows: 3 });
    t.feedString("\x1b[?7labcdxyz");
    expect(lineText(t, 0)).toBe("abcz");
    expect(t.cursorY).toBe(0);
  });

  test("BS 后退、HT 跳制表位（默认每 8 列）", () => {
    const t = new Terminal({ cols: 20, rows: 3 });
    t.feedString("abc\b\bX");
    expect(lineText(t, 0)).toBe("aXc");
    t.feedString("\r\tY");
    expect(cellText(t.lineAt(t.scrollbackCount)!, 8)).toBe("Y");
    expect(t.cursorX).toBe(9);
  });
});

describe("CSI 光标移动与擦除", () => {
  test("CUP 定位", () => {
    const t = new Terminal({ cols: 10, rows: 5 });
    t.feedString("\x1b[3;4HX");
    expect(lineText(t, 2)).toBe("   X");
    expect(t.cursorX).toBe(4);
    expect(t.cursorY).toBe(2);
  });

  test("CUU/CUD/CUF/CUB 相对移动", () => {
    const t = new Terminal({ cols: 10, rows: 5 });
    t.feedString("\x1b[2;2H\x1b[1A\x1b[3C");
    expect(t.cursorY).toBe(0);
    expect(t.cursorX).toBe(4);
    t.feedString("\x1b[2D\x1b[2B");
    expect(t.cursorX).toBe(2);
    expect(t.cursorY).toBe(2);
  });

  test("EL 0 擦除到行尾（BCE：擦除格带当前背景）", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.feedString("\x1b[41mabc\x1b[1;5H\x1b[K");
    const line = t.lineAt(t.scrollbackCount)!;
    expect(line.text).toBe("abc       "); // col3 未写 + col4–9 共 7 格擦除
    expect(line.bg[5]).toBe(1); // 未写过的格子被擦成当前背景
    expect(line.fg[5]).toBe(TERM_DEFAULT_COLOR);
  });

  test("ED 2 清屏 / ED 0 光标到屏底", () => {
    const t = new Terminal({ cols: 5, rows: 3 });
    t.feedString("aaa\r\nbbb\r\nccc");
    t.feedString("\x1b[2J");
    expect(lineText(t, 0)).toBe("");
    expect(lineText(t, 2)).toBe("");
    t.feedString("\x1b[1;1Hxx\x1b[J");
    expect(lineText(t, 0)).toBe("xx");
    expect(lineText(t, 1)).toBe("");
  });

  test("DCH/ICH/ECH", () => {
    const t = new Terminal({ cols: 6, rows: 2 });
    t.feedString("abcdef\x1b[1;2H\x1b[2P"); // 删 bc
    expect(lineText(t, 0)).toBe("adef");
    t.feedString("\x1b[1;1H\x1b[2@"); // 插 2 格
    expect(lineText(t, 0)).toBe("  adef");
    t.feedString("\x1b[1;1H\x1b[3X"); // 覆盖 3 格为空格
    expect(lineText(t, 0)).toBe("   def");
  });

  test("IL/DL 在滚动区域内", () => {
    const t = new Terminal({ cols: 6, rows: 4 });
    t.feedString("aaa\r\nbbb\r\nccc\r\nddd");
    t.feedString("\x1b[2;1H\x1b[1L"); // 第 2 行起插 1 行
    expect(lineText(t, 1)).toBe("");
    expect(lineText(t, 2)).toBe("bbb");
    expect(lineText(t, 3)).toBe("ccc"); // ddd 被推出区域底
    t.feedString("\x1b[2;1H\x1b[1M");
    expect(lineText(t, 1)).toBe("bbb");
    expect(lineText(t, 2)).toBe("ccc");
    expect(lineText(t, 3)).toBe("");
  });
});

describe("SGR 属性", () => {
  test("前景/背景/亮色", () => {
    const t = new Terminal({ cols: 4, rows: 2 });
    t.feedString("\x1b[31;44mA\x1b[91mB\x1b[0mC");
    const line = t.lineAt(t.scrollbackCount)!;
    expect(line.fg[0]).toBe(1);
    expect(line.bg[0]).toBe(4);
    expect(line.fg[1]).toBe(9);
    expect(line.fg[2]).toBe(TERM_DEFAULT_COLOR);
  });

  test("粗体/下划线/反显 flag 与复位", () => {
    const t = new Terminal({ cols: 4, rows: 2 });
    t.feedString("\x1b[1;4;7mA\x1b[22;24;27mB");
    const line = t.lineAt(t.scrollbackCount)!;
    expect(line.flags[0] & (CELL_BOLD | CELL_UNDERLINE | CELL_REVERSE)).toBe(
      CELL_BOLD | CELL_UNDERLINE | CELL_REVERSE,
    );
    expect(line.flags[1] & (CELL_BOLD | CELL_UNDERLINE | CELL_REVERSE)).toBe(0);
  });

  test("256 色与 24-bit 色（分号与冒号两种形态）", () => {
    const t = new Terminal({ cols: 4, rows: 2 });
    t.feedString("\x1b[38;5;196mA\x1b[48;5;21mB\x1b[38:5:46mC");
    const line = t.lineAt(t.scrollbackCount)!;
    expect(line.fg[0]).toBe(196);
    expect(line.bg[1]).toBe(21);
    expect(line.fg[2]).toBe(46);
    t.feedString("\x1b[38;2;10;20;30mD");
    const c = t.lineAt(t.scrollbackCount)!.fg[3]!;
    expect(isTermRgb(c)).toBe(true);
    expect(c).toBe(termRgb(10, 20, 30));
  });
});

describe("滚动区域与回滚", () => {
  test("LF 滚出屏幕底：顶行进回滚", () => {
    const t = new Terminal({ cols: 5, rows: 3 });
    t.feedString("one\r\ntwo\r\nthree\r\nfour");
    expect(t.scrollbackCount).toBe(1);
    expect(t.lineAt(0)!.text.replace(/[ ]+$/, "")).toBe("one");
    expect(lineText(t, 0)).toBe("two");
    expect(lineText(t, 2)).toBe("four");
  });

  test("DECSTBM 区域内滚动不进回滚（区域顶非 0）", () => {
    const t = new Terminal({ cols: 5, rows: 4 });
    t.feedString("\x1b[2;4r"); // 区域 = 第 2–4 行
    t.feedString("a\r\nb\r\nc\r\nd\r\ne");
    expect(t.scrollbackCount).toBe(0);
    expect(lineText(t, 0)).toBe("a"); // 区域外不动
    expect(lineText(t, 1)).toBe("c");
    expect(lineText(t, 3)).toBe("e");
  });

  test("RI 在区域顶下滚", () => {
    const t = new Terminal({ cols: 5, rows: 3 });
    t.feedString("a\r\nb");
    t.feedString("\x1b[1;1H\x1bM");
    expect(lineText(t, 0)).toBe("");
    expect(lineText(t, 1)).toBe("a");
    expect(lineText(t, 2)).toBe("b");
  });

  test("scrollback 默认 9999、setScrollback 即时裁剪（SPEC §3.4）", () => {
    const t = new Terminal({ cols: 5, rows: 2, scrollback: 10 });
    for (let i = 0; i < 20; i++) t.feedString(`l${i}\r\n`);
    expect(t.scrollbackCount).toBe(10);
    t.setScrollback(3);
    expect(t.scrollbackCount).toBe(3);
    expect(t.lineAt(0)!.text.replace(/[ ]+$/, "")).toBe("l16");
    t.setScrollback(0); // 0 = 不回滚
    expect(t.scrollbackCount).toBe(0);
    expect(t.scrollbackLimitLines).toBe(0);
  });

  test("IND 下移不回车 / NEL 下移并回车", () => {
    const t = new Terminal({ cols: 5, rows: 3 });
    t.feedString("ab\x1bDcd"); // IND：下移不回车
    expect(lineText(t, 1)).toBe("  cd");
    expect(t.cursorX).toBe(4);
    t.feedString("\x1b[Exy"); // CNL 等价 NEL：下移 + 行首
    expect(t.cursorX).toBe(2);
    expect(lineText(t, 2)).toBe("xy");
  });
});

describe("备用屏（alt screen）", () => {
  test("?1049 保存主屏、退出恢复", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.feedString("main\x1b[?1049h");
    expect(t.inAltScreen).toBe(true);
    expect(lineText(t, 0)).toBe(""); // alt 屏为空
    t.feedString("\x1b[2;1Halt\x1b[?1049l");
    expect(t.inAltScreen).toBe(false);
    expect(lineText(t, 0)).toBe("main");
  });

  test("alt 屏滚动不进回滚", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    t.feedString("\x1b[?1049h");
    t.feedString("a\r\nb\r\nc\r\nd");
    expect(t.scrollbackCount).toBe(0);
  });
});

describe("模式与查询", () => {
  test("DECCKM ?1 切换方向键形态", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    expect([...t.keyBytes("Up")!]).toEqual([0x1b, 0x5b, 0x41]);
    t.feedString("\x1b[?1h");
    expect([...t.keyBytes("Up")!]).toEqual([0x1b, 0x4f, 0x41]);
    t.feedString("\x1b[?1l");
    expect([...t.keyBytes("Up")!]).toEqual([0x1b, 0x5b, 0x41]);
  });

  test("?25 光标可见开关", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    expect(t.showCursor).toBe(true);
    t.feedString("\x1b[?25l");
    expect(t.showCursor).toBe(false);
    t.feedString("\x1b[?25h");
    expect(t.showCursor).toBe(true);
  });

  test("DSR 6 光标位置应答（CPR）", () => {
    const t = new Terminal({ cols: 20, rows: 10 });
    t.feedString("\x1b[4;7H\x1b[6n");
    const resp = t.takeResponses();
    expect(resp.length).toBe(1);
    expect(new TextDecoder().decode(resp[0])).toBe("\x1b[4;7R");
    expect(t.takeResponses().length).toBe(0);
  });

  test("DSR 5 状态应答与 DA", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    t.feedString("\x1b[5n\x1b[c");
    const resp = t.takeResponses();
    expect(new TextDecoder().decode(resp[0]!)).toBe("\x1b[0n");
    expect(new TextDecoder().decode(resp[1]!)).toBe("\x1b[?1;2c");
  });

  test("DECOM 原点模式：CUP 相对区域 + CPR 区域内", () => {
    const t = new Terminal({ cols: 10, rows: 6 });
    t.feedString("\x1b[3;5r\x1b[?6h\x1b[1;1H\x1b[6n");
    const resp = t.takeResponses();
    expect(new TextDecoder().decode(resp[0]!)).toBe("\x1b[1;1R");
    expect(t.cursorY).toBe(2); // 绝对第 3 行
  });
});

describe("按键编码（SPEC §3.4）", () => {
  test("Backspace 发 0x7F，Enter 发 0x0D，Tab/Escape", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    expect([...t.keyBytes("Backspace")!]).toEqual([0x7f]);
    expect([...t.keyBytes("Enter")!]).toEqual([0x0d]);
    expect([...t.keyBytes("Tab")!]).toEqual([0x09]);
    expect([...t.keyBytes("Tab", { sh: true })!]).toEqual([0x1b, 0x5b, 0x5a]);
    expect([...t.keyBytes("Escape")!]).toEqual([0x1b]);
  });

  test("方向键/Home/End 常态 CSI，应用态 SS3", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    expect([...t.keyBytes("Down")!]).toEqual([0x1b, 0x5b, 0x42]);
    expect([...t.keyBytes("Home")!]).toEqual([0x1b, 0x5b, 0x48]);
    expect([...t.keyBytes("End")!]).toEqual([0x1b, 0x5b, 0x46]);
    t.feedString("\x1b[?1h");
    expect([...t.keyBytes("Home")!]).toEqual([0x1b, 0x4f, 0x48]);
  });

  test("PageUp/PageDown/Insert/Delete/F 键", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    expect([...t.keyBytes("PageUp")!]).toEqual([0x1b, 0x5b, 0x35, 0x7e]);
    expect([...t.keyBytes("PageDown")!]).toEqual([0x1b, 0x5b, 0x36, 0x7e]);
    expect([...t.keyBytes("Insert")!]).toEqual([0x1b, 0x5b, 0x32, 0x7e]);
    expect([...t.keyBytes("Delete")!]).toEqual([0x1b, 0x5b, 0x33, 0x7e]);
    expect([...t.keyBytes("F1")!]).toEqual([0x1b, 0x4f, 0x50]);
    expect([...t.keyBytes("F5")!]).toEqual([0x1b, 0x5b, 0x31, 0x35, 0x7e]);
    expect([...t.keyBytes("F12")!]).toEqual([0x1b, 0x5b, 0x32, 0x34, 0x7e]);
  });

  test("Ctrl 控制码、Alt ESC 前缀", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    expect([...t.keyBytes("c", { ctl: true })!]).toEqual([0x03]);
    expect([...t.keyBytes("d", { ctl: true })!]).toEqual([0x04]);
    expect([...t.keyBytes("z", { ctl: true })!]).toEqual([0x1a]);
    expect([...t.keyBytes("a", { ctl: true, alt: true })!]).toEqual([0x1b, 0x01]);
    expect([...t.keyBytes("x", { alt: true })!]).toEqual([0x1b, 0x78]);
    expect(t.keyBytes("F13")).toBeNull();
  });

  test("粘贴：?2004 关闭原样、开启包括号标记", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    expect(new TextDecoder().decode(t.pasteBytes("hi"))).toBe("hi");
    t.feedString("\x1b[?2004h");
    expect(new TextDecoder().decode(t.pasteBytes("hi"))).toBe("\x1b[200~hi\x1b[201~");
    expect(t.pasteBytes("").byteLength).toBe(0);
  });
});

describe("宽字符与 UTF-8", () => {
  test("CJK 占 2 格，续格跳过渲染", () => {
    const t = new Terminal({ cols: 6, rows: 2 });
    t.feedString("中文");
    const line = t.lineAt(t.scrollbackCount)!;
    expect(cellText(line, 0)).toBe("中");
    expect(line.flags[0] & CELL_WIDE).toBe(CELL_WIDE);
    expect(cellText(line, 1)).toBe("\x00");
    expect(cellText(line, 2)).toBe("文");
    expect(t.cursorX).toBe(4);
  });

  test("多字节序列跨帧切断自动续接", () => {
    const t = new Terminal({ cols: 6, rows: 2 });
    const full = new TextEncoder().encode("中");
    t.feed(full.slice(0, 1));
    expect(t.lineAt(t.scrollbackCount)!.text.trim()).toBe(""); // 未完成不显示
    t.feed(full.slice(1));
    expect(cellText(t.lineAt(t.scrollbackCount)!, 0)).toBe("中");
  });

  test("宽字符在最后一列先换行", () => {
    const t = new Terminal({ cols: 4, rows: 3 });
    t.feedString("abc中");
    expect(lineText(t, 0)).toBe("abc");
    expect(lineText(t, 1)).toBe("中");
  });

  test("宽字符残半被覆盖时清理续格", () => {
    const t = new Terminal({ cols: 6, rows: 2 });
    t.feedString("中文\x1b[1;1HX");
    const line = t.lineAt(t.scrollbackCount)!;
    expect(line.flags[0] & CELL_WIDE).toBe(0);
    expect(cellText(line, 0)).toBe("X");
    expect(cellText(line, 1)).toBe(" ");
    expect(cellText(line, 2)).toBe("文"); // 后面的宽字符不受影响
  });
});

describe("杂项序列", () => {
  test("OSC 标题（BEL 与 ST 两种结束）吞掉不显示", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.feedString("\x1b]0;title\x07ok");
    expect(lineText(t, 0)).toBe("ok");
    t.feedString("\x1b]2;title\x1b\\!");
    expect(lineText(t, 0)).toBe("ok!");
  });

  test("DCS 吞到 ST", () => {
    const t = new Terminal({ cols: 10, rows: 2 });
    t.feedString("\x1bP+q544e\x1b\\X");
    expect(lineText(t, 0)).toBe("X");
  });

  test("RIS 全复位：清屏 + 属性 + 模式", () => {
    const t = new Terminal({ cols: 5, rows: 2 });
    t.feedString("\x1b[31mabc\x1b[?1h\x1b[?7l\x1bc");
    expect(lineText(t, 0)).toBe("");
    expect(t.cursorApplicationMode).toBe(false);
    t.feedString("X");
    expect(t.lineAt(t.scrollbackCount)!.fg[0]).toBe(TERM_DEFAULT_COLOR);
    expect([...t.keyBytes("Up")!]).toEqual([0x1b, 0x5b, 0x41]); // DECAWM/DECCKM 复位
  });

  test("制表位 HTS/TBC/CBT", () => {
    const t = new Terminal({ cols: 20, rows: 2 });
    t.feedString("\x1b[1;5H\x1bH"); // 光标在第 5 列设自定义制表位（index 4）
    t.feedString("\r\t\tX");
    expect(t.cursorX).toBe(9); // 0 → 4 → 8，X 写在 8
    expect(cellText(t.lineAt(t.scrollbackCount)!, 8)).toBe("X");
    t.feedString("\x1b[1;5H\x1b[g"); // 清除第 5 列制表位
    t.feedString("\r\tY");
    expect(t.cursorX).toBe(9); // 自定义位已清，直达 8
    expect(cellText(t.lineAt(t.scrollbackCount)!, 8)).toBe("Y");
    t.feedString("\x1b[1;9H\x1b[Z"); // CBT：从第 9 列回退，8 以下无位 → 0
    expect(t.cursorX).toBe(0);
  });

  test("DECSC/DECRC 保存恢复光标与属性", () => {
    const t = new Terminal({ cols: 10, rows: 3 });
    t.feedString("\x1b[2;3H\x1b[31m\x1b7");
    t.feedString("\x1b[1;1Hzz\x1b8");
    expect(t.cursorY).toBe(1);
    expect(t.cursorX).toBe(2);
    t.feedString("X"); // 恢复后的红前景落到新写入的格子
    const line = t.lineAt(t.scrollbackCount + 1)!; // 第 1 行（0 = 第 0 行）
    expect(line.fg[2]).toBe(1);
    expect(lineText(t, 1)).toBe("  X");
  });

  test("resize：增补底部空行、裁剪、光标钳位（SPEC §3.4 SIGWINCH 钩子预留）", () => {
    const t = new Terminal({ cols: 6, rows: 3 });
    t.feedString("aaa\r\nbbb\r\nccc\x1b[3;4H");
    t.resize(4, 2);
    expect(t.rows).toBe(2);
    expect(t.cols).toBe(4);
    expect(lineText(t, 0)).toBe("aaa");
    expect(t.cursorY).toBe(1);
    expect(t.cursorX).toBe(3);
    t.resize(8, 4);
    expect(t.rows).toBe(4);
    expect(lineText(t, 2)).toBe("");
  });
});
