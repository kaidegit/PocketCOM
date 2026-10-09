# PocketCOM on AIC + RT-Thread

本期接入 D12x demo68-nor：PocketCOM 应用包、固件构建与静态内存预算。复用现有 480×272 UI，布局尚未针对小屏优化；没有 UART/网络/MCP `com.*` 桥、持久化或软键盘。构建不自动烧录，产物尚需真机启动验证。

## 分层

```text
PocketCOM app/core/bridge（共享产品逻辑，Vue Vapor）
  → host/rtthread（产品 manifest/profile + 构建编排）
  → vendor/pocketjs/hosts/aic（QuickJS、触摸、帧循环、RGB565、MPP 显示）
  → vendor/luban-lite（RT-Thread、板级驱动、链接、bootloader、镜像）
```

`app/main.aic.tsx` 在 mount 前初始化 480×272 应用视口，桌面入口独立。host profile 固定 density 1、native presentation、60Hz，仅声明真实宿主能力。UI 保持 MiSans，mono 用 fork 的 JetBrains Mono（与产品 vendor 字体相同）；从两份语言包的字符串值提取额外字形，不烘焙整个 CJK 字符域。未烘焙输入仍可能显示替换符，HEX 视图保证字节表达。

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
npm run flash:aic -- -p /dev/cu.usbserial-XXX --verify --reset
npm run flash:aic -- --all -p /dev/cu.usbserial-XXX
```

前置：Bun、npm、Python 3、SCons、cargo/rustup，以及 fork 的 `hosts/aic/rust/rust-toolchain.toml` 指定的 nightly + rust-src。工具链需要 upstream `riscv-none-elf-gcc`；脚本遵循 SDK 的 `RTT_EXEC_PATH`，不下载或安装工具链。SDK 的 Python 依赖由其环境提供，SCons/Python 缺失模块会直接报错退出。

构建流程：

1. fork CLI 校验产品 manifest/profile 与应用类型。
2. fork resolver 生成 plan，编译器生成 JS/PAK，`makeVariant`/包编码 API 生成 `.pocket`，再执行包验证。
3. 生成契约头和完整二进制 C 数组到 fork 已忽略的 `hosts/aic/generated`。
4. SDK 已跟踪的 bootloader.bin 保持原样；应用 bootloader defconfig 并调用 SDK `calc_linked_addr.py` 生成忽略的 `.image_cfg.json.tmp` 地址元数据，再切回产品 defconfig。
5. SCons 编译运行时和产品固件，输出 ELF/map/ITB/IMG，生成并检查内存预算。

`--sdk` 将在指定 checkout 产生 SDK 正常构建文件/配置，但不修改其已跟踪源码。SCons 参数用于构建选项，不支持切配置、清理、dry-run 或目标覆盖。共用一份 fork 的 `generated`，因此不同应用/SDK 构建不可同时运行；切换回 demo 时需重新生成 demo 包。

## 产物与内存

- `dist/aic/pocketcom-aic.pocket`：应用包。
- `.pocket/aic/`：plan、JS、PAK 和中间文件。
- `dist/aic/memory-report.json`：本次固件 ELF/map 的包大小、section 大小与地址、CMA/SW 区域/heap 边界、framebuffer/TLSF 和 flash 预算，字段单位均为 bytes。
- `vendor/luban-lite/output/d12x_demo68-nor_rt-thread_pocketjs/images/`：SDK 固件产物，包括 `d12x_demo68-nor_v1.0.0.img`。

当前 `.rodata` 位于 **PSRAM_CMA**，内联包随 bootloader 的固件加载常驻 PSRAM，并非 flash 零拷贝资源。宿主借用该包，没有额外整包加载缓冲。文件入口 `pocketjs_aic_run(path)` 会读入整包，PAK 又长期借用，所以仅恢复 `/rodata` 分区不能减少总 PSRAM。

报告从 ELF 读取 allocated section，从 map 读取实际边界和内联包大小。CMA 余额扣两个 RGB565 framebuffer（480×272×2×2 = 522240 bytes），SW 余额扣宿主 TLSF 池；两者都是理论余额，不含其他分配、对齐、驱动和碎片开销，不构成运行稳定性证明。OS 预算按 ITB 对比实际分区大小。任一预算不足时，报告仍保存，但命令非零退出；不自动扩大分区或调高 heap。

本期保留内联存储。将来可评估应用包 flash 映射或资源按需缓存；当前 SDK 即使开启 XIP，链接脚本也仍将 `.rodata` 放入 PSRAM，不能直接宣称节省包内存。

## 验证

```sh
bun test test/host/rtthread/
npm run typecheck
bun test test/
npm run check && npm run build
cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host
```

重复 package 应得到相同 `.pocket`；构建后查看报告和 ELF/map。烧录用 `npm run flash:aic`：写入 `images/` 下 SDK 打包产物（spl 分区放 `bootloader.aic`，os 分区放 `d12x_os.itb`），烧写偏移按 pack image_cfg.json 的分区表推导；`.img` 是带 section 偏移的容器，不能作为裸文件直接写某个 flash 地址。真机检查启动错误、持续出帧、字体和 UI 渲染；当前不以完整触摸交互或串口收发作为验收。

本机验证（2026-10-09）：应用包 1153064 bytes，ITB 2711552 / 3145728 bytes；CMA 扣双 framebuffer 理论余额 408656 bytes，SW 扣 TLSF 理论余额 468992 bytes。重复打包 SHA-256 相同，273 项 Bun 测试、48 项 macOS 宿主测试通过，桌面脚本启动出帧成功。真机验收尚未执行。
