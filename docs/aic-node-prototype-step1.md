# AIC 内存优化第 1 步：共享节点兼容接口

日期：2026-10-23（Asia/Shanghai）。状态：本地验证及本轮真机启动、120 帧短时空闲验证通过；用户确认画面正常、触摸下拉可操作。本步只优化 PocketJS 的节点表示，保持当前共享 App、JSON profile、容量、字体、堆、栈、GC 和宿主能力。以下实测可作为后续优化基线；长时、业务负载和 WiFi 组合场景尚未验收。

## 改动与对照身份

[`native-tree.ts`](../vendor/pocketjs/framework/src/native-tree.ts) 的 `decorateNativeNode()` 原先为每个节点创建 15 个 getter、4 个 setter、14 个方法，以及 style/classList 的 3 个辅助函数。本步将这些函数移出逐节点装饰路径：访问器和节点方法放在共享原型，通过 `this` 访问当前节点；style/classList 共用函数，各节点的容器、children、属性缓存仍独立。

普通元素、文本、注释、克隆节点、主根及宿主接管的根都沿用同一装饰入口。节点方法与访问器现在是继承属性；审计的框架和 Vue 调用路径通过接收者访问它们，未发现需要保留 own-property 或脱离接收者调用的路径。retain/release、sweep、焦点和事件生命周期继续沿用既有实现。

| 输入 | 值 |
|---|---|
| PocketCOM 起始提交 | `25074313eae8933d8fdd10e2b31f7cf331c6daa2` |
| PocketJS 对照提交 | `4acb1db2d016b919fc1e2312432823ab1f9e6778` |
| PocketJS 本步提交 | `d32959c4c17f4d0dc705834eb7a2b818be39f6e7` |
| luban-lite | `ef55c659f03fac3d4eaf5ce24f1543e14b2f15a7` |
| profile | 根目录 `pocket.features.json` 的 `aic-diagnostic`，取值不在本文复制 |
| 配置 SHA-256 | `4d59491303a7938a58b7fe7f51a6a4c570db9694076f81aa0700f74561a84e41` |
| profile 指纹 | `df808f8021ccf4d57f078da7b2a7b38e2642f3418e29d71a90f1a33f6f293347` |
| 对照包 SHA-256 | `d45a10203297808f7b1b64a640d03363d7f2af934d4b0d4f3ad492cad20500d6` |
| 入口与视口 | `app/main.aic.tsx → app/app.tsx`，480×272，density 1 |
| 统一堆 / JS 配额 / PocketJS 栈 | 7,340,032 / 5,242,880 / 393,216 bytes |

源码改动在 PocketJS 子模块提交中，父仓库同步 gitlink；产品功能、容量与 allocator 不在本步调整。优化前包与前次失败真机记录的包 hash 一致，旧真机结果见 [2026-10-23 复测](aic-memory-perf-2026-10-23.md)。

## 离板 A/B

前后各运行 3 个独立进程、每次 120 turns，JS 配额 5 MiB，不注入 caps 堆预算，取中位数。两组各阶段表中的读数在三次运行间一致。默认串口配置面板可见，无 `com.*` 桥，右侧为空态；没有业务收发、历史增长、终端网格或交互负载。

`caps` 包含 QuickJS、Rust UI 与分配包装；`js`、`guest` 与它存在包含关系，不能相加。单位为 bytes：

| 指标 | 优化前 | 优化后 | 减少 |
|---|---:|---:|---:|
| S3 编译历史 caps 峰值 | 4,679,280 | 4,675,598 | 3,682（0.08%） |
| S4 挂载后 caps 存活 | 6,743,150 | 5,136,291 | 1,606,859（23.83%） |
| S5 空闲 caps 存活 | 6,886,541 | 5,279,682 | 1,606,859（23.33%） |
| 全程 caps 峰值 | 7,628,094 | 6,023,152 | 1,604,942（21.04%） |
| S5 caps 存活块数 | 51,356 | 33,987 | 17,369（33.82%） |
| S5 QuickJS malloc_size | 3,676,288 | 2,903,141 | 773,147（21.03%） |
| S5 QuickJS 对象数 | 13,264 | 7,223 | 6,041（45.54%） |
| S5 QuickJS shape 数 | 322 | 484 | 增加 162 |
| 正常帧 / 错误帧 | 120 / 0 | 120 / 0 | — |
| caps 分配失败 | 0 | 0 | — |

