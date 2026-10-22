---
name: mem-probe
description: PocketCOM 离板内存探针——无 AIC 板时粗测应用包的内存占用与峰值（S2–S5 分阶段 [PJS-PROBE] 采样）、--heap 注入堆预算粗找断点、与板端 [PJS-DIAG] 真机数据对比、共享 UI/裁剪迭代的前后对比。当需要运行 npm run probe:aic、分析某个 .pocket 包吃多少内存/峰值在哪、评估裁剪效果时使用。
---

# PocketCOM 离板内存探针（mem-probe）

## 定位：量什么、不量什么

把与固件**同一套可移植组件**（guest / ui_core / ui_qjs / package / render_rgb565 + 同一 QuickJS）编成
原生二进制：`heap_caps` 走 malloc shim（与 port 同款 3 槽包装头 + live/peak 记账），加载路径走与固件
相同的 `pocketjs_guest_eval_stages` 拆分。回答"这个包大概吃多少内存、峰值在哪个阶段、裁剪有没有效"。

**不模拟**：碎片（malloc 无 TLSF）、系统侧占用（任务栈 384 KiB / WiFi / lwIP 线程）、XIP 取指代价、
渲染器 target（固件 S5 渲染器有小额已知差值）。64 位指针使数字系统性偏大：caps 峰值约 +10%、
js 约 +15%、guest_peak 约 +2%、**realloc 次数几乎零偏差**。粗测工具，板端 `[PJS-DIAG]` 才是验收。

## 前置

```sh
npm run package:aic    # 探针读 dist/aic/pocketcom-aic.pocket 与 fork generated 契约头
```

另需 cc、cargo。对象缓存在 `.pocket/aic/probe-host/`（按 mtime 增量），首次构建 ~1 分钟，重复运行只重链。
改了应用代码**必须先重跑 package:aic**，否则测的是旧包。

## 命令

```sh
npm run probe:aic                     # 测 dist/aic 当前包，S2→S3→S4→S5 全阶段采样
npm run probe:aic -- --heap 7340032   # 注入统一堆预算（超限分配失败并计数）
npm run probe:aic -- --heap 3m --turns 600
npm run probe:aic -- path/to/other.pocket --limit 4m   # 测其它包 / 改 QuickJS 配额
```

`--heap`/`--limit` 支持纯字节或 `512k`/`3m` 后缀；`--turns` 默认 120。

## 产品 feature 对比（共享 App 离板实验）

```sh
npm run probe:features                      # terminal A/B
npm run probe:features -- --feature mcp.server # MCP A/B，固定 terminal=false
npm run probe:features -- --feature transport  # 传输 A/B，其它功能固定
```

统一配置在根目录 `pocket.features.json`；目录中的裁剪状态和 profile 值以此文件为准，`planned` 仅登记，不能配置或用于编译条件。
脚本先顺序生成正常诊断包/契约，再用同一 `app/main.feature-probe.tsx`、AIC plan、480×272、
MiSans/JetBrains Mono 和容量构建 `terminal-on` / `terminal-off`，每组独立进程运行三次、每次 120 turns。
默认 JS 配额 5 MiB，caps 不注入预算，以完整测得峰值。关闭组必须排除解析器和视图模块；
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

字段（每阶段两三行）：`caps_live/caps_peak/caps_blocks/caps_fails`（QuickJS + Rust UI + 包装头，即
板上"guest+Rust"口径）、`js=malloc_size/limit` 与 `atoms/str/obj/shape`、`guest_live/guest_peak` 与
`rloc=reallocs/shrinks`、`frames=正常/错误`。

**对比要点**：绝对值偏大是系统性的，**比变化量更可靠**——裁剪前后的探针差值 ≈ 板上差值。基线参考
docs/aic-memory-optimization.md §2.1.3（精简页）与 §2.1.4（完整 UI 断点）的真机表。

## 断点粗猎

`--heap` 从大往小二分。失败时退出码非零，stderr 打 `probe: … failed (caps_live=… caps_peak=…
caps_fails=…)`，stdout 最后一个成功 sample 定位失败阶段。板上统一堆 7,340,032 中系统侧约占
0.45 MiB（栈 + 杂项），探针不含——折算经验式：**板上 sys_max ≈ 探针 caps_peak + ~0.45 MiB**。
板上验收门槛（caps 峰值 ≤4 MiB 目标等）见内存优化方案 §11.2。

## 典型工作流（共享 UI / 编译期裁剪迭代）

1. 改 `app/` / `core/`（裁剪、装配、容量限额）。
2. `npm run package:aic && npm run probe:aic -- --heap <目标预算>`。
3. 记录 S3/S4 的 caps_peak 变化，对照 §2.1.3/§2.1.4 基线判断该步收益。
4. 阶段性上板验收：`build:aic` + `flash:aic`（skill `aic-build`）采 `[PJS-DIAG]`，重复性与稳态以板为准。

## 坑

- 失败行走 stderr、采样走 stdout，管道重定向时顺序会交错——分开存文件或直接看终端。
- stderr 的 CHECK 行里 `#call` 是完整调用表达式，看括号里的 caps 计数即可。
- 探针的 turn 为空输入、无 vsync：稳态数字与板上（GC 空闲节律不同）略有差异，正常。
