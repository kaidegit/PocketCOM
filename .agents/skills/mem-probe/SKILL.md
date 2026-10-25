---
name: mem-probe
description: PocketCOM 离板内存探针——无 AIC 板时粗测应用包的内存占用与峰值（S2–S5 分阶段 [PJS-PROBE] 采样）、--heap 固定 TLSF 池粗找断点、与板端 [PJS-DIAG] 真机数据对比、共享 UI/裁剪迭代的前后对比。当需要运行 npm run probe:aic、分析某个 .pocket 包吃多少内存/峰值在哪、评估裁剪效果时使用。
---

# PocketCOM 离板内存探针（mem-probe）

## 定位：量什么、不量什么

把与固件**同一套可移植组件**（guest / ui_core / ui_qjs / package / render_rgb565 + 同一 QuickJS）编成
原生二进制：`heap_caps` 走固定连续内存区 + SDK 同源 TLSF（与 port 同款 3 槽包装头、先分配后释放的 realloc + live/peak 记账），加载路径走与固件
相同的 `pocketjs_guest_eval_stages` 拆分。回答"这个包大概吃多少内存、峰值在哪个阶段、裁剪有没有效"。

默认一次性分配 **7,340,032 bytes**，`--heap N` 直接指定池总大小（含 TLSF 元数据），不扩池、不回退 malloc。
复用 `vendor/luban-lite/bsp/artinchip/drv_bare/tlsf_heap/tlsf.c`，与板端 `rt_tlsf_heap.c` 相同。
真实产生碎片，记录 `sys/sys_max`（TLSF 分配块大小）、`walk_free/walk_maxfree/walk_frags`；失败环保存失败瞬间的请求、空闲总量与最大连续块。
包文件缓冲在池外，模拟固件内联包 XIP；C/Rust guest 分配进入同一池。

**不模拟**：系统侧占用（任务栈 384 KiB / WiFi / lwIP 线程）、XIP 取指代价、渲染器 target。
原生 64 位指针和 TLSF 元数据、块布局不同于 RV32，不能将相同字节预算的成败当作真机成败。
此前 malloc 探针的约 +10% caps/+15% JS 偏差仅为历史基线，不是 TLSF 碎片/断点换算系数。

## 前置

```sh
npm run package:aic    # 探针读 dist/aic/pocketcom-aic.pocket 与 fork generated 契约头
```

另需 cc、cargo，以及已初始化的 `vendor/luban-lite`（直接编译其中 TLSF，不修改 SDK）。对象缓存在 `.pocket/aic/probe-host/`（按 mtime 增量），首次构建 ~1 分钟，重复运行只重链。
改了应用代码**必须先重跑 package:aic**，否则测的是旧包。

## 命令

```sh
npm run probe:aic                     # 测 dist/aic 当前包，S2→S3→S4→S5 全阶段采样
npm run probe:aic -- --heap 7340032   # 固定 7 MiB 连续 TLSF 池（也是默认值）
npm run probe:aic -- --heap 3m --turns 600
npm run probe:aic -- path/to/other.pocket --limit 4m   # 测其它包 / 改 QuickJS 配额
```

`--heap`/`--limit` 支持正整数纯字节或 `512k`/`3m` 后缀；零、负值、溢出和多余后缀拒绝。`--turns` 默认 120。
`bun test test/host/rtthread/probe-heap.test.ts` 以 ASan/UBSan 验证碎片拒绝、合并复用、对齐、溢出及 realloc 失败保留原内容。

交互/存活集实验（每类参数最多 512 条）：

```sh
npm run probe:aic -- --turns 240 --tap 60,16@5 --sample 60 --tap 238,22@65 --collect 120
```

