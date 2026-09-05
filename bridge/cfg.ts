// bridge/cfg.ts — `com.*` 设置持久化桥的类型与封装（SPEC §3.7/§3.8，M2）。
// cfgRead/cfgWrite 读写宿主侧 config.json（原子写 + 0600）；cfgExport/cfgImport
// 走原生文件面板（导出由宿主剥离 mcp.token），返回宿主结果 JSON 原文，
// 解析归 app 层（app/session.ts parseCfgResult）。
import type { ComNs } from "./com";

/** cfg ops 形状；未实现 cfg 桥的宿主上各方法返回 null。 */
export interface CfgOps {
  /** 配置文件全文（不存在返回 null）。 */
  cfgRead(): string | null;
  /** 原子写配置文件（0600）；返回是否成功。 */
  cfgWrite(json: string): boolean | null;
  /** 导出配置（原生保存面板；宿主剥离 mcp.token）。返回宿主结果 JSON 原文。 */
  cfgExport(json: string): string | null;
  /** 导入配置（原生打开面板）。返回宿主结果 JSON 原文。 */
  cfgImport(): string | null;
}

/** 组装 cfg ops；宿主缺 cfgRead/cfgWrite 时返回 null。 */
export function createCfgOps(ns: ComNs): CfgOps | null {
  const hasCfg = typeof ns.cfgRead === "function" && typeof ns.cfgWrite === "function";
  if (!hasCfg) return null;
  return {
    cfgRead() {
      try {
        return ns.cfgRead!();
      } catch {
        return null;
      }
    },
    cfgWrite(json) {
      try {
        return ns.cfgWrite!(json);
      } catch {
        return false;
      }
    },
    cfgExport(json) {
      if (typeof ns.cfgExport !== "function") return null;
      try {
        return ns.cfgExport(json);
      } catch {
        return null;
      }
    },
    cfgImport() {
      if (typeof ns.cfgImport !== "function") return null;
      try {
        return ns.cfgImport();
      } catch {
        return null;
      }
    },
  };
}
