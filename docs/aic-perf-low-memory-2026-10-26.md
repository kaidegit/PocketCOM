# AIC 减少重复工作与分段计时（2026-10-26）

用户要求优化连接配置/软键盘首次创建与重绘，尽量不增加内存负担。
本轮减少原生节点兼容对象和临时闭包、GE 重复写入、空闲帧缓存刷新/翻页；
补齐分段计时并修正 FPS 统计。堆/CMA 边界、JS 配额、产品 feature、节点复用策略和
GE 48 KiB 暂存面容量均保持原值。

## 修改

1. `native-tree.ts`：DOM 兼容 style/classList 首次访问才分配，各节点独立可写，
   节点标记共享于原型；取消每节点的初始化 Object.assign 临时对象。
   Vue Vapor 原语的直接 HostOps 路径不访问这些兼容容器，因此启动和首次面板创建减少分配。
2. `components-vue-vapor.ts`：复用两份文本/注释创建函数；嵌套原生文档上下文直接复用；
   无 slot 的叶子跳过子节点处理，函数 slot 省掉 wrapper closure 与 rest 参数数组。
   对象 slot bag 保留调用方式和文档恢复语义。
3. `pocketjs_ge.c`：有效像素在转换时全部覆盖，只清每行至多3个 padding 像素，
   取消两张暂存面的整面 memset。保留 stride、对齐、缓存维护、同步与失败不写回规则。
4. `pocketjs_host.c`：standby target 无 damage 时仍 commit，但不清整面 cache、不 PAN、
   不切换当前可见 buffer；保留 vsync 与 guest 固定虚拟 tick。有变化后按该 target 历史绘制。
5. FPS 按实际窗口的帧数/耗时归一化，并从本次报告时刻重开窗口。旧 stats_deadline +=1秒
   在1–2秒长停顿后积压，可能把很短追赶窗口的一帧打印成 fps=1；旧日志的 fps=1
   不能直接等同于“一帧渲染耗时1秒”。新增窗口跨度让这个解释可核验。

## 分段诊断与内存代价

沿用 POCKETJS_DIAG；关闭时不编译计数和时间读取。计数数组仅88 B、无 trace 环、
无逐帧日志、无动态分配。用 SDK 单调微秒计时 aic_get_time_us，不依赖 Date.now/RTC。
每个统计窗口打印：

- `[PJS-PERF] window_ms=... ui_max_us hit=... js=... tick=... draw=...`
- `[PJS-PERF] frame_max_us prepare=... raster=... present=... vsync=...`
- `[PJS-PERF] ge_sum_us convert=... wait=... copy=...`

ui/frame 是窗口内该阶段单次最大微秒数，各项可能出自不同帧，不能相加当作一帧总时间。
GE 是该窗口内累计值，wait 含 fill/blit 的同步驱动等待；转换与写回独立，raster 本身也包含 GE。
每次报告后清零。日志串口输出与时钟读取存在观测开销，不是零成本。

**更正旧分析口径**：turn_max 围绕 pocketjs_ui_turn，包含触摸命中、JS frame/jobs、core tick
和 core draw（包括布局），并非纯 JS 执行。它不含后续 RGB565 光栅化、PAN/vsync 及帧末显式 GC。
旧日志不能单独定位面板创建、布局、GE 或内部自动 GC；新增分段值用于下一次真机定位。

相对本轮前固件快照，ELF .bss 从259564增加到259676 B，.data 从22984到22988 B，
两者合计增加116 B（含计数器和链接变化）。主机每帧另有少量局部时间戳，不分配堆缓存。
以下离板实测显示整体工作集/峰值净降低；这不替代 RV32 系统运行峰值验收。

## 验证

### 内存对照：同一 LP64 固定 7 MiB TLSF 池

`python3 tools/aic-memory-stress.py --scenario combined --combined-cycles 10 --tag perf-before --package dist/aic/perf-low-memory/before/pocketcom-aic.pocket`

