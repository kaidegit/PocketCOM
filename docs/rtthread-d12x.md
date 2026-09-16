# PocketCOM 移植 ArtInChip D12x（RT-Thread + AIC GE）完整方案

状态：M5 预研产出（SPEC §8 M5「移植评估报告」）。本文是基于本地代码实证 + 官方文档 + 社区资料的可执行移植手册：从零开始，每一步给出具体命令、文件与验收标准。

- 调研基线：`vendor/pocketjs` @ 当前 submodule pin、luban-lite master（本地 `/Volumes/aigo_1t/DevPkgs/artinchip/luban-lite`，RT-Thread 内核 4.1.1）、pocketjs.dev 文档与博客、ArtInChip D12x Datasheet（2026-09 检索）。
- 结论先行：**可行**。D12x（玄铁 E907，RV32IMAFC @384–400MHz，8MB SiP PSRAM，GE 2D 引擎，480×272 RGB565 屏）落在 PocketJS 已验证硬件谱系内（该谱系包含 24MB RAM 的 PSP 和 ESP32-S3/P4 MCU）。技术路线 **照搬 PocketJS 官方 ESP-IDF 宿主的组件结构**，把 FreeRTOS 层换成 RT-Thread，把 PPA 加速器换成 AIC GE。工作量估计（单人）：**6–9 周**。

---

## 目录