**峰值从 7.27 降到 5.74 MiB，空闲存活从 6.57 降到 5.04 MiB。** S3 变化小、S4/S5 下降，符合减少逐节点实例分配的机制；shape 数增加，净内存仍下降。此实验没有新增节点计数或 Rust arena 细分计数，不能由对象数差值推算节点数，也不能将全部差值归为函数 payload。

探针为 64 位 malloc，不包含 RT-Thread 任务栈、WiFi/lwIP 或 TLSF 碎片，离板数字不代替真机验收。本轮真机结果见下节；现有 `caps_peak ≤ 4 MiB` 候选目标尚未达到。

## 本地验证

- `npm run typecheck`、`npm run check`、`npm run build`：通过。
- `bun test test/`：319 项通过。
- PocketJS：`bun test --conditions=browser tests/native-tree-dom.test.ts tests/vue-vapor-dom.test.ts tests/renderer.test.ts tests/pocket-input.test.ts`，69 项通过；新增 7 项覆盖共享函数/独立容器、接收者调用、移动/根节点、深浅克隆、class 访问器、文本/注释及 retain/sweep。
- PocketJS：`bun test --conditions=browser tests/vue-vapor-frame-flush.test.ts tests/action-handler-vue-vapor.test.ts`，5 项通过。
- macOS 实际宿主前后均完成 86 ticks、14 个绘制帧。相同脚本覆盖初始界面、连接下拉、设置弹窗、主题下拉、终端模式、切回收发及输入 `prototype check`。隔离设置文件并丢弃物理输入；6 组截图去掉原生标题栏后的内容区逐像素一致，设置、终端和输入截图已目视检查。这里只记录这组场景的相等结果，不建立通用 PNG 金样规则。

原始日志、对照包、截图和元数据保留在忽略目录 `.pocket/aic/node-prototype-step1/`：`before/`、`after/` 各含 `probe-1.log` 至 `probe-3.log`，另有 `probe-comparison.json`、桌面/测试/构建日志；生成物不加入源码仓库。数据以本节和版本/hash 记录为可维护摘要。

复测时先重新打包当前源码，避免使用旧包：

```sh
npm run package:aic
npm run probe:aic
# 本机保留的旧包可单独复跑；仍使用同一契约及 5 MiB JS 配额：
npm run probe:aic -- .pocket/aic/node-prototype-step1/before/pocketcom-aic.pocket
```

## 固件与用户真机复测

构建使用 `RTT_EXEC_PATH=/Users/kai/DevTools/xpack-riscv-none-elf-gcc-15.2.0-1/bin npm run build:aic`，xPack GCC 15.2.0，保留诊断，构建成功、静态预算通过；链接器输出一条 LOAD segment RWX 权限警告，原文保留在构建日志。交付快照位于忽略目录 `dist/aic/step1-node-prototype/`，包含下列文件及 `metadata.json`、`memory-report.json`；烧录由用户执行。

| 文件 | bytes | SHA-256 |
|---|---:|---|
| `d12x_os.itb` | 2,957,312 | `2daef737ebf6671f7159ec2bafa3cc2c5f8d33bee787293a53fdb4542ac325ab` |
| `pocketcom-aic.pocket` | 791,224 | `32719cab70bbd05c562dd2774ff2f4bb75dc6ce6abb7341cf39d7c28869a4694` |
| `d12x_demo68-nor_v1.0.0.img` | 3,493,376 | `f3d115cec1f03a6a7af715a9e6f9f18e4b6ed9e35aed99faeca245b550a2a61f` |

