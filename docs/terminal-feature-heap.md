# terminal feature heap 对比

日期：2026-10-22。状态：统一 feature 配置与 terminal 裁剪已实现；本记录为离板实验，不是板端验收。

关闭 terminal 后，空闲稳态 caps 分配减少约 **0.713 MiB（9.14%）**，全程 caps 峰值减少约
**0.745 MiB（8.69%）**；QuickJS 稳态 `malloc_size` 减少约 **0.418 MiB（9.89%）**。
每组独立进程测量三次，各阶段读数完全一致；所有分配失败和帧错误计数均为 0。

## 实验边界

- 同一 `app/main.feature-probe.tsx` 挂载共享 `App`，480×272，使用同一个 AIC host plan，宿主 capability、字体、字号和容量相同。
- 唯一产品功能差异是 `pocket.features.json` 中 `terminal-on` / `terminal-off` 的 terminal 值。该文件同时声明模块和文案归属。
- 启用组在收发模式创建终端模型、RX 订阅及应答/版本泵；关闭组不创建模型，拒绝切入终端模式，并移除模式控件、回滚设置及终端事件路由。
- 无 `com.*` 桥，右侧显示桥不可用空态；左配置面板正常挂载。**终端网格没有挂载，也没有收发流量或回滚历史增长**。这些结果反映终端功能的编译/初始化及面板成本，不是打开终端网格的全部增量。
- 真实 QuickJS + Rust UI + PAK 组件，原生 64 位 malloc shim；JS 配额 5 MiB、caps 不限预算、120 个空输入 turns。caps 含 QuickJS、Rust UI、资源和分配包装头；`malloc_size` 只统计 QuickJS。
- 不模拟 RV32/TLSF 碎片、RT-Thread 任务栈及 WiFi/lwIP。峰值为累计历史峰值，不是每阶段独立清零的峰值；S5 稳态是最后一次空输入 turn，没有额外强制 GC。

## 数据

下表单位为 bytes，括号补充 MiB；结果为三次独立运行的中位数。

| 指标 | terminal 开 | terminal 关 | 节省 |
|---|---:|---:|---:|
| S3 编译历史峰值（caps） | 5,585,742 | 5,205,017 | 380,725（0.363 MiB，6.82%） |
| S4 挂载后存活（caps） | 8,037,450 | 7,290,556 | 746,894（0.712 MiB，9.29%） |
| S5 空闲稳态（caps） | 8,182,819 | 7,434,805 | 748,014（0.713 MiB，9.14%） |
| 全程峰值（caps） | 8,993,048 | 8,211,702 | 781,346（0.745 MiB，8.69%） |
| S5 QuickJS malloc_size | 4,431,191 | 3,993,093 | 438,098（0.418 MiB，9.89%） |

关闭后的总稳态约 7.090 MiB，峰值约 7.831 MiB。仅这一步仍不能证明完整共享 UI 可以在 AIC 上运行；
还需要后续功能/节点优化、真实设备桥接后的测量，以及 WiFi 开启后的板端验收。正式 AIC 入口仍是诊断页。

## 裁剪证据

- terminal-off 的 pass 1 模块图不包含 `core/term.ts`、`app/terminal.tsx`，剔除清单明确列出两者；开启组包含它们。
- 颜色编码移入共享 `core/term-color.ts`，接收区 ANSI 颜色与主题无需依赖终端解析器；原终端模块仍保留兼容导出。
- 字典与额外烘焙字符按同一文案归属清单过滤；不单独删语言或字体档位。
- 预转换测试验证禁用 JSX 不生成终端模板/样式/字形，开启关闭交替构建的缓存不会串用；功能专属 import 若仍有活引用或顶层副作用，构建失败，并保留被剔除模块的其他依赖初始化。
- 两个实验入口在运行期分别断言模型已创建/未创建，以及关闭后不能切入终端模式。

紧凑 JS：328,554 → 297,867 bytes；PAK：612,912 → 587,216 bytes。

## 复现与产物

```sh
npm run probe:features
```

脚本先生成正常诊断包/契约，再顺序构建和测量两个隔离实验包；不修改正式入口、不构建或烧录固件。
`dist/feature-heap/report.json` 保存配置/包 hash、主仓库及 PocketJS 版本、工作区 patch、变更源码快照/hash、
全部原始读数和逐阶段差值。各 profile 子目录保存 JS/PAK/.pocket、feature receipt、构建日志与三份探针日志。

配置的当前受支持组合：`desktop`（终端开）、`aic-diagnostic`（终端关，诊断入口不变）、
`terminal-on` / `terminal-off`（同一共享 App 的离板实验）。其余功能目录与裁剪接入状态以 `pocket.features.json` 为准；`planned` 项仅登记，尚不能配置。

验证：290 项单测、TypeScript 检查、桌面完整构建、AIC 诊断包构建、5 项真实宿主 MCP e2e
（含切入终端停服/切回收发恢复）及通过 `tools/dev.mjs` 启动的界面截图检查。

编译器通用机制在 PocketJS fork 的 `framework/compiler/app-features.ts`，使用说明见
`vendor/pocketjs/docs/APP-FEATURES.md`。
