// 板端字形守卫（SPEC §5.4）：AIC 烘焙 atlas 无系统回退，烘焙集 = 源码字面量 +
// i18n 文案的字符，但只有 MiSans 自身 cmap 映射的字形才烘得出来。凡渲染面
// （MiSans 槽）用到的非 ASCII 字符缺映射，板端即豆腐——桌面 CoreText 系统回退
// 会掩盖（曾发现在 Select 下拉箭头 ▾ 与发送历史换行符 ⏎ 上，2026-10-24）。
// 本测试与烘焙器 pass-1 AST 扫描同口径扫 app 源码字面量，另扫全部 i18n 语言包，
// 断言每个非 ASCII 字符都被 MiSans Regular/Bold 两个烘焙面映射。
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";
import opentype from "opentype.js";

const ROOT = join(import.meta.dir, "..", "..");

interface Hit {
  ch: string;
  where: string;
}

/** 非代理区间的非 ASCII 标量值（ASCII 32–126 恒烘焙；控制字符不渲染）。 */
function visibleScalars(text: string): string[] {
  return [...text].filter(ch => {
    const cp = ch.codePointAt(0)!;
    return cp >= 0x80 && !(cp >= 0xd800 && cp <= 0xdfff);
  });
}

function walkAst(node: unknown, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n.type !== "string") return;
  visit(n);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "start" || key === "end" || key.startsWith("has") ||
        key === "leadingComments" || key === "trailingComments" || key === "innerComments") continue;
    const value = n[key];
    if (Array.isArray(value)) for (const child of value) walkAst(child, visit);
    else walkAst(value, visit);
  }
}

/** 源码字符串/模板字面量与 JSX 文本中的可见字符（带 file:line）。 */
function collectSourceChars(file: string): Hit[] {
  const code = readFileSync(file, "utf8");
  const isTsx = file.endsWith(".tsx");
  const ast = parse(code, {
    sourceType: "module",
    plugins: isTsx ? ["typescript", "jsx"] : ["typescript"],
  });
  const hits: Hit[] = [];
  const label = file.slice(ROOT.length + 1);
  walkAst(ast, node => {
    let text: string | undefined;
    if (node.type === "StringLiteral") text = node.value as string;
    else if (node.type === "TemplateElement") {
      const cooked = (node.value as { cooked?: string | null }).cooked;
      text = typeof cooked === "string" ? cooked : undefined;
    } else if (node.type === "JSXText") text = node.value as string;
    if (!text) return;
    const line = (node.loc as { start: { line: number } }).start.line;
    for (const ch of visibleScalars(text)) hits.push({ ch, where: `${label}:${line}` });
  });
  return hits;
}

/** i18n 语言包全部字符串值中的可见字符。 */
function collectI18nChars(): Hit[] {
  const dir = join(ROOT, "assets/i18n");
  const hits: Hit[] = [];
  const collect = (value: unknown, label: string): void => {
    if (typeof value === "string") {
      for (const ch of visibleScalars(value)) hits.push({ ch, where: label });
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) collect(child, label);
    }
  };
  for (const name of readdirSync(dir).filter(f => f.endsWith(".json"))) {
    collect(JSON.parse(readFileSync(join(dir, name), "utf8")), `assets/i18n/${name}`);
  }
  return hits;
}

function faceMapped(face: opentype.Font, ch: string): boolean {
  return face.charToGlyphIndex(ch) > 0;
}

test("UI 渲染面字符全部被 MiSans Regular/Bold 映射（app 字面量 + i18n，SPEC §5.4）", () => {
  const regular = opentype.parse(
    readFileSync(join(ROOT, "assets/fonts/MiSans-Regular.ttf")).buffer.slice(0) as ArrayBuffer,
  );
  const bold = opentype.parse(
    readFileSync(join(ROOT, "assets/fonts/MiSans-Bold.ttf")).buffer.slice(0) as ArrayBuffer,
  );

  const files = readdirSync(join(ROOT, "app"), { recursive: true }) as string[];
  const hits = [
    ...files.filter(f => /\.(ts|tsx)$/.test(f)).flatMap(f => collectSourceChars(join(ROOT, "app", f))),
    ...collectI18nChars(),
  ];
  expect(hits.length).toBeGreaterThan(0);

  const missing = new Map<string, string[]>();
  for (const { ch, where } of hits) {
    const misses = [regular, bold].filter(face => !faceMapped(face, ch)).length;
    if (misses === 0) continue;
    const label = `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} '${ch}'`;
    const list = missing.get(label) ?? [];
    list.push(misses === 2 ? where : `${where}（仅单面缺）`);
    missing.set(label, list);
  }

  const report = [...missing.entries()]
    .map(([label, wheres]) => `${label}: ${wheres.slice(0, 5).join(", ")}`)
    .join("\n");
  expect(report).toBe("");
});
