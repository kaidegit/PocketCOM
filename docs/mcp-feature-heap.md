# MCP server 编译期裁剪与离板内存对比

测量日期：2026-10-22。`mcp.server` 已接入统一 feature registry；平台取值以
`pocket.features.json` 为准（desktop 包含服务功能，aic-diagnostic 裁掉）。运行时默认开关仍为关闭。

裁剪覆盖 `core/mcp.ts` 命令执行器，以及共享 App 的 MCP 状态、watcher、配置装配、
启停与每帧中继、面板几何/控件、状态栏和专属文案。MCP 关闭时保留配置 schema 和
原 MCP 配置字段，忽略宿主 MCP 状态事件，不调用 MCP HostOps。共享 bridge 契约兼容保留，
macOS 原生 server 不作 Cargo feature 拆分。正式 AIC 仍使用诊断入口。

## 测量方法

```sh
npm run probe:features -- --feature mcp.server
```

- 同一共享 App、AIC plan、480×272、MiSans/JetBrains Mono、相同容量。
- `mcp-on` / `mcp-off` 均关闭 terminal，仅 `mcp.server` 不同；脚本检查无其他变量变化。
- 每组独立进程运行三次，每次 120 turns；下表为逐阶段中位数。
- QuickJS 配额 5 MiB，caps 不注入限额；全部运行分配失败数及错误帧数为零。
- 无 `com.*` 桥，处于面板与桥不可用空态；开启组包含 MCP 功能，但没有运行 server。
- 64 位 malloc 离板探针，未包含 RT-Thread、WiFi/lwIP、TLSF 碎片、原生 server/客户端缓冲。

## 结果

单位为 bytes；caps 包含 QuickJS、Rust UI 及分配包装头。caps_peak 是截至该阶段的累计峰值。

| 阶段 / 指标 | MCP on | MCP off | 减少 | 降幅 |
|---|---:|---:|---:|---:|
| 资源基线 caps live | 783,981 | 774,121 | 9,860 | 1.26% |
| 编译 caps peak | 5,217,254 | 5,059,872 | 157,382 | 3.02% |
| 挂载 caps live | 7,331,383 | 7,067,373 | 264,010 | 3.60% |
| 稳态 caps live | 7,475,664 | 7,210,796 | 264,868 | 3.54% |
| 累计 caps peak | 8,252,839 | 7,975,252 | 277,587 | 3.36% |
| 稳态 QuickJS malloc | 4,012,180 | 3,860,163 | 152,017 | 3.79% |

| 产物 | MCP on | MCP off | 减少 |
|---|---:|---:|---:|
| 压缩 JS | 298,157 | 285,136 | 13,021 |
| PAK | 593,152 | 583,232 | 9,920 |

关闭 MCP 节省稳态约 **258.7 KiB**，累计峰值约 **271.1 KiB**。
关闭后稳态约 6.88 MiB、累计峰值约 7.61 MiB，仍不能据此将完整 App 切入板端；
需要继续优化，并以 WiFi 启用后的真机堆测量验收。

原始三次读数、包/配置 hash、模块收据、版本、源码快照及日志保存在
`dist/mcp-feature-heap/report.json` 和相邻 profile 目录（构建产物不提交）。
`core/mcp.ts` 在关闭组模块收据中被剔除；探针入口断言 MCP refs 没有创建。

## 验证

- `npm run typecheck`、`npm run build` 和诊断包生成通过。
- `bun test test/`：294 pass，0 fail。
- `bun test host/macos/mcp/`：7 pass，0 fail，使用现有 release 宿主和本次 guest 构建。
- 覆盖桌面鉴权、工具调用、回环、终端门控与大流量，以及关闭组加载 enabled=true 配置、
  收到宿主 on=true 事件仍不调用 MCP HostOps，导出时保留原配置。