`--tap X,Y@TURN` 在指定 turn 按下、下一 turn 释放，坐标限当前契约视口，tap 必须早于末帧；
`--sample TURN` 输出 S6-turnN，`--collect TURN` 显式 guest GC 后输出 S7-gcN，二者不超过末帧。
显式 GC 仅观察存活集，不模拟板端空闲 GC 时序，不改变固件。反复创建子树还须做不额外 GC 的快速操作测试。
框架输入记录环保留 36,000 帧，触摸页按需分配；交互后增长不能直接认作泄漏，要设空白触摸对照并跨回卷检查。
第 2 步的快速开关与 48,000 turns 方法、原始参数位置见 [连接配置记录](../../../docs/aic-narrow-panel-step2.md)。
交互实验必须逐轮验证实际状态/命中，不能把 `--tap` 已发送或 `frames=N/0` 当作点击成功。
2026-10-24 发现旧包的 Vue Vapor Portal host 关闭后截获 bounds 触摸；旧循环数据只代表首轮
打开/关闭后的重复触摸负载，修复后的实际开关结果另记于上述文档。

## 产品 feature 对比（共享 App 离板实验）

```sh
npm run probe:features                      # terminal A/B
npm run probe:features -- --feature mcp.server # MCP A/B，固定 terminal=false
npm run probe:features -- --feature transport  # 传输 A/B，其它功能固定
npm run probe:features -- --feature ui         # UI A/B，其它功能固定
```

统一配置在根目录 `pocket.features.json`；目录中的裁剪状态和 profile 值以此文件为准，`planned` 仅登记，不能配置或用于编译条件。
脚本先顺序生成正常诊断包/契约，再用同一 `app/main.feature-probe.tsx`、AIC plan、480×272、
MiSans/JetBrains Mono 和容量构建 `terminal-on` / `terminal-off`，每组独立进程运行三次、每次 120 turns。
默认 JS 配额 5 MiB，A/B 两组显式使用固定 16 MiB TLSF 池以完整测得峰值；报告保存 allocator/arenaBytes。关闭组必须排除解析器和视图模块；
入口包含模型存在性/关闭后模式不可切入的运行断言。

结果在 `dist/feature-heap/report.json`，各 profile 子目录保留包、feature receipt、构建日志及三份探针日志。
`report.json` 按阶段记录中位数、差值和原始三次读数；记录包/配置 hash、版本及工作区 patch。
当前无 `com.*` 桥，测的是共享 App 的面板 + 桥不可用空态；终端开启组创建模型并保持 RX 订阅，
但终端网格未挂载，无 IO 或历史增长。只比较这个边界，不能当成完整收发/终端或真机结果。
正式 AIC 入口不变，不构建/烧录固件。首轮结果见 `docs/terminal-feature-heap.md`。

MCP 对比使用同样边界及三次 120 turns，产物在 `dist/mcp-feature-heap/`，结果见
`docs/mcp-feature-heap.md`。每组检查 `core/mcp.ts` 的模块收据；关闭组运行断言验证不创建
MCP 响应式状态，启停调用为空操作。MCP 开启组表示编译包含服务功能，运行时默认开关仍关闭；
无 com 桥，不测原生 server、客户端连接或流量缓冲占用。

传输对比使用 `transport-all` / `transport-serial`，具体开关取值以 JSON 为准，其它功能取值相同；
产物在 `dist/transport-feature-heap/`，结果见 `docs/transport-feature-heap.md`。每组检查所有传输
适配器的模块收据，QuickJS 入口断言关闭的协议不分配参数状态、不能进入连接选择器。
同样独立进程三次 120 turns，默认串口面板可见、无 com 桥、无收发负载。关闭协议的配置
保留，共享会话状态机与原生 macOS 协议实现保留；测的是 guest 裁剪收益，不含原生 IO 内存。

## 读数

阶段与板端 `[PJS-DIAG]` 一一对应：

| 阶段 | 边界 |
|---|---|
| S2-uibind | PAK 挂载后（字体 atlas 等资源基线） |
| S3-compile | `JS_EVAL_FLAG_COMPILE_ONLY` 返回后（编译峰值所在，realloc 瞬时双份） |
| S4-mount | 执行 + frame 获取后（组件树/响应式对象常驻） |
| S5-frame1 / S5-steady | 首帧 / 最后一次 turn |

