---
name: aic-build
description: AIC（D12x + RT-Thread）板端构建——check:aic/package:aic/build:aic/flash:aic 全流程、submodule 前置、内存报告解读、XIP/统一 TLSF 堆布局、WiFi 配置、板端回归测试。当需要构建/烧录固件或分析 memory-report.json 时使用。
---

# PocketCOM AIC 板端构建（D12x + RT-Thread）

## 前置

桌面前置（见 skill `desktop-build`）之外，板端还需要：

```sh
git submodule update --init --depth 1 vendor/luban-lite   # 需访问局域网 Gitea（192.168.0.20）
```

- 工具链：upstream `riscv-none-elf-gcc`（脚本遵循 SDK 的 `RTT_EXEC_PATH`，不自动下载）。**本机已装**：
  xPack 15.2.0-1 于 `/Users/kai/DevTools/xpack-riscv-none-elf-gcc-15.2.0-1/bin`，即
  `RTT_EXEC_PATH=/Users/kai/DevTools/xpack-riscv-none-elf-gcc-15.2.0-1/bin`。
  另需 Python 3、SCons、cargo/rustup + fork `hosts/aic/rust/rust-toolchain.toml` 指定的 nightly + rust-src。
- 分支跟踪：`.gitmodules` 指定 `vendor/pocketjs` → feat/aic、`vendor/luban-lite` → feat/pocketjs；
  普通初始化按父仓库 gitlink 检出，**构建不拉取更新**；显式升级
  `git submodule update --remote vendor/pocketjs vendor/luban-lite`。

权威细节见 **host/rtthread/README.md**（接入记录、XIP/TLSF/WiFi 改造全文）与
**docs/aic-memory-optimization.md**（内存优化方案 A–G、P0–P3 推进阶段）。
后续 UI 恢复方向见 **docs/shared-ui-memory-optimization.md**：共享现有应用 / 控件、TS 内存优化与
编译期功能裁剪提案；原方案 A 的独立产品页方向由该提案接替，板端入口现按用户要求切换为 JSON 裁剪共享 UI，2026-10-23 优化前真机 S4 底层 OOM；节点共享原型优化后，启动/120 帧与基本交互已通过，长时/业务负载/WiFi 组合验收仍待补（见第 1 步记录）。统一 `pocket.features.json` 的 `aic-diagnostic` profile 已接入 check/package，
只有 `implemented` 项允许进入 profile；`planned` 项仅登记，不能配置/引用，也不改变功能行为。
功能名与实际启停值只读取这份 JSON，文档和构建代码不维护另一套开关表。
共享 App 的 terminal 开/关离板实验用 `npm run probe:features`，MCP 用 `npm run probe:features -- --feature mcp.server`（产物 `dist/mcp-feature-heap/`），产物隔离到 `dist/feature-heap/`，
传输用 `npm run probe:features -- --feature transport`（产物 `dist/transport-feature-heap/`），
UI 用 `npm run probe:features -- --feature ui`（产物 `dist/ui-feature-heap/`），
不切正式入口、不构建或烧录固件，具体边界见 skill `mem-probe`。

## 命令

```sh
npm run check:aic      # 校验产品 manifest/profile 与应用类型
npm run package:aic    # 生成 JS/PAK/.pocket + 宿主契约头与内联 C 数组（重复打包应得相同 .pocket）

RTT_EXEC_PATH=/Users/kai/DevTools/xpack-riscv-none-elf-gcc-15.2.0-1/bin npm run build:aic
                       # 本机 xPack 工具链；默认 SDK=vendor/luban-lite；
                       # 可加 -- --sdk /path/to/sdk -- -j4（不传则 -j8）
                       # 输出 ELF/map/ITB/IMG + dist/aic/memory-report.json；预算超限非零退出
                       # 构建环境 POCKETJS_GE=0 编译关闭 GE 2D 加速（等价纯 CPU 渲染，
                       # 用于 A/B 对比与真机异常兜底）；启用时每秒日志行含
                       # ge_fill/ge_blend/ge_srm 计数（详见 host/rtthread/README 的 GE 章节）

npm run flash:aic -- -p /dev/cu.usbserial-XXX -b 3000000 --verify --reset
npm run flash:aic -- --all -p /dev/cu.usbserial-XXX

npm run probe:aic                    # 离板内存探针：同一套组件 + 固定连续区/SDK TLSF，
                       # [PJS-PROBE] 输出与板端 [PJS-DIAG] 字段一致；前置 package:aic + cc + cargo。
                       # 默认 7 MiB；--heap N 固定池大小并模拟碎片，--turns N 加长浸泡；64 位指针/块布局仍与 RV32 有差异，
                       # 只做粗测不替代板端验收（详见 host/rtthread/README 的"离板内存探针"）
```