OS 分区 3,145,728 bytes，ITB 余量 188,416 bytes；CMA 扣静态与双 framebuffer 后余额 243,780 bytes，SW 堆和 guest 配额保持不变。包比对照增加 256 bytes，运行内存下降来自实例表示而非包体缩小。交付快照包额外复跑一次 120 turns，核对其阶段读数与三次优化后 A/B 读数一致，原始日志为 `after/probe-handoff.log`。`.img` 是容器，烧录沿用现有脚本的 ITB/分区流程。

在仓库根目录使用既有烧录脚本（将 `-p` 后的端口替换为实际设备）：

```sh
npm run flash:aic -- -p /dev/cu.usbserial-XXX -b 3000000 --verify --reset
```

该脚本读取 SDK images 中的 `d12x_os.itb`；本次构建后已核对它与交付快照 hash 相同。若之后执行其他固件构建，先重新核对 hash，避免误烧另一份产物。

1. 使用本步镜像烧录，保留完整启动日志，并说明冷上电或复位方式；首轮保持原有 WiFi 操作状态，便于对照。
2. 观察 S3、S4、S5-frame1 和 S5-frame120；如果失败，保留异常栈与全部 `heap-fail` 行。
3. 若进入首帧，空闲约 30 秒后执行 `pjs_mem`；界面可操作时，打开/关闭下拉和配置后再采一次，记录实际操作。
4. 回传后补记 `sys_max`、`caps_peak/live/blocks/fails`、QuickJS、最大空闲块、碎片、栈高水位与帧指标，再决定下一步。后续产品验收的冷启动次数、长流及 WiFi 状态矩阵仍沿用共享 UI 方案，不把这次启动复测当作全部验收。

## 用户真机结果

用户提供启动片段、完整串口记录，并确认“显示正常，触摸下拉可操作”。**本轮通过挂载、首帧和 120 帧，采样中的 `caps_fails` 均为 0，120 帧为 `frames=120/0`。** 这是第 1 步的启动与短时空闲验证结果，优化前 S4 OOM 记录作为历史对照保留。

### 日志归档与解释边界

两份附件逐字节保存到忽略目录 `.pocket/aic/node-prototype-step1/after/`，不覆盖优化前日志；解析结果为同目录 `board-summary.json`，交付元数据也已补充这次结果。

| 原始记录 | bytes | SHA-256 |
|---|---:|---|
| `board-boot-partial.txt` | 6,433 | `6b7be3968357bcdaf9597921332600e58a4a493ce39ed3a82bc6c74772482682` |
| `board-boot-full.txt` | 8,237 | `afb2d1ced866cb068152297c0e10adff059114f3bfd7df1004e1c62ba7d73985` |

- 下表采用完整记录中 `AIBURNID` 后的新启动段；文件开头的 30 FPS、150 个 touch_reports 和触摸坐标属于启动标记前的片段，不与新启动段合并，也不据此诊断重启原因。两份记录不计作两次独立冷启动验证。
- 日志标记 `Warm-Reset / External-PIN-Reset`。设备未打印固件 hash，镜像身份按用户烧录本步交付产物的上下文关联，不能独立从串口核验；旧 `Built on Oct 11` banner 不作为镜像身份依据。
- 原始文本含粘贴折行，分析视图连接 CR/LF 以还原被折断的标签和数字，原始文件保持不变。`S0-task.walk_maxfree` 中插入 `aic />` 提示符，标记为不可用，不猜测补值。
- 新启动段的 touch_reports 均为 0，基本交互通过依据用户后续直接反馈；未取得交互时的内存采样。WiFi/SDIO 初始化与启动交错，未提供 wifi_on、AP 连接、断开或流量矩阵，不定义为已测 WiFi 关闭基线。
- 文件末尾 `[系统] closed by user` 记录串口会话关闭，本段未出现 guest/渲染失败或退出错误；没有 30 秒后的手动 `pjs_mem`，不推断长期稳定性。

### 分阶段内存

单位为 bytes；Δt 取相邻表行的 `t` 差，首行无对照。`sys`、`caps`、`guest` 存在包含关系，各自峰值不能相加。

