# PocketCOM on AIC + RT-Thread

本期接入 D12x demo68-nor：PocketCOM 应用包、固件构建与静态内存预算。固件 **XIP 运行**（`.text/.rodata` 在 SPI NOR 的 0x60000000 窗口原地执行，仅 `.data/.bss` 进 PSRAM），PSRAM 为 **统一 TLSF 系统堆**（不再划分 PocketJS 私有池）。2026-10-23 起切换为 480×272 共享完整 UI，按 JSON profile 裁剪，用于新一轮真机内存 perf（优化前 S4 挂载 OOM，节点共享原型优化后已通过首帧/120 帧零错误和基本交互）；`com.*` 设备桥自 2026-10-24 起实现串口部分（仅 uart1，无网络/MCP 桥或持久化，见下文"com 串口桥"）。精简页保留为历史基线。构建不自动烧录；实测基线见 [D12x 8 MiB PSRAM 内存优化方案](../../docs/aic-memory-optimization.md)，后续应用恢复方向见[共享 UI 与编译期裁剪提案](../../docs/shared-ui-memory-optimization.md)（terminal / mcp.server / transport.* / ui.* 裁剪与离板 A/B 已实施，节点共享原型已完成本地与本轮真机启动/120 帧及基本交互验证，第 2 步连接配置延后创建已完成真机启动/120 帧内存验证，完整交互采样待补；高级窄屏工具栏和容量方案仍待推进）。

## 阅读导航与当前结论

- **当前优化步骤**：[第 2 步：连接配置延后创建](../../docs/aic-narrow-panel-step2.md)，本地/固件完成，真机启动/120 帧内存验证通过。真机首次打开前系统峰值 4.54 MiB、frame120 系统占用 3.37 MiB；首次触摸后的系统峰值 5.08 MiB，完整反复开关 caps/最大空闲块采样待补。3091 ms 首次交互卡顿经用户确认并安排后续处理；尚未归因于 GPU。默认不创建、首次打开后复用。2026-10-24 修复关闭后无法再打开：Vue Vapor Portal host 须设置 `hitPass: 1`，否则透明容器拦截触摸；本地逐轮命中回归通过，固件已重建，真机待复验。此前循环测试未验证实际开关，证据边界与修复后数据见第 2 步记录。第 1 步真机 120 帧及基本交互结果继续作为已验收基线。
- **优化前真机基线**：[2026-10-23 共享 UI 内存复测](../../docs/aic-memory-perf-2026-10-23.md)。S3 编译通过，S4 底层分配失败 8 次，系统历史峰值 6,839,160 / 7,340,032 bytes；无首帧与稳态数据。
- **构建与采集操作**：本文的构建、产物和 P0 诊断章节，以及 [aic-build skill](../../.agents/skills/aic-build/SKILL.md)。
- **历史证据与方案评估**：[内存优化方案](../../docs/aic-memory-optimization.md)；**后续共享实现路线**：[共享 UI 方案](../../docs/shared-ui-memory-optimization.md)。
- 下文带日期的旧包大小、内存布局和精简页结果保留为历史记录；不代表当前构建。功能启停始终以根目录 JSON 为准。

## 分层

```text
PocketCOM app/main.aic.tsx → app/app.tsx（共享 UI，JSON feature 裁剪）
  → host/rtthread（产品 manifest/profile + 构建编排）
  → vendor/pocketjs/hosts/aic（QuickJS、触摸、帧循环、RGB565、GE 2D 加速、MPP 显示）
  → vendor/luban-lite（RT-Thread、板级驱动、链接、bootloader、镜像）
```

产品功能由根目录 `pocket.features.json` 统一管理；AIC 构建显式选 `aic-diagnostic`。
`npm run probe:features` 用共享 App 做 terminal 开/关离板对比，输出 `dist/feature-heap/report.json`，
MCP 对比用 `npm run probe:features -- --feature mcp.server`，输出 `dist/mcp-feature-heap/report.json`。
传输对比用 `npm run probe:features -- --feature transport`，输出 `dist/transport-feature-heap/report.json`，见[传输测量记录](../../docs/transport-feature-heap.md)。
详见 [terminal 测量记录](../../docs/terminal-feature-heap.md)、[MCP 测量记录](../../docs/mcp-feature-heap.md) 与 skill `mem-probe`；实验不改变正式入口。

`app/main.aic.tsx` 在 mount 前初始化 480×272 应用视口并挂载共享 `app/app.tsx`/session，启停值只读取 JSON 的 `aic-diagnostic`；桌面入口独立。host profile 固定 density 1（native presentation 合约要求 logical×density == 物理面板 480×272，1:1 面板锁死 density=1；更高密度需引擎级超采样呈现，尚未实现）、native presentation、60Hz，仅声明真实宿主能力。UI 保持 MiSans，mono 用 fork 的 JetBrains Mono（与产品 vendor 字体相同）；从两份语言包的字符串值提取额外字形，不烘焙整个 CJK 字符域。未烘焙输入仍可能显示替换符，HEX 视图保证字节表达。

SDK 复用 `application/rt-thread/pocketjs`，产品不复制引擎/QuickJS/显示/触摸源码。`POCKETJS_ROOT` 由脚本指向当前 fork。未来 `com.*` 属于本目录的产品桥；通用 guest 扩展接口属于 PocketJS，板级驱动属于 SDK。设备事件入 FIFO，在 tick 边界 drain；core 仍保持纯 TS。

### LCD 字边噪声与 RGB 时钟

demo68-nor 的 SDK 同板参考方案使用 **90° pixel clock 输出相位**。产品 defconfig 曾设为
0°，2026-10-24 根据静止画面仍有字边彩点/跳动的反馈，恢复 `CONFIG_AIC_DEGREE_90=y`；
生成的 `rtconfig.h` 应为 `AIC_RGB_CLK_CTL 1`。此相位控制 LCD 采样时序，不改变字体图集、
480×272 framebuffer 或 density。原生 RGB565 离板回放的空闲双缓冲一致，只能证明所测软件
路径未产生漂移；修正相位后，用户真机确认字体发虚/静态字边跳动“确实好了”。该反馈
仅覆盖本次显示问题。证据、固件与复验方法见
[字体显示排查](../../docs/aic-font-rendering-2026-10-24.md)。