烧录要点：

- 板子先进下载模式（**按住下载键 PA1 上电**）。
- 默认只烧 app（`d12x_os.itb` → os 分区）；`--all` 先烧 bootloader（`bootloader.aic` → spl 分区）。
- 其余参数原样透传 SDK `tools/aic-isp`（端口、`-b` 波特率、`--reset` 等）；烧写偏移由 pack
  `image_cfg.json` 分区表推导；上传工具优先用其 bin/ 预编译产物，缺失时首次自动 cargo 构建。
- `--verify` 走 `GET_MEDIA_CRC`（aicupg 0x1C，设备算 CRC32 一条命令秒级校验），**要求 bootloader
  编入该命令**；当前 tracked `bootloader.aic` 已含 GET_MEDIA_CRC + XIP Boot（2026-10-10 重编）。
  更旧的 bootloader 用 `--verify=readback`（全量读回逐字节比对，慢但通用）。
- `.img` 是带 section 偏移的容器，不能作为裸文件直接写某个 flash 地址。

## 构建流程（5 步）

1. fork CLI 校验产品 manifest/profile 与应用类型。
2. resolver 生成 plan，编译器生成 JS/PAK，`makeVariant`/包编码生成 `.pocket`，包验证。
3. 生成契约头和完整二进制 C 数组到 fork 已忽略的 `hosts/aic/generated`（多应用/SDK 共用一份，不可并行构建）。
4. 应用 bootloader defconfig 并调 SDK `calc_linked_addr.py` 生成地址元数据，再切回产品 defconfig。
5. SCons 编译运行时与固件，输出 ELF/map/ITB/IMG，生成并检查内存预算。

## 产物

- `dist/aic/pocketcom-aic.pocket`：应用包。
- `.pocket/aic/`：plan、JS、PAK 和中间文件。
- `dist/aic/memory-report.json`：包大小、XIP/PSRAM 段拆分与地址、CMA/SW 边界、framebuffer、
  guest 配额与统一堆预算、OS 分区占用（字段单位 bytes）。**只覆盖静态预算**，不含运行峰值。
- `vendor/luban-lite/output/d12x_demo68-nor_rt-thread_pocketjs/images/`：SDK 固件产物（含 `d12x_demo68-nor_v1.0.0.img`）。

## 内存布局（XIP + 统一堆，2026-10-10 起）

```text
SPI NOR 16 MiB   spl 512k | env 128k | env_r 128k | userid 256k | os 3072k | os_r 3072k |（尾部空闲）
os 分区          d12x_os.itb：FIT 头 0x800 + XIP 段（.text/.rodata，含内联包）+ RAM 段（.data）
XIP 窗口         0x60000000 + 0x100800（os 偏移 0x100000 + 0x800）原地执行
PSRAM 8 MiB      CMA 1 MiB（.data/.bss + 双 RGB565 framebuffer 522,240 B）
                 SW 7 MiB（统一 TLSF 系统堆：QuickJS/Rust guest + 系统线程共用，guest JS 配额 5 MiB）
```

- bootloader `xip_boot` 按 FIT 段地址跳过 XIP 段、仅把 `.data` 拷入 PSRAM，`.bss` 启动清零。
- 报告校验 ITS XIP 段地址 = `0x60000000 + CONFIG_AIC_XIP_FW_OFFSET`、FW_OFFSET = os 偏移 + 0x800；
  预算不足仍保存报告但非零退出，不自动扩分区/提配额、不自动烧录。
