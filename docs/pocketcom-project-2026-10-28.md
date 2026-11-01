# 【2026嵌入式大赛】PocketCOM——基于 RT-Thread 与 D12x MCU 的触控串口调试终端

> 本项目以 **ArtInChip D12x MCU 和 RT-Thread** 为核心，在 demo68-nor 开发板上实现 480×272 触控串口调试终端。工作覆盖 BootLoader 与 XIP 启动、RT-Thread 统一 TLSF 堆、UART/SDIO/GE 外设接入、macOS 原生构建烧录工具链，以及 PocketJS 共享应用的内存与交互优化。
>
> 项目仓库：[PocketCOM](https://github.com/kaidegit/PocketCOM) · [PocketJS fork](https://github.com/kaidegit/pocketjs) · luban-lite 项目 fork（作为 PocketCOM submodule 管理）
>
> 文档与提交快照：2026-10-28。本文依据三个仓库的提交、源码和已有验证记录整理；尚未完成的板端功能单独标明，不把构建通过或离板测试通过等同于真机验收。

## 一、项目概述

### 1.1 项目背景与目标

在嵌入式研发与维修现场，串口助手通常依赖 PC。PocketCOM 希望把常用收发、参数配置和日志观察能力放到一块触控开发板上，同时保留与桌面端共享应用逻辑的能力。项目的竞赛重点是 **D12x MCU 上的 RT-Thread 系统适配与产品化**，不是单纯在开发板上显示一个演示页面。

D12x 采用玄铁 E907 RV32 内核，板载 8 MiB PSRAM、16 MiB SPI NOR、RGB 触控屏和 SDIO WiFi 模组。要在这类资源受限 MCU 上运行 TypeScript/Vue Vapor 应用，需要同时解决 QuickJS/Rust 运行时、Flash 原地执行、内存碎片、帧缓冲与 cache 一致性、串口事件投递、字体和触摸输入等问题。

本轮目标包括：

1. 基于厂商 Luban-Lite BSP，将 PocketJS/PocketCOM 接入 D12x + RT-Thread，形成可构建、可烧录、可持续出帧的固件。
2. 用 XIP 和统一 TLSF 堆重新组织 Flash/PSRAM，使共享 UI 能在 8 MiB PSRAM 上运行。
3. 接通 UART1、触摸、RGB 显示、GE 和 SDIO WiFi，并给出明确的板上验证边界。
4. 补齐 macOS 上的编译、烧录、校验与诊断工具链，减少对特定操作系统和私有工具链的依赖。
5. 用可复现的静态报告、离板探针和真机日志约束优化，不靠盲目扩堆或隐藏功能缺口换取表面通过。

### 1.2 RT-Thread 主线、厂商 BSP 与本项目的关系

**RT-Thread 主线目前没有 ArtInChip/AIC 的官方 BSP。** 本项目并不是从主线空目录开始移植全部驱动，而是以芯片厂商的 Luban-Lite 为系统基础。Luban-Lite 已集成 RT-Thread 4.1.1，以及较完整的 AIC HAL、RT-Thread 驱动层、MPP、板级 pinmux/时钟、显示/触摸/GE、UART、SDIO 和 lwIP 适配。厂商适配为本项目提供了可靠的硬件基线，也避免了重复编写大量寄存器驱动。

在这个基础上，本轮主要完成的是 **产品运行时与 MCU 系统能力的二次适配**：

| 层次 | 已有基础 | 本轮工作 |
|---|---|---|
| RT-Thread 主线 | 内核、设备框架、线程/IPC、FinSH/MSH 等通用能力 | 保持纯 TS 核心与宿主解耦，通过厂商 BSP 使用内核与设备接口 |
| 厂商 Luban-Lite | D12x 启动、时钟、pinmux、HAL/DRV/MPP、显示/触摸/GE/UART/SDIO 驱动 | 增加 PocketJS 产品目标、XIP 双段启动、统一 TLSF、Puya NOR、RTL8189FTV 产品配置和 LCD 相位修正 |
| PocketJS/PocketCOM | QuickJS/native core、Vue Vapor、共享调试应用 | 新增 AIC 宿主、UART1 `com.*` 桥、GE 加速、内存/GC/性能诊断和 480×272 共享 UI |
| 构建与升级工具 | SDK SCons/Kconfig、BootLoader FWC 协议 | 新实现 macOS 可用的 Rust `aic-isp`，增强 BootLoader CRC/XIP，适配公版 RISC-V GCC 并接入一键构建烧录 |

因此，本项目既利用了厂商较完善的 RT-Thread 适配，也包含启动链、内存管理、上位机协议工具和应用运行时等实质改造；不是对厂商 demo 的简单换皮。

### 1.3 当前实现范围与技术亮点

| 方向 | 已完成的主要工作 | 当前边界 |
|---|---|---|
| MCU 启动与内存 | XIP `.text/.rodata`/内联包、FIT 双段启动、1 MiB CMA + 7 MiB 统一 TLSF、5 MiB JS 软配额 | 静态预算不等于运行稳定性，仍需长时和组合负载验证 |
| RT-Thread 外设 | UART1 INT_RX/poll、GT911 触摸、RGB565 双缓冲、GE normal 模式、RTL8189FTV + lwIP | WiFi 已验证至 AP 扫描，不代表共享应用已有 TCP/UDP/WS 桥 |
| 板端应用 | 480×272 共享 UI、连接抽屉、发送区折叠、软键盘、接收/配置触摸拖动、MiSans/JetBrains Mono | 当前 `aic-diagnostic` 仅保留串口和软键盘；终端、MCP 和网络应用未装配 |
| 构建与烧录 | macOS 原生固件构建、公版 `riscv-none-elf-gcc`、Rust `aic-isp`、`flash:aic`、设备端 CRC 校验 | 已在 macOS arm64 用 Cargo 构建运行；其他平台使用同一 Rust 源码 |
| 桌面同源参考 | macOS 完整串口/TCP/UDP/WS、终端和 MCP，用于验证共享核心与交互语义 | 桌面功能完整不代表这些能力已全部移植到 AIC |
| 验证体系 | S0–S5 真机采样、TLSF 最大连续块、失败环、固定池探针、触摸/像素/压力回归、`pjs_mem`/`pjs_hw` | LP64 离板结果不替代 RV32、DMA、电气和长时真机验收 |

当前产品功能与裁剪只由根目录 `pocket.features.json` 决定。板端优化的重点是在厂商 MCU/RT-Thread 基础上控制 QuickJS、原生节点、显示与系统驱动的共同内存峰值，同时保留真实的串口数据路径。

## 二、D12x 板端功能介绍

### 2.1 串口收发与参数配置

板端通过 RT-Thread `/dev/uart1` 和 PocketJS `com.*` 桥接入共享收发应用：

- 配置串口波特率、数据位、校验和停止位；当前硬件桥只接受无流控，DTR/RTS 作为兼容 no-op。
- 发送输入经核心层组包后调用 `com.write()`；接收由 UART1 INT_RX 缓冲和每帧 `com.poll()` 进入会话。
- 共享应用提供 ASCII/HEX、转义、时间戳、软换行、ANSI 前景色、发送历史、定时发送和 Rx/Tx 计数等能力。
- 串口按“2×单字节传输时间”的静默间隔合帧；消息统一进入有界总线和日志视图，不由驱动直接操作 UI。
- UART1 跳线回环发送 `aaa` 已证明字节能经硬件桥返回会话；接收时钟问题已修复并通过共享 App 回归，修复版真机显示延迟仍待复验。

这里要区分三个层次：**RT-Thread UART 驱动可用、`com.*` 数据路径可用、完整产品收发验收通过**。当前前两项已有实现和局部证据，连续流量、参数矩阵及 WiFi 组合仍需继续验证。

### 2.2 480×272 触控交互

- 顶部“连接配置”打开 272px 宽抽屉；面板首次打开才创建，关闭后移出视口并复用。
- 配置内容和接收日志支持手指纵向拖动，带滚动边界和贴底锁定；工具栏与覆盖弹层不参与拖动。
- 文本域首次点击聚焦，再次点击当前域展开 ASCII 软键盘；程序聚焦和拖动不会误展开。
- 临时编辑面板复用原域文本和光标，支持长行跟随及两行可见窗口。
- 发送区可折叠，草稿与光标保留；应用配置弹窗首次创建后复用，每次打开重新生成草稿。
- MiSans 承担中文 UI，JetBrains Mono 承担数据与等宽内容；构建期只烘焙所需字符和已映射字形。

### 2.3 板上诊断与升级

- `pjs_mem`：在 PocketJS 任务边界采集 RT-Thread 系统堆、最大连续空闲块、guest、CMA、栈和 GC 状态。
- `pjs_hw`：只读解算 CPU/GE/DE/UART/QSPI 等时钟、cache CSR 和 SYSMAP，不修改硬件配置。
- MSH WiFi/nettools：用于 SDIO 模组、AP 扫描和网络栈基线验证。
- `aic-isp`：在 macOS 上完成分区烧写、RAM 下载、波特率切换、CRC/readback 校验和复位。
- `memory-report.json`：构建期检查 XIP、PSRAM、framebuffer、guest 配额和 OS 分区预算。

### 2.4 桌面端作为同源功能参考

macOS 版本已交付串口、TCP Client/Server、UDP、WebSocket、Loopback、收发/终端双模式和 MCP server。终端使用纯 TypeScript VT100/xterm 模型；MCP 通过 Streamable HTTP 提供连接、收发、状态和配置工具，仅监听 `127.0.0.1` 并使用 token 鉴权。

桌面端的作用是提前验证共享核心、协议和交互，并为 AIC 的 `com.*` 语义提供参考实现。本文后续不再展开桌面功能，重点回到 D12x 的 RT-Thread 系统实现与实测。

## 三、D12x 硬件框架与 MCU 状态

### 3.1 核心平台

| 项目 | 配置/用途 |
|---|---|
| 主控 | ArtInChip D12x，THead E907 RV32IMAFC；板上读回 CPU 396 MHz |
| 操作系统 | **RT-Thread 4.1.1**，Luban-Lite SCons + Kconfig |
| 运行时 | PocketJS 0.15.0 fork，QuickJS guest + Rust native core |
| Cache | 32 KiB I-Cache + 16 KiB D-Cache，line 32 B；板上确认 I/D Cache 开启 |
| 内存 | 8 MiB PSRAM；1 MiB CMA + 7 MiB 统一 TLSF 系统堆 |
| 存储 | 16 MiB SPI NOR，实测 Puya PY25Q128HA（Flash ID `0x852018`） |
| 显示 | 480×272 RGB 接口，RGB565 双 framebuffer，60 Hz，density 1 |
| 显示加速 | D12x GE/MPP；板上读回 GE 147 MHz、DE 98 MHz |
| 触摸 | GT911 电容触摸，I²C0，RST=PA.10、INT=PA.11 |
| 应用串口 | UART1，PA.2 TX / PA.3 RX；RT-Thread `/dev/uart1` |
| 控制台/烧录 | UART0 控制台；`aic-isp` 固定使用 UART0 下载通道 |
| 无线 | RTL8189FTV，SDIO/SDMC0，4-bit @ 40 MHz，PB.6–PB.11 |
| 网络栈 | third-party lwIP 2.1.3，netif `WL0`；不是 RT-Thread WLAN 框架路径 |

### 3.2 时钟、Cache 与一致性核查

为了避免把交互卡顿简单归因于“主频太低”或“Cache 没开”，本轮增加只读 `pjs_hw`，从 CMU、CSR 和 SYSMAP 读回实际状态。代表性结果如下：

| 项目 | 板上读回/解算 | 结论 |
|---|---|---|
| CPU / AXI0 / AHB0 | 396 / 196 / 196 MHz | 与 D12x 典型配置一致，未通过超频掩盖性能问题 |
| GE / DE | 147 / 98 MHz | 按实际 GE V11、DE V12 时钟链解算 |
| QSPI0 module / XIP SCK | 96 / 96 MHz | XIP wrap32 已启用，与 32 B cache line 对应 |
| RGB pixel clock | 9.9375 MHz，90° 相位 | 实际 PLL 取整结果；相位与 SDK 同板参考一致 |
| SDMC0 | 本次启动采样为 38.4 MHz | 是采样时刻读回，不把枚举阶段值写成全程工作频率 |
| UART0 / UART1 | 53.454545 MHz | 驱动按实际模块时钟计算 115200 等波特率分频 |
| MHCR / MHINT | `0x103f` / `0x8` | I/D Cache 开启，D-Cache 预取沿用 SDK 默认关闭 |
| PSRAM / XIP SYSMAP | `SO=0/C=1/B=1` | 可缓存、可缓冲；GE/DE DMA 仍需显式维护一致性 |

`pjs_hw` 不写寄存器、不切换时钟、不做 cache flush。GE/DE 与 CPU 共享 PSRAM，因此 DMA 前 clean、DMA 后 invalidate 仍是必需路径；不能用关闭 Cache 的方式回避一致性问题。

### 3.3 系统连接关系

```text
┌───────────────────────────────────────────────────────────────────┐
│ D12x demo68-nor                                                   │
│                                                                   │
│  SPI NOR 16 MiB ── XIP ── QuickJS/Rust/RT-Thread + 内联应用包     │
│  PSRAM 8 MiB   ── CMA/TLSF ─ framebuffer/guest/系统线程/驱动      │
│  RGB LCD        ◀── DE/GE ── RGB565 双缓冲                       │
│  GT911          ── I²C0 ── 触摸事件                               │
│  UART1 PA.2/3   ◀────────── 外部串口设备/TX-RX 回环               │
│  UART0          ◀────────── RT-Thread console / ISP               │
│  RTL8189FTV     ◀── SDIO0 ─ lwIP/WiFi（已验证至 AP 扫描）         │
└──────────────────────────────▲────────────────────────────────────┘
                               │
                    ┌──────────┴───────────┐
                    │ macOS 开发机         │
                    │ 公版 GCC + SCons     │
                    │ Rust aic-isp         │
                    │ 构建/烧录/CRC/日志   │
                    └──────────────────────┘
```

### 3.4 硬件设计中的约束

1. **UART 引脚以 D12x 官方数据手册为准**：SDK 的 `aic_gpio_id.h` 部分枚举名带有其他家族遗留信息，PA.2/PA.3 func5 实为 UART1_TX/RX；不能按错误枚举名判断复用关系。
2. **UART3 与 WiFi 存在资源冲突**：PB.10/PB.11 同时涉及 UART3 和 SDMC0，RTL8189FTV 的 4-bit SDIO 需要 PB.6–PB.11 全部引脚。
3. **LCD 采样相位影响静态字边**：同板参考设计的 90° pixel clock 相位不是可有可无的配置；软件 framebuffer 一致并不能排除硬件采样问题。
4. **WiFi 模组 EN 由载板保证**：当前固件不做模组电源控制；SDIO 无探测时首先要确认 EN 电平。
5. **PSRAM 预算不能只看总字节**：双 framebuffer、JS 编译峰值、原生节点、系统任务栈、驱动缓冲和 TLSF 最大连续块必须分别观察。

## 四、RT-Thread 系统架构与本轮适配

### 4.1 厂商驱动三层与三个仓库的职责

Luban-Lite 的驱动组织为 **AIC HAL → RT-Thread DRV → MPP/应用**。HAL 负责寄存器，DRV 对接 `rt_device` 和 OSAL，MPP 提供显示、GE 等应用门面。本项目尽量复用这些厂商接口，把新增代码放在产品运行时、构建工具和板级配置层。

| 仓库 | 主要职责 | 代表性目录 |
|---|---|---|
| PocketCOM | 共享 UI、纯 TS 核心、`com.*` 契约、AIC 产品 profile、构建/烧录编排、内存探针与验证 | `app/`、`core/`、`bridge/`、`host/rtthread/`、`tools/` |
| PocketJS fork | QuickJS/native core、Vue Vapor、AIC 帧循环/RGB565/触摸、GE、`com.*` UART1 桥、内存/GC/性能诊断 | `framework/`、`hosts/aic/`、`engine/` |
| luban-lite 项目 fork | **RT-Thread 4.1.1 与厂商 BSP**；本轮增加 PocketJS 目标、XIP、TLSF、WiFi 配置、BootLoader 和 `aic-isp` | `target/d12x/`、`bsp/artinchip/`、`application/rt-thread/pocketjs/`、`tools/aic-isp/` |

PocketCOM 通过 submodule 固定 PocketJS `feat/aic` 与 luban-lite `feat/pocketjs` 的实际提交。构建使用 checkout 中的版本，不在后台自动更新子模块。

### 4.2 本轮关键适配一：增强 BootLoader 与 XIP 启动

厂商 SDK 已提供 NOR 启动和 FWC 烧录协议，本轮针对 PocketJS 固件体积和 PSRAM 限制做了以下增强：

- 新增 `xip_boot` 启动路径，按 FIT 段地址区分 XIP 与 RAM：`.text/.rodata`/内联包直接从 NOR 执行，只把 `.data` 拷入 PSRAM，保留 `nor_boot` 作为手动兜底。
- 修改 D12x 链接脚本，使 `.rodata` 与 `.text` 一起进入 `0x60000000` XIP 窗口，避免只搬代码却留下大块只读数据。
- 固定 `CONFIG_AIC_XIP_FW_OFFSET=0x100800`，即 OS 分区偏移 `0x100000` 加 FIT 头 `0x800`；构建报告校验 ELF、FIT 和分区三者一致。
- 为实板 Puya PY25Q128HA 增加 XIP 参数表，使用 QIO EBh 与 wrap32；没有假设“同容量 NOR 即可直接复用”。
- 在 BootLoader FWC 协议中新增 `GET_MEDIA_CRC`（aicupg `0x1C`），让设备直接计算分区 CRC32，供上位机做确定性烧录校验。

### 4.3 本轮关键适配二：macOS 可用的 Rust `aic-isp`

为避免烧录环节依赖 Windows AiBurn，本轮在 luban-lite fork 中新实现了 Rust 上位机 `aic-isp`，而不是只在应用脚本里调用现有工具：

- 实现串口握手、FWC 组件、设备分区表、SPI NOR 烧写、RAM 下载与执行、Intel HEX、复位和详细协议日志。
- 烧写地址必须等于设备报告的分区起始地址，防止把 IMG 容器或裸文件误写到错误位置。
- `-b/--baud` 统一表示连接后的下载波特率，支持 3 Mbps 等提速；握手仍从 115200 开始。
- `--verify` 使用新增 `GET_MEDIA_CRC`，由设备计算 CRC32，2 MiB 镜像可在秒级完成；`--verify=readback` 保留逐字节比对和首个差异定位。
- `src/sim.rs` 实现设备侧模型，覆盖连接、内存写入、Flash 烧写、CRC 和波特率切换，能在无板情况下测试协议时序。
- 已在 macOS arm64 用 Cargo 构建出 Mach-O 可执行文件；其他平台使用同一 Rust 源码，不依赖预编译二进制。

PocketCOM 的 `npm run flash:aic` 进一步读取镜像分区表，自动选择 `bootloader.aic`/`d12x_os.itb` 和偏移，优先使用预编译工具，缺失时才构建，并将端口、校验、复位等参数原样传给 `aic-isp`。

### 4.4 本轮关键适配三：公版 GCC 与 macOS 原生构建

SDK 原始构建链主要面向 Linux/Windows，并携带玄铁 `riscv64-unknown-elf-` 工具链。预研阶段曾考虑用 Linux 虚拟机作为固件构建机；实际实现后，已经在 **macOS 上使用公版 xPack `riscv-none-elf-gcc` 15.2.0 完成完整固件构建**。

- 构建脚本遵循 SDK 的 `RTT_EXEC_PATH`，接受外部 `riscv-none-elf-gcc`，不下载或暗中替换工具链。
- C/RT-Thread/AIC 驱动继续由 Luban-Lite SCons 构建；Rust native core 使用 E907 对应的 `riscv32imafc-unknown-none-elf` target。
- `check:aic → package:aic → build:aic → flash:aic` 串成统一入口，包、ELF/map、ITB/IMG 和内存报告来自同一次构建。
- 静态预算不足会直接失败，不自动扩分区、扩堆或烧录；重复构建可核对包与固件哈希。

### 4.5 RT-Thread 内核与外设的实际使用

| 能力 | 项目中的用法 |
|---|---|
| UART 设备框架 | `/dev/uart1` 配置、INT_RX、2048 B 驱动环形缓冲；每 tick 由 `com.poll()` 拉取 |
| 线程与帧循环 | PocketJS 宿主任务执行 guest/UI/frame；诊断采样在同一任务边界排队执行 |
| 内存管理 | `RT_USING_USERHEAP` + TLSF；`heap_caps_*` 走 `rt_malloc/rt_free`；CMA memheap 保存 framebuffer 与 GE 暂存面 |
| 内存观测 | `rt_memory_info`、TLSF `rt_memory_walk`、分配峰值/块数/失败环、QuickJS `JS_ComputeMemoryUsage` |
| MSH/诊断 | `pjs_mem`、只读 `pjs_hw`，以及 SDK 的 WiFi/nettools 命令 |
| 显示与 GE | MPP display、GE normal 同步模式、DMA 前后 cache clean/invalidate |
| SDIO 与网络 | RTL8189FTV + third-party lwIP；当前用于驱动/AP 扫描验证，尚未接入共享应用网络桥 |
| 启动与升级 | FIT 双段 XIP、BootLoader `xip_boot`、`aic-isp` 和 `GET_MEDIA_CRC` 校验 |

### 4.6 板端数据流

**UART 接收与发送：**

```text
RX：UART1 INT_RX → 2048 B 驱动环 → tick 边界 com.poll()
    → base64 字节事件 → ComSession/FrameCoalescer → 消息总线 → LogView

TX：共享 UI → 发送组装 → IConnection.write(bytes)
    → com.write(handle, …) → rt_device_write(uart1)
```

RX 字节计数在成帧前更新，因此“计数已增加”与“日志文字已生成”是两个阶段。这个区分是定位板端短包显示延迟的关键。

**显示路径：**

```text
Vue Vapor 更新 → native tree/core draw → RGB565 DrawList
  → GE fill/blit/A8（不支持或失败则 CPU 回退）
  → cache clean/invalidate → 双 framebuffer PAN/vsync
```

无 damage 时保留虚拟 tick 和输入处理，但跳过整面 cache clean 与 PAN；有 damage 后仍按各 target 的历史状态渲染。

### 4.7 构建与烧录链路

```text
pocket.features.json + pocket.json + AIC host profile
  → PocketJS 编译器：TS/TSX 特化、JS/PAK、字形与 feature receipt
  → .pocket 应用包 + 契约头 + 内联 C 数组
  → 公版 GCC + Luban-Lite SCons：QuickJS/Rust/C/驱动/链接
  → ELF/map/静态内存报告
  → d12x_os.itb（XIP 段 + RAM 段）
  → macOS aic-isp 分区烧录 + 设备端 CRC
  → BootLoader xip_boot → RT-Thread/PocketCOM
```

## 五、关键技术实现

### 5.1 `com.*`：把平台 IO 挤出核心层

PocketJS 本身不提供项目所需的串口、raw socket、WebSocket 和 MCP server，因此项目按产品扩展方式实现 `com.*`。核心只面对统一的句柄、连接事件和字节流，桌面与 AIC 可以拥有不同能力集合。

AIC 当前实现串口子集：

- `serialList` 只枚举 UART1；`serialOpen` 对齐桌面参数语义。
- `write`、`close`、`poll` 是必需路径，`setSignals` 当前为兼容 no-op。
- RX 使用 INT_RX，不在中断或原生线程中直接调用 JS。
- 拒绝 Mark/Space 校验、1.5 停止位和非 `none` 流控，与真实硬件能力一致。
- `POCKETJS_COM=0` 可编译关闭；缺少 cfg/MCP/net 桥时共享 App 按能力探测降级。

### 5.2 XIP 与统一 TLSF 堆

初版将固件整体拷入 PSRAM，并给 PocketJS 划分私有 TLSF 池。代码、只读数据、内联包和 guest 同时挤占 PSRAM，完整 UI 很容易在编译/挂载阶段 OOM。

改造后：

```text
SPI NOR 16 MiB
  os 分区 → FIT 头 + .text/.rodata/内联包（XIP）+ .data（载入 PSRAM）

PSRAM 8 MiB
  PSRAM_CMA 1 MiB：.data/.bss + 双 RGB565 framebuffer + CMA 动态内存
  PSRAM_SW  7 MiB：RT-Thread TLSF，guest 与系统线程/驱动共用
```

- `.text/.rodata` 位于 `0x60000000` XIP 窗口；bootloader 跳过 XIP 段，只拷贝 `.data`，启动代码清零 `.bss`。
- SDK 链接模板同时迁移 `.rodata`，避免只迁 `.text` 留下隐形 PSRAM 占用。
- 私有 PocketJS 池被移除，`heap_caps_*` 直接进入 RT-Thread 系统堆；guest JS 保留 5 MiB 软配额。
- 不再使用运行期 data 分区及 FAL/SFUD/userid 链，QSPI0 留给 XIP 缓存。
- 为实测的 Puya PY25Q128HA 补充 XIP 参数表，不能假设同容量 NOR 都有相同 QIO/wrap 配置。

XIP 精简页真机保持 60–62 fps，与拷贝模式 61–63 fps 接近；这说明该基线下没有明显帧率回退，但不代表所有完整 UI/IO 场景都已验收。

### 5.3 分阶段诊断与固定池离板探针

项目将启动拆成 S0–S5：boot/task、display/touch、package/guest/uibind、compile/mount、renderer/frame1/frame120。每个采样点记录：

- 系统堆已用/历史峰值、空闲总量、最大连续空闲块和碎片数。
- guest+Rust `caps` 的 live/peak/blocks/fails。
- QuickJS malloc、对象/shape/函数代码/帧和 realloc 统计。
- CMA、PocketJS 任务栈高水位、GC 次数与最大停顿。
- 最近 8 条分配失败，失败路径使用固定缓冲，避免诊断本身再分配。

离板 `probe:aic` 使用同一个 QuickJS/native core/package/RGB565 组件，并直接编译 SDK 的 TLSF。默认池固定为 7,340,032 B，不允许 malloc 回退或自动扩池；包缓冲模拟 XIP 留在池外。这样可以先比较包与交互策略，再用真机确认 RV32、系统驱动和硬件时序差异。

### 5.4 编译期产品裁剪

`pocket.features.json` 同时声明功能状态、依赖、模块所有权、文案归属和 profile。PocketJS 在 Vue 转换、样式/字形收集和依赖遍历前进行 AST 特化，并输出 feature receipt。

已完成 terminal、MCP、五类传输和九项 UI 能力的裁剪。早期同基线离板 A/B 结果如下；这些差值用于评估裁剪机制，不与后续节点优化后的绝对内存混用：

| 裁剪项 | 空闲/稳态收益 | 累计峰值收益 | 测试边界 |
|---|---:|---:|---|
| 关闭 terminal | 约 0.713 MiB | 约 0.745 MiB | 未挂载终端网格，无流量/回滚增长 |
| 关闭 MCP | 约 258.7 KiB | 约 271.1 KiB | 不运行原生 server，只比较 guest 装配 |
| 五种传输裁为仅串口 | 约 203.0 KiB | 约 218.1 KiB | 无真实 socket/驱动负载 |
| 九项 UI 全关 | 约 280.9 KiB | 约 295.5 KiB | 未展开软键盘/选区等交互 |

配置 schema 保留被裁剪功能的旧字段，导入/导出不丢配置；直接调用禁用协议会在触及宿主和改变状态前被拒绝。

### 5.5 节点、面板和 GC：降低挂载与组合峰值

内存优化不是单一技巧，而是一组相互衔接的改动：

1. **共享原生节点 DOM 兼容函数**：将逐节点 getter/setter/方法移到共享原型，children、样式和属性缓存仍逐节点独立。受控离板 A/B 中，S4 存活下降 23.83%，S5 QuickJS 对象数下降 45.54%。
2. **DOM 容器按需创建**：`style`/`classList` 首次访问才分配，减少不经过兼容层的 Vapor 原语成本。
3. **Vue Vapor 普通原语降低**：编译器识别真实导入绑定的普通 `View`/`Text`，减少逐节点组件实例、attrs 代理和 effect；动态 slot、ref、展开属性等保留保守路径。
4. **面板延后创建、隐藏复用**：连接配置、发送区、设置弹窗和软键盘避免启动时全量创建，也避免反复销毁/重建的峰值。
5. **帧边界压力 GC**：首帧前回收一次；之后按 caps 增长与系统余量在完整帧末回收，低余量持续重绘时最多等待 2 秒，不在分配器或宿主回调中重入 JS。
6. **减少重复工作**：无 slot 叶子跳过子节点处理、减少临时闭包，GE 暂存面只清 padding，无 damage 跳过 cache clean/PAN。

组合“软键盘 → 连接配置 → 应用配置并编辑”的旧包曾在 7 MiB 固定池失败；新包在相同条件下完成首次组合 20/20，以及正常/无空闲/快速三组各 50 轮、每组 420/420 状态检查，分配失败为 0。该结果是离板压力验证，不是 UART/WiFi 真机长时结论。

### 5.6 GE 2D 加速与软件回退

AIC RGB565 renderer 的 accelerator 表接入 MPP GE：

- 不透明矩形填充 → GE fillrect。
- 1:1 PSM5650 搬运 → GE bitblt，使用 BGR_565 源格式完成 R/B 交换。
- A8 字形/透明遮罩 → CPU 合并覆盖率与全局 alpha，转 straight ARGB8888；GE 在私有 RGB565 暂存面混合，成功后写回。
- A8 暂存区按 SDK 示例从 MEM_CMA 分配并复用，按补齐后的 8192 像素限制，约 48 KiB；行 stride 8 B 对齐、首地址 64 B 对齐。
- 每次 DMA 按行 clean/invalidate；旋转、缩放、越界、超限、分配失败或 GE 错误均回退 CPU。
- 私有暂存面保证部分硬件写入失败时原目标未被污染，避免 CPU 重放造成重复混合。

初版 A8 曾因遗漏 stride 对齐和暂存内存类型出现黑屏；修正后用户回传确认恢复出帧、A8 `rc=0`、首帧/120 帧及触摸后出帧，frame120 `caps_fails=0`。硬件混合舍入和性能 A/B 仍需独立验证，不能把 stub 测试当成硬件像素或提速证明。

### 5.7 字体、触摸与窄屏适配

- UI 文案统一 MiSans，数据与终端网格使用 JetBrains Mono。
- AIC 构建只烘焙 ASCII、语言包与已映射 UI 字符，不预烘焙完整 CJK 字符域。
- 系统消息和下拉选项属于 UI 文案，必须走 MiSans；把它们放入不含 CJK 的 mono 槽会在板端出现豆腐块。
- 桌面 CoreText 有系统字体回退，可能掩盖缺字；因此增加桌面 baked-font 模拟和 UI glyph coverage 测试。
- 桌面鼠标按 ink 命中，AIC 触摸按 bounds 命中。透明 Portal host 必须设置 `hitPass: 1`，否则抽屉关闭后仍拦截后续触摸。
- 触摸拖动不会自动生成 companion 滚轮事件，配置面板和接收区需要显式纵向 pan。

### 5.8 无 RTC 环境下的接收合流时钟

UART1 TX/RX 短接发送 `aaa` 时，旧固件 TX/RX 计数立即各为 3 B，但接收文字延后。定位结果为：

- 当前产品未启用 RTC，`gettimeofday()` 失败且不写 `timeval`。
- QuickJS 的该路径未检查返回值，`Date.now()` 因而不能可靠驱动亚毫秒/毫秒级静默超时。
- 会话泵已从 `Date.now()` 改为 `virtualNow() × 1000`，重连期限使用同一时间域；日志的日历时间戳来源保持不变。

真实 Vue Vapor/core 回归已覆盖冻结/回拨时钟、孤立短包、接收文字和低波特率阈值。修复后的真机显示延迟仍需用同一跳线复验，不能把 60 Hz 虚拟帧直接写成真实端到端延迟保证。

### 5.9 烧录校验与性能 A/B

`aic-isp` 与 bootloader 增加 `GET_MEDIA_CRC`：设备对分区内容计算 CRC32，主机与镜像比较，一条命令完成校验；旧 bootloader 仍可使用较慢的全量 readback。下载波特率统一复用 `-b/--baud`，避免通信与下载参数含义混乱。

性能优化同样要求对照。inline style 自动合批曾把配置属性 HostOp 从 254 降为 82、键盘从 414 降为 54，但减少调用次数不等于减少总耗时。后续同口径真机 A/B 中，本组 batch 的配置首开和键盘首开分别慢 18.22% 和 20.52%，因此撤回自动合批，恢复逐属性 `setProp`；可选 C batch 接口保留给显式调用。该比例只对应这组带诊断样本，不能外推为所有负载的固定回退。

## 六、提交驱动的实现过程

| 阶段 | PocketCOM | PocketJS fork | luban-lite 项目 fork |
|---|---|---|---|
| 桌面 M1–M4 | 初始收发、协议桥、统一会话、终端、MCP、打包与测试 | 使用桌面宿主与框架能力 | — |
| 交互与性能完善 | 选区/右键/ANSI、设置弹窗、增量日志、环形回滚、历史容量、性能报告 | — | 早期 SDK/ISP 熟悉与 helloworld 提交 |
| D12x bring-up | AIC 产品配置、包/固件/烧录编排、精简验证页 | 新增 AIC host、显示/触摸/QuickJS/Rust 接入 | 新增 PocketJS 目标、板级配置和镜像链 |
| 构建与升级工具链 | 公版 GCC 路径、静态报告、`check/package/build/flash:aic` | AIC SConscript 与 RV32 Rust target | 新实现 macOS Rust `aic-isp`、设备模拟、`GET_MEDIA_CRC`、`xip_boot` |
| XIP/统一堆/WiFi | 内存报告、真机基线、诊断计划 | guest 分配改走系统堆、S0–S5 诊断 | XIP 链接/BootLoader、TLSF、Puya NOR、RTL8189、空闲块遍历 |
| 0.15 与编译裁剪 | 统一 feature catalog、terminal/MCP/transport/UI A/B | 合并上游 0.15、保留 GPUI 契约、AST 特化 | — |
| 共享 UI 内存优化 | 共享入口、窄屏抽屉、压力脚本、组合 OOM 修复 | 节点原型共享、Vapor lowering、帧末 GC | — |
| 硬件与产品交互 | GE 集成、字体/触摸/软键盘、UART 时钟、性能复测 | GE fill/blit/A8、Portal hitPass、UART1 桥、粗粒度诊断 | LCD 90° 相位修正 |

完整提交逐条列在附录。PocketCOM 的 `1eddc18` 位于独立 `wgpu-host` 实验分支，当前 `main` 仍是 GPUI 桌面宿主，不把该提交写成主线已切换 wgpu。

## 七、测试与实机结果

### 7.1 自动化与离板验证

最近一轮 scalar 恢复版验证记录包括：

- PocketCOM：351 项测试、2410 次断言通过；PocketJS 相关 14 项测试、142 次断言通过。
- TypeScript typecheck、桌面 manifest check/build、实际 AIC SDK 固件构建通过。
- 恢复版与较快 scalar 对照包的 6 个 480×272 RGB565 状态零像素差异。
- 固定 7 MiB TLSF 的普通产品路径 busy/rapid 各 50 轮，均 420/420 状态检查通过，`caps_fails=0`。
- 实际 QuickJS 绑定验证 `inline=scalar batch_api=1`，确认 inline 样式未被自动包装成批次。

这些数字来自对应提交已有验证记录；本文编写时未重新执行固件构建或烧录。离板虚拟 turn、LP64 指针和 CPU 回放不代替真机时长、RV32 内存、GE/DMA 与电气验证。

### 7.2 代表性真机结果

| 场景 | 结果 | 证据边界 |
|---|---|---|
| XIP + 统一堆精简页 | 60–62 fps；系统堆启动峰值 3,358,052 B；触摸正常，无 OOM | 精简验证页，不是完整共享 App |
| 共享节点原型第 1 步 | 共享 UI 挂载、首帧、120 帧通过；`frames=120/0`、采样 `caps_fails=0`；用户确认显示与触摸下拉正常 | 启动/短时空闲与已反馈交互，不是长时或 IO/WiFi 验收 |
| 连接抽屉第 2 步 | 首开前系统峰值 4,760,220 B，frame120 系统占用 3,534,768 B；启动 120 帧无分配失败 | 首次触摸出现 3091 ms 卡顿；完整反复开关与操作后采样当时未补齐 |
| 低内存节点/空闲帧优化 | frame120 系统占用较前版减少 64,780 B，最大连续空闲块增加 69,484 B | 两轮交互输入不完全一致；首开配置/键盘 JS 阶段仍约 1860/684 ms |
| GE fill/blit | 真机颜色、持续出帧和触摸正常 | 长时、WiFi 组合与严格性能 A/B 待补 |
| GE A8 修正版 | 黑屏恢复，A8 `rc=0`，首帧/120 帧与触摸后出帧，frame120 `caps_fails=0` | CMA 增加 49,240 B；硬件舍入与净性能仍待验证 |
| LCD 90° 相位 | 用户确认静态字边跳动/字体发虚恢复 | 只验收该显示问题 |
| WiFi | RTL8189FTV 探测、lwIP netif 与 AP 扫描链路已点亮 | 未据此声明应用网络收发或长时流量通过 |
| UART1 回环 | 旧版 `aaa` 回环已证明 3 B 能返回会话；时钟问题已修复并通过真实共享 App 回归 | 修复版真机接收显示延迟待复验 |

### 7.3 当前恢复版静态预算

`dist/aic/scalar-style/memory-report.json` 记录：

| 指标 | 数值 |
|---|---:|
| `.pocket` 应用包 | 831,496 B |
| XIP flash 段 | 2,981,436 B |
| `d12x_os.itb` / OS 分区 | 3,008,512 / 3,145,728 B |
| OS 分区余量 | 137,216 B |
| CMA 扣静态区与双 framebuffer 后 | 243,692 B |
| 统一 SW 堆 | 7,340,032 B |
| guest JS 软配额 | 5,242,880 B |

静态余量不包含全部运行期分配、对齐、碎片和驱动开销，不能单独证明运行稳定性。恢复版本地验证已完成，恢复后的真机首开时间仍需复测。

## 八、主要踩坑记录

| 现象 | 根因 | 处理与验证 |
|---|---|---|
| 静态预算通过，启动仍 OOM | Flash/PSRAM 静态段不包含 QuickJS 编译与 UI 挂载峰值 | 增加 S0–S5、caps、QuickJS、最大连续块与失败环；按阶段优化 |
| `TypeError: not a function`，本机大堆却正常 | 板端底层 OOM 可伪装成 JS 类型异常 | 不把它当普通 UI bug；用同包探针与分配失败记录定位 |
| 私有池与系统堆并存仍放不下 | 代码/包和 guest 同时占 PSRAM，memheap/TLSF 割裂预算 | XIP + 7 MiB 统一 TLSF，保留 5 MiB JS 软配额 |
| XIP NOR 无法启动 | 实板 Puya PY25Q128HA 不在原支持表 | 按实测 Flash ID 补 QIO/wrap 参数，再烧录验证 |
| 配置抽屉只能打开一次 | 透明 Portal host 在 AIC bounds 命中下继续截获触摸 | `hitPass: 1`；真实 Vapor/core 连续开关和命中回归 |
| 面板/日志不能手指滑动 | 触摸 pan 不会自动生成 companion wheel | 内容区显式纵向 gesture，隔离头部、工具栏和弹层 |
| 中文系统消息/下拉符号豆腐 | i18n 文案落入无 CJK 的 mono 槽，或符号不在 MiSans cmap | UI 文案回 MiSans；烘焙映射检查与桌面 atlas 模拟 |
| 静止字边仍跳动 | RGB pixel clock 相位与同板参考不一致 | 恢复 90°；离板像素一致仅作辅助证据，真机确认 |
| A8 接入后黑屏 | 初版漏掉行 stride 对齐，暂存内存路径不符合 SDK 示例 | MEM_CMA、对齐与缓存顺序修正；失败不写回并保留 CPU 回退 |
| RX 计数增加但文字延迟 | 无 RTC 时 `Date.now()` 不可靠，合流静默超时不推进 | 使用框架帧时钟；冻结/回拨时钟与真实文字节点回归 |
| HostOp 数下降却更慢 | 调用次数不包含数组构造、分配和边界成本 | 同口径 A/B 否定自动 style 合批，恢复 scalar，保留显式 batch API |
| “200 次开关通过”后来发现不成立 | 旧脚本只注入触摸和检查错误，没有断言实际命中/开关状态 | 撤回旧结论，补每轮 bounds 与状态检查后再验收 |

## 九、D12x 构建、烧录与验证

### 9.1 macOS 原生构建 D12x 固件

前置：Bun、npm、SCons、Rust、`riscv-none-elf` 公版工具链，以及两个 submodule。

```sh
git submodule update --init --depth 1 vendor/pocketjs vendor/luban-lite
npm ci
(cd vendor/pocketjs && bun install --frozen-lockfile)

npm run check:aic
npm run package:aic
RTT_EXEC_PATH=/path/to/riscv-none-elf/bin npm run build:aic
```

在 macOS 上通过 `aic-isp` 烧录 OS 分区：

```sh
npm run flash:aic -- -p /dev/cu.usbserial-XXX -b 3000000 --verify --reset
```

首次或需要更新 BootLoader 时使用 `--all`，使 `xip_boot` 与 `GET_MEDIA_CRC` 同时进入设备。IMG 是带多个 section 的烧录容器，不能当作裸文件直接写入某个 Flash 地址；脚本按分区表烧写 `bootloader.aic` 与 `d12x_os.itb`。

ISP 协议与设备模型可独立回归：

```sh
cd vendor/luban-lite/tools/aic-isp
cargo test
```

### 9.2 离板内存与裁剪复测

```sh
npm run probe:aic
npm run probe:aic -- --heap 7340032
npm run probe:features
npm run probe:features -- --feature mcp.server
npm run probe:features -- --feature transport
npm run probe:features -- --feature ui
```

这些命令用于修改前后的受控比较，最终仍须烧录核对 RV32 内存、真实 DMA、UART/WiFi 负载和交互耗时。

### 9.3 可选：运行 macOS 同源桌面端

```sh
npm run typecheck
bun test test/
npm run check
npm run build
npm run dev
```

桌面包通过 `tools/package-macos.sh` 生成；它用于验证共享核心和完整协议功能，不是 D12x 固件的替代验收。

## 十、当前限制与后续计划

1. **先完成板端串口闭环验收**：复验 UART1 参数切换、短包显示延迟、连续收发、不同波特率与 console 共存，并记录运行态内存。
2. **补长时与组合矩阵**：覆盖反复开关、设置/键盘组合、UART 流量、WiFi 开/连 AP/断开和流量状态，采集系统峰值、最大连续块、GC 与错误计数。
3. **继续处理首次创建卡顿**：以粗粒度组件/Vue/frame 数据定位 JS 创建与响应更新，不能把所有停顿归因于 GPU；优化后撤除诊断再做净性能验收。
4. **验证恢复版与复用路径**：补 scalar 恢复版真机首开数据，以及配置/键盘第二次打开的复用时间。
5. **完善窄屏产品能力**：高级收发工具栏、板端容量配置和完整触摸验收仍需推进。
6. **网络与 MCP 不把驱动当应用**：WiFi 已点亮不代表 `com.*` 网络桥已实现；后续按统一会话契约接入，并重新测量 lwIP/驱动缓冲对统一堆的影响。
7. **维护厂商 BSP 与主线的边界**：当前留在 Luban-Lite fork 能复用完整 AIC 驱动；若未来回归 RT-Thread 主线，需要独立建设 ArtInChip BSP 并持续移植驱动，不能把本轮产品适配误当成主线已经支持 AIC。

## 十一、总结

PocketCOM 的竞赛核心是一个运行在 **D12x MCU + RT-Thread 4.1.1** 上的触控串口调试终端。RT-Thread 主线尚无 ArtInChip BSP，厂商 Luban-Lite 提供了完整的芯片、驱动和 MPP 基础；本轮则把这套基础推进到 PocketJS 产品运行时，并补齐了 XIP 启动、统一 TLSF 堆、UART1 桥、GE 加速、RTL8189FTV 配置和共享触控 UI。

在工程链上，本轮还增强了 BootLoader，新增设备端 CRC 校验，完成了 macOS 可用的 Rust `aic-isp`，并用公版 xPack `riscv-none-elf-gcc` 在 macOS 上构建实际固件。它们使“编写应用—编译固件—烧录校验—启动诊断—内存与性能复测”形成闭环。

目前板端已经从厂商 BSP 和“能编译”推进到可启动、可显示、可触摸、具备真实串口数据路径的阶段。后续重点仍是 UART/WiFi 真实负载、长时组合交互、首开延迟和完整窄屏能力；所有优化继续以 RT-Thread 系统资源和 MCU 实测为验收依据。

## 十二、资料索引

### 项目资料

- [PocketCOM 功能与架构规格](../SPEC.md)
- [AIC + RT-Thread 接入与构建手册](../host/rtthread/README.md)
- [D12x 移植预研与主线/BSP 关系](rtthread-d12x.md)
- [macOS `aic-isp` 工具与烧录协议](../vendor/luban-lite/tools/aic-isp/README.md)
- [D12x 时钟与 Cache 核查](aic-clock-cache-audit-2026-10-26.md)
- [D12x 内存优化方案](aic-memory-optimization.md)
- [共享 UI 与编译期裁剪提案](shared-ui-memory-optimization.md)
- [共享节点原型第 1 步](aic-node-prototype-step1.md)
- [连接配置延后创建第 2 步](aic-narrow-panel-step2.md)
- [组合面板 OOM 修复](aic-combined-oom-2026-10-26.md)
- [GE A8 支持记录](aic-ge-a8-2026-10-26.md)
- [UART 接收显示延迟排查](aic-uart-receive-delay-2026-10-26.md)
- [低内存性能优化](aic-perf-low-memory-2026-10-26.md)
- [粗粒度性能 A/B 与 scalar 恢复](aic-coarse-perf-2026-10-27.md)
- [MCP 服务手册](mcp.md)

---

# 附录：三个仓库的个人提交全量索引

统计口径：对三个仓库执行所有本地/远端分支的 `git log --all`，作者匹配 `kaidegit`、`Kai` 及共同邮箱 `2857693944@qq.com`，按作者日期升序排列。共 **128 个提交**：PocketCOM 102 个、PocketJS 17 个、luban-lite 9 个。包含功能、修复、性能、测试、文档、CI、依赖与合并提交，不包含其他作者提交和未提交工作区改动。

- PocketCOM：`main` 含其中 101 个；`1eddc18` 仅在 `wgpu-host` 实验分支。
- PocketJS：17 个均包含在当前 `feat/aic`。
- luban-lite：当前 `feat/pocketjs` 含其中 8 个；`98bc70fa` 是 `master` 上早期 helloworld/ISP 文档提交。
- luban-lite 是浅克隆，两个 grafted 根提交的整树快照统计不代表本轮新写代码量，因此本文不使用插入/删除行数衡量工作量。

## 附录 A：PocketCOM（102 个）

| 提交 | 日期 | 标题 |
|---|---|---|
| `dccfe13` | 2026-09-05 | feat: initial PocketCOM implementation |
| `8ff0104` | 2026-09-05 | chore: move core tests to test/ |
| `955e52a` | 2026-09-05 | ci: add macOS arm64 .app/.dmg packaging workflow |
| `8f2c8ef` | 2026-09-05 | chore(deps): regenerate package-lock.json to fix npm ci |
| `228586f` | 2026-09-05 | ci: use node 24 so npm ci matches the lockfile's npm 11 semantics |
| `46b4beb` | 2026-09-05 | fix(deps): add @emnapi/core+runtime as devDeps to complete the lockfile |
| `6a89911` | 2026-09-05 | test(bridge): add com bridge tests with hardware loopback suite |
| `e408938` | 2026-09-05 | chore: ignore .zcode workspace dir |
| `1c9f17e` | 2026-09-05 | add README |
| `83ff6e4` | 2026-09-05 | feat(host): add com net and env bridges, split namespace by protocol |
| `cf6f03c` | 2026-09-05 | feat(bridge): split com bridge into serial/net/cfg modules |
| `1dfcb8d` | 2026-09-05 | feat(core): unified com session and config schema |
| `d0e2f79` | 2026-09-05 | feat(app): per-type connection panels, follow-system theme, settings persistence |
| `7cc98aa` | 2026-09-05 | docs(agents): update layout, commands, and counts for M2 |
| `26c170a` | 2026-09-05 | feat(host): add --screenshot PATH@TICK window capture flag |
| `8f10d7f` | 2026-09-05 | feat(core): headless VT100/xterm terminal model (M3) |
| `d459fca` | 2026-09-05 | feat(app): terminal view with direct key send and scrollback setting (M3) |
| `6049744` | 2026-09-05 | feat(host): forward ctrl-modified printable keys as key lines |
| `a5295e7` | 2026-09-05 | docs(agents): update layout, commands, and counts for M3 |
| `669df71` | 2026-09-05 | feat(host): add --wheel injection, e2e scripting doc |
| `28223e4` | 2026-09-05 | feat(core): MCP command executor, read lines, terminal-mode gate (M4) |
| `336305e` | 2026-09-05 | feat(bridge): MCP host ops contract (mcpStart/Stop/Feed/Cmds/Results) |
| `2924465` | 2026-09-05 | feat(app): MCP share toggle, URL/token copy, statusbar state, session relay (M4) |
| `6020f18` | 2026-09-05 | test(host): deflake listener write broadcast with wait_batch |
| `9aaacc7` | 2026-09-05 | feat(host): MCP server with Streamable HTTP and terminal-mode gating (M4) |
| `b04227a` | 2026-09-05 | docs: update agents/readme/e2e for M4 |
| `9542474` | 2026-09-05 | fix(core): session skips {t:"mcp"} host events |
| `a334280` | 2026-09-05 | docs(mcp): add MCP service manual |
| `3e8a19d` | 2026-09-05 | fix(app): size popup backdrop to viewport so outside clicks dismiss it |
| `591e8e8` | 2026-09-06 | fix(app): use shallowRef for active field so caret renders on focus |
| `864d454` | 2026-09-06 | feat(app): blink text-field caret; auto-refresh serial ports on open |
| `0d006f7` | 2026-09-06 | fix(core): keep sys lines readable under HEX/escape display switches |
| `2dc69ad` | 2026-09-06 | refactor(core): detect frame loss via message id gap, not sys events |
| `872ed7c` | 2026-09-06 | feat(app): drag text selection in text fields and receive log |
| `f34d9e5` | 2026-09-06 | feat: add loopback connection type for hardware-free testing |
| `4ce4012` | 2026-09-06 | feat(app): gate receive-pane rx/tx display on mcp server state |
| `d4f1d47` | 2026-09-07 | test(mcp): add high-volume loopback flood e2e |
| `61d671e` | 2026-09-07 | fix(core): split hard newlines in log rows to stop text overlap |
| `2f8c93c` | 2026-09-07 | fix(mcp): apply DTR/RTS on serial connect even when args omitted |
| `1e1b519` | 2026-09-07 | change font to jetbrains mono |
| `27488c1` | 2026-09-07 | fix(app): anchor send-pane popup to flowing select position |
| `1176e14` | 2026-09-07 | docs: add e2e control coordinate reference with pixel probe tool |
| `79de13e` | 2026-09-08 | feat: 添加右键菜单功能，支持日志区复制和全选 |
| `91c519b` | 2026-09-08 | feat(receive): add ANSI color escape for the receive log |
| `9d807d0` | 2026-09-15 | 更多的波特率 |
| `c3f9caf` | 2026-09-16 | feat(app): add settings modal and input controls |
| `c3efc48` | 2026-09-16 | feat(tools): enhance preflight checks and error diagnostics in dev script |
| `d54b8d2` | 2026-09-17 | 性能分析报告 |
| `17a0877` | 2026-09-17 | Merge branch 'main' of https://github.com/kaidegit/PocketCOM |
| `1eddc18` | 2026-09-18 | feat(host): migrate desktop host from gpui to portable wgpu backend |
| `fb63187` | 2026-09-18 | perf(core): incremental log layout, chunked framing, ring scrollback, strict base64 |
| `659928c` | 2026-09-23 | feat(app): configurable receive history lines, defaults 10000 |
| `e2d4232` | 2026-09-28 | chore(tools): add pnpm install:macos to package and install the app |
| `ffef72a` | 2026-09-29 | feat(build): update macOS installation script to include cargo build step |
| `e245832` | 2026-10-09 | feat(rtthread): integrate AIC SDK and firmware build pipeline |
| `316d626` | 2026-10-09 | refactor(rtthread): reflow AIC build scripts for human reading |
| `c612aca` | 2026-10-09 | feat(rtthread): add flash:aic target using SDK aic-isp uploader |
| `a375f8f` | 2026-10-09 | docs(rtthread): flash:aic passes -b instead of --isp-baud to aic-isp |
| `7ebd312` | 2026-10-09 | chore(vendor): bump luban-lite for aic-isp baud flag change |
| `30b55cc` | 2026-10-10 | feat(rtthread): verify aic flashes with the new GET_MEDIA_CRC bootloader command |
| `c557a71` | 2026-10-10 | feat(app): AIC slim board verify page after full-UI OOM |
| `1bbccb6` | 2026-10-10 | feat(rtthread): XIP firmware, unified TLSF heap, drop data partition |
| `eb2f773` | 2026-10-11 | feat(rtthread): bring up RTL8189FTV WiFi on demo68-nor |
| `0c320e4` | 2026-10-12 | docs(aic): account for WiFi bring-up in memory plan, rewrite for readability |
| `0920a86` | 2026-10-12 | feat(rtthread): staged memory diagnostics and first P0 captures |
| `d7fa671` | 2026-10-12 | feat(core): raise serial baud rate cap to 6 Mbps |
| `3d0d6f2` | 2026-10-12 | docs(spec): revise to v0.2 with delivered/unimplemented split |
| `91f9918` | 2026-10-12 | chore(agents): add desktop-build, aic-build and desktop-test skills |
| `9dfbd2c` | 2026-10-12 | feat(rtthread): off-board memory probe for AIC packages |
| `ccf2d87` | 2026-10-12 | docs(plan): shared-UI memory optimization proposal |
| `b26712e` | 2026-10-22 | fix(desktop): integrate PocketJS 0.15 and preserve GPUI capabilities |
| `7d3d3c5` | 2026-10-22 | feat(app): add terminal feature profile and heap comparison |
| `9da1578` | 2026-10-22 | feat(config): register planned product features in one catalog |
| `6250f89` | 2026-10-22 | feat(mcp): add compile-time server trimming and heap comparison |
| `2ee13d9` | 2026-10-22 | feat(transports): add compile-time pruning and heap comparison |
| `ddc214a` | 2026-10-23 | feat(ui): add compile-time UI pruning and heap comparison |
| `2507431` | 2026-10-23 | chore(aic): profile shared UI and record board memory failure |
| `f5010e6` | 2026-10-23 | perf(aic): validate shared node prototype memory reduction |
| `3962b85` | 2026-10-23 | docs(aic): record step-one hardware validation |
| `682464f` | 2026-10-23 | perf(aic): defer narrow connection panel until first use |
| `2d84501` | 2026-10-23 | docs(aic): record step-two board memory results |
| `7285bfc` | 2026-10-23 | feat(e2e): support custom viewport resolutions |
| `d6fc0a1` | 2026-10-24 | feat(aic): adapt pocketjs renderer to the d12x ge 2d engine |
| `24302fd` | 2026-10-24 | docs(aic): record on-panel ge validation and bump pocketjs fork |
| `d26d988` | 2026-10-24 | fix(aic): bump pocketjs fork for portal host hitPass fix |
| `1a76980` | 2026-10-24 | feat(tools): simulate AIC baked fonts on the desktop host |
| `172b034` | 2026-10-24 | fix(app): render non-data texts in MiSans slot to fix baked-font CJK tofu |
| `3d4b3b8` | 2026-10-24 | fix(ui): enable touch scrolling in connection panel |
| `29ffd9b` | 2026-10-24 | docs(aic): record why the board profile stays at rasterDensity 1 |
| `24234e6` | 2026-10-24 | fix(aic): restore LCD pixel clock phase and bake only mapped glyphs |
| `2db87e9` | 2026-10-24 | feat(aic): add uart1 com.* serial bridge |
| `ceb28f3` | 2026-10-25 | refactor(ui): always soft-wrap receive log and simplify panel footer |
| `d9e6eaa` | 2026-10-25 | feat(app): add status-bar send pane collapse toggle |
| `8183a46` | 2026-10-25 | fix(ui): open soft keyboard editor on repeated field taps |
| `55ad04d` | 2026-10-25 | test(aic): use a fixed TLSF arena for off-device probes |
| `b33388a` | 2026-10-25 | fix(ui): reduce send pane and keyboard allocation peaks |
| `e1ec96a` | 2026-10-25 | fix(ui): render sys log lines in MiSans slot to fix board tofu |
| `f1ff41b` | 2026-10-26 | fix(aic): prevent combined panel OOM and add memory stress coverage |
| `b4159a0` | 2026-10-26 | fix(aic): use frame clock for receive coalescing |
| `7b8dc72` | 2026-10-26 | fix(app): enable touch scrolling in receive log |
| `402851c` | 2026-10-26 | feat(aic): integrate GE A8 blending and record device validation |
| `06c55ef` | 2026-10-28 | perf(aic): retain scalar styles and record device profiling |

## 附录 B：PocketJS fork（17 个）

| 提交 | 日期 | 标题 |
|---|---|---|
| `5201a0eb` | 2026-10-08 | feat(aic): host PocketJS on ArtInChip D12x via luban-lite |
| `a4c569d6` | 2026-10-10 | chore: ignore *.o object files |
| `7db40c10` | 2026-10-10 | feat(aic): allocate from the unified TLSF system heap |
| `ebfc3654` | 2026-10-12 | feat(aic): staged memory diagnostics for the board measurement plan |
| `57ffb464` | 2026-10-22 | chore: merge upstream main v0.15.0 into feat/aic |
| `518cf2a9` | 2026-10-22 | fix(gpui): retain the desktop host contract and small font slots |
| `44c81c83` | 2026-10-22 | feat(compiler): add application feature profiles and static pruning |
| `4acb1db2` | 2026-10-22 | feat(compiler): distinguish planned application features |
| `d32959c4` | 2026-10-23 | perf(runtime): share native node DOM facade functions |
| `da0e4927` | 2026-10-24 | feat(aic): offload rgb565 fills and psm5650 blits onto ge |
| `79a563d2` | 2026-10-24 | docs(aic): record on-panel ge validation |
| `bab50352` | 2026-10-24 | fix(framework): pass bounds hits through vue vapor portal host |
| `dcb3be8e` | 2026-10-24 | feat(aic): mount PocketCOM com.* serial bridge on uart1 |
| `1848fade` | 2026-10-26 | fix(aic): collect guest cycles under system heap pressure |
| `83637683` | 2026-10-26 | perf(vue-vapor): lower plain primitives and batch prop effects |
| `9a90bc1e` | 2026-10-26 | feat(aic): add staged GE A8 blending with aligned CMA buffers |
| `ffea265c` | 2026-10-28 | perf(aic): reduce UI overhead and add coarse diagnostics |

## 附录 C：luban-lite 项目 fork（9 个）

| 提交 | 日期 | 标题 |
|---|---|---|
| `98bc70fa` | 2026-09-17 | helloworld: count by 3 per click, doc aic-isp prebuilt bin/ |
| `1eb5690b` | 2026-10-08 | feat(pocketjs): host PocketJS on D12x demo68-nor |
| `c62f2d9a` | 2026-10-09 | feat(tools): drop aic-isp --isp-baud and reuse -b/--baud as download baud |
| `5114e783` | 2026-10-10 | chore: ignore *.o object files |
| `bf9f458a` | 2026-10-10 | feat(aicupg): add GET_MEDIA_CRC so aic-isp verifies flash by CRC |
| `81a127dc` | 2026-10-10 | feat(d12x): XIP firmware, unified TLSF system heap, drop data partition |
| `3da68f3f` | 2026-10-11 | feat(wifi): bring up RTL8189FTV on d12x pocketjs target |
| `ef55c659` | 2026-10-12 | feat(mem): add rt_memory_walk to summarize free blocks |
| `fa1db289` | 2026-10-24 | fix(d12x): restore 90-degree RGB pixel clock phase on pocketjs defconfig |
