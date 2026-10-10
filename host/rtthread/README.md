# PocketCOM on AIC + RT-Thread

本期接入 D12x demo68-nor：PocketCOM 应用包、固件构建与静态内存预算。固件 **XIP 运行**（`.text/.rodata` 在 SPI NOR 的 0x60000000 窗口原地执行，仅 `.data/.bss` 进 PSRAM），PSRAM 为 **统一 TLSF 系统堆**（不再划分 PocketJS 私有池）。当前使用 480×272 精简验证页（标题、帧计数、触摸计数），完整共享 UI 因启动 OOM 暂停挂载；没有 UART/网络/MCP `com.*` 桥、持久化或软键盘。构建不自动烧录；完整应用恢复路线见 [D12x 8 MiB PSRAM 内存优化方案](../../docs/aic-memory-optimization.md)。

## 分层

```text
PocketCOM app/aic.tsx（精简启动页，Vue Vapor；共享 i18n/theme）
  → host/rtthread（产品 manifest/profile + 构建编排）
  → vendor/pocketjs/hosts/aic（QuickJS、触摸、帧循环、RGB565、MPP 显示）
  → vendor/luban-lite（RT-Thread、板级驱动、链接、bootloader、镜像）
```

`app/main.aic.tsx` 在 mount 前初始化 480×272 应用视口并挂载 `app/aic.tsx`，不导入完整 App/session；桌面入口独立。host profile 固定 density 1、native presentation、60Hz，仅声明真实宿主能力。UI 保持 MiSans，mono 用 fork 的 JetBrains Mono（与产品 vendor 字体相同）；从两份语言包的字符串值提取额外字形，不烘焙整个 CJK 字符域。未烘焙输入仍可能显示替换符，HEX 视图保证字节表达。

SDK 复用 `application/rt-thread/pocketjs`，产品不复制引擎/QuickJS/显示/触摸源码。`POCKETJS_ROOT` 由脚本指向当前 fork。未来 `com.*` 属于本目录的产品桥；通用 guest 扩展接口属于 PocketJS，板级驱动属于 SDK。设备事件入 FIFO，在 tick 边界 drain；core 仍保持纯 TS。

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

## 验证

```sh
bun test test/host/rtthread/
npm run typecheck
bun test test/
npm run check && npm run build
cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host
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


## 当前精简板端入口

第二次真机启动仍报 bundle eval OOM，先按产品侧裁剪启动图：
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
SW 扣 TLSF 理论余额仍为 468992 bytes。烧录 `npm run flash:aic` 后，
应看到精简页，帧计数每秒递增，点击按钮触摸计数递增。


### 精简页真机验证（2026-10-09）

用户烧录后反馈页面基本正常。启动日志不再出现 bundle eval OOM 或 run finished，
持续输出 61–63 fps；touch raw/mapped 坐标一致，touch_reports 随触摸增长。
该日志片段中的 turn_max 为 4–7 ms（宿主 turn 测量范围，不代表整帧显示延迟）。

- JS heap：启动采样 1163037 bytes，随后 996688–1007882 / 4194304 bytes。
- TLSF pool：启动采样 2284370 bytes，随后 2034199–2057791 / 4249600 bytes。
- pool 历史峰值：2930837 bytes，距池容量余量 1318763 bytes（约 1.26 MiB；不代表最大连续空闲块）。

这次验证确认当前精简入口可以启动、持续出帧并接收触摸。日志仍有
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
约 6.0–6.4 MiB。板端入口已回退精简页；完整功能恢复走
[内存优化方案](../../docs/aic-memory-optimization.md) 的方案 A（板端紧凑装配），
实测记录见其 §2.1.1。