1. [平台画像：D12x 与 luban-lite](#1-平台画像d12x-与-luban-lite)
2. [PocketJS 嵌入式运行模型（ESP 参照）](#2-pocketjs-嵌入式运行模型esp-参照)
3. [总体架构设计与关键决策](#3-总体架构设计与关键决策)
4. [Phase 0：环境准备](#4-phase-0环境准备)
5. [Phase 1：luban-lite 基线固件](#5-phase-1luban-lite-基线固件)
6. [Phase 2：PocketJS 引擎移植（先桌面验证、后上板 smoke）](#6-phase-2pocketjs-引擎移植)
7. [Phase 3：显示、触摸与帧循环](#7-phase-3显示触摸与帧循环)
8. [Phase 4：PocketCOM 应用嵌入式变体](#8-phase-4pocketcom-应用嵌入式变体)
9. [Phase 5：com.* 桥（串口/网络/配置）](#9-phase-5com-桥串口网络配置)
10. [回归主线 RT-Thread 的路线](#10-回归主线-rt-thread-的路线)
11. [性能评估与调优手段](#11-性能评估与调优手段)
12. [风险清单](#12-风险清单)
13. [附录：命令速查 / 路径速查 / 参考资料](#13-附录)

---

## 1. 平台画像：D12x 与 luban-lite

### 1.1 SoC（D12x Datasheet 实证）

| 项 | 规格 | 对移植的意义 |
|---|---|---|
| CPU | 平头哥 **玄铁 E907**，RV32IMAFC（单精度 FPU），384–400MHz | **不是 Cortex-A7**。RISC-V 32 位；Rust target 用 `riscv32imafc-unknown-none-elf`——与 ESP32-P4 官方用的 target **完全相同** |
| Cache | 32KB I-Cache + 16KB D-Cache，line 32B | CPU/GE/DE 共享内存，需 `aicos_dcache_clean_range/invalid` 维护一致性 |
| SRAM | 32KB @ `0x30040000` | 只放中断栈/关键段，JS 放不下 |
| PSRAM | SiP **8MB** @ `0x40000000`（demo68 板），200MHz | QuickJS 堆 + UI 树 + 引擎的主战场 |
| 显示 | DE 显示引擎 + LCDC，RGB888 24bit 物理接口，demo 板 480×272 | framebuffer 双 buffer（`CONFIG_AIC_PAN_DISPLAY=y`） |
| 2D 加速 | **GE 图形引擎**：fill（含渐变）、blit、H/V flip、90/180/270° 旋转、1/16–16x 双线性缩放、Porter-Duff alpha、colorkey、命令队列（CMDQ） | 对应 ESP32-P4 的 PPA（FILL/A8-BLEND/SRM），可做加速适配层 |
| 串口 | UART×4（16550 兼容） | PocketCOM 的核心 IO；console 默认 `uart1` |
| USB / 以太网 | **基础型号 D12x 都没有**（USB 在 d12p 型号上才有，CherryUSB） | USB 转串口 dongle、板子模拟 CDC 串口均不可行；网络只有 Wi-Fi |
| Wi-Fi | SDIO 外挂 **AIC8800** 模块（demo 板带），luban-lite 有驱动（默认不开） | TCP/UDP/WS 能力的唯一来源 |
| 触摸 | demo 板 **GT911** 电容触摸（I2C0，RST=PA.10，INT=PA.11） | 输入源 |
| 启动介质 | SD → SPI NOR → SPI NAND → eMMC（eFuse 可改） | demo68 有 nor/nand/mmc 三种 defconfig |
| 视频引擎 VE | JPEG/PNG 解码 720P@60 | 未来可解图片资源（本期不用） |

### 1.2 luban-lite（本地 SDK 实证）

- 内核 **RT-Thread 4.1.1**（`kernel/rt-thread/include/rtdef.h`：`RT_VERSION 4 / RT_SUBVERSION 1 / RT_REVISION 1`），OSAL 层 `kernel/common/include/osal/aic_osal.h`。
- 驱动三层：`bsp/artinchip/hal/*`（寄存器）→ `bsp/artinchip/drv/*`（rt_device）→ `packages/artinchip/mpp/*`（应用门面：`mpp_fb`/`mpp_ge`/`mpp_ve`）。**应用一律走 mpp 层**。
- d12x 的 defconfig（`target/configs/`）：
  - `d12x_demo68-nand_rt-thread_helloworld_defconfig`
  - `d12x_demo68-nor_rt-thread_helloworld_defconfig`
  - `d12x_demo68-mmc_rt-thread_helloworld_defconfig`
  - `d12x_hmi-nor_rt-thread_helloworld_defconfig`
  - defconfig 四元组：`CONFIG_PRJ_CHIP="d12x"` / `CONFIG_PRJ_BOARD="demo68-nor"` / `CONFIG_PRJ_KERNEL="rt-thread"` / `CONFIG_PRJ_APP="helloworld"`——**加自己的应用就是把 `PRJ_APP` 指到 `application/rt-thread/<app>/` 目录名**。
- 显示栈：`drv_de_core.c` + `drv_fb.c` → mpp 封装 `packages/artinchip/mpp/fb/mpp_fb.c`（`mpp_fb_open/ioctl/close`）。**没有 /dev/fb0**，ioctl 集：`AICFB_GET_SCREENINFO / AICFB_PAN_DISPLAY / AICFB_WAIT_FOR_VSYNC / AICFB_UPDATE_LAYER_CONFIG / AICFB_POWERON ...`（`bsp/artinchip/include/uapi/artinchip_fb.h`）。格式 `AICFB_FORMAT=0x0e`（RGB565），`CONFIG_AIC_PAN_DISPLAY=y` 时内建 2 个显示 buffer。
- GE 栈：`packages/artinchip/mpp/ge/mpp_ge.c`：`mpp_ge_open / mpp_ge_fillrect / mpp_ge_bitblt / mpp_ge_rotate / mpp_ge_emit / mpp_ge_sync`（Kconfig：`AIC_GE_NORMAL` / `AIC_GE_CMDQ`，demo defconfig 开 CMDQ）。现成测试：`packages/artinchip/mpp/mpp_test/ge_test/`（shell 命令 `ge_fill`/`ge_bitblt`/`ge_rotate`）。
- LVGL 已有完整 port（`packages/artinchip/lvgl-ui/lvgl_v9/lv_drivers/`：`lv_port_disp.c` 双 buffer + `lv_draw_ge2d` 硬件加速 + `lv_port_indev.c` 触摸）——**我们不用 LVGL，但它是显示/触摸/GE 用法的最佳参考代码**。
- 文件系统：rodata 分区为只读 FAT（`/rodata`），data 分区 FAT 或 littlefs（`/data`），构建期用 `AIC_FS_IMAGE_DIR_0/1` 指定的源目录打成镜像烧入——**`.pocket` 应用包就放这里**。
- 工具链：玄铁 **Xuantie-900 gcc V2.6.1**（SDK 内 `tools/toolchain/` 压缩包，首次 `scons` 自动解压），PREFIX `riscv64-unknown-elf-`，实际 `-march=rv32imafc -mabi=ilp32f`。
- 烧录：`scons` 后调 AiBurn 的 `aicupg` 命令（USB 下载 RAM updater），也支持 SD 卡升级。

### 1.3 与主线 RT-Thread 的关系（影响第 10 节）

- luban-lite = RT-Thread 4.1.1 + `bsp/artinchip` 全套驱动 + ArtInChip packages。**主线 RT-Thread（github.com/RT-Thread/rt-thread）没有任何 artinchip BSP**；主线软件包索引里也没有 quickjs（只有 jerryscript，默认 512KB 堆）。ArtInChip 官方没有向主线提交过驱动的记录（GitHub issue/PR 搜索为 0）。
- 社区最近似先例：立创「衡山派 D133EBS」（ArtInChip D133）维护的 `lcsc/luban-lite` fork + 自建 wiki——仍是 luban-lite 系。
- 结论：**先在 luban-lite 上把产品跑通（本篇 Phase 0–5），主线回归作为独立阶段（第 10 节）设计好隔离层再动手**。

---

## 2. PocketJS 嵌入式运行模型（ESP 参照）

PocketJS 官方嵌入式宿主是 `vendor/pocketjs/hosts/esp-idf/`（支持 ESP32-P4 / S3，IDF >=6.0,<6.2，quickjs-ng 0.14.0）。核心原则（`hosts/esp-idf/README.md` 原文）：**"The product firmware owns tasks, input drivers, display buffers, presentation, and package storage."**——任务、输入驱动、显示缓冲、呈现、包存储全部归产品固件；PocketJS 只提供七个纯 C/Rust 组件。

### 2.1 七个组件与依赖闭包

```
pocketjs_package          纯 C：解析 .pocket 容器 + host 准入校验（零依赖）
pocketjs_guest       ->   quickjs-ng：QuickJS realm、eval、globalThis.frame 调用、job 排水
pocketjs_ui_core          Rust(pocketjs-core) 的 C 包装：retained UI 树/taffy 布局/DrawList
pocketjs_ui_qjs      ->   guest + ui_core：挂 globalThis.ui、喂 PAK、执行一帧 turn
pocketjs_render_rgb565    Rust(pocketjs-render-rgb565) 的 C 包装：RGB565 damage 软渲染
pocketjs_esp32p4_ppa      仅 P4：PPA 硬件加速回调（D12x 上由 GE 适配层替位）
pocketjs_runner           唯一建 RTOS 任务的组件：精确节拍帧循环（可选）
```

其中 `package.c`、`ui_qjs.c`、`render_rgb565.c` 及全部生成头文件是**纯 C、零 OS 依赖**；RTOS 相关调用集中在 `runner.c`（FreeRTOS）和三个文件的内存策略（`heap_caps_*`）。上游甚至自带桌面垫片（`hosts/esp-idf/tests/host/include/{esp_err,esp_log,esp_heap_caps}.h`）证明这些组件可以脱离 IDF 编译——**这就是我们移植的工作量上界**。

### 2.2 包格式与准入

- `.pocket` 容器：`PCKT` header + manifest（pocket.json 原文）+ variant 表 + section 表（kind：1 identity / 2 plan / 3 js（NUL 结尾零拷贝 eval）/ 4 pak / 5 cover / **7 hostInputs（104B 准入记录）**）+ FNV footer。
- `.pak`：样式（`ui:styles`）、烘焙字形图集（`ui:font.<slot>`）、图片/精灵（`ui:img.*`）。
- 设备端校验：`pocketjs_package_select()` 逐项比对 target id、HostOps ABI、逻辑/物理宽高、rasterDensity、tick、32B host-profile SHA-256——**包与宿主画像强绑定**，宿主画像（`pocket.host.json`）改任何字段都要重新出包。
- JS 侧通过 `JS_SetImmutableArrayBuffer` 零拷贝借用 PAK 字节（quickjs-ng 需要上游 `prepare_quickjs.py` 打的两个 immutable 补丁）。

### 2.3 渲染管线（D12x 直接复用）

```
pocketjs_ui_turn(binding, &input, &frame)        # JS 一帧：frame() → tick → draw，产出 DrawList
pocketjs_rgb565_prepare(renderer, target, &frame, &plan)   # ≤8 个不相交 damage 矩形（≥75% 视口自动升为整帧）
pocketjs_rgb565_render_strip(renderer, &frame, strip, pixels, region, accelerator, &stats)
                                                 # 一次渲染一个"全视口宽条带"进调用方给的 uint16_t* 内存
pocketjs_rgb565_commit / abort                   # 提交 damage 历史 / 异步推屏失败回滚
```

要点：
- **没有完整帧 surface**，渲染器只产条带 → 条带指针可以直接指向 **framebuffer 后台缓冲的对应行**，省一次拷贝。
- 硬件加速通过回调结构体注入（`render_types.h`）：

```c
typedef struct {
  size_t struct_size; void *user_data;
  pocketjs_rgb565_fill_fn fill_rgb565;        // 纯色填充        → mpp_ge_fillrect
  pocketjs_rgb565_blend_fn blend_a8_rgb565;   // A8 掩码混合(文字) → 软件实现（GE 无逐像素掩码混合）
  pocketjs_rgb565_srm_fn  srm_psm5650_rgb565; // 整块搬移/缩放/旋转 → mpp_ge_bitblt(+rotate)
} pocketjs_rgb565_accelerator_t;
```
传 NULL 全部软件回退——**Phase 3 可以先全软件跑通，GE 适配作为纯优化项**。
- A8 scratch 要求 128 字节对齐；示例条带内存 `heap_caps_aligned_alloc(128, ..., DMA|INTERNAL)` → D12x 上用 `aicos_malloc_align(MEM_CMA, size, 32)` + dcache clean。

### 2.4 帧契约与输入

- 所有宿主统一驱动方式：每 tick 调 `globalThis.frame(buttons, analog?, touches?, hits?, touchSurfaces?)`（`framework/src/host.ts` 注释原文）；ESP 组件里由 `pocketjs_ui_turn()` 代为执行：触摸坐标压 wire 字（**9bit，x/y ≤ 511**）→ `pocketjs_guest_frame()` → `pocketjs_ui_core_tick/draw`。
- 宿主画像能力位：`input.buttons / input.touch / input.cursor / input.analog.left / text.glyphs.baked`。声明 `input.touch` 时逻辑视口必须 ≤512×512（480×272 满足）。
- **svc companion 方言**（`framework/src/host.ts` 的可选 HostOps `svcOpen/svcPoll/svcSend`）：宿主把键盘/IME/鼠标/滚动以 **JSON 行**逐 tick 投递（`{t:"mouse",x,y,d,b}` / `{t:"key",k}` / `{t:"ch",s}` / `{t:"scroll",dy}` / `{t:"paste",s}` / `{t:"hello",w,h}`）。SPEC §4.3 明确：**"该方言是 app 级协议而非宿主能力，可在嵌入式宿主上以触摸/按键复用同一 dispatcher"**。PocketCOM 全部指针交互（选区、右键、拖拽、点按转 press）都走 `app/svc.ts` 的 poll——没有 svc 通道时 app 退化为纯按键模式。**所以 D12x 宿主必须合成 svc 行**（见 §3 决策 4）。

### 2.5 字体烘焙（嵌入式约束，SPEC §5.4）

- 构建期 `framework/compiler/bake-font.ts` 扫 app 源码码点 + **ASCII 0x20–0x7E 恒定烘焙** + `--extra-chars` 补充；未知字形运行时解析为 gid 0（tofu），U+FFFD 有手绘映射。
- 默认字体：Inter Regular/Bold（UI 槽）+ **JetBrains Mono（mono 槽）**——后者与 PocketCOM 的 mono 字体天然一致，接收区/终端网格开箱即用。
- **UI 槽 Inter 不含 CJK**：i18n 中文文案必须额外烘焙或换字体。i18n 文案在 JSON 数据文件里，AST 扫描扫不到——必须显式 `--extra-chars` 传入（Phase 4 步骤 4.3），或给 `bake-font.ts` 加字体覆盖开关烘 MiSans（vendor 改动，见 §12 风险 R6）。

### 2.6 ESP 实战坑位（Pocket Pi 博客，pocketjs.dev/blog/pocket-pi-on-esp32-p4）

1. 全量 minify 生成深嵌套表达式会撑爆 QuickJS parser 栈（PocketJS 打包默认不压缩，无此问题；不要自行加 minifier）。
2. agent 任务默认 8KB 栈不够，单独开 64KB——RT-Thread 上 runner 线程栈直接给 32KB 起步。
3. LittleFS 对有打开句柄的文件 rename 返回 EBUSY——cfg 文件写入注意先关句柄。
4. ASCII-only 字形图集把弯引号渲染成 `I?m`——`--extra-chars` 要把 `’“”—…` 一并烘进去（从 i18n JSON 提取时自然覆盖）。
5. 大 bundle 启动解析慢（9MB bundle 解析 4 分钟）——PocketCOM bundle 542KB，量级安全。

---

## 3. 总体架构设计与关键决策

### 3.1 分层图

```
┌────────────────────────────────────────────────────────────────┐
│ PocketCOM app（不改）   app/*.tsx + core/* + bridge/*          │
│   逻辑视口 480×272，svc 驱动输入，com.* 契约降级探测           │
├────────────────────────────────────────────────────────────────┤
│ guest 运行时（移植，纯 C）                                     │
│   quickjs-ng 0.14.0 + immutable 补丁                           │
│   pocketjs_package / guest / ui_core / ui_qjs / render_rgb565  │
│   扩展：ui_qjs 端口额外挂 globalThis.svc 与 globalThis.com     │
├────────────────────────────────────────────────────────────────┤
│ Rust 引擎静态库（重编，不改源码）                               │
│   libpocketjs_idf_ui_core.a / libpocketjs_idf_render_rgb565.a  │
│   target = riscv32imafc-unknown-none-elf（与 P4 相同）          │
│   仅需 3 个 C 符号：pocketjs_idf_rust_alloc/dealloc/panic       │
├────────────────────────────────────────────────────────────────┤
│ RT-Thread 适配层（新写，放 host/rtthread/）                     │
│   垫片 esp_err/esp_log/heap_caps + runner 线程 + svc 合成      │
│   com 桥：uart/网卡/cfg + 显示后端（mpp_fb 翻页）+ GE 加速适配  │
├────────────────────────────────────────────────────────────────┤
│ luban-lite（RT-Thread 4.1.1 + bsp/artinchip + mpp_fb/mpp_ge）  │
└────────────────────────────────────────────────────────────────┘
```

目录规划（符合 SPEC §4.4 与 `host/rtthread/README.md` 的既有约定，作为 RT-Thread 离线软件包组织）：

```
host/rtthread/
├── SConscript                  # DefineGroup 收编全部 C 源
├── Kconfig                     # PKG_POCKETCOM [=y] + 选项（串口名/tick/日志）
├── shims/
│   ├── esp_err.h esp_log.h heap_caps.h    # ~40 行垫片（仿上游 tests/host/include）
│   └── rust_alloc.c            # pocketjs_idf_rust_alloc/dealloc/panic → aicos_malloc/rt_kprintf
├── components/                 # 从 vendor/pocketjs/hosts/esp-idf/components 拷贝的五个纯 C 组件
│   ├── pocketjs_package/ pocketjs_guest/ pocketjs_ui_core/
│   ├── pocketjs_ui_qjs/        # ★ 我们的 fork：额外挂 globalThis.svc / globalThis.com
│   └── pocketjs_render_rgb565/
├── runner/
│   └── runner.c                # runner.c 的 RT-Thread 化（rt_thread + rt_sem + tick deadline）
├── backend/
│   ├── disp.c                  # render_strip 条带 → fb 后台缓冲 → PAN_DISPLAY + WAIT_VSYNC
│   ├── ge_accel.c              # pocketjs_rgb565_accelerator_t 的 GE 实现（可选优化）
│   ├── touch.c                 # GT911 采样 → svc mouse 行合成
│   ├── svc_host.c              # svc 事件环（合成行 + 键盘行排队）
│   ├── com_serial.c            # uart rt_device → data 事件环
│   ├── com_net.c               # lwIP TCP/UDP/WS（Phase 5b）
│   └── com_cfg.c               # /data/pocketcom.json 读写（Phase 5c）
├── app_main.c                  # 装配：package_open → guest/core/ui_qjs → runner 起线程
└── lib/
    └── riscv32imafc/           # 预编译 Rust 静态库 ×2 + build-receipt
```

### 3.2 关键决策表

| # | 决策点 | 选择 | 理由与备选 |
|---|---|---|---|
| 1 | 代码路线 | 移植 `hosts/esp-idf` 五组件 + 自写适配层 | 与官方嵌入式宿主同构、准入/包格式/渲染全复用。备选 `engine/quickjs-c/pocket_runtime.c`（更小但只有 ARGB32 全帧接口、无 svc/ui 契约，PocketCOM 跑不了）——仅作引擎行为参考 |
| 2 | Rust target | `riscv32imafc-unknown-none-elf`（P4 同款）重编 | E907 = RV32IMAFC。P4 预编译归档理论上可直接链（同为 ilp32f），但保险起见从源码重编（工具链版本钉在 `hosts/esp-idf/native/toolchains.json`：rust 1.93.0） |
| 3 | 显示路径 | `render_strip` 条带直接写 fb 后台缓冲 + `AICFB_PAN_DISPLAY` + `AICFB_WAIT_FOR_VSYNC` | 零额外拷贝；双 buffer 由 `CONFIG_AIC_PAN_DISPLAY=y` 免费提供 |
| 4 | 输入路径 | **宿主合成 svc JSON 行**（触摸→mouse 行），frame() 的 touches 恒空、能力位只声明 `input.buttons` | PocketCOM 的全部交互语义（拖选/右键/滚轮/press）都在 svc 方言里，复用桌面 app 代码零改动；避免 svc 行与 frame touches 双路径重复投递 |
| 5 | 视口 | 固定 480×272（`pocket.host.json` logicalViewports `[[480,272]]` + 独立 manifest 变体 `viewport.fixed`） | 桌面 manifest 是 dynamic（min 720×480），480×272 过不了准入；引擎 vue-vapor Portal host 的"规格屏 480×272"怪癖在此板上反而严丝合缝 |
| 6 | 字体 | mono 槽用默认 JetBrains Mono；UI 槽先 Inter + i18n 码点 `--extra-chars`；MiSans 烘焙作为后续 vendor 增强 | Inter 无 CJK，`--extra-chars` 烘的中文用 Inter 缺字形 → 实际方案见 Phase 4.3 两选项 |
| 7 | 串口 | `rt_device` 框架挂 `uart0`（uart1 是 console），RX 用 DMA + 独立收线程 | 对齐 `bridge/serial.ts` 契约；demo68 的 RS232/RS485 收发器在 UART 上 |
| 8 | 网络 | Phase 5b：AIC8800 Wi-Fi（SDIO）+ lwIP 2.1.3，实现 tcp/udp（ws 视 mbedtls 裁剪情况） | d12x 无以太网；Wi-Fi 驱动成熟度是最大变数，所以放最后、可独立砍掉 |
| 9 | 配置存储 | `/data/pocketcom.json`（FAT/littlefs），宿主垫片实现 `cfgRead/cfgWrite` | `bridge/cfg.ts` 契约只需字符串读写；cfgExport/Import 无原生面板 → 返回 null 让 UI 降级（契约允许） |
| 10 | MCP | **不移植**，com 垫片对 mcp* 全返 null | MCP 需要 HTTP server；lwIP 理论可做但属独立大件（SPEC M5 明确"不实现"）。UI 侧 MCP 前缀/入口自动隐藏（SPEC §3 工作守则 3 的语义已内建） |

### 3.3 内存与 flash 预算（demo68-nor，8MB PSRAM / 16MB NOR）

| 段 | 内容 | 预算 | 说明 |
|---|---|---|---|
| PSRAM CMA（低段） | fb ×2 = 518KB、GE CMDQ 2KB、GE 源/目的 buffer（若启用加速）~512KB | ~1.1MB | `aicos_malloc(MEM_CMA,...)`，与 GE/DE 共享，注意 cache 维护 |
| PSRAM SW（堆，defconfig 4MB） | QuickJS 堆（guest heap_limit 建议先 2.5MB）+ UI 树/DrawList + svc/com 事件环 + `.pocket` 包字节（若从 /rodata 读入） | ~3.5MB | PocketCOM 包 542KB JS + 857KB PAK；参照 Pocket Pi 实测 304KB bundle ≈ 1.3MB 堆，542KB 估 2–3MB。不够就把 `CONFIG_AIC_PSRAM_SW_SIZE` 提到 0x600000（CMA 相应压缩） |
| NOR os 分区 | luban-lite 基线 + quickjs-ng (~500KB) + 引擎归档 (~300–500KB) + 组件 (~50KB) | defconfig os=3MB，**够但紧**；nand 版 os=2MB 需扩到 3–4MB | 改 `target/d12x/demo68-nor/pack/image_cfg.json` |
| NOR rodata 分区 | `pocketcom.pocket`（~1.5MB） | 10MB，绰绰有余 | 经 `AIC_FS_IMAGE_DIR_0` 目录打包 |

---

## 4. Phase 0：环境准备

目标：四套工具链全部就位，能编译 PocketCOM 桌面包与 luban-lite 基线镜像。

**步骤 0.1 — PocketCOM 侧（macOS 本机，已有）**

```sh
cd /Volumes/aigo_1t/GitRepo/PocketCOM
git submodule update --init --depth 1
cd vendor/pocketjs && bun install && cd -
npm run check && npm run build   # 产出 dist/pocketcom-main.js + .pak，证明构建链可用
bun test test/                   # 核心层单测基线
```

**步骤 0.2 — Rust 嵌入式 target**

```sh
rustup toolchain install 1.93.0          # 与 vendor/pocketjs/hosts/esp-idf/native/toolchains.json 一致
rustup target add riscv32imafc-unknown-none-elf --toolchain 1.93.0
rustup component add rust-src --toolchain 1.93.0   # 若需 -Zbuild-std
```

验证：`cargo build --release --locked --no-default-features --target riscv32imafc-unknown-none-elf --manifest-path vendor/pocketjs/hosts/esp-idf/native/ui-core/Cargo.toml`（先做一次冒烟，产物路径记下，Phase 2 正式走 `tools/esp-idf-native.ts` 流程）。

**步骤 0.3 — luban-lite 工具链**

SDK 自带玄铁工具链压缩包（`tools/toolchain/Xuantie-900-gcc-elf-newlib-x86_64-V2.6.1-*.tar.gz`），首次 `scons` 自动解压到 `<sdk>/toolchain/`。本机是 macOS：luban-lite 官方构建脚本面向 Linux/Windows，**macOS 原生跑不了 scons 全流程时，用一台 Linux 虚拟机/容器（或公司 Linux 服务器）作为固件构建机**，macOS 只负责 PocketCOM/PocketJS 构建与串口观测。以下命令均在 Linux 构建机执行。

```sh
cd /path/to/luban-lite          # 把 /Volumes/aigo_1t/DevPkgs/artinchip/luban-lite 同步到构建机
scons --list-def | grep d12x    # 确认 defconfig 可见
```

**步骤 0.4 — 硬件与线材**

- d12x demo 板（demo68，先确认手上是 nor/nand/mmc 哪种存储版本，后文以 `-nor` 示例，替换即可）。
- USB 转 TTL ×1（接 `uart1` console 观测日志，115200 8N1）。
- 目标串口线：demo 板 RS232 口或 TTL 直连 `uart0`（PocketCOM 被测串口）；回环测试时 TX↔RX 短接。
- AiBurn 上位机 + USB 线（烧录用）。

验收：`npm run build` 成功；rust target 冒烟编出 `.a`；luban-lite 能出镜像（Phase 1 完成）。

---

## 5. Phase 1：luban-lite 基线固件

目标：demo 板跑起 helloworld + 显示/触摸/GE/串口四个外设逐项验证通过（全用 SDK 现成测试命令，不写代码）。

**步骤 1.1 — 选择并应用 defconfig**

```sh
scons --apply-def d12x_demo68-nor_rt-thread_helloworld_defconfig
scons --menuconfig
```

menuconfig 检查/确认以下项（路径按 Kconfig 层级找）：

```
Application Options → Prj App = helloworld（暂不动）
Board Options(目标板) →
    [*] Using Display Engine (AIC_USING_DE)
    [*] Using GE (AIC_USING_GE)          # GE 模式选 CMDQ（默认）
    Panel → 480x272 RGB（CONFIG_AIC_PANEL_480X272_RESOLUTION=y，demo68 默认已对）
    Framebuffer → AICFB_FORMAT=RGB565、[*] AIC_PAN_DISPLAY（双 buffer）
    [*] Using Touch Panel (AIC_USING_TOUCH) → GT911（默认），I2C=i2c0
    [*] Using UART0 (AIC_USING_UART0)，UART1 为 console（默认）
Rt-Thread Options →
    [*] RT_USING_DFS + DFS 文件系统类型（elm FAT；nor 版按需 littlefs）
    [*] RT_USING_HEAP / MEMHEAP_AS_HEAP（默认开）
```

**步骤 1.2 — 编译与烧录**

```sh
scons                                   # 产物在 output/d12x_demo68-nor_rt-thread_helloworld/images/
scons --burn / run aicupg 上位机烧录    # 或 SD 卡升级（env 分区配置）
```

console（uart1, 115200）应看到 RT-Thread 启动 banner + msh 提示符。

**步骤 1.3 — 逐项外设验收（msh 命令）**

| 命令 | 来源 | 通过标准 |
|---|---|---|
| `help` / `version` | RT-Thread | 显示 4.1.1 |
| `test_fb` | `bsp/examples/test-fb/` | 屏幕出色块；`GET_SCREENINFO` 打印宽高 480×272、格式 RGB565、双 buffer 地址；`PAN_DISPLAY`+`WAIT_FOR_VSYNC` 无报错 |
| `ge_fill` / `ge_bitblt` / `ge_rotate` | `packages/artinchip/mpp/mpp_test/ge_test/` | 屏幕对应图形正确（fill 色块 / blit 搬移 / rotate 旋转），无超时 |
| `test_ctp` | `bsp/examples/test-ctp/` | 触摸坐标随手指打印，无漂移 |
| `test_uart`（或 `uart_test`） | `bsp/examples/test-uart/` | uart0 收发回环成功（先 TX↔RX 短接） |
| `ls /rodata` | — | rodata 分区挂载成功（Phase 4 放包的位置） |

把每一项的输出留档（`docs/` 或 issue），这是后面对比的基线。

**步骤 1.4 — 新建 PocketCOM 应用壳**

```sh
mkdir -p application/rt-thread/pocketcom
```

`application/rt-thread/pocketcom/SConscript`（抄 helloworld 模板）：

```python
from building import *
cwd = GetCurrentDir()
src = Glob('*.c') + Glob('shims/*.c') + Glob('runner/*.c') + Glob('backend/*.c')
CPPPATH = [cwd, cwd + '/shims',
           cwd + '/components/pocketjs_package/include',
           cwd + '/components/pocketjs_guest/include',
           cwd + '/components/pocketjs_ui_core/include',
           cwd + '/components/pocketjs_ui_qjs/include',
           cwd + '/components/pocketjs_render_rgb565/include']
CPPDEFINES = []
group = DefineGroup('Applications', src, depend=[''], CPPPATH=CPPPATH, CPPDEFINES=CPPDEFINES)
# Rust 静态库在此处并入 LIBS/LIBPATH（Phase 2）
Return('group')
```

`application/rt-thread/pocketcom/main.c` 暂时只 `rt_kprintf("pocketcom app\n");`。然后 `scons --menuconfig` 把 `CONFIG_PRJ_APP="pocketcom"`，重编重烧，console 应打印 `pocketcom app`。

验收：壳应用跑通，外设五项测试全绿。

---

## 6. Phase 2：PocketJS 引擎移植

目标：五个纯 C 组件 + 两个 Rust 静态库在 D12x 上跑通官方 smoke（**先在桌面全链路验证 hash，再上板**），屏幕还没亮没关系——先求 `pocketjs_ui_turn` + 软渲染条带 FNV hash 与桌面一致。

### 6.1 桌面先行验证（半天，避免上板盲调）

上游自带脱离 IDF 的编译证据：`vendor/pocketjs/hosts/esp-idf/tests/host/`（桌面垫片 + CMake）。我们照它给 RT-Thread 垫片做一次桌面单测：

**步骤 2.1 — 写垫片**（`host/rtthread/shims/`，共 ~60 行）

`esp_err.h`（抄上游 `tests/host/include/esp_err.h`）：

```c
#pragma once
#include <stdint.h>
typedef int esp_err_t;
#define ESP_OK 0
#define ESP_FAIL -1
#define ESP_ERR_NO_MEM 0x101
#define ESP_ERR_INVALID_ARG 0x102
#define ESP_ERR_INVALID_STATE 0x103
#define ESP_ERR_NOT_FOUND 0x105
#define ESP_ERR_NOT_SUPPORTED 0x106
```

`esp_log.h`：

```c
#pragma once
#include <stdio.h>
#define ESP_LOGE(tag, fmt, ...) fprintf(stderr, "E %s: " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_LOGI(tag, fmt, ...) printf("I %s: " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_LOGW(tag, fmt, ...) printf("W %s: " fmt "\n", tag, ##__VA_ARGS__)
#define ESP_ERROR_CHECK(x) do { esp_err_t e_ = (x); if (e_ != ESP_OK) { \
    fprintf(stderr, "ESP_ERROR_CHECK %d @%s:%d\n", e_, __FILE__, __LINE__); abort(); } } while (0)
```

`heap_caps.h`（桌面版 = 普通 malloc；板上版见步骤 2.4）：

```c
#pragma once
#include <stdlib.h>
#include <stddef.h>
#define MALLOC_CAP_SPIRAM 1
#define MALLOC_CAP_INTERNAL 2
#define MALLOC_CAP_8BIT 4
#define MALLOC_CAP_DMA 8
static inline void *heap_caps_malloc(size_t size, int caps) { (void)caps; return malloc(size); }
static inline void *heap_caps_aligned_alloc(size_t align, size_t size, int caps) {
    (void)caps; void *p = NULL; return posix_memalign(&p, align, size) == 0 ? p : NULL; }
static inline void heap_caps_free(void *p) { free(p); }
```

**步骤 2.2 — 桌面编译五组件并跑 smoke hash**

在 `host/rtthread/` 下加一个仅供桌面验证的 makefile/脚本（不进 SConscript），把 `components/*` 的 C 源 + 垫片 + 上游 `tests/host/` 的驱动 main 一起编成 macOS 可执行文件，跑官方 smoke 包（`bun tools/pocket.ts build --host-profile hosts/esp-idf/examples/smoke/pocket.host.json` 产出的 `.pocket`），对齐上游 `examples/smoke` 的 FNV hash 断言。此后**垫片与组件的任何改动都在桌面回归，上板只剩板级问题**。

### 6.2 Rust 归档

**步骤 2.3 — 重编引擎静态库**

```sh
cd vendor/pocketjs
bun tools/esp-idf-native.ts --target esp32p4 --cargo cargo
# 若该脚本钉死 P4 工具链，等价手工命令：
cargo +1.93.0 build --release --locked --no-default-features \
  --target riscv32imafc-unknown-none-elf \
  --manifest-path hosts/esp-idf/native/ui-core/Cargo.toml
cargo +1.93.0 build --release --locked --no-default-features \
  --target riscv32imafc-unknown-none-elf \
  --manifest-path hosts/esp-idf/native/render-rgb565/Cargo.toml
```

产物拷到 `host/rtthread/lib/riscv32imafc/libpocketjs_idf_ui_core.a`、`libpocketjs_idf_render_rgb565.a`（连同各自 `build-receipt.json`）。

Rust 侧只向 C 要三个符号（`hosts/esp-idf/native/runtime/src/lib.rs` 的 `#[global_allocator]`/`#[panic_handler]`），`host/rtthread/shims/rust_alloc.c` 板上实现：

```c
#include <stddef.h>
#include <rtthread.h>
void *pocketjs_idf_rust_alloc(size_t size, size_t align) {
    return aicos_malloc_align(0, size, align > 32 ? align : 32);  /* 系统堆(PSRAM SW) */
}
void pocketjs_idf_rust_dealloc(void *p) { aicos_free(0, p); }
void pocketjs_idf_rust_panic(void) {
    rt_kprintf("POCKETJS RUST PANIC\n");
    while (1) { rt_thread_mdelay(1000); }
}
```

（对齐分配也可走 `rt_malloc_align`；`aicos_malloc_align(0,..)` 与 `rt_malloc_align` 在 `RT_USING_MEMHEAP_AS_HEAP` 下等价，选团队熟悉的。）

**ABI 自检**（防止玄铁工具链与 Rust target 不匹配）：

```sh
riscv64-unknown-elf-readelf -h output/.../images/d12x_os.elf | grep -E "Flags|Machine"
riscv64-unknown-elf-readelf -h host/rtthread/lib/riscv32imafc/libpocketjs_idf_ui_core.a | head
# 双侧都应为 RISC-V、float ABI=double?否——ilp32f(single)； architectures 一致即可
```

链接时给 SConscript 加 `LINKFLAGS = ['-march=rv32imafc','-mabi=ilp32f']` 对齐（如构建机 rtconfig.py 已设则不动）。

### 6.3 quickjs-ng

**步骤 2.4 — quickjs-ng 0.14.0 编译进固件**

- 源：组件 `pocketjs_guest/idf_component.yml` 声明 `espressif/quickjs-ng: 0.14.0`；RT-Thread 侧直接从 quickjs-ng 上游拉 0.14.0 tarball，放进 `host/rtthread/components/quickjs/`。
- **必须执行上游补丁**：`components/pocketjs_guest/tools/prepare_quickjs.py`（校验源 hash 后打 immutable-arraybuffer 相关两处补丁并拷贝到 build 目录）。RT-Thread 侧复用该脚本产出的补丁副本，把它作为提交进仓库的预打补丁源码（luban-lite 无 npm 生态，别把补丁流程塞进 scons）。
- 编译开关：ANSI C 即可；关掉 quickjs-libc 中依赖完整 POSIX 的文件类 helper（`js_std_add_handlers` 等）——guest 只需要 console/print。裁剪方法：不编 `quickjs-libc.c` 的文件部分，或提供空的 `js_std_add_helpers`。
- `CCFLAGS` 加 `-Wno-...` 按 scons 输出微调；`DSO` 相关不用。

### 6.4 上板 smoke

**步骤 2.5 — 生成 smoke 包并上板**

```sh
cd vendor/pocketjs
bun tools/pocket.ts build --host-profile hosts/esp-idf/examples/smoke/pocket.host.json \
  --manifest hosts/esp-idf/examples/smoke/pocket.json --project-root hosts/esp-idf/examples/smoke \
  --output /tmp/smoke.pocket
python3 components/pocketjs_package/tools/embed_package.py \
  /tmp/smoke.pocket pocketcom_smoke   # 生成 pocketcom_smoke.{h,c,S}
```

把三个生成文件放进 `application/rt-thread/pocketcom/embed/`（由 SConscript 的 Glob 收编）。这样包内嵌固件，免文件系统依赖——**Phase 4 才切到 /rodata 文件方案**。

**步骤 2.6 — `app_main.c` 装配（照抄 ESP smoke main.c 的调用序列）**

```c
#include <rtthread.h>
#include "pocketjs/package.h" "pocketjs/guest.h" "pocketjs/ui_core.h"
#include "pocketjs/ui_qjs.h" "pocketjs/render_rgb565.h" "pocketcom_smoke.h"

static pocketjs_ui_qjs_t *binding;
static pocketjs_ui_core_t *core;
static pocketjs_guest_t *guest;
static pocketjs_rgb565_renderer_t *renderer;

static int pocketcom_init(void) {
    pocketjs_package_t *pkg;
    ESP_ERROR_CHECK(pocketjs_package_open(pocketcom_smoke.data, pocketcom_smoke.size, 0, &pkg));
    pocketjs_package_variant_t app = {.struct_size = sizeof(app)};
    ESP_ERROR_CHECK(pocketjs_package_select(pkg, &pocketcom_smoke_contract, &app));

    pocketjs_guest_config_t gc; pocketjs_guest_config_defaults(&gc);
    gc.heap_limit = 2u * 1024u * 1024u;      /* PSRAM 预算内先给 2MB */
    ESP_ERROR_CHECK(pocketjs_guest_create(&gc, &guest));

    pocketjs_ui_core_config_t cc; pocketjs_ui_core_config_defaults(&cc);
    cc.logical_width  = pocketcom_smoke_contract.logical_width;   /* 320 */
    cc.logical_height = pocketcom_smoke_contract.logical_height;  /* 240 */
    cc.raster_density = pocketcom_smoke_contract.raster_density;
    cc.tick_hz        = pocketcom_smoke_contract.tick_hz;         /* 60 */
    ESP_ERROR_CHECK(pocketjs_ui_core_create(&cc, &core));

    const pocketjs_ui_qjs_config_t bc = {.struct_size = sizeof(bc),
        .target_id = pocketcom_smoke_contract.target_id,
        .host_abi  = pocketcom_smoke_contract.host_abi};
    ESP_ERROR_CHECK(pocketjs_ui_qjs_create(guest, core, &bc, &binding));
    ESP_ERROR_CHECK(pocketjs_ui_qjs_feed_pak(binding, app.pak.data, app.pak.size));
    ESP_ERROR_CHECK(pocketjs_ui_qjs_mount(binding));
    ESP_ERROR_CHECK(pocketjs_guest_eval(guest, (const char *)app.javascript.data,
                                        app.javascript.size - 1u, "pocketcom"));
    /* 帧循环 Phase 3 接管；此处先手跑一帧做 hash 验证 */
    pocketjs_ui_frame_view_t frame = {.struct_size = sizeof(frame)};
    pocketjs_ui_input_t input = {.struct_size = sizeof(input)};
    ESP_ERROR_CHECK(pocketjs_ui_turn(binding, &input, &frame));
    /* ... prepare/render_strip/commit + FNV hash 打印（照抄 smoke main.c）... */
    return 0;
}
MSH_CMD_EXPORT(pocketcom_init, pocketcom smoke);
```

**步骤 2.7 — 验收**

- 桌面：smoke hash 与上游 `examples/smoke` 预期一致。
- 板上：`msh> pocketcom_init` 打印 `PASS target=aic-d12x-smoke hash=...`，**hash 值与桌面一致**（同一 `.pocket` + 同 contract ⇒ 字节级同图，这正是 PocketJS 的确定性承诺）。
- 内存观测：`free` / `list_thread` 记录基线 heap 占用。

---

## 7. Phase 3：显示、触摸与帧循环

目标：smoke 应用 60Hz 真实上屏，GT911 触摸可点。

**步骤 3.1 — 显示后端 `backend/disp.c`**

```c
#include "mpp_fb.h"
static struct mpp_fb *fb;
static struct aicfb_screeninfo si;

int disp_init(void) {
    fb = mpp_fb_open();
    mpp_fb_ioctl(fb, AICFB_GET_SCREENINFO, &si);   /* width/height/stride/format/framebuffer */
    return 0;
}

/* 把一帧的每个 damage 矩形画进"后台 buffer"，然后翻页。
 * si.framebuffer 是前台；CONFIG_AIC_PAN_DISPLAY=y 时后台 = framebuffer + fb_size（参考 lv_port_disp.c） */
int disp_present(pocketjs_ui_frame_view_t *frame, pocketjs_rgb565_damage_plan_t *plan) {
    uint16_t *back = (uint16_t *)((uint8_t *)si.framebuffer + si.buf_size);  /* 后台缓冲 */
    for (uint32_t i = 0; i < plan->region_count; ++i) {
        const pocketjs_rgb565_rect_t *r = &plan->regions[i];
        uint16_t *strip = back + (size_t)r->y * (si.stride / 2) + r->x;
        pocketjs_rgb565_render_stats_t st;
        /* 直接把条带渲进 fb 后台缓冲（零拷贝路径） */
        pocketjs_rgb565_render_strip(renderer, frame, strip,
            (size_t)frame->logical_width - r->x, *r, accel_get(), &st);
        /* PSRAM 有 cache：CPU 写完必须 clean，DE 才能看到 */
        aicos_dcache_clean_range((unsigned long)strip,
            (unsigned long)((si.stride / 2) * r->height * 2));
    }
    mpp_fb_ioctl(fb, AICFB_PAN_DISPLAY, NULL);     /* 翻页（IoctlType 视 uapi 签名传 buf 参数） */
    mpp_fb_ioctl(fb, AICFB_WAIT_FOR_VSYNC, NULL);  /* 等待场同步，天然限速 60Hz */
    pocketjs_rgb565_commit(renderer, NULL, frame);
    return 0;
}
```

注意：
- `AICFB_PAN_DISPLAY` 的准确用法（buf id 参数）以 `test_fb.c` 与 `lv_port_disp.c` 为准，上面是骨架。
- stride 是字节，render_strip 输出连续行；damage x 偏移导致条带不是整行宽时，`pixels = width - x`、每行末尾跳 stride——若上游 render_strip 契约要求"全视口宽条带"（一次一个 full-width strip），则把条带起点固定 `x=0`、宽 = 逻辑宽，逐 region 渲染后由 fb 自身 stride 对齐（官方 smoke 就是 `frame.logical_width * region.height` 的整宽条带）。**实现时以 `pocketjs_rgb565_render_strip` 头文件注释为准**，两种落法都不影响正确性，只差一次 memcpy。
- cache line 32B：条带起点对齐到 32（render_strip 的 MASK_ALIGNMENT=128 是 A8 scratch 的要求，由 Rust 内部自管；CPU 直写 fb 的 clean 范围用 `aicos_dcache_clean_range` 即可）。

**步骤 3.2 — GE 加速适配 `backend/ge_accel.c`（可选，先空着）**

软件渲染跑通并测得帧耗时后再做。映射关系：

```c
static bool ge_fill(void *ud, const pocketjs_rgb565_fill_desc *d) {
    struct mpp_ge *ge = ud;
    struct ge_fillrect f = {
        .type = GE_NO_GRADIENT,
        .start_color = rgb565_to_argb(d->color),
        .dst_buf = { .phy_addr = d->dst_phys, .stride = d->dst_stride,
                     .size = {d->w, d->h}, .format = MPP_FMT_RGB565 },
    };
    return mpp_ge_fillrect(ge, &f) == 0 && mpp_ge_sync(ge) == 0;   /* CMDQ 模式可 emit 攒批 */
}
/* blend_a8_rgb565：GE 无逐像素 A8 掩码混合 → 保持 NULL（软件）。
 * srm_psm5650_rgb565（整块搬移/滚动）：→ mpp_ge_bitblt（crop 即 region），必要时加 rotate。 */
```

物理地址从 `aicos_virt_to_phys()`（或 CMA 段分配即物理连续）取；GE buffer 用 `aicos_malloc(MEM_CMA, ...)`。**fill 与滚动 blit 是 PocketCOM 的高频操作（状态栏/面板底色、日志滚动），这两项值得做；文字 A8 混合留给 CPU。**

**步骤 3.3 — runner 线程 `runner/runner.c`（FreeRTOS runner.c 的 RT-Thread 化）**

```c
static void runner_entry(void *arg) {
    uint64_t started = tick_us();
    for (uint32_t tick = 0; !stop; ++tick) {
        pocketjs_ui_input_t input = {.struct_size = sizeof(input)};
        svc_sample_input(&input);                      /* Phase 3 只填 buttons=0/touches=NULL */
        pocketjs_ui_frame_view_t frame = {.struct_size = sizeof(frame)};
        esp_err_t e = pocketjs_ui_turn(binding, &input, &frame);
        if (e != ESP_OK) { rt_kprintf("turn fail %d\n", e); break; }
        disp_present(&frame);
        svc_flush_lines();                             /* 把合成好的 svc 行送进 guest（Phase 3.4） */
        /* 绝对 deadline 节拍：60Hz，滞后 >500ms 跳帧 */
        uint64_t deadline = started + (uint64_t)(tick + 1) * 1000000ull / TICK_HZ;
        int64_t rest = (int64_t)(deadline - tick_us());
        if (rest > 0) rt_sem_take(wake_sem, rt_tick_from_millisecond(rest / 1000));
        else skipped++;
    }
}
/* 创建：rt_thread_create("pocketjs", runner_entry, NULL, 32*1024, 20, 20) + startup */
```

`tick_us()` 用 `rt_tick_get()` 换算（1ms 精度对 60Hz 够用）或 D12x CPU timer。触摸/串口线程在事件到达时 `rt_sem_release(wake_sem)` 提前唤醒（可选优化）。

**步骤 3.4 — 触摸 → svc 行合成 `backend/touch.c` + `backend/svc_host.c`**

GT911 驱动已在 Phase 1 验证（`AIC_TOUCH_PANEL_NAME` 设备）。做法：触摸线程 30–60Hz 采样（参考 `lv_port_indev.c`/`lv_tpc_rtp.c` 的读法），把"按下/移动/抬起"翻译成与桌面宿主一致的事件行（语义对照 `app/svc.ts` 的 `HostEvent`）：

```c
/* 按下: */ svc_line("{\"t\":\"mouse\",\"x\":%d,\"y\":%d,\"d\":true,\"b\":1}", x, y);
/* 移动(按住): 同上 d:true，坐标去抖（>2px 才发） */
/* 抬起: */ svc_line("{\"t\":\"mouse\",\"x\":%d,\"y\":%d,\"d\":false,\"b\":1}", x, y);
/* 长按 >600ms（可选）: 发一次 {"t":"mouse",...,"d":true,"b":2} 模拟右键菜单 */
```

svc 行先落本地环形队列；**真正投递给 guest 的时机在帧内**——`pocketjs_ui_qjs` 的端口层提供 `svcPoll()` 实现，从队列取"自上次 poll 以来的完整行"拼成单个字符串返回（与桌面宿主逐 tick 批量投递一致）。开机时投一行 `{"t":"hello","w":480,"h":272}`（驱动 `app/layout.ts` 的 `viewportSize`）。`svcOpen("pocketcom")` 恒返回 true。

**步骤 3.5 — ui_qjs 端口扩展（挂 svc 与 com）**

上游 `pocketjs_ui_qjs` 只挂 `globalThis.ui`。我们的端口（`host/rtthread/components/pocketjs_ui_qjs/`）在同一 binding 上额外装：

```c
/* globalThis.svc —— @pocketjs/framework HostOps 契约（framework/src/host.ts）:
 *   svcOpen(app) -> true / svcPoll() -> string|undefined / svcSend(line) */
/* globalThis.com —— PocketCOM 契约（bridge/com.ts 的 ComNs）:
 *   serialList/serialOpen/write/setSignals/close/poll (+tcpConnect/tcpListen/udpBind/wsConnect/cfg*/mcp* 后续补) */
```

理由：`ui_qjs.c` 已持有 `JSContext` 与安装点，加两个对象不影响 guest 组件；`svc` 的形状按 framework 的可选 HostOps 契约实现即可被 `getOps()` 探测到；`com` 的形状按 `bridge/com.ts` 的 `ComNs` 实现、缺的方法直接不装（JS 侧 feature-detect 降级为 null）。

**步骤 3.6 — 验收**

- smoke 应用以 60Hz 上屏，帧率用 `frames_skipped` 计数观察（>1% 跳帧则先降 `tickHz=30` 记录基线）。
- 触摸点击 smoke 界面无响应也算正常（smoke 无交互），用手写 mini app（一个 `onPress` 计数按钮，走 `bun tools/pocket.ts build --host-profile ...`）验证 svc mouse 行 → press 的整链路。
- `list_thread`：pocketjs 线程栈水位（`list_thread` 显示 max used），32KB 不够就加。

---

## 8. Phase 4：PocketCOM 应用嵌入式变体

目标：PocketCOM 本体（Vue Vapor 版）在 480×272 上启动、可操作、i18n 文案完整。

**步骤 4.1 — 宿主画像 `app/d12x.pocket.host.json`**

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-idf-host-1.json",
  "version": 1,
  "id": "aic-d12x",
  "platform": "esp-idf",
  "form": "embedded",
  "tickHz": 60,
  "display": {
    "physicalViewport": [480, 272],
    "logicalViewports": [[480, 272]],
    "presentations": ["native"],
    "rasterDensity": 1
  },
  "capabilities": ["input.buttons", "text.glyphs.baked"]
}
```

说明：`platform` 目前是 schema 常量 `"esp-idf"`（`contracts/spec/idf-host.ts`），设备端校验的是 target id/ABI/hash，不是这个字符串——先用它，等上游愿意加 `"rt-thread"` 常量再换（§12 R7）。`id` 必须 ≤15 字节。不声明 `input.touch`（决策 4：输入全走 svc 合成行，避免与 frame touches 双路径）。

**步骤 4.2 — 应用清单变体 `app/pocket.d12x.json`**

```json
{
  "$schema": "https://pocketjs.dev/schema/pocket-2.json",
  "pocket": 2,
  "id": "dev.kaidegit.pocketcom",
  "name": "pocketcom",
  "title": "PocketCOM",
  "version": "0.1.0",
  "engine": { "capabilities": {
    "requires": ["text.glyphs.baked", "input.buttons"],
    "enhances": ["input.text", "host.clipboard"] } },
  "app": {
    "entry": "app/main.tsx",
    "output": "pocketcom-d12x",
    "framework": "vue-vapor",
    "viewport": { "logical": [480, 272], "presentation": "native" }
  }
}
```

与桌面 `app/pocket.json` 的差异只有：viewport 固定 480×272（dynamic min 720×480 过不了准入）、去掉 `companions`（svc 由我们宿主直供，`svcOpen` 恒真）、去掉桌面专属 enhances（`text.layout.native`/`text.glyphs.runtime`/`display.viewport.live`/`input.ime`/`input.pointer`——嵌入式没有运行时排版与实时视口）。**app 源码零改动**；若后续觉得 272 高度下 `PANEL_FOOTER_H` 拥挤，再做一个小变体常量表（app 侧改，不动框架）。

构建命令（放 `package.json` scripts：`"build:d12x": "bun vendor/pocketjs/tools/pocket.ts build --host-profile app/d12x.pocket.host.json --manifest app/pocket.d12x.json --project-root . --output dist/pocketcom-d12x.pocket"`）：

**步骤 4.3 — 字形烘焙（关键步骤）**

mono 槽 JetBrains Mono 开箱即用；UI 槽 Inter 缺 CJK，两个选项：

- **选项 A（MVP，推荐先做）**：设备端语言包切 `en`（`settings` 里切），同时把 zh-CN 文案的码点也烘进去以防 UI 短文案缺字：

```sh
# 从两个语言包提取全部非 ASCII 码点（含弯引号等，Phase 2.6 坑位 4）
bun -e 'const fs=require("fs");const zh=JSON.parse(fs.readFileSync("assets/i18n/zh-CN.json"));
const en=JSON.parse(fs.readFileSync("assets/i18n/en.json"));
const s=JSON.stringify(zh)+JSON.stringify(en);
const chars=[...new Set([...s])].filter(c=>c.codePointAt(0)>0x7e).join("");
fs.writeFileSync("/tmp/extra-chars.txt",chars);'
bun vendor/pocketjs/tools/pocket.ts build --host-profile app/d12x.pocket.host.json \
  --manifest app/pocket.d12x.json --project-root . \
  -- --extra-chars="$(cat /tmp/extra-chars.txt)"
```

  注意：Inter 没有 CJK 字形，烘了也只对 JetBrains Mono 槽生效有限——**真正可行的是中文文案走 mono 槽渲染或接受 tofu**，所以 MVP 建议设备端 UI 用英文，中文支持交给选项 B。
- **选项 B（完整中文）**：给 `bake-font.ts` 加字体覆盖（如 env `POCKETJS_FONT_REGULAR=path/to/MiSans-Regular.ttf`），UI 槽烘 MiSans + i18n 码点子集（~300–500 字，图集体积可控在几百 KB）。这是 vendor/pocketjs 的改动，做成可上游的 env 开关（§12 R6）。assets/fonts 里的 MiSans TTF 可直接复用。

**步骤 4.4 — `.pocket` 放 /rodata 并读入**

```sh
cp dist/pocketcom-d12x.pocket <sdk>/rodata/pocketcom.pocket   # AIC_FS_IMAGE_DIR_0 指向的目录
# 构建机: scons  → rodata.fatfs 会包含它 → 烧录
```

`app_main.c` 改为从文件系统读包（替换 Phase 2 的内嵌数组）：

```c
int fd = open("/rodata/pocketcom.pocket", O_RDONLY, 0);
/* 读进 PSRAM 堆（~1.5MB），然后照旧 pocketjs_package_open(buf, size, 0, &pkg) */
```

（`pocketjs_package_open` 只要"内存里一段字节"，从 FAT/littlefs 读入与从内嵌数组给入无差别；后续要省 RAM 可换成直接 mmap 到 XIP/rodata——先不优化。）

**步骤 4.5 — com 垫片最小实现（让 app 能启动）**

Phase 4 先装"空桥"：`globalThis.com` 只挂 `serialList() -> "[]"` 与 `poll() -> null`，其余不装。`bridge/com.ts` 的 `connectCom()` 探测六个必备 op——缺一个即返回 null，app 全量降级为"无连接"模式（UI 正常渲染，连接操作报错提示）。这样 Phase 4 与 Phase 5 解耦。

**步骤 4.6 — 验收清单**

- `pocketcom_init` → UI 完整上屏：状态栏 + 左配置面板 + 接收/发送区，480×272 布局无错位（重点看 absolute 定位块与 Portal 弹层——引擎规格屏恰好 480×272）。
- 设置弹窗（页脚"应用配置"）打开/Escape/遮罩关闭全链路可用。
- 接收区滚动、发送历史下拉、终端模式切换可用（触摸）。
- `frames_skipped` 稳定；`free` 显示 heap 余量 > 20%。
- i18n：英文完整；中文按 4.3 所选选项验证。

---

## 9. Phase 5：com.* 桥（串口/网络/配置）

目标：PocketCOM 变成真能用的串口工具。所有实现都在宿主 C 侧，把 `bridge/com.ts` 的 `ComNs` JSON 协议对齐 `host/macos/src/com_serial.rs` 等的语义（它们是协议的权威参考实现）。

### 5a. 串口（核心）

**步骤 5.1 — `backend/com_serial.c`**

- 打开：`rt_device_find("uart0")` → `RT_SERIAL_GET_CONFIG` → 设 `baud_rate/data_bits/stop_bits/parity` → `RT_SERIAL_SET_CONFIG` → `rt_device_open(RT_DEVICE_OFLAG_RDWR | RT_DEVICE_FLAG_DMA_RX)` → `rt_device_set_rx_indicate()`。
- RX 线程：indicate 回调里 `rt_sem_release`；线程 drain `rt_device_read` 进 64KB 环形缓冲；**每帧把增量数据 base64 编码成 `{t:"data",h:0,b64:"..."}` 行压进 com 事件环**（帧合流天然由"每 tick 一次 poll"完成，与 macOS 宿主行为一致；115200 ≈ 11.5KB/s，一帧 60Hz ≈ 192B/帧，无压力）。
- `serialList()` 返回静态枚举：`[{"path":"uart0","...":...}]`（形状对照 `bridge/serial.ts` 的 `SerialPortInfo`；console 的 uart1 标注或剔除）。
- `write()`：`rt_device_write`，返回排队结果；错误经 `{t:"error"/"closed",h,...}` 事件回报。
- `setSignals()`：DTR/RTS 走 `RT_SERIAL_CTSRTS`/AIC 驱动的 ioctl（在 Phase 1 用 `test_uart` 验证过能力）。
- JSON 组装：用 SDK 自带 cJSON-1.7.16。

**验收**：板上 uart0 TX↔RX 短接，UI 里打开 uart0@115200 → 发送任意 → 接收区按帧合流显示；HEX 模式比对字节；3M 波特（若 RS232 收发器支持）压测 `core` 的帧合流；对照 `test/host/macos/serial_tests.rs` 的语义逐条核对（参数校验/事件格式/close 语义/立即重开）。

### 5b. 网络（可选，独立可砍）

**步骤 5.2 — Wi-Fi 起来**

```text
menuconfig:  [*] LPKG_USING_LWIP (2.1.3)
             bsp peripheral → wlan → AIC8800（SDIO，AIC_WIFI_SDMC_ID=1）
参考: bsp/examples/test-wifi/、test-lwip/
```

起 DHCP 拿到 IP 是本步唯一目标（风险最高的一步，见 §12 R4）。

**步骤 5.3 — `backend/com_net.c`**

- socket 用 lwIP BSD API（`socket/connect/bind/accept`），协议语义对照 `host/macos/src/com_tcp.rs/com_udp.rs`：`{"t":"opened"/"accepted"/"closed"...}` 事件、tcps 句柄广播、踢除语义。
- WS：lwIP 无 TLS，`ws://` 明文可做（自己写握手或移植一个微型 ws client）；`wss://` 依赖 mbedtls（SDK 有 mbedtls 包，裁剪后内存代价 ~40KB）——先不做。
- **不做** `0.0.0.0` 监听以外的任何无鉴权服务（工作守则 4；TCP Server 监听属 SPEC 明文例外）。

**验收**：PC 与板子同网段，PC 起 TCP echo → 板子 netOpen/connect/互发；tcps 双客户端广播；对照 `test/host/macos/tcp_tests.rs`/`udp_tests.rs` 语义。

### 5c. 配置持久化

**步骤 5.4 — `backend/com_cfg.c`**

- `cfgRead()`：`open("/data/pocketcom.json")` 全文读出；不存在返 null。
- `cfgWrite()`：写临时文件 → `rename()` 原子替换（littlefs 的 rename-with-open-handle EBUSY 坑，写前确保关闭句柄）；权限概念在 FAT/littlefs 上不存在，0600 语义记录在文档即可。
- `cfgExport/cfgImport`：无原生文件面板，返 null（设置弹窗对应按钮降级，SPEC 契约允许）。
- `core/config` 的 schema/归一化/封顶逻辑在 JS 侧（`core/config.ts`），宿主不用管。

**验收**：改设置 → 应用 → 断电重启 → 配置恢复；导出 token 不落盘问题不存在（无 MCP）。

---

## 10. 回归主线 RT-Thread 的路线

前提认知：主线没有任何 AIC BSP 与先例，"回归主线"= 自建 `bsp/artinchip/d12x`（或先用社区 BSP 形态），工作量集中在驱动移植与持续跟进主线 API 演进。**设计约束从 Phase 2 起就要遵守**：`host/rtthread/` 里我们的代码只允许调用以下接口——

```
rt_thread/rt_sem/rt_mutex/rt_msgqueue   rt_device(serial 框架)   dfs 文件 POSIX 层
rt_tick / rt_kprintf                    aicos_malloc[_align]/dcache_* （AIC OSAL，唯一 AIC 专属）
mpp_fb / mpp_ge                          （AIC 专属，经 backend/ 包装）
```

后两类已全部收口在 `shims/rust_alloc.c` + `backend/*`，**切换平台 = 重写 backend/，app 与组件层零改动**。

### 10.1 主线 BSP 工程（Phase M，独立立项）

1. **起 BSP**：按主线 `bsp/README.md` 的提交规范，从 luban-lite 的 `target/d12x/common + demo68-*` 与 `bsp/artinchip/sys/d12x`（startup_gcc.S、aic_hal_clk、isr、pinmux、链接脚本）提取，新建 `bsp/artinchip/d12x/`（主线风格：`board/Kconfig`、`applications/`、`SConstruct`、`rtconfig.py`）。先只求 UART + console + PIN 级支持（主线对 BSP 的最低门槛）。
2. **驱动移植顺序**（每个都可独立提交、独立验证）：
   1. `drv_uart`（libuart 框架，luban-lite 已是标准 rt_serial ops，基本直移）
   2. `drv_gpio/pinmux`
   3. QSPI + SPINOR/SPINAND + DFS（主线有 dfs 主干，AIC 的 nftl 是私有件——NOR 优先）
   4. DE/LCDC + framebuffer（主线无统一 fbdev 框架，参考其他 RISC-V BSP 的 lcd 驱动形态暴露 `rt_device`；或以 `RT_USING_DFS` 之外的块设备无关自定 ioctl 暴露 mpp_fb 能力）
   5. GE（暴露成自定 rt_device 或直接编译进 backend，社区无标准）
   6. GT911（主线有 touch 框架 `rt_touch` 与既有 gt911 驱动可参照合并）
   7. AIC8800 Wi-Fi（主线有 rtw/AIC8800 类包先例，需调研，风险最大）
3. **内核版本差异**：luban-lite 是 4.1.1，主线已 5.x——`rt_device`/`rt_serial`/dfs API 大体稳定，重点回归点是 `rt_pinmode`、中断栈、memheap 行为；pocketjs 组件与 app 层不触碰内核 API（决策已保证）。
4. **收益评估**（何时值得回归）：主线带来 5.x 调度/绑核改进 + 完整软件包生态（我们的 Wi-Fi/lwIP 版本更潮）；代价是 AIC 驱动永久自维护。**若产品形态稳定在 demo68 上，留在 luban-lite（或像立创一样维护 fork）是更低成本的选择**；若要跟主线生态（如 lvgl 主线包、RT-Thread Studio），再启动本节。
5. 参考路线图：立创 `lcsc/luban-lite`（fork 维护范式）、主线 `bsp/README.md` 的 BSP 制作规范、《RT-Thread 移植、设备驱动接口实现规范》（rtthread-specification 仓库）。

---

## 11. 性能评估与调优手段

**CPU 预算**（E907 @384MHz，60Hz 帧 = 16.6ms 预算）：

| 环节 | 估计 | 依据/手段 |
|---|---|---|
| JS turn（frame + tick + draw） | PocketCOM 桌面无数据；Pocket Pi 精简 profile（304KB bundle）整 turn ~几 ms 级 | 板上用 `pocketjs_guest_stats()`（frames/jobs）+ tick 时间戳打点；超预算先降 30Hz |
| 软渲染（damage 通常 <15% 视口） | 480×272 整帧 = 130K 像素写；damage 8% ≈ 10K 像素/帧 | `render_stats.software_ops` 观测；大 damage（日志整屏滚动）是热点 |
| GE 加速后 | fill/滚动 blit 走硬件，CPU 只剩文字 A8 | §7 步骤 3.2 的适配；`stats.ppa_*` 对位观测 |
| PSRAM 带宽 | 整帧 60Hz 写 15.7MB/s + DE 扫描读 ~7.8MB/s | 200MHz PSRAM 理论带宽足够；真不行把 tick 降 30Hz |

**调优顺序**：① `tickHz` 60→30（宿主画像一改、重出包即可）；② GE fill/blit 适配；③ 缩小日志区 damage（`core/logview` 已有帧合流，检查是否整区重绘）；④ 最后才考虑 rasterDensity/分辨率截断。

**内存红线**：QuickJS heap_limit 2.5MB 起步；`gc.oom`/alloc 失败路径要让 UI 报错而不是 panic（engine 分配耗尽是 abort——观察 `pocketjs_idf_rust_panic` 触发即回捞 heap 曲线）。

---

## 12. 风险清单

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 玄铁工具链与 Rust `riscv32imafc` 归档 ABI/扩展不匹配（xthead 扩展、ilp32f） | 链接失败/运行崩溃 | §6.2 的 readelf 自检；必要时用 `-march=rv32imafc_zicsr` 的纯标准编译、或让玄铁 gcc 关扩展；最坏情况换 `riscv32imac` target + soft-float（性能降） |
| R2 | E907 软渲染帧率不达标 | UI 掉帧 | tickHz 降 30 + GE 加速；damage 已内建 ≤8 矩形 |
| R3 | QuickJS 堆 + 包字节 > PSRAM SW 4MB | 启动 OOM | 压缩 PSRAM CMA（fb 用 2 buffer 不可省，GE buffer 后给）；`PSRAM_SW_SIZE` 调 6MB；长期：JS bundle 拆分/按需 eval（上游 pocketjs compile 能力） |
| R4 | AIC8800 Wi-Fi 驱动在 demo68-nand/nor 配置下不可用或不稳 | 无网络连接 | Phase 5b 独立、可砍；串口功能不依赖它 |
| R5 | `render_strip` 与 fb stride 的配合理解偏差 | 花屏 | 以头文件注释 + 官方 smoke 双实现（整宽条带 vs 行内偏移）对照；Phase 3 先 memcpy 路径验证再切零拷贝 |
| R6 | 嵌入式 UI 中文字体（Inter 无 CJK） | 中文 tofu | MVP 英文 UI；中期给 bake-font 加 MiSans 覆盖开关（vendor 改动，提上游） |
| R7 | host-profile `platform` 常量只有 `"esp-idf"` | 语义混淆（无功能影响） | 记 issue 向上游提 `"rt-thread"` 常量；设备端校验不受影响 |
| R8 | 上游 submodule pin 快速演进 | 移植偏基线 | 全程在 pin 的 commit 上做，升级 pocketjs 视为独立任务（组件 diff 小、Rust 归档重编） |
| R9 | macOS 无 luban-lite 构建环境 | 迭代慢 | 固定一台 Linux 构建机/容器 + scp 镜像脚本；烧录用 AiBurn（Windows）或 SD 卡（可全流程 Linux） |

---

## 13. 附录

### 13.1 命令速查

```sh
# —— PocketCOM / PocketJS（macOS）——
npm run build                              # 桌面包（js+pak）
bun vendor/pocketjs/tools/pocket.ts build \
  --host-profile app/d12x.pocket.host.json \
  --manifest app/pocket.d12x.json --project-root . \
  -- --extra-chars="$(cat /tmp/extra-chars.txt)"    # D12x 包
bun vendor/pocketjs/tools/pocket.ts check --host-profile ... --manifest ...   # 只校验
cargo +1.93.0 build --release --locked --no-default-features \
  --target riscv32imafc-unknown-none-elf --manifest-path \
  vendor/pocketjs/hosts/esp-idf/native/ui-core/Cargo.toml                    # Rust 归档
python3 vendor/pocketjs/hosts/esp-idf/components/pocketjs_package/tools/embed_package.py \
  app.pocket symbol_prefix                                                    # 包→C 数组（内嵌方案用）

# —— luban-lite（Linux 构建机）——
scons --list-def
scons --apply-def d12x_demo68-nor_rt-thread_helloworld_defconfig
scons --menuconfig
scons                                   # 镜像: output/<config>/images/
# 烧录: AiBurn(aicupg) 或 SD 卡；console: uart1 115200 8N1
# 板上 msh: test_fb / ge_fill / ge_bitblt / ge_rotate / test_ctp / test_uart / free / list_thread
```

### 13.2 路径速查

| 内容 | 路径 |
|---|---|
| PocketJS ESP 宿主组件（移植源） | `vendor/pocketjs/hosts/esp-idf/components/` |
| ESP 指南 / 宿主 README | `vendor/pocketjs/docs/ESP_IDF.md`、`hosts/esp-idf/README.md` |
| Rust 桥与工具链版本 | `vendor/pocketjs/hosts/esp-idf/native/`（`toolchains.json`） |
| 构建工具 / 包契约 | `vendor/pocketjs/tools/pocket.ts`、`contracts/spec/{idf-host,pocket-package,pocket-manifest}.ts` |
| 字形烘焙 | `vendor/pocketjs/framework/compiler/bake-font.ts` |
| 最小宿主参考（备选路线） | `vendor/pocketjs/engine/quickjs-c/pocket_runtime.{c,h}` |
| framework 输入/svc 契约 | `vendor/pocketjs/framework/src/host.ts`（HostOps + frame hookup 注释） |
| com 契约（JS 侧权威） | `bridge/com.ts`、`bridge/serial.ts`、`bridge/net.ts`、`bridge/cfg.ts` |
| com 契约（macOS 宿主参考实现） | `host/macos/src/com.rs + com_serial/tcp/udp/ws/env.rs` |
| RT-Thread 宿主落点 | `host/rtthread/`（本方案新建，组织见 §3.1） |
| luban-lite defconfig / 板级 | `target/configs/d12x_*`、`target/d12x/demo68-nor/` |
| fb / GE 门面 | `packages/artinchip/mpp/fb/mpp_fb.c`、`packages/artinchip/mpp/ge/mpp_ge.c` |
| 显示/GE/触摸参考代码 | `packages/artinchip/lvgl-ui/lvgl_v9/lv_drivers/{lv_port_disp,lv_port_indev,lv_ge2d}` |
| 外设测试 | `bsp/examples/test-{fb,ctp,uart,spi-nor,mmc,filesystem,lwip,wifi}/` |
| 分区表 | `target/d12x/demo68-nor/pack/image_cfg.json` |
| 内存布局 | `bsp/artinchip/sys/d12x/link_script/gcc_aic.ld.S`（SRAM/PSRAM_CMA/PSRAM_SW 注释即内存图） |

### 13.3 参考资料

- PocketJS：https://github.com/pocket-stack/pocketjs · https://pocketjs.dev/docs/esp-idf/ · Pocket Pi 上 ESP32-P4 实战：https://pocketjs.dev/blog/pocket-pi-on-esp32-p4/ · 社区 IDF 组件（渲染模式参考）：https://components.espressif.com/components/halfsweet/pocketjs-idf
- ArtInChip：D12x Datasheet（https://aicdoc.artinchip.com/out/downloads/D12x_Datasheet_EN.pdf）· D12x Demo 板（https://aicdoc.artinchip.com/topics/product/d12x-demo-v1.html）· luban-lite 用户指南（https://aicdoc.artinchip.com/topics/sdk/luban-lite-user-guide-lite.html）· LVGL 移植设计（https://aicdoc.artinchip.com/topics/sdk/lvgl/lvgl_design_guide-lite.html）· luban-lite 仓库（https://gitee.com/artinchip/luban-lite）
- RT-Thread：软件包索引（无 quickjs，仅 jerryscript）https://github.com/RT-Thread/packages · BSP 规范 https://github.com/RT-Thread/rt-thread/blob/master/bsp/README.md · 立创衡山派 luban-lite fork https://gitee.com/lcsc/luban-lite · SiFli QuickJS 用量参考（4KB 栈 + 512KB 堆起）https://www.sifli.com/documents/sifli/qjs_usage_page.html
