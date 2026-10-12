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

## 命令

```sh
npm run check:aic      # 校验产品 manifest/profile 与应用类型
npm run package:aic    # 生成 JS/PAK/.pocket + 宿主契约头与内联 C 数组（重复打包应得相同 .pocket）

RTT_EXEC_PATH=/Users/kai/DevTools/xpack-riscv-none-elf-gcc-15.2.0-1/bin npm run build:aic
                       # 本机 xPack 工具链；默认 SDK=vendor/luban-lite；
                       # 可加 -- --sdk /path/to/sdk -- -j4（不传则 -j8）
                       # 输出 ELF/map/ITB/IMG + dist/aic/memory-report.json；预算超限非零退出

npm run flash:aic -- -p /dev/cu.usbserial-XXX -b 3000000 --verify --reset
npm run flash:aic -- --all -p /dev/cu.usbserial-XXX
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

- 板端入口 `app/main.aic.tsx → app/aic.tsx`：**480×272 精简验证页**（帧计数 + 触摸计数），
  真机验证通过（启动/持续出帧 60–62 fps/触摸一致，无 OOM）。**不得未经内存验证重新引入完整
  App/session 启动图**——完整桌面 UI 常驻工作集 ≈8.1 MiB，超出板上 guest 可用约 6.0–6.4 MiB
  （WiFi 前口径）， mount 会以 `TypeError: not a function` 的伪装形式 OOM。
- AIC 打包对 SDK 编译器输出的自包含 IIFE 再压缩标识符和空白（不折叠表达式、不改宿主属性名），
  桌面构建不变。
- 字体：UI MiSans、mono JetBrains Mono；从两份语言包字符串值提取额外字形烘焙；
  未知字形回退替换符，HEX 视图无损。
- WiFi（RTL8189FTV，2026-10-11 点亮至 AP 扫描）：SDIO 接 SDMC0（4-bit @40MHz）+ third-party
  lwIP（netif `WL0`，`AIC_WLAN_REALTEK` 配置链）；驱动 `.bss` ≈259 KiB 进 PSRAM、运行缓冲吃统一堆，
  恢复收发功能前必须补 WiFi 开/关、连 AP/断开状态的堆基线测量。模组 EN 由载板保证，固件不做电源控制；
  PM 睡眠驱动未编入，固件不进睡眠。

## 回归验证

```sh
bun test test/host/rtthread/    # 板端构建编排单测
npm run typecheck && bun test test/
npm run check && npm run build  # 桌面回归（allocator/字节码类改动需加对应宿主测试）
```

完整恢复路线（方案 A 板端紧凑装配 → P0 测量 → P1 收发闭环 → P2 功能恢复 → P3 取舍）见
docs/aic-memory-optimization.md §11。