### UART 引脚（2026-10-24 核对）

- **SDK d12x 引脚枚举头文件有错，以官方数据手册为准**：
  `bsp/artinchip/sys/d12x/include/aic_gpio_id.h` 把 PA.2/PA.3 func5 标成 `UART0_RTS/UART0_CTS`、
  PB.10/PB.11 func5 标成 `UART6_TX/UART6_RX`（d21x 家族表带入；D12x 只有 UART0–3，无 UART6）。
  官方 D12x 数据手册表 5-3/5-5/5-6（aicdoc.artinchip.com）实为 **PA.2/PA.3 func5 = UART1_TX/RX、
  PB.10/PB.11 func5 = UART3_TX/RX、PA.4/PA.5 func5 = UART2_TX/RX**。这些枚举名无代码引用
  （板级 pinmux 一律写裸 func 值），不影响运行，但按头文件名判断引脚会得出错误结论
  （2026-10-24 曾因此误判 uart1 不可用，被用户以 bootloader 日志实证纠正）。
- **uart1 已随当前固件可用**：产品 defconfig `AIC_USING_UART1=y` + demo68-nor pinmux "uart1" 块
  （PA.2=TX pull_dis、PA.3=RX pull_up）与手册一致。设备 `/dev/uart1`：115200 8N1、INT_RX、
  2048 环形缓冲、无流控、无 DMA。bootloader console 即 UART1（`AIC_BOOTLOADER_CONSOLE_UART=1`，
  日志出在 PA.2/PA.3），是该组引脚工作的实证；aic-isp 烧录协议固定跑 UART0
  （`aicupg uart 0`，PA.0/PA.1），RT-Thread console 也是 UART0。
- **uart3@PB.10/PB.11 与 WiFi 互斥**：该组脚 func2 = SDC0_D1/D2，RTL8189FTV 4-bit SDIO 需要
  PB.6–PB.11 全部六根，开 UART3 必须放弃 WiFi，二选一。手册中 UART3 另有 PC.4(TX)/PC.5(RX)
  func5 落点，本板 PC 口空闲（SDMC1 未启用），能否使用取决于载板走线。
- **勿给 UART0 开 Kconfig 流控**：`Kconfig.dev` 默认 RTS=PA.3/CTS=PA.2 在 D12x 上实为
  UART1_TX/RX，启用会把 uart1 复用抢走（真实 UART0_RTS 在 PB.5 func5）。

### com 串口桥（2026-10-24）

宿主在 guest 创建后、bundle 求值前经 PocketJS 的通用扩展点
`pocketjs_guest_quickjs_install_once` 挂载 `globalThis.com`（`hosts/aic/port/pocketjs_com.c`，
fork 侧）。op 语义与桌面 `host/macos` 对齐：

- **能力面**：仅串口，仅 `uart1`（设备名固定，`serialList` 只列它）。`write`/`close`/`poll`
  为契约必需三件套；`netOpen`/`cfg*`/`mcp*` 不实现，共享 App 按既有路径降级（cfg 缺失 →
  DEFAULT_CONFIG 且不回写）。`aic-diagnostic` profile 本就只开 `transport.serial`。
- **poll 驱动**：RX 不回调 JS。驱动 INT_RX 环形缓冲（2048 字节，驱动自管）暂存，JS 每 tick
  `com.poll()` 拉取，C 侧把当次读到的字节合成一条 `{t:"data",h,b64}` 事件（base64）。
  60Hz tick 下建议线速 ≤921600，更高的波特率可能在两次 poll 之间撑爆设备环。
- **open**：标准 `RT_SERIAL_GET_CONFIG` → 改 baud/dataBits/parity/stopBits →
  `RT_DEVICE_CTRL_CONFIG` → `RT_DEVICE_OFLAG_RDWR|RT_DEVICE_FLAG_INT_RX` 打开。保留
  驱动自有字段（bufsz/uart_index/uart_freq/function）。`mark`/`space` 校验、`"1.5"` 停止位
  与桌面同样拒绝；`flowControl` 仅接受 `"none"`（板端未接流控引脚），`setSignals` 接受为
  no-op 并返回 true。
- **编译开关**：`POCKETJS_COM=0` 编译关闭（同 `POCKETJS_GE` 模式）；关闭后 guest 无
  `com` 全局，UI 回到"com 桥接不可用"占位。
- **真机验收待补**：烧录后连接 uart1 的收发、波特率切换、与 console（uart0）共存互不干扰
  均需用户确认；此前任何板端内存数据都不覆盖本桥的运行态。

2026-10-26 用户反馈 UART1 TX/RX 短接发送 `aaa` 后两端计数立即各为 3 B，接收文字延后显示。
当前产品未启用 RTC，`gettimeofday()` 返回失败且 QuickJS 未检查返回值，`Date.now()` 不可靠；
共享 App 会话泵已改用 `virtualNow() × 1000` 驱动静默超时/重连，消息日历时间戳来源保留。冻结/回拨时钟的真实
Vue Vapor/core 回归通过，修复后真机延迟待复验，见 [排查记录](../../docs/aic-uart-receive-delay-2026-10-26.md)。

## 初始化与更新

```sh
# 桌面只需运行时（公开 GitHub）
git submodule update --init --depth 1 vendor/pocketjs
npm ci
(cd vendor/pocketjs && bun install --frozen-lockfile)

# 板端还需要局域网 SDK，在能访问 192.168.0.20 的环境执行
git submodule update --init --depth 1 vendor/luban-lite

# 浅克隆默认可能只 fetch 默认分支，先让 remote 能获取目标分支
# 此配置只影响后续显式更新，不在构建时联网
git -C vendor/pocketjs config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C vendor/luban-lite config --replace-all remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'

# 显式更新 .gitmodules 指定的 feat/aic / feat/pocketjs 分支
# 普通初始化按父仓库 gitlink 检出版本，build 不自动更新
git submodule update --remote vendor/pocketjs vendor/luban-lite
```