| 阶段 | Δt ms | sys used / max | caps live / peak | js malloc_size | guest live / peak |
|---|---:|---:|---:|---:|---:|
| S2-uibind | — | 1,104,576 / 1,111,640 | 680,057 / 686,743 | 78,308 | 106,244 / 106,244 |
| S3-compile | 5,317 | 3,206,112 / 4,689,788 | 2,753,970 / 4,245,016 | 1,684,325 | 1,967,477 / 3,359,043 |
| S4-mount | 3,811 | 4,987,280 / 5,810,936 | 4,528,125 / 5,345,447 | 2,424,911 | 3,246,719 / 3,986,609 |
| S5-renderer | 163 | 4,987,624 / 5,810,936 | 4,528,469 / 5,345,447 | 2,424,911 | 3,246,719 / 3,986,609 |
| S5-frame1 | 262 | 5,246,160 / 5,810,936 | 4,797,620 / 5,345,447 | 2,425,983 | 3,248,343 / 3,986,609 |
| S5-frame120 | 2,250 | 4,830,772 / 5,810,936 | 4,387,571 / 5,345,447 | 2,166,582 | 2,905,254 / 3,986,609 |

| 指标 | S4-mount | S5-frame1 | S5-frame120 |
|---|---:|---:|---:|
| walk_free | 2,187,836 | 1,928,924 | 2,355,948 |
| walk_maxfree | 1,188,320 | 1,057,608 | 1,057,608 |
| walk_frags | 5,825 | 5,676 | 6,244 |
| caps_blocks | 34,552 | 34,715 | 31,229 |
| QuickJS 对象数 | 7,396 | 7,404 | 6,858 |
| shape 数 | 481 | 484 | 469 |
| reallocs / shrinks（累计） | 108,435 / 7,879 | 108,479 / 7,883 | 108,717 / 7,883 |
| stack_pjs used / size | 130,580 / 393,216 | 130,580 / 393,216 | 130,580 / 393,216 |
| 正常 / 错误帧 | 0 / 0 | 1 / 0 | 120 / 0 |
| caps_fails | 0 | 0 | 0 |

各阶段 CMA 均为 538,912 / 766,020 bytes；该采样区域余额为 227,108 bytes，不与 SW 堆合并。S5-frame120 系统堆占用 **4.61 MiB**，caps 存活 **4.18 MiB**，最大空闲块 **1.01 MiB**。观测到的系统历史峰值 **5.54 MiB**、caps 历史峰值 **5.10 MiB**；`总堆 − sys_max = 1,529,096 bytes` 是记账差额，不保证任意时刻可分配这一大小的连续块。

### 短时性能与前后比较

新启动段第一条统计为 48 FPS、`turn_max=76 ms`；之后 6 条统计 FPS 为 59、45、59、56、59、56，均为 `damage=0`、`turn_max=11 ms`，系统堆保持 4,830,772 bytes、JS 保持 2,166,582 bytes、系统历史峰值未再增加。这支持短时空闲未持续增长，不能宣称恒定 60 FPS 或覆盖交互性能；`turn_max` 只计 guest turn，不等于包含绘制/等待的整帧耗时。

优化前记录在 S4 失败，本轮成功到 S5：系统历史峰值从 6,839,160 到 5,810,936 bytes，观测差额 1,028,224 bytes（约 0.98 MiB）；caps 峰值从 6,367,796 到 5,345,447 bytes，观测差额 1,022,349 bytes。**旧值是失败截断峰值，不能把这些差额当成同等完整工作负载的节省量**；单项优化的受控差值仍以此前离板 A/B 为依据。S3 系统峰值只减少 3,664 bytes，与主要收益来自挂载阶段的机制一致。

本步保留为新的启动基线。后续优化继续固定 profile 和容量，一次改一项、验证并记录后交用户烧录；`caps_peak ≤ 4 MiB` 候选目标、长期运行、IO 突发及 WiFi 组合场景仍需后续验证。本轮只归档日志和更新文档，未再次构建、烧录或运行源码测试。