- 板载 NOR 为 Puya PY25Q128HA，SDK XIP 支持表已补表项（`aic_flash_xip_def.c`）。

## 板端现状速览

- demo68-nor 480×272 RGB 屏的产品 defconfig 使用 SDK 同板参考的 90° pixel clock 相位
  （`AIC_DEGREE_90` / `AIC_RGB_CLK_CTL=1`），不要恢复成默认 0°。2026-10-24 针对静止字边
  彩点/跳动恢复该配置；离板空闲双缓冲像素一致，用户真机确认“确实好了”，见
  [字体显示排查](../../../docs/aic-font-rendering-2026-10-24.md)。显示时序修正在 SDK 产品
  defconfig 维护，不以改字体/density 代替；固件构建后核对生成的 `rtconfig.h` 中相位为 1。
- 2026-10-24 补齐共享 `LeftPanel` 的触摸纵向 pan：内容节点子树接手势并复用滚轮的边界夹取，
  拖动取消点击，隐藏取消手势；真实 Vue Vapor/核心 WASM 与实际 AIC 包 QuickJS 连续触摸回归通过，
  固件快照在 `dist/aic/panel-touch-fix/`，真机手感待用户烧录复验。详见[本步记录](../../../docs/aic-narrow-panel-step2.md)。
- 2026-10-24 修复 Vue Vapor Portal host 缺少 `hitPass: 1`：复用连接配置抽屉关闭后透明 host
  拦截 bounds 触摸，导致只能打开一次。真实核心回归及实际 AIC 包逐轮命中检查已通过，固件已重建，
  真机待用户复验。旧循环测试未检查每次开关结果，其数据不能作为成功反复开关的证据，见[更正记录](../../../docs/aic-narrow-panel-step2.md)。
- 当前第 2 步连接配置延后创建已完成本地/固件及本轮真机启动/120 帧内存验证：首次打开前系统峰值 4.54 MiB、frame120 占用 3.37 MiB；首次触摸后系统峰值 5.08 MiB，完整反复开关采样待补。首次交互 3091 ms 卡顿已确认，用户要求后续处理，不能直接归因于 GPU，详见 [第 2 步记录](../../../docs/aic-narrow-panel-step2.md)。默认不创建、首次打开后复用，启动与使用后占用分开记录；不把离板 4.53 MiB 启动峰值扩展为所有状态结果。第 1 步：节点共享原型已通过本地 A/B、用户真机启动/120 帧零错误、零分配失败及基本交互，详见 [本步记录](../../../docs/aic-node-prototype-step1.md)。用户负责烧录及日志；每步记录结果后再推进下一项优化，不能把短时通过扩展成长时/业务负载验收。保持 JSON profile、容量、堆/栈和诊断口径，交付包/固件 hash 与静态报告，避免仅凭离板收益更新真机验收状态。
- 板端入口 `app/main.aic.tsx → app/app.tsx`：2026-10-23 起按用户要求用于 **480×272 共享 UI 内存 perf**，沿用 JSON `aic-diagnostic` profile，2026-10-23 优化前真机 S4 底层分配失败 8 次，未进入首帧，见[历史复测记录与原始日志](../../../docs/aic-memory-perf-2026-10-23.md)。`app/aic.tsx` 精简页保留作基线；此前未裁剪完整 UI 曾 OOM，mount 可能以 `TypeError: not a function` 伪装失败。构建保持现有配额和容量，默认保留 `[PJS-DIAG]` 与 `pjs_mem`，本步新真机日志已记录 S5-frame120；后续补长时空闲、交互峰值与 WiFi 状态日志，失败后的快照不能当作失败瞬间可分配空间。
- AIC 打包对 SDK 编译器输出的自包含 IIFE 再压缩标识符和空白（不折叠表达式、不改宿主属性名），
  桌面构建不变。
- 字体：UI MiSans、mono JetBrains Mono；从两份语言包字符串值提取额外字形烘焙；
  未知字形回退替换符，HEX 视图无损。UI 固定符号必须取 MiSans 已映射字形
  （`▾`/`⏎` 等缺映射符号板端豆腐），守卫测试 `test/app/ui-glyph-coverage.test.ts`（SPEC §5.4）。