新包同参数、tag=perf-after-final；场景/输入/宿主观察钩子/GC 策略一致，每组100/100状态检查。
同一输入序列验证抽屉、键盘、设置、收起复用及编辑，未增加额外手动 GC。

| 包 | 系统峰值 B | caps 峰值 B | 分配失败 | GC 次数 |
|---|---:|---:|---:|---:|
| 本轮前 | 6621664 | 6468614 | 0 | 416 |
| 新包 | 6429928 | 6278324 | 0 | 405 |
| 减少 | 191736（187.24 KiB） | 190290 | — | — |

新包额外50轮验证：

| 模式 | 检查数 | 系统峰值 B | 分配失败 |
|---|---:|---:|---:|
| --busy，无空闲机会 | 420/420 | 6527616 | 0 |
| --rapid，快速输入 | 420/420 | 6456776 | 0 |

普通/忙帧为48000 turns，快速为3600 turns；这些帧数是虚拟时钟，不是真机浸泡时长。
原始输入/日志/报告位于 `.pocket/aic/memory-stress/perf-*`，汇总随固件保存为 stress-report.json。
PSRAM/XIP、DMA、系统线程与RV32指针差异仍需板上测量。

### 视觉与双缓冲

同一原生核心/QuickJS/实际包字体，用 RGB565 离板回放比较初始、抽屉展开/收起、键盘展开/
收起、发送区收起6个状态，每张480×272，前后零像素差异。
新“无 damage 不翻页”序列又与原每帧交替双缓冲输出比较，6个状态零像素差异；92帧的
整个操作序列由92次翻页降为17次，验证 target 历史更新未破坏可见结果。
这是CPU回放，不能证明真实 GE 像素、DMA cache 一致性、PAN/vsync 驱动行为或触摸手感。
回放用的脚本/源码/原始RGB565在 `.pocket/aic/perf-low-memory/`，汇总为 pixel-report.json /
idle-present-report.json；该回放的 malloc allocator 不参与上方TLSF内存结论。

### 时间探针与测试

实际包的 LP64 QuickJS 分段采样确认首次抽屉/键盘主要时间在JS侧，但几毫秒级原生样本
有抖动，本轮不据此宣称已降低真机1.69秒/626毫秒停顿。native-timing.json 保留三次原始值，
离板不包含 XIP 取指、板端 PSRAM 和真实调度。

- 349项源码测试全部通过，真实 Vue Vapor/core 的软键盘/抽屉/接收滚动在其中，未跳过。
  测试文件用 rg --files test -g '*.test.ts' 枚举并传绝对路径，避免 Bun 把 dist/旧快照里的测试
  一并发现。初次宽泛发现曾误收录历史 dist/aic/uart-receive-delay-fix/source 测试，已排除该产物路径。
- fork相关13项测试通过：DOM容器按需与独立状态、Vapor lowering/交互/销毁、硬件解码、
  tick wrap/FPS窗口归一化、GE alpha/stride/失败回退与禁用变体。
- typecheck、桌面check/build、AIC实际SDK构建及静态预算通过。

## 交付

固件/IMG/ELF/map/应用包/报告/测试日志/两仓工作区patch：`dist/aic/perf-low-memory/`。
只烧录 os 的内容是 d12x_os.itb，IMG为容器。应用包与本轮旧包不同，请使用本目录完整固件。

- 应用包 829192 B，SHA-256 `720eeabbd7eee061f0070d538cdc2c43983f000d05642922fc935bdb8dcbfac8`。
- ITB 3006464 / 3145728 B，SHA-256 `3ad78bf8adff674f7a91afcdb0d229ff0e51d95ca32c8d5ca7b6965c45b2b52c`。
- CMA扣双framebuffer后静态余量 243668 B，运行期A8约48 KiB另扣。

### 本轮真机回传

