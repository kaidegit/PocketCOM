# AIC 静态字边彩点、发虚与像素跳动排查（2026-10-24）

## 反馈与判断边界

用户提供 `IMG_2414.HEIC`：480×272 共享 UI 连接配置抽屉中的字边有彩点、笔画不清。
用户另行明确：**画面静止时也会跳动**。照片可能叠加相机与 LCD 像素网格的干涉，
不能仅凭照片判定软件字形颜色错误；静态跳动需要检查显示采样链路。

## 软件回放

以本轮实际 `dist/aic/pocketcom-aic.pocket` 为输入，复用已有离板探针的 QuickJS、
原生核心与原生 RGB565 渲染器，增加与固件相同的两个独立 damage target 和两个
480×272 RGB565 framebuffer；按 prepare → render_strip → commit 逐帧运行。
此实验 accelerator 为 NULL，不模拟 GE、DMA/cache、VSYNC 或物理 LCD。

- 120 帧，第 3 帧在 `(20,20)` 触摸一次并在下一帧释放，打开共享连接抽屉。
- 两个缓冲完成初始绘制后第 2、3 帧逐像素差异为 0；第 4、5 帧因抽屉打开有更新。
- 第 6–120 帧双缓冲逐像素差异均为 **0**；第 7–120 帧 damage regions 为 **0**。
- guest `frames=120/0`、`caps_fails=0`。
- 导出的 framebuffer 字边为正常灰度覆盖，没有照片中的强烈彩色杂点。

这排除了所测软件路径在空闲时持续重采样/改变字形的情况，**不能排除 GE/cache 或物理
显示链路的问题**。本次无需增加 font atlas density、放大 framebuffer 或更换字体。
实验的内存数字包含额外两个离板 framebuffer，不作为本轮板端内存结论。

诊断源、日志与原始 RGB565/PNG 保存在 `dist/aic/font-render-fix/diagnostics/`。

## 板级时序修正

发现同板 SDK 的参考方案
`target/configs/d12x_demo68-nor_rt-thread_helloworld_defconfig` 使用
`CONFIG_AIC_DEGREE_90=y`，而 PocketJS 产品 defconfig 自初始接入起使用
`CONFIG_AIC_DEGREE_0=y`。其他 demo68 参考方案同样显式选择 90°。

本次仅将产品
`vendor/luban-lite/target/configs/d12x_demo68-nor_rt-thread_pocketjs_defconfig`
恢复为 **90°**。Kconfig 将其转换为 `AIC_RGB_CLK_CTL=1`，`panel_simple.c` 传入
`panel_rgb.clock_phase`，`drv_rgb.c` 在 RGB `CKO_PHASE_SEL` 写入相位。
MiSans / JetBrains Mono、字号、灰度 atlas、density=1、RGB565、UI 和堆配额保持原配置，
以便单独验证采样相位的影响。

依据：匠芯创的 [Panel_RGB 参数说明](https://aicdoc.artinchip.com/topics/sdk/display/display_parameter_panel_rgb-luban.html)
定义 clock-phase 为时钟上升沿相对数据延后 0°/90°/180°/270°；
[LCD 调试指南](https://aicdoc.artinchip.com/topics/tools/aipq-function_intro.html)
将调整时钟相位列为 RGB 颜色异常的排查项。软件回放稳定、产品相位偏离同板参考和
静态噪声反馈共同支持优先恢复板级配置。这是烧录前的修复判断；用户随后确认的真机结果见下文。

## 本地验证与交付

- `npm run typecheck`：通过。
- `bun test test/host/rtthread/`：14 pass，0 fail。
- `RTT_EXEC_PATH=/Users/kai/DevTools/xpack-riscv-none-elf-gcc-15.2.0-1/bin npm run build:aic`：
  manifest/应用检查、打包校验、固件构建与静态预算校验通过。
- 构建后的 `rtconfig.h`：`AIC_DEGREE_90`、`AIC_RGB_CLK_CTL 1`。
- 新包再次回放 120 帧，与诊断时的 RGB565 结果逐字节一致；第 6–120 帧双缓冲差异为 0，
  第 7–120 帧 damage regions 为 0；零 guest 帧错误、零分配失败。
- 静态预算：framebuffer 后 CMA 余额 **243,780 B**，guest/系统预留后 SW 余额
  **1,441,792 B**；OS 分区 **2,969,600 / 3,145,728 B**，余量 **176,128 B**。
  这些数字不代表运行时内存验收。

交付快照目录：`dist/aic/font-render-fix/`，含 ITB、IMG、应用包、内存报告、生成的
`rtconfig.h`、构建日志、诊断与 `SHA256SUMS`。

| 产物 | SHA-256 |
|---|---|
| `d12x_os.itb` | `5d25b6ef4069cd3011a2a962f3a15ef552c9569e53ee5174f67d584604da7be7` |
| `pocketcom-aic.pocket` | `aa43cb0dfddc5b31eba775f08528c1033efcb32816658ee450ab60ff3dd115db` |
| `d12x_demo68-nor_v1.0.0.img` | `5c8f24a5aed6000b7f66e739ed029228829f1f13630c251bfb04dd93905307d9` |

## 真机结果与回归方法

2026-10-24，用户在本轮修正后明确反馈：**“确实好了”**。本次字体发虚与静态字边
跳动的修复经用户真机确认；没有据此新增长时、业务流量或 WiFi 组合验收结论。

用户负责烧录与屏幕反馈。本轮只需烧录 app 的 `d12x_os.itb`，不需要更新 bootloader。
构建交付时串口 `/dev/cu.wchusbserial5C361369071` 被 PocketCOM 占用，agent 未抢占或自动烧录。
后续回归可按以下步骤观察：

1. 观察静止画面 30 秒：标题、12/14px 中文、串口/波特率与细边框应稳定，无持续彩点跳动。
2. 打开连接配置，滚动并停止；观察停止后的字边，再切换浅色/深色观察高反差笔画。
3. 检查抽屉、下拉与触摸滑动仍正常；回传启动/帧日志及屏幕观感。

如仍跳动，下一步在真机上区分 GE/cache 与 LCD 链路，再用同一静态图做相位 A/B；
不能把离板截图或构建成功写成真机已修复。
