// app/i18n.ts — 运行时语言包（SPEC §3.6）。
// JSON 直接打进 bundle；t() 在 JSX 表达式里被 Vue Vapor 依赖追踪，
// 切换 locale 立即全量重渲染。缺 key 回退 en，再回退 key 本身。
import { ref } from "vue";
import zhCN from "../assets/i18n/zh-CN.json";
import en from "../assets/i18n/en.json";

export type Locale = "zh-CN" | "en";

const packs: Record<Locale, Record<string, unknown>> = { "zh-CN": zhCN, en };

/** 当前语言（运行时切换，SPEC §3.6）。 */
export const locale = ref<Locale>("zh-CN");

type JsonObject = Record<string, unknown>;

function lookup(pack: JsonObject, key: string): string | undefined {
  // 先按扁平 key 全字匹配，再点分逐层下钻（SPEC §3.6 两种形态都支持）
  const flat = pack[key];
  if (typeof flat === "string") return flat;
  let node: unknown = pack;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as JsonObject)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** 取文案：当前语言 → en → key 本身。 */
export function t(key: string): string {
  return lookup(packs[locale.value], key) ?? lookup(packs.en, key) ?? key;
}

/** 切换语言。 */
export function setLocale(next: Locale): void {
  locale.value = next;
}