父仓库 gitlink 始终记录实际提交，这是 Git submodule 机制，不是额外 SHA 锁定策略。更新后重新安装依赖并执行板端/桌面回归。根 framework 使用本地 fork；Vue/Vapor 版本与 fork 一致。先安装根依赖，再安装 vendor 依赖：npm 会 hoist/remove 本地链接包内的依赖，而编译器需要 vendor 内的 runtime bundles。`.npmrc` 使用 legacy peer resolution，因为 Vapor 的 `^3` peer 范围排除 fork 固定使用的 Vue RC。

## 命令

```sh
npm run check:aic
npm run package:aic

# SDK 默认读取 toolchain/bin，也支持显式路径；使用 upstream GCC 工具链
RTT_EXEC_PATH=/path/to/riscv-none-elf/bin npm run build:aic

# 可选 SDK 与 SCons 并行参数（不传则 -j8）
RTT_EXEC_PATH=/path/to/riscv-none-elf/bin npm run build:aic -- --sdk /path/to/sdk -- -j4 -Q

# 烧录已构建镜像：板子先进下载模式（按住下载键 PA1 上电）。
# 默认只下载 app（d12x_os.itb -> os 分区）；--all 先烧 bootloader（bootloader.aic -> spl 分区）。
# 其余参数原样透传给 SDK 的 tools/aic-isp（端口、-b 波特率、--verify、--reset 等）；
# 烧写偏移由 pack image_cfg.json 的分区表推导；上传工具优先用其 bin/ 预编译产物，
# 缺失时首次自动 cargo 构建
npm run flash:aic -- -p /dev/cu.usbserial-XXX -b 3000000 --verify --reset
npm run flash:aic -- --all -p /dev/cu.usbserial-XXX
```

`--verify` 走新增的 `GET_MEDIA_CRC` 协议命令（aicupg 0x1C）：设备对 flash 分区内容计算 CRC32
并与镜像比对，一条命令完成，2 MiB 镜像校验秒级。**它要求 bootloader 里编入该命令**；
当前 tracked `bootloader.aic` 同时编入 `GET_MEDIA_CRC` 与 `XIP Boot`（2026-10-10 重编）。
对更旧的 bootloader 请用 `--verify=readback`（全量读回逐字节比对，慢但通用）。

前置：Bun、npm、Python 3、SCons、cargo/rustup，以及 fork 的 `hosts/aic/rust/rust-toolchain.toml` 指定的 nightly + rust-src。工具链需要 upstream `riscv-none-elf-gcc`；脚本遵循 SDK 的 `RTT_EXEC_PATH`，不下载或安装工具链。SDK 的 Python 依赖由其环境提供，SCons/Python 缺失模块会直接报错退出。

构建流程：

1. fork CLI 校验产品 manifest/profile 与应用类型。
2. fork resolver 生成 plan，编译器生成 JS/PAK，`makeVariant`/包编码 API 生成 `.pocket`，再执行包验证。
3. 生成契约头和完整二进制 C 数组到 fork 已忽略的 `hosts/aic/generated`。
4. SDK 已跟踪的 bootloader.bin 已含 XIP Boot 与 GET_MEDIA_CRC（重编流程见下节）；构建时应用 bootloader defconfig 并调用 SDK `calc_linked_addr.py` 生成忽略的 `.image_cfg.json.tmp` 地址元数据，再切回产品 defconfig。
5. SCons 编译运行时和产品固件，输出 ELF/map/ITB/IMG，生成并检查内存预算。

`--sdk` 将在指定 checkout 产生 SDK 正常构建文件/配置，但不修改其已跟踪源码。SCons 参数用于构建选项，不支持切配置、清理、dry-run 或目标覆盖。共用一份 fork 的 `generated`，因此不同应用/SDK 构建不可同时运行；切换回 demo 时需重新生成 demo 包。

## 产物与内存

- `dist/aic/pocketcom-aic.pocket`：应用包。
- `.pocket/aic/`：plan、JS、PAK 和中间文件。
- `dist/aic/memory-report.json`：本次固件 ELF/map 的包大小、XIP/PSRAM 段拆分与地址、CMA/SW 区域/heap 边界、framebuffer、guest 配额与统一堆预算、OS 分区占用，字段单位均为 bytes。
- `vendor/luban-lite/output/d12x_demo68-nor_rt-thread_pocketjs/images/`：SDK 固件产物，包括 `d12x_demo68-nor_v1.0.0.img`。

内存布局（XIP，2026-10-10 起）：

```text
SPI NOR 16 MiB   spl 512k | env 128k | env_r 128k | userid 256k | os 3072k | os_r 3072k |（尾部空闲）
os 分区          d12x_os.itb：FIT 头 0x800 + XIP 段（.text/.rodata，含内联包）+ RAM 段（.data）
XIP 窗口         0x60000000 + 0x100800（os 偏移 0x100000 + 0x800）原地执行
PSRAM 8 MiB      PSRAM_CMA 1 MiB（.data/.bss + 双 RGB565 framebuffer 的 CMA 堆）
                 PSRAM_SW 7 MiB（统一 TLSF 系统堆：QuickJS/Rust guest + 系统线程共用）
```

`.text/.rodata` 与内联包不再占用 PSRAM；bootloader 的 `xip_boot` 按 FIT 段地址跳过 XIP 段、
仅把 `.data` 拷入 PSRAM，`.bss` 由启动代码清零。RT-Thread 系统堆算法为 TLSF
（SDK `RT_USING_USERHEAP` + `bsp/artinchip/drv/mem/rt_tlsf_heap.c`），宿主 `heap_caps_*`
直接走 `rt_malloc/rt_free`（保留 3 槽对齐包装头），没有私有池。

