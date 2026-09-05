// app/locale.ts — 语言切换的统一入口：改 locale + 重排日志前缀文案。
import { localeChangeHooks, applyLogFormat } from "./session";
import { setLocale, type Locale } from "./i18n";

/** 运行时切换语言（SPEC §3.6）：i18n 响应式重渲染 + 日志行前缀重取。 */
export function applyLocale(next: Locale): void {
  setLocale(next);
  applyLogFormat();
  for (const hook of localeChangeHooks) hook();
}