用户按连接配置打开/收起、发送框聚焦/键盘、键盘交互/收起、发送区收起回传日志。
原文保存于 `dist/aic/perf-low-memory/user-board-perf.log`；串口有数字跨行，以相邻片段复原。
前版原日志为 `dist/aic/clock-cache-decode-fix/user-interaction-sequence.log`。

| 指标 | 前版 | 本轮 | 变化 |
|---|---:|---:|---:|
| S4 系统占用 B | 4524772 | 4462516 | -62256 |
| frame120 系统占用 B | 4498272 | 4433492 | -64780（63.26 KiB） |
| frame120 JS 对象数 | 5178 | 4859 | -319 |
| frame120 最大连续空闲块 B | 1565780 | 1635264 | +69484 |
| 线程栈历史峰值 B | 90868 | 82596 | -8272 |
| 操作期间系统历史峰值 B | 5782276 | 5655204 | -127072（124.09 KiB） |
| 最后系统占用 B | 5750688 | 5607948 | -142740 |

启动120帧样本支持按需分配降低工作集的结论。两轮触摸/键盘输入并非严格一致，
操作峰值与最终占用只作观测对比，不能将差值全部归因于本轮修改。
本轮启动、首帧、120帧 caps_fails=0，后续未见失败日志；交互结束没有新的完整 caps
快照，不据此声明全过程计数为零。CMA 使用588152/765908 B，剩177756 B。
时钟、MHCR与SYSMAP与前轮一致，D-Cache及PSRAM/XIP cacheable配置开启。

| 操作所在窗口 | UI turn 最大 ms | JS 最大 ms | core tick 最大 ms | core draw 最大 ms | raster 最大 ms |
|---|---:|---:|---:|---:|---:|
| 首次打开连接配置 | 1898 | 1860.328 | 29.221 | 8.185 | 65.581 |
| 收起连接配置 | 73 | 65.638 | 3.083 | 6.214 | 32.268 |
| 发送框聚焦 | 139 | 113.905 | 20.456 | 4.173 | 32.883 |
| 首次打开键盘 | 710 | 684.234 | 13.819 | 11.783 | 77.537 |
| 键盘点击 | 196 | 169.119 | 18.824 | 7.786 | 77.429 |
| 收起键盘 | 95 | 84.498 | 3.384 | 7.663 | 77.093 |
| 收起发送区 | 216 | 185.916 | 24.053 | 6.353 | 19.965 |

各列是窗口最大值，可能来自不同帧，不能相加作端到端延迟。JS阶段包含 guest frame、
jobs及其间可能发生的自动GC，不等同于某个组件构造函数耗时。
前版首开配置turn1689ms、键盘626ms，本轮未显示首开延迟改善；单次不同输入样本也不足以
定量判定回退。首开配置窗口2124ms，fps=1对应真实长停顿，主要落在JS阶段。
该窗口只有1个damage帧，GE累计转换12.468ms、等待14.616ms、写回4.348ms；
GE不是这次接近2秒停顿的主因。后续应进一步定位JS首次创建/响应更新，维持不扩堆的约束。

初始静态窗口通常56–59fps（一次带GC窗口47fps）；无damage时present=0、GE累计全0，
raster约0.23ms，确认跳过翻页路径运行。配置展开后无damage仍28–29fps，UI turn约15ms，
vsync最大约15.4ms，需继续检查帧调度与常驻JS/core draw成本；不能凭窗口最大值直接归因。
发送区收起后54–58fps，raster约0.16ms。显式GC历史最大66ms，无法解释首开1.86秒JS耗时，
但JS内自动GC尚未独立计时。本次没有第二次展开配置/键盘样本，复用速度仍待量化。

本轮完成启动/120帧及上述交互的内存和分段采样；未覆盖长时、UART/WiFi组合或视觉验收。
内存优化已在板端体现，首次创建卡顿仍未解决。