报告从 ELF 读取 allocated section 并按 0x60000000 窗口拆分 XIP/PSRAM，从 map 读取实际边界，
并校验 ITS XIP 段地址等于 `0x60000000 + CONFIG_AIC_XIP_FW_OFFSET`、FW_OFFSET 等于 os 分区
偏移 + 0x800 ITB 头。CMA 余额扣两个 RGB565 framebuffer（480×272×2×2 = 522240 bytes）；
SW 统一堆预算扣 guest JS 配额（fork SConscript 的 `CONFIG_POCKETJS_GUEST_HEAP_LIMIT`，
当前 5 MiB）与系统预留（384 KiB 任务栈 + 256 KiB 内核/驱动）。两者都是理论余额，不含其他
分配、对齐、驱动和碎片开销，不构成运行稳定性证明。OS 预算按 ITB 对比实际分区大小。
任一预算不足时，报告仍保存，但命令非零退出；不自动扩大分区或调高配额。

## P0 内存分阶段诊断（2026-10-12）

固件默认编入分阶段内存诊断（[内存优化方案](../../docs/aic-memory-optimization.md) §3 的 P0 工具）。环境变量 `POCKETJS_DIAG=0` 构建时整体关闭：fork `hosts/aic/SConscript` 据此省去 `-DPOCKETJS_AIC_DIAG -DCONFIG_POCKETJS_GUEST_ALLOC_STATS`，阶段采样与 `pjs_mem` 命令编译为空，宿主改走与拆分路径语义一致的原 eval 行为；`heap_caps` 计数与失败环形记录始终保留（每笔分配两次加法）。

启动时在各阶段边界打印一组 `[PJS-DIAG]` 行，阶段名同时是分配失败记录的标签：

| 阶段 | 边界 |
|---|---|
| S0-boot / S0-task | 统一堆统计打印后 / pocketjs 任务入口（384 KiB 栈已分配） |
| S1-display / S1-touch | 显示契约校验通过后 / 触摸打开后 |
| S2-package / S2-guest / S2-uibind | 包解析并选定变体后 / guest 创建后 / PAK 挂载后 |
| S3-compile / S4-mount | `JS_EVAL_FLAG_COMPILE_ONLY` 返回后 / `JS_EvalFunction` + frame 获取后 |
| S5-renderer / S5-frame1 / S5-frame120 | 渲染器与双 target 创建后 / 首帧 / 第 120 帧 |

字段速查（同一阶段名多行）：

- `sys=used/total sys_max`：TLSF 系统堆（`rt_memory_info`）；`walk_free/walk_maxfree/walk_frags`：空闲块遍历（SDK `rt_tlsf_heap.c` 新增 `rt_memory_walk`，锁内 `tlsf_walk_pool`，只在采样点调用）。`maxfree` 是物理块大小，实际可分配的最大请求略小于它。
- `caps_live/caps_peak/caps_blocks/caps_fails`：本 port `heap_caps` 全量记账（QuickJS + Rust UI + 3 槽包装头 + 对齐余量），即"guest+Rust"口径。
- `cma=used/total cma_max`：`heap_cma` memheap（framebuffer 所在区）；`stack_pjs=used/size`：宿主任务栈 '#' 填充高水位。
- `js=malloc_size/limit`、`atoms/str/obj/shape/func_code/frames`：`JS_ComputeMemoryUsage`；`guest_live/guest_peak`、`rloc=reallocs/shrinks`：QuickJS 分配器侧记账与 copy-realloc 统计（方案 C 第一步的数据）。
- `[PJS-DIAG] heap-fail #N charged=… align=… stage=…`：最近 8 条 `rt_malloc` NULL 记录（固定缓冲，失败路径不分配）；eval 失败时随 `pocketjs_diag_dump()` 打印。QuickJS 配额拒绝（`JS_SetMemoryLimit`）不经过该路径——ring 为空而 `js=` 逼近 limit 即可区分"配额拒绝 vs 底层分配失败"。

运行期（S6，含 WiFi 状态维度）用 msh 命令按需采样：

```console
pjs_mem              # 排队一个采样，下一 tick 在 guest 任务上打印（标签 manual）
pjs_mem wifi_on      # 带标签采样；建议 wlan wifi_on / 连 AP / 断开 / 流量前后各一次
pjs_mem reset        # 记账峰值回落到当前 live，用于增量测量
```

`pjs_mem` 只排队请求，采样由帧循环在自己的任务边界执行——`JS_ComputeMemoryUsage` 和栈扫描不能与运行中的帧并发。host 加载链始终走 `pocketjs_guest_eval_stages`（编译一次、执行一次，回调为空时行为等同原 `pocketjs_guest_eval`），避免"诊断路径 ≠ 生产路径"。

### P0 诊断真机首采（2026-10-12）

精简页（WiFi 构建、未 `wifi_on`）首次全阶段采样：S3 编译为启动峰值——sys_max 3,369,880 / caps_peak 2,930,837 / guest_peak 2,335,161，编译 2,749 ms、realloc 109→63,085 次、瞬时双份开销 ≈ 985 KiB；S4 后稳态 sys 2.46 MiB / js 0.95 MiB，120 帧零错误，fps 60–62，`caps_fails=0`。

同日完整 UI 断点实测（入口临时挂完整 App，当时测毕恢复）：编译通过（5,065 ms，caps_peak 5,029,764 bytes），挂载执行段底层分配失败——sys_max 6,876,604、异常后有数千个空闲碎片、`caps_fails=6` 全是小请求、异常后 js 2,946,998 bytes / 5 MiB。异常后快照不能还原失败瞬间，早期缺口估算不能用于当前版本验收。完整数据表与结论见 [内存优化方案 §2.1.3/§2.1.4](../../docs/aic-memory-optimization.md)。两个采集坑：

- **`t=` 只看相邻差值**：暖复位（External-PIN-Reset）后 `rt_tick` 计数不归零，绝对值带重启前会话的偏移（本例 ~70 min）；帧节奏差值与 60fps 一致，可信。
- **banner "Built on" 日期在增量构建下可能过期**（scons 不重生成版本文件）；判断固件新旧以 `[PJS-DIAG]` 输出为准。

### 离板内存探针（无 AIC 快测）