- 2026-10-24 核对 UART 引脚：SDK d12x `aic_gpio_id.h` 枚举有错（按 d21x 抄），以官方数据手册为准——
  PA.2/PA.3 func5 = UART1（已随固件可用，`/dev/uart1`），PB.10/PB.11 func5 = UART3 但与 WiFi SDIO
  互斥（func2 = SDC0_D1/D2），UART0 Kconfig 默认流控脚 PA.2/PA.3 不可用。详见 host/rtthread README
  的 "UART 引脚" 小节，勿按头文件枚举名判断引脚。
- 2026-10-24 起固件含 PocketCOM `com.*` 串口桥（fork `hosts/aic/port/pocketjs_com.c`）：仅
  uart1（PA.2/PA.3），op 语义与桌面一致、RX 走 tick poll；`POCKETJS_COM=0` 编译关闭。
  详见 host/rtthread README 的 "com 串口桥" 与 "UART 引脚" 小节。
- 2026-10-26 修复 UART1 计数先变、接收文字延后显示：当前固件未启用 RTC，QuickJS 未检查
  `gettimeofday()` 失败，会话泵改用 `virtualNow() × 1000` 驱动合流/重连，消息时间戳来源保留。真实 Vue Vapor/core WASM 的
  `test/app/serial-receive-clock.test.ts` 覆盖 AIC/桌面配置与冻结/回拨时钟；固件在
  `dist/aic/uart-receive-delay-fix/`，真机显示延迟待用户烧录复验，见
  [排查记录](../../../docs/aic-uart-receive-delay-2026-10-26.md)。
- WiFi（RTL8189FTV，2026-10-11 点亮至 AP 扫描）：SDIO 接 SDMC0（4-bit @40MHz）+ third-party
  lwIP（netif `WL0`，`AIC_WLAN_REALTEK` 配置链）；驱动 `.bss` ≈259 KiB 进 PSRAM、运行缓冲吃统一堆，
  恢复收发功能前必须补 WiFi 开/关、连 AP/断开状态的堆基线测量。模组 EN 由载板保证，固件不做电源控制；
  PM 睡眠驱动未编入，固件不进睡眠。

## 软键盘交付验证

文本域首次点击聚焦、再次点击当前域展开键盘，程序聚焦不展开；首次展开创建，之后隐藏复用。
功能启停只查 JSON。构建前运行真实 Vue Vapor/core bounds 触摸回归
`bun test test/app/soft-keyboard-touch.test.ts`（WASM 缺失时先构建，不接受跳过）。
构建后除启动/120 帧外，还要记录首次展开、大小写、反复开关、抽屉/设置内编辑及输入发送的真机
堆峰值、稳态和分配失败；离板 QuickJS/核心成功不等于 RV32/TLSF 真机通过。
用户负责烧录与回传日志，产物/测试边界见
[软键盘修复](../../../docs/aic-soft-keyboard-2026-10-25.md)。

临时编辑面板（`keyboard-editor.tsx`）直接使用原域状态，展开后显示字段名、两行文本和光标，
按键居中；回归还包含 `keyboard-editor-layout.test.ts` 与实际字体 RGB565 回放。
最新交付见 [临时编辑面板](../../../docs/aic-keyboard-editor-2026-10-25.md)，
保留原配额，不能将静态构建或离板高占用下的成功等同真机内存验收。

## 回归验证

```sh
bun test test/host/rtthread/    # 板端构建编排单测
npm run typecheck && bun test test/
npm run check && npm run build  # 桌面回归（allocator/字节码类改动需加对应宿主测试）
```

后续恢复按 docs/shared-ui-memory-optimization.md §9 的共享 UI 路线推进；实测基线、诊断阶段和
容量 / allocator 研究继续参考 docs/aic-memory-optimization.md。本次共享入口切换已更新 SPEC，仅用于真机 perf；产品验收仍以真机内存结果为准。