字段（每阶段五行）：`sys=used/total sys_max` 为 TLSF 分配块大小口径（同板端 rt_memory_info，不包含全部分配器元数据），
`walk_free/walk_maxfree/walk_frags` 为总空闲/最大连续块/空闲块数。
`caps_live/caps_peak/caps_blocks/caps_fails`（QuickJS + Rust UI + 包装头，即
板上"guest+Rust"口径）、`js=malloc_size/limit` 与 `atoms/str/obj/shape`、`guest_live/guest_peak` 与
`rloc=reallocs/shrinks`、`frames=正常/错误`。

**对比要点**：用同一池大小与输入序列比较前后包；指针宽度会改变碎片分布，不能保证差值等于板端差值。历史基线参考
docs/aic-memory-optimization.md §2.1.3（精简页）与 §2.1.4（完整 UI 断点）的真机表。

## 断点粗猎

`--heap` 从大往小二分。失败时退出码非零，stderr 打失败调用；stdout 输出 `failed` 采样及最近 8 次
`heap-fail`。失败环中的 `walk_free/walk_maxfree` 才是分配失败瞬间的状态，不能拿异常展开后的采样代替。
相同总空闲量仍可能因碎片分配失败。原 malloc 的“caps_peak + ~0.45 MiB”只可回看历史，不能估算 TLSF 连续块断点。
板端系统线程/WiFi 不在离板池内，测试时可显式缩小 `--heap` 留预算，但这不生成真实系统分配序列。
板上验收门槛见内存优化方案 §11.2；本次实现/前后包结果见 [发送框及 TLSF 记录](../../../docs/aic-probe-tlsf-2026-10-25.md)。


## 典型工作流（共享 UI / 编译期裁剪迭代）

当前逐步优化按用户约定每次完成一项、本地验证并记录，再交用户烧录、等待板端日志后决定下一项；[第 1 步节点共享原型](../../../docs/aic-node-prototype-step1.md)已取得前后三次 120 turns 对照，并通过用户真机启动/120 帧零错误、零分配失败及基本交互确认；这不替代长时/业务流量/WiFi 组合场景验收。保留旧包与 hash；原始运行日志/截图放忽略目录，源码文档记录版本、边界、数据摘要与待验收项，不把离板成功写成真机通过。

1. 改 `app/` / `core/`（裁剪、装配、容量限额）。
2. `npm run package:aic && npm run probe:aic -- --heap <目标预算>`。
3. 记录 S3/S4 的 caps_peak 变化，对照 §2.1.3/§2.1.4 基线判断该步收益。
4. 阶段性上板验收：`build:aic` + `flash:aic`（skill `aic-build`）采 `[PJS-DIAG]`，重复性与稳态以板为准。

## 坑

- 失败行走 stderr、采样走 stdout，管道重定向时顺序会交错——分开存文件或直接看终端。
- stderr 的 CHECK 行里 `#call` 是完整调用表达式；内存快照和失败环在 stdout，保存两路输出。
- 探针的 turn 为空输入、无 vsync：稳态数字与板上（GC 空闲节律不同）略有差异，正常。

## UI 裁剪对比

`--feature ui` 使用 `ui-on` / `ui-off`，开关只查 `pocket.features.json`；结果在
`dist/ui-feature-heap/report.json`，测量说明见 `docs/ui-feature-heap.md`。固定相同 terminal/MCP/
传输配置及空闲共享 App 边界，每组独立进程三次、每次 120 turns。收据核对选区几何、语言切换和
软键盘模块的移除；QuickJS 入口断言关闭后的语言/主题/字号固定值和系统主题状态不分配。
本实验没有聚焦输入域、展开软键盘、打开设置、收发历史或终端网格；反映编译代码、资源及空闲状态
的差值，交互时分配的额外状态不在此读数内。正式 AIC 入口与真机验收边界保持原约定。