`npm run probe:aic` 把与固件同一套可移植组件（guest / ui_core / ui_qjs / package / render_rgb565 + 同一 QuickJS）编成原生二进制，`heap_caps` 走一次性固定连续内存区 + SDK 同源 TLSF（与 port 同款 3 槽包装头、realloc 先分配后释放 + live/peak/块数记账），加载路径走与固件相同的 `pocketjs_guest_eval_stages` 拆分。输出 `[PJS-PROBE]` 行，字段名与 `[PJS-DIAG]` 一致，可与 §2.1.3/§2.1.4 真机数据并排对比；共享 UI / 裁剪提案的每一步都可以先在这里量再上板。

2026-10-25 AIC 宿主增加帧边界压力 GC：首帧前回收一次；caps 自上次回收后增长 128 KiB
触发回收，系统余量 ≤1 MiB 时门槛降为 32 KiB，低余量持续重绘最多等 2 秒。
旧 2 秒空闲回收保留，回收后重测基线，判断只读 O(1) 计数；`S5-gc` 与累计 `gc/gc_max` 记录
内存和停顿。探针 `--aic-gc` 复用同源策略，`--aic-gc-idle` 对照旧版，均与 `--collect` 互斥；
按虚拟契约时钟/raster revision 近似空闲，不能模拟真机停顿。固定池触摸压力入口为
`python3 tools/aic-memory-stress.py --busy --gc compare --tag busy-7m`（`--rapid` 测快速操作）。
busy 只给调度器持续非空闲输入，不制造真实 IO/damage。7 MiB 三组长测/快速组通过，
当时抽屉+设置组合仍失败；历史固件见 [压力 GC 记录](../../docs/aic-gc-pressure-2026-10-25.md)。

2026-10-26 后续通过普通 View/Text 编译器路径降低组件/属性代理开销，同作用域批量更新，
并复用首次创建的设置弹窗，每次打开重新快照配置。固定 7 MiB 同策略旧包复现失败，新包
首次组合 20/20、正常/无空闲/快速三组各 50 轮 420/420、零分配失败；五张 RGB565 对照
零像素差异。入口 `--scenario combined --combined-cycles 50 --gc policy`，可加 `--busy`/`--rapid`。
当前固件在 `dist/aic/combined-oom-fix/`，真机内存/GC 停顿/UART/WiFi 尚待验收，见
[组合修复记录](../../docs/aic-combined-oom-2026-10-26.md)。

```sh
npm run probe:aic                    # 测 dist/aic 当前包
npm run probe:aic -- --heap 7340032  # 固定 7 MiB TLSF 池（默认值），含真实碎片
npm run probe:aic -- --heap 3m --turns 600
npm run probe:aic -- --turns 240 --tap 60,16@5 --sample 60 --tap 238,22@65 --collect 120
```

`--tap X,Y@TURN` 在该帧按下、下一帧释放，`--sample TURN` 输出 S6 附加采样，`--collect TURN` 显式 guest GC 后输出 S7；每类最多 512 条，tap 必须早于末帧，采样/GC 不超过末帧。显式 GC 仅供离板存活集实验，不模拟板端空闲 GC，也不改固件。默认无这些参数时保持原有空闲探针行为。

前置：`npm run package:aic`（探针读 `.pocket` 包与生成的契约头）、cc、cargo、已初始化的 `vendor/luban-lite`。直接编译板端同一份 `drv_bare/tlsf_heap/tlsf.c`，默认 7,340,032 bytes 固定池；`--heap` 调整池大小，禁止零值/扩池/malloc 回退。包缓冲模拟 XIP 在池外，其余 guest/Rust 分配走同一池。对象缓存在 `.pocket/aic/probe-host/`，追踪包装头/契约头和编译参数变化。新增 `sys/sys_max`、`walk_free/walk_maxfree/walk_frags` 及失败瞬间的固定 8 条失败环；caps/js/guest/rloc 含义保留。64 位指针与 TLSF 块布局不同于 RV32，且不含系统线程/WiFi 分配和 XIP 时延，仍不能替代板端验收。历史 malloc 数据不与新池的碎片断点直接换算。`probe:features` 显式用两组相同的固定 16 MiB 池，报告保存 allocator/arenaBytes。测试、发送框复测和产物见 [2026-10-25 记录](../../docs/aic-probe-tlsf-2026-10-25.md)。

## GE 2D 加速（feat/aic-gpu 分支，2026-10-24）

fork `hosts/aic/port/pocketjs_ge.c` 把 RGB565 渲染器的 accelerator 表接到
mpp_ge，工作在 GE normal 模式（产品 `RT_USING_PM=y`，Kconfig 排除 cmdq）：

- **加速范围**：不透明矩形填充→一次 GE fillrect（常量色展开为 fill 路径固定的
  ARGB8888 源，565 通道低位复制保证 ARGB→RGB565 截断往返精确）；1:1 PSM 5650
  纹理搬运→一次 GE bitblt，源格式声明 `MPP_FMT_BGR_565`，由格式转换完成 PSM
  5650 与 framebuffer RGB565 的 R/B 交换，mirror 映射 `MPP_FLIP_H/V`。
  A8 掩码混合（字形/alpha 四边形）经 CPU 转 ARGB8888 后走 GE，范围与验证边界见下文。
- **同步与 cache**：normal 模式 ioctl 阻塞到 finish IRQ；每次 DMA 前 clean 目的
  行、后 invalidate，按行维护避免窄矩形冲掉同行相邻 CPU 写，维持 PpaOps
  "返回即对后续 CPU 可见"契约（同帧内 CPU 软件回退与 GE 交替写同一 strip）。
- **回退**：旋转、缩放、越界几何与任何 GE 错误返回 false，渲染器按 DrawList
  顺序软件重放；填充/搬运是整矩形写，失败后重放幂等。
