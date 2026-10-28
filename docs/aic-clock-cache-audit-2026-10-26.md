# AIC D12x 时钟与缓存核查（2026-10-26）

结论：当前配置与 SDK 的 D12x/demo68-nor 路径一致，未发现 CPU 降频或关闭 I/D Cache 的
配置；GE、DE 和总线请求值经整数分频后有正常偏差。用户后续回传已包含寄存器读回，实际值及诊断解码修正在末节；
历史 FPS 日志不能代替频率验证。未调整主频、PLL、预取或内存属性。

## 核查依据

- SDK 生成配置 `.config` / `rtconfig.h`，产品与 bootloader defconfig。
- `target/d12x/demo68-nor/sys_clk.c`、`bsp/artinchip/sys/d12x/aic_hal_clk.c`。
- 当前链接 map 确认 CMU 使用 `hal/cmu/v1/aic_hal_fixed_parent_clk.o`；
  `AIC_CMU_DRV_V12` 是 IP 版本，不等于启用 `AIC_CMU_FRAMEWORK_V2`。
- CPU `startup_gcc.S` / `system.c` / `include/core_rv32.h`。
- PSRAM `pack/pbp_cfg.json`，QSPI bootloader `cmd/xip_boot.c` 与 `hal_qspi_v1x.c`。
- GE normal V11、DE V12、RGB V12 的实际分支与时钟申请。
- 官方 [D12x 用户指南](https://aicdoc.artinchip.com/out/download-doc/D12x_User_Manual.pdf)
  §5 总线属性、§8 时钟，以及 [D12x 功能特性](https://aicdoc.artinchip.com/topics/product/d12x-feature.html)。

## 时钟：配置与推算

下表是源码/分频推算，尚无本轮板上寄存器日志。

| 时钟域 | 配置或驱动请求 | 按初始化路径推算 / 判定 |
|---|---|---|
| PLL_INT0 / CPU | 396 MHz / 396 MHz | CPU 396 MHz，与官方典型值一致 |
| PLL_INT1 | 588 MHz | 总线及 GE/DE/UART 来源，官方典型值 |
| PLL_FRA0 | 384 MHz | bootloader 与 app 一致；XSPI/QSPI/SDMC 共享，不能只为一种外设更改 |
| AXI0 / AHB0 | 各 200 MHz | PLL_INT1 / 3 = 196 MHz；二者共用分频寄存器 |
| APB0 | 100 MHz | 588 / 6 = 98 MHz |
| APB1 / GTC | 24 MHz / APB1 | GTC 底层还分频；SysTick `drv_get_sys_freq()` 为 4 MHz，不是 CPU 主频 |
| GE（V11 normal） | 150 MHz | 588 / 4 = 147 MHz，SDK 对本 IP 的请求值；不能套别的 GE 版本 200 MHz |
| DE（V12） | 100 MHz | 588 / 6 = 98 MHz，不能套 V10 的 200 MHz |
| PSRAM | PBP 的 8 MiB OPI cfg0 clock=192 MHz | 参数与同板 SDK 一致；最终 XSPI 模块分频、内部倍频关系及引脚时钟须读回/解码，不能把另一路裸驱动默认值当实际值 |
| QSPI0/XIP | bootloader 默认 module/bus 请求均为 100 MHz | module 推算 384 / 4 = 96 MHz；串行 SCK 还要读 QSPI CCFG 内部分频，不能只看 app 的 MAX_SRC_FREQ |
| LCD | 10 MHz 像素时钟、90° 相位 | 既有真机日志 pclk=10 MHz、panel fps=63，像素相位为 AIC_RGB_CLK_CTL=1 |
| PLL_FRA2 / LCD sclk | 启动配置 396 MHz | RGB 驱动之后会重设：V12 PRGB 的 sclk=20 MHz，算法选择 PLL 640 MHz，pixel=10 MHz；不能把初始 396 MHz 当最终值 |
| SDMC0 / WiFi | 请求 40 MHz | module 可能在初始化重设，历史日志 19.2 MHz 为阶段值；最终工作分频待读回，不把 400 kHz 枚举或 19.2 MHz 初始化值写成持续工作频率 |
| UART0 / UART1 | app 请求 48 MHz | 588 / 12 = 49 MHz；波特率由 UART 自己继续分频，不能与 module 时钟混同 |

分频计算来自实际 fixed-parent `set_rate` 的就近取整，非硬件测量。
官方典型 PLL 与内存属性和本配置相符；本次未查明任何需要提高 CPU 或 GE 时钟的错误。

## 缓存与一致性

- 产品未关闭 I/D Cache。Reset_Handler 调用 enable，SystemInit 再调用 CSI enable。
  SDK 的 D-Cache 初始化在 DE=0 时设置 DE/WB/WA/RS/BPE/L0BTB；已有 DE=1 则保留
  部分启动状态，故完整控制位仍需读回。
- 官方特性列 I-Cache 32 KiB、D-Cache 16 KiB；这是硬件容量，不由产品 Kconfig 分配。
  CACHE_LINE_SIZE=32 B；GE 的 64 B 对齐是更严格的首地址对齐，不改变 CPU cache line。
- CPU_DCACHE_PREFETCH_EN 未启用，DPLD 关闭、AMR=1；这是 SDK 默认值。
  是否开启要以 XIP/PSRAM 的实测命中率、总线竞争和交互耗时 A/B 决定，不是漏开 Cache。
- 未配置 PSRAM_UNCACHED_EN。官方 SYSMAP 默认 PSRAM 与 FLASH 区均 C=1/B=1/SO=0；
  实机非 QEMU 路径继承硬件/bootloader 属性，没有在 app 重写。最终须读取 SYSMAP6/7。
  core_rv32.h 的 sysmap_config_region 参数表示 region 边界；QEMU 专用映射不能当真机配置。
- XIP PY25Q128HA 表使用 QIO EBh、wrap32（0x77 / fixed_len=0x40），与 32 B cache line
  对应，QSPI XIP 入口调用 set_xip_burst_cfg 使能 wrap。需要读回 BTR 验证开启状态。
- RGB565 目标 DMA 前 clean、DMA 后 invalidate；A8 使用独立对齐 CMA 面并在完成后写回。
  帧缓冲交给 DE 时的 clean 路径保留。不关闭缓存来规避一致性，不扩大堆或 CMA。

## 只读板上诊断

固件首次创建 renderer 后、首帧前输出 `[PJS-HW]`；也可在现有串口控制台执行 `pjs_hw`。
编译开关沿用 POCKETJS_DIAG，关闭诊断时命令与自动输出一起裁掉。

输出包含 19 路 `hal_clk_get_freq()` 读回及 gate 状态、QSPI CCFG 解码后的 XIP SCK 与 BTR、
MHCR/MHINT、8 组 SYSMAP 边界及 SO/C/B。不写寄存器、不切换时钟、不做 cache flush，
不访问 guest JS。诊断中的频率是从寄存器解算，不是外部仪器测得的晶振/引脚频率。

期望检查：CPU=396000000，AXI/AHB≈196000000，GE≈147000000，DE≈98000000；
MHCR IE/DE 均为 1；SYSMAP6/7 C=1、SO=0。其余 WB/WA/BPE 与 MHINT 需结合 bootloader
继承状态解释。gate=0 的域不能仅凭 rate 值声称正在工作。XSPI、QSPI 分频需结合 PBP 与内部分频。

初次交付时没有板上日志；后续用户读回与结论见末节。
产物在 `dist/aic/clock-cache-audit/`；不自动烧录。

## 本地验证与固件身份

- 相关回归 `bun test vendor/pocketjs/tests/aic-port.test.ts test/host/rtthread/` 18/18。
- `RTT_EXEC_PATH=/Users/kai/DevTools/xpack-riscv-none-elf-gcc-15.2.0-1/bin npm run build:aic`
  成功，包含真实 SDK 时钟 API、CSR/SYSMAP 读取的 RV32 编译和固件链接；静态预算通过。
- ITB 3004416 / 3145728 B，CMA 扣双 framebuffer 后静态余量 243772 B。
- ITB SHA-256 `72e6809884c91a06cc7a2c25278a4f8f92e5fdb022fa00bb3e41fb7ab197f873`。
- 应用包 SHA-256 `c38c5bcfe4faacf5b12ffa593cd0faf904113b24c1b688edaeae43cfbbcf535f`，与 GE A8 用户验证包一致。
- 本轮验证只证明构建和相关回归通过；新增硬件读回尚未在板上执行。
- SystemCoreClock / drv_get_cpu_freq 是 SDK 软件变量，未作为这次 CPU 频率证据；诊断使用
  hal_clk_get_freq 从 CMU 解算，避免软件变量与时钟切换不同步的影响。

## 用户实际读回与 SYSMAP 解码修正

用户日志保存在 `dist/aic/clock-cache-audit/user-hw-readback.log`。

| 域 | 板上寄存器解算 |
|---|---|
| CPU / PLL_INT0 | 396 MHz |
| PLL_INT1 / PLL_FRA0 | 588 / 384 MHz |
| AXI0 / AHB0 | 196 / 196 MHz |
| APB0 / APB1 | 98 / 24 MHz |
| XSPI module | 384 MHz（不等于 PSRAM 引脚 DDR 时钟） |
| QSPI0 module / XIP SCK | 96 / 96 MHz，CCFG=0x2 |
| GE / DE | 147 / 98 MHz |
| PLL_FRA2 | 636 MHz |
| SCLK / RGB / pixel | 19.875 / 19.875 / 9.9375 MHz |
| SDMC0 | 38.4 MHz（此启动时刻读回，后续日志驱动继续初始化） |
| UART0 / UART1 | 各 53.454545 MHz |

PLL_FRA2 原推算 640 MHz 是请求值；当前 SDM 类型按 PLL 整数系数取整，实际 636 MHz，
pixel 为 636/64=9.9375 MHz，比名义 10 MHz 低 0.625%。启动 panel 日志按 MHz 取整不能表达
这一差异。未见显示异常，不据此自动调整 PLL 或关闭展频。
UART 115200 baud 在 D12x 驱动频率表选择 53.454545 MHz（588/11），HAL 按实际时钟计算
波特率分频；不是仍按 48 MHz 计算。之前只按 menuconfig 推算 49 MHz 不完整，现以此更正。
QSPI BTR=0x77314010 的 WRAP_EN bit16=1，固定长度字段为 0x40，与现有 wrap32 表相符。

MHCR=0x103f，IE/DE/WB/WA/BPE 均为 1，RS 与 L0BTB 也为 1；MHINT=0x8，
DPLD=0、AMR=1、PREF_N=0。确认 I/D Cache 开启、预取关闭、cache line=32 B。

### 诊断错误：SDK SYSMAP 位掩码与实际 E907 位域不一致

旧打印把 attr=0x0c 解成 SO=1/C=0/B=0，这是诊断错误，**不是设备缓存被关闭**。
E907 R1S1 用户手册 §4.1 图4.1（印刷页49）定义 SO/C/B 在 bit4/3/2，bit1:0 保留。
已从原厂署名手册的图中核实；SDK core_rv32.h 却将 B/C/SO 置于 bit0/1/2，初版诊断沿用
这个错误布局。参考原文与图保存在忽略目录 `reference/e907.pdf`、`reference/Im19.png`：
[E907 原厂手册（全志社区提供）](https://bbs.aw-ol.com/assets/uploads/files/1658215723286-%E7%8E%84%E9%93%81e907-r1s1%E7%94%A8%E6%88%B7%E6%89%8B%E5%86%8C_occ.pdf)。

正确解码：SYSMAP0–2 的 0x10 为 SO=1/C=0/B=0，外设等区域保持强序；
SYSMAP3–7 的 0x0c 为 SO=0/C=1/B=1，含 BROM/SRAM/PSRAM/FLASH。
因此 PSRAM 与 XIP 区的可缓存属性正常，无需改写寄存器。

只在 PocketJS 诊断层使用硬件位定义，不改 SDK 的属性设置函数或 QEMU 映射。
新增从实际日志取值的回归，包含 0x0c、0x10、独立 C/B 与保留位，避免再次误解码。
相关回归 19/19、固件构建及预算通过；新固件只更正打印，不修改硬件时钟或缓存配置。
输出在 `dist/aic/clock-cache-decode-fix/`，不要求为“开启 Cache”重新烧录，因为它已经开启。

本次 frame120 caps_fails=0，空闲多次 57–60 fps，GC 最大 69 ms。
交互仍有 guest turn_max=1823 ms、689 ms 与重绘 fps=1/7/16 样本，未证明性能瓶颈来自
频率或缓存关闭；不能把本次配置核查写成所有交互性能通过。

解码修正版 ITB SHA-256 `eba04d85a1f86e1ac298b7201fd0f903d4e1afc497561a5743c8df5389da78b7`。

## 用户补充操作顺序后的样本对应

本次用户明确操作依次为：打开连接配置 → 收起 → 点发送框唤出软键盘 → 收起键盘 →
收起发送部分。原始日志在 `dist/aic/clock-cache-decode-fix/user-interaction-sequence.log`。
修正后的 SYSMAP 日志已直接显示 PSRAM/FLASH SO=0/C=1/B=1，与前一轮 raw 值一致。

以下是结合操作顺序和 touch 坐标对每秒窗口的对应推断；窗口没有 UI 动作标签，
不能把某个 turn_max 当作单次点击到显示完成的端到端耗时。

| 对应操作 | 坐标/guest turn_max | 观察 |
|---|---|---|
| 首次打开连接配置 | (59,16)，1689 ms | JS heap 从约2.01 MB 增到2.41 MB；随后无新触摸窗口 fps=1、turn_max=25 ms |
| 收起连接配置 | (313,108)，55 ms | 返回主页面，JS heap 仍约2.41 MB，与隐藏复用行为相符 |
| 点发送框/唤出软键盘 | (247,213)，先113 ms，随后626 ms | 触摸分布在相邻窗口，后者 JS heap 增至约2.52 MB，fps=4；可能分别包含聚焦与首次挂载，需动作埋点确认 |
| 收起软键盘 | (438,261)，182 ms | 后续页面仍出帧 |
| 收起发送部分 | (439,264)，105 ms | 最后空闲fps=57，turn_max=14 ms |

首帧/120 帧 caps_fails=0；系统历史峰值最终5782276 B，CMA 首次 A8 后为588152/766020 B。
帧末显式 GC 最大69 ms。两次主要长停顿1689/626 ms 已计入 guest turn，首次创建控件与
响应更新值得优先分段；guest 内部自动 GC 也可能计入 turn，当前没有独立测量，不能排除。
另一条线索是无触摸、guest turn仅25 ms 时fps=1，需要区分渲染/GE等待/缓存维护/显示等待/
时钟追赶等耗时，不能由当前日志认定就是 GE 慢或预取关闭。
未做第二次打开同一面板/键盘的对照，因此首次创建与复用耗时差异尚未量化。

后续确认旧 FPS 统计存在长停顿后追赶窗口、turn_max 包含整个 UI turn；修正与低内存优化见 [本轮记录](aic-perf-low-memory-2026-10-26.md)。