2026-10-25 发送框折叠改为首次创建后隐藏复用，避免重建峰值；离板探针已换成 SDK 同源固定池 TLSF，
新增碎片/最大连续块及失败瞬间记录。交付和真机待验收边界见 [本次记录](../../../docs/aic-send-collapse-tlsf-2026-10-25.md)。

后续候选还将 45 个固定键位改为共享渲染器 Text 批量更新，保持交互及字体像素一致，
最新固件在 `dist/aic/send-collapse-key-batch/`。7 MiB 短测通过，不把长压测的额外 GC 对照当作无 GC 通过；详见同一记录后续章节。

2026-10-25 后续帧边界压力 GC 固件在 `dist/aic/oom-gc/`：挂载结束/首帧前一次回收，
之后按 caps 增长 128 KiB、低系统余量时 32 KiB 与最多 2 秒的策略回收；旧 2 秒空闲回收保留。
新增 `S5-gc` 与每秒累计 `gc`/全程 `gc_max`，验收须同时看内存和停顿，不能只看 turn_max。
探针 `--aic-gc` 复用策略，`--aic-gc-idle` 对照旧版；交互压力入口见 skill `mem-probe`。
LP64 7 MiB 忙帧长测/快速组通过，当时抽屉+设置组合仍失败，不扩产品堆/配额。
源码、产物 hash 与真机待验收边界见 [本次记录](../../../docs/aic-gc-pressure-2026-10-25.md)。

2026-10-26 组合边界修复固件在 `dist/aic/combined-oom-fix/`：普通 View/Text 降低组件/属性代理
开销，同作用域批量更新，设置弹窗首次创建后隐藏复用并在每次打开重置草稿。
同策略旧包在 7 MiB 复现失败；新包首次组合 20/20，普通/无空闲/快速 50 轮各 420/420，
零分配失败，五张 RGB565 对照零像素差异，固件静态预算通过。未改 feature/堆/配额；
真机峰值、GC 停顿及 UART/WiFi 组合仍待验收。源码、产物 hash 和完整数据见
[组合修复记录](../../../docs/aic-combined-oom-2026-10-26.md)。

2026-10-26 GE 补齐 A8：CPU 合并遮罩与全局 alpha 为 ARGB8888，再由 GE 混合到私有 RGB565
暂存面，成功才写回。首次使用申请并复用 49152+63 B，超 8192 像素/分配失败/GE 失败回退 CPU。
拒绝异步 cmdq。端口回归 `cd vendor/pocketjs && bun test tests/aic-port.test.ts` 覆盖缓存、
局部区域、alpha 与部分失败。硬件舍入、峰值和性能必须真机 A/B 验证，不能由 mock 推定；
固件与记录见 [GE A8](../../../docs/aic-ge-a8-2026-10-26.md)。

GE A8 初版用户真机黑屏（S5-gc 后无 frame1）。修正必须对照 SDK
`packages/artinchip/mpp/mpp_test/ge_test/example/alpha_blend_example.c` 与
`public/ge_mem.c`：源/输出每行 stride 均对齐 8 B，图像暂存从 MEM_CMA 分配，
首地址对齐不能代替行 stride 对齐。共用 4 像素 pitch，容量按 padding 后像素计。
示例 bitblt → emit → sync 后才读输出；当前 normal 的后两者为 no-op，不能据此归因卡死。
修正版 `dist/aic/ge-a8-layout-fix/`，纯 CPU 恢复对照 `dist/aic/ge-a8-recovery-cpu/`。
新增首次 fill/A8 begin/submit/end 日志，回传到哪一行用于定位；本地通过不能宣布黑屏已修复。

A8 修正版后续用户回传已确认黑屏恢复、首次 fill/A8 rc=0、首帧/120 帧及触摸后出帧。
frame120 caps_fails=0，CMA 增加 49240 B、余额 177852 B；触摸后系统峰值 5589620 B。
仍有首次触摸 turn_max=1763 ms 与重绘 fps=1 样本；turn_max 不含 GE 绘制等待，
不能由该值或 ge_blend 计数宣称加速。首帧恢复已验收，性能/长时范围见同一 GE A8 记录。