- **配置与内存不变**：GE 驱动与 mpp_ge 本就在固件内（`AIC_USING_GE` 默认 y，
  mpp SConscript 在 `AIC_GE_DRV` 下编入 ge/*.c；defconfig 的 `AIC_GE_CMDQ`
  因 `RT_USING_PM` 无效），无 defconfig、分区、配额改动；GE open 在
  S5-renderer 采样前，分配入统一堆。
- **构建开关与观测**：`POCKETJS_GE=0` 编译关闭（`-DPOCKETJS_AIC_GE_DISABLE`），
  accelerator 表保持 NULL，等价 pre-GE 固件，用于 A/B 与真机异常兜底；每秒
  fps 行新增 `ge_fill/ge_blend/ge_srm` 计数，启动打印 GE 就绪或禁用原因。
- **验证状态**：host 侧 stub 回归（`vendor/pocketjs` `tests/aic-port.test.ts`，
  覆盖参数映射、clean→GE→invalidate 顺序、回退与禁用变体）与固件编译通过；
  2026-10-24 真机烧录验证通过——GE 就绪行、画面颜色（含 BGR_565 源交换）、
  持续出帧与触摸交互正常；`POCKETJS_GE=0` A/B 的 fps/turn_max 数字与长时
  稳定性、WiFi 组合尚未采样。

### A8 遮罩混合补齐（2026-10-26）

字形和透明四边形的 A8 覆盖率在 CPU 上与全局 alpha 合并（`(mask * alpha + 127) / 255`），
生成 straight ARGB8888，GE `GE_PD_NONE` 做源 alpha / 逆源 alpha 混合到私有 RGB565 面，
成功后逐行写回目标。SDK `alpha_en` 注释与驱动相反，按 `hal_ge_normal.c` 设置为 1。
不直接在原 framebuffer 混合，因此 GE 部分写入后失败也可由 CPU 重放，避免重复叠加。

暂存区按 SDK `ge_test/public/ge_mem.c` 从 MEM_CMA 首次使用分配、后续复用，按 padding 后
8192 像素 = 49152 B + 63 B 对齐空间；源/输出 stride 均为 8 B 的倍数，首地址各自
64 B 对齐，clean → bitblt/emit/sync → invalidate（失败也 invalidate 私有输出）后才读取结果。
初版真机黑屏，日志停在 S5-gc；已修正初版漏掉的行 stride 对齐并按示例改用 MEM_CMA，
增加首次 fill/A8 提交前后日志。修正版 `dist/aic/ge-a8-layout-fix/` 用户回传已确认
黑屏恢复、A8 rc=0、首帧/120 帧及触摸后出帧；frame120 caps_fails=0，CMA 增加
49240 B。首次触摸 turn_max=1763 ms、部分重绘样本 fps=1，性能 A/B 与长时验证仍待补。
超限、分配失败、非法几何仍走 CPU；首次分配失败后不反复申请，关闭宿主释放。
不扩堆/配额。异步 cmdq 模式拒绝挂载加速表，防止未完成就读取 DMA 输出。

端口回归覆盖遮罩/全局 alpha、局部矩形、缓存顺序、复用、分配失败与部分 DMA 失败。
测试中的混合模型不能证明硬件舍入与 CPU 逐像素一致，也不能证明更快；真机需检查
字边/透明叠层、`ge_blend`、帧耗时、系统堆峰值，并与 `POCKETJS_GE=0` 对照。
旋转、缩放及超过上限的混合仍在 CPU；本次固件与验收记录见
[GE A8 支持记录](../../docs/aic-ge-a8-2026-10-26.md)。

## 验证

```sh
bun test test/host/rtthread/
npm run typecheck
bun test test/
npm run check && npm run build
cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host
# fork 侧 GE 端口回归（stub mpp_ge，含 POCKETJS_GE=0 禁用变体）
(cd vendor/pocketjs && bun test tests/aic-port.test.ts)
```

重复 package 应得到相同 `.pocket`；构建后查看报告和 ELF/map。烧录用 `npm run flash:aic`：写入 `images/` 下 SDK 打包产物（spl 分区放 `bootloader.aic`，os 分区放 `d12x_os.itb`），烧写偏移按 pack image_cfg.json 的分区表推导；`.img` 是带 section 偏移的容器，不能作为裸文件直接写某个 flash 地址。真机检查启动错误、持续出帧、字体和 UI 渲染；当前不以完整触摸交互或串口收发作为验收。

初版本机验证（2026-10-09）：应用包 1153064 bytes，ITB 2711552 / 3145728 bytes；CMA 扣双 framebuffer 理论余额 408656 bytes，SW 扣 TLSF 理论余额 468992 bytes。重复打包 SHA-256 相同，273 项 Bun 测试、48 项 macOS 宿主测试通过，桌面脚本启动出帧成功。随后真机启动发生 OOM，详见下文。


## 启动时 bundle eval OOM（2026-10-09）

真机首次启动在 `[PocketJS] heap: 4249600-byte TLSF pool ready` 后报
`InternalError: out of memory` / `guest: bundle eval failed`，尚未进入正常帧循环。
静态/flash 预算通过不能证明 JS 编译与界面初始化能装进运行时 heap。

AIC 打包现在对 SDK 编译器输出的自包含 IIFE 再压缩标识符和空白，
保持属性名及表达式结构；二次打包使用 ESM 输出模式保留已有 IIFE，
避免多包一层闭包增加 QuickJS 编译内存。实际输出仍是无 import/export 的
自执行脚本。桌面构建保持原样，guest/TLSF、链接分区与字体集未调整。

同版本 QuickJS 的本机 64 位编译诊断使用 allocate-copy-free realloc，
原始 JS 607688 bytes 的请求字节峰值约 4935145 bytes，在 4 MiB 限制下失败；
压缩后 JS 327877 bytes 的峰值约 3984867 bytes，4 MiB 编译测试通过。
这些数字不包括 TLSF/guest 分配头和其他模块，也不能直接等同于 D12x 的
32 位运行占用。完整本机 guest 挂载和 120 tick 冒烟只在放宽诊断内存/栈限制后
通过；**这版完整界面随后真机复验仍 OOM；下述精简页已经通过启动验证**。

仅压缩完整界面的重建：应用包 873256 bytes，ITB 2430976 / 3145728 bytes，
CMA 扣双 framebuffer 理论余额 688432 bytes，SW 扣 TLSF 理论余额仍为
468992 bytes。包和静态区减少约 273 KiB，新增空间属于 CMA，不会自动扩大
SW 内的 TLSF 池。使用 `npm run flash:aic` 重新烧写 os，并检查启动日志及持续出帧；
若仍 OOM，需要继续定位编译/挂载峰值、TLSF 实际用量和最大空闲块，不能仅凭
此报告提高 JS heap 上限。


## 历史基线：精简板端入口（2026-10-09）

当时第二次真机启动仍报 bundle eval OOM，因此按产品侧裁剪启动图；此入口现保留为历史基线，当前入口见文首：
`main.aic.tsx → aic.tsx → i18n/theme`。不加载桌面 App、session、连接面板、
接收/发送区、终端模型、设置弹窗或 MCP 分发。保留完整桌面入口，后续功能逐项恢复。
验证页仅展示本地帧计数（每 60 tick 更新）和可触摸的计数按钮，不做任何 IO。
所有文案位于两份语言包的 `aic.*`，字体依旧通过 fork 的编译器烘焙。

精简版本机 guest 验证使用同版本 QuickJS 和通用 UI/RGB565 Rust 模块：
JS 限制 4194304 bytes、栈限制 262144 bytes，并把诊断分配的总存活字节限制为
4249600 bytes。挂载和 120 tick 通过，frame_errors=0；JS heap 为 1338409 bytes，
诊断分配峰值 3217055 bytes。诊断运行在 64 位本机，未包含实际 TLSF 碎片和硬件驱动，
不能替代板端验收，但已无需放宽 guest 限制才能跑完该验证页。

新 JS 196719 bytes，PAK 328064 bytes，应用包 526568 bytes，
ITB 2084864 / 3145728 bytes；CMA 扣双 framebuffer 理论余额 1035120 bytes，
SW 扣 TLSF 理论余额仍为 468992 bytes。当时烧录该精简包后，
应看到精简页，帧计数每秒递增，点击按钮触摸计数递增。


### 精简页真机验证（2026-10-09）

用户烧录后反馈页面基本正常。启动日志不再出现 bundle eval OOM 或 run finished，
持续输出 61–63 fps；touch raw/mapped 坐标一致，touch_reports 随触摸增长。
该日志片段中的 turn_max 为 4–7 ms（宿主 turn 测量范围，不代表整帧显示延迟）。

- JS heap：启动采样 1163037 bytes，随后 996688–1007882 / 4194304 bytes。
- TLSF pool：启动采样 2284370 bytes，随后 2034199–2057791 / 4249600 bytes。
- pool 历史峰值：2930837 bytes，距池容量余量 1318763 bytes（约 1.26 MiB；不代表最大连续空闲块）。

这次验证确认当时的精简入口可以启动、持续出帧并接收触摸。日志仍有
`mount fs[elm] on /sdcard failed`，此次内联包启动未因此退出；它不表示 SD 卡存储功能已可用。
后续以此作为内存基线，分批恢复紧凑收发界面和会话逻辑，每批复测启动峰值、
稳定用量和 turn_max；终端、设置弹窗、设备 IO 仍未验收。


## XIP 与统一 TLSF 堆改造（2026-10-10）

按用户决策实施平台层改造，板端布局从"bootloader 整体拷贝固件进 PSRAM 运行 +
PocketJS 私有 4150 KiB TLSF 池 + 系统 memheap 堆"切换为：

- **XIP**：`.text/.rodata`（含内联包）链接到 SPI NOR 0x60000000 窗口原地执行。
  d12x 链接脚本模板在 `AIC_XIP` 下把 REGION_RODATA 一并别名到 FLASH_XIP
  （SDK 原实现只迁 .text，rodata 仍留 PSRAM）；bootloader 新编入 `xip_boot`
  命令（保留 `nor_boot` 作控制台手动兜底），按 FIT 段地址跳过 XIP 段、
  仅把 `.data` 拷入 PSRAM。`CONFIG_AIC_XIP_FW_OFFSET=0x100800`
  （os 分区偏移 0x100000 + 0x800 ITB 头），构建报告对此做三重校验
  （.text/.rodata 地址、ITS 段 load、偏移=分区+头）。
- **统一堆**：删除 PocketJS 私有池，`heap_caps_*` 直接走 `rt_malloc/rt_free`；
  RT-Thread 系统堆算法改为 TLSF（SDK `RT_USING_USERHEAP` +
  `bsp/artinchip/drv/mem/rt_tlsf_heap.c`，复用 drv_bare 的 tlsf.c，
  提供 rt_malloc/rt_realloc/rt_calloc/rt_free/rt_malloc_align/rt_memory_info
  及 hook/sethook）。私有池当初存在的根因是 memheap best-fit 在 JS 突发
  分配下退化，系统堆本身 TLSF 后不再需要隔离。guest JS 配额 4→5 MiB。
- **分区**：删除从未使用的 `data` 分区（9216k，尾部空闲不映射）；
  QSPI0 运行期归 XIP 缓存，产品配置去掉 spinor 设备与 FAL/SFUD/userid
  运行时 flash 访问链。PSRAM_CMA 缩为 1 MiB（.data/.bss + framebuffer），
  PSRAM_SW 扩为 7 MiB 统一系统堆。
- **bootloader.bin 重编**：tracked 二进制现为 GET_MEDIA_CRC + XIP Boot 版本
  （219312 bytes）。重编流程：`scons --apply-def=d12x_demo68-nor_baremetal_bootloader_defconfig`
  后在 SDK 内 `scons`，POST 动作会把产物直接拷回 `pack/bootloader.bin`。
  首次真机 bring-up（2026-10-10）确认板载 NOR 为 **Puya PY25Q128HA**
  （启动日志 `XIP flash ID: 0x852018`），不在 SDK 原 XIP 支持表内——已在
  `bsp/artinchip/drv_bare/spinor/aic_flash_xip_def.c` 补表项
  （QIO EBh + 0x77 wrap，参数随 GD25Q128E 16 MiB 模板）。
- **WiFi（RTL8189FTV，2026-10-11）**：产品 defconfig 开启 SDK Realtek 驱动
  （`AIC_WLAN_REALTEK` + `AIC_USING_RTL8189_WLAN0`，SDIO 探测 VID `0x024c`/
  PID `0xf179`，链接闭源 `libwlan_rtl8189_e907f.a`，芯片固件内嵌于库中）。
  配置依据 SDK 文档 `doc/topics/sdk/peripheral/wifi_rtl8189.html`：Realtek
  粘合层喂的是 **third-party lwIP 包**（`LPKG_USING_LWIP`，v2.1.3，
  `os/wlan_lwip/ethernetif_wlan.c` 适配，netif 名 `WL0`），**不是** RT-Thread
  wlan 框架/内核 lwIP（`RT_USING_WIFI`/`RT_USING_LWIP` 均关闭，那条
  `adapt_to_rtt` 路径是 AIC8800 用的）；`wlan wifi_on/wifi_scan/wifi_connect`
  命令来自 `api/wifi_interactive_mode.c`，`dhcpc`/`ifconfig`/`ping` 来自
  lwIP 包 nettools（`LPKG_LWIP_EXAMPLES` 提供 `netif_startup.c` 的
  `init_wlan_netif`）。模组接 SDMC0（PB.6–PB.11，4-bit SDIO @40MHz，
  `AIC_WIFI_SDMC_ID=0`），SDMC1 关闭（原默认开、只贡献 /sdcard 挂载失败
  噪音）。模组 EN 与 SoC 断开（用户硬件决策，使能由载板保证），固件不做
  电源控制：`AIC_WIRELESS_PWR_GPIO` 置空，`general_wireless_pin/pm` 胶水
  对无效脚只打 "pwr pin not configured" 告警并跳过（pinmux 表同样安全跳过）。
  注意：PD.17 原本与 `AIC_PRGB_24BIT` LCD 数据线（PD.0–PD.27）冲突，
  EN 断开后该矛盾解除；若 `wlan wifi_on` 超时且 SDIO 无探测日志，优先查
  模组 EN 是否确有定义的高电平。PM 约束同前：`general_wireless_pm.c` 无
  `#ifdef RT_USING_PM` 保护故 `RT_USING_PM` 保持 y，但 `AIC_USING_PM` 为
  n、PM 睡眠驱动未编入，固件不进睡眠。

本次本地构建（精简页包 526568 bytes）预算全过：

| 项 | 数值 |
|---|---:|
| XIP flash 段（.text+.rodata 含内联包） | 2,037,820 B @ 0x60100800 |
| PSRAM 静态（.data 11,392 + .bss 29,984） | 41,376 B（原 2,112,656 B） |
| CMA 1 MiB 扣静态+双 framebuffer 余额 | 484,960 B |
| SW 7 MiB 统一堆扣 guest 5 MiB+系统预留 640 KiB | 余 1,441,792 B |
| ITB / os 分区 | 2,054,144 / 3,145,728 B |

ITS 为双段：seg0 load=entry=0x60100800（XIP 直跳），seg1 load=0x40000000
（.data 拷入 PSRAM）。

### XIP 真机验证（2026-10-10）

烧录 `npm run flash:aic -- --all` 后 XIP 启动成功；bring-up 中发现板载 NOR 为
Puya PY25Q128HA（`XIP flash ID: 0x852018`），补 XIP 表项后精简页全绿：

- 精简页稳定 fps 60–62（拷贝模式基线 61–63，**XIP 无明显帧率回归**）；
  空闲 turn_max 12–13 ms（基线 4–7 ms，XIP 取指代价，仍稳在 60fps 帧预算内），
  触摸时 17–23 ms。
- 统一 TLSF 系统堆 7,340,032 bytes；精简页启动峰值（sys_heap max）
  **3,358,052 bytes**，稳态 live ≈2.45 MiB；js_heap ≈1.0 MiB / 5 MiB 配额。
- 触摸 raw/mapped 一致，touch_reports 随触摸增长；无 OOM。

同日尝试挂载完整桌面 App：编译阶段通过（不再有 `InternalError: out of memory`），
但 mount 阶段抛 `TypeError: not a function`——本机同版本 QuickJS probe
（16 MiB 上限）判定为 **OOM 伪装**：完整 UI 代码本身无 bug（120 帧全过），
但峰值需 **8,904,442 bytes**、常驻 7,951,217 bytes，超出板上 guest+Rust 可用的
约 6.0–6.4 MiB。当时板端入口回退精简页；2026-10-23 再切共享 UI 的结果见文首。完整功能恢复走
[内存优化方案](../../docs/aic-memory-optimization.md) 的方案 A（板端紧凑装配），
实测记录见其 §2.1.1。

## 文本域二次点击软键盘（2026-10-25）

共享文本域首次点击只聚焦，再次点击当前域展开 ASCII 软键盘；两次独立点击，无快速双击时限。
程序聚焦不展开；拖动/取消不展开。键盘保留文本域路由，切换域、失焦或卸载时收起。
首次使用才创建键盘，之后移出视口复用；固定键位在大小写切换时只更新标签/输入值。
复用 Portal host 层级高于连接抽屉和应用配置，收起后不截获工作区触摸。
启停值只读取 `pocket.features.json`。实际包离板复验与固件交付见
[本次记录](../../docs/aic-soft-keyboard-2026-10-25.md)；真机交互、内存峰值和发送仍待用户烧录验证。

2026-10-25 后续：展开键盘时显示临时编辑面板，480×272 下为字段名 24px + 编辑区 56px +
键盘 164px + 状态栏 28px；与原输入框共用文本/光标，点击预览可定位光标，长行/多行跟随，
收起直接返回，发送仍通过原按钮。键帽文字水平/垂直居中，交付与真实字体回放见
[临时编辑面板](../../docs/aic-keyboard-editor-2026-10-25.md)。
