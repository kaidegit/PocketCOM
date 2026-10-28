---
name: desktop-test
description: PocketCOM 桌面端测试——核心单测、宿主 Rust 测试、串口硬件回环、性能复测、脚本化 UI e2e（截图/坐标/tick 时钟）、MCP 集成与大流量测试。当需要跑 bun test、cargo test、e2e 脚本或验证 UI 行为时使用。
---

# PocketCOM 桌面端测试

## 核心层与类型检查

```sh
bun test test/          # 核心层单测（test/core/*、test/bridge/*、test/app/*、test/host/rtthread/*）
npm run typecheck       # tsc --noEmit；tsconfig 严格度对齐上游，不要私自加严 flags
```

`test/app/features.test.ts` 覆盖统一 feature 配置校验、依赖冲突/循环、planned 登记项禁止配置/调用/拥有资源、AST 特化、
作用域与动态调用拒绝、Vue 转换前的资源移除、热缓存隔离、模块副作用保护与终端/MCP 启动路径裁剪、MCP 控件/文案的开关隔离。
`npm run probe:features` 运行真实 QuickJS terminal 开/关对比，MCP 对比用 `npm run probe:features -- --feature mcp.server`，传输对比用 `npm run probe:features -- --feature transport`，UI 对比用 `npm run probe:features -- --feature ui`，详见 skill `mem-probe`。

`test/app/transport-features.test.ts` 覆盖每种协议单独启用、全开/全关、面板/字典特化、参数 ref 与配置保留、网络宿主无串口 ops 的独立探测、直接会话及桥入口拒绝关闭协议。

`test/app/desktop-profile.test.ts` 验证 `macos-gpui` 构建计划启用原生文字/输入，且误用
上游软件宿主 `macos-app` 会因缺少必需的 `text.layout.native` 被拒绝；实际启动须通过
`node tools/dev.mjs` 复验 plan 派生参数，MCP 测试的显式 `--native-text` 不能覆盖该路径。

## 宿主 Rust 测试

```sh
cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host
```

`--release` 复用既有 release 产物，免 15–25 分钟全量重编。测试源在 `test/host/macos/`，经 `#[path]` 编入宿主 crate：

- `serial_tests.rs` 参数校验 / 事件格式 / 端口过滤
- `tcp_tests.rs` 参数校验 + 127.0.0.1 TCP 回环（监听/接入/定向/广播/踢除/关停级联）
- `udp_tests.rs` UDP 回环
- `ws_tests.rs` 参数校验 / 握手失败 / 子协议头
- `env_tests.rs` 配置原子写 0600 / 导出剥 token（`POCKETCOM_CONFIG` 重定向路径）
- `main_tests.rs` 调度 / repaint hash / 脚本 flags 解析（含 `--no-native-mouse-keyboard`）
- `shot_tests.rs` PNG 头校验
- `mcp_tests.rs` HTTP 解析 / 401 鉴权 / JSON-RPC 分发 / 读缓冲有界 / 命令往返 / mcpStop 语义

## 串口硬件回环（需 TX↔RX 短接的真实串口）

```sh
POCKETCOM_LOOPBACK_PORT=/dev/cu.xxx POCKETCOM_LOOPBACK_BAUD=3000000 \
  cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host com_serial::loopback -- --nocapture
```

未设 `POCKETCOM_LOOPBACK_PORT` 自动跳过；波特率缺省 115200。
校验 serialList 枚举 / 打开 / 信号冒烟 / 回环逐字节（512B ramp、2048B 全字节域、64KiB 分块突发）/
空闲 poll=None / close 语义 / 立即重开。

## 性能复测

```sh
bun tools/perf-audit.ts     # 核心层性能复测
# 桌面 QuickJS 基准：tools/perf-quickjs.c 链接既有 release 引擎库，
# 命令与测量边界见 docs/performance-review-2026-09-17.md
```

只测核心层，不代表完整 UI 帧耗时。

## 脚本化 UI e2e

宿主脚本 flags 经 `node tools/dev.mjs -- <flags…>` 原样转发给宿主二进制（不带 `--` 行为不变）：

- 输入：`--mouse` `--click` `--wheel` `--key` `--type` `--press` `--storm`
- 观测：`--screenshot PATH@T`（第 T tick 导出窗口 PNG，opt-in，CI 不传即不触发）`--announce-ready`
- 控制：`--quit-after`；**e2e 必加** `--no-native-mouse-keyboard`（丢弃物理输入污染）
- `@T` 为 60Hz 虚拟时钟 tick 序号

指定尺寸用 `node tools/dev.mjs --resolution 480x272 -- <flags…>`：覆盖逻辑视口并固定窗口，
其余能力/功能仍来自桌面构建，仅验证该尺寸下共享 UI 的布局/交互。坐标不可从 960×640 等比缩放；
截图探测 `tools/coords-probe.py --density 2 --title-bar 28 diff A.png B.png`，
无标题栏的 1x 板端截图用 `--density 1 --title-bar 0`。截图比例由屏幕 backing scale 决定，
与宿主 raster density 不同。

各参数详解、tick/坐标系、拖拽与组合键配方、截图机制与坑位见 **docs/e2e.md**；
控件坐标速查见 **docs/coords.md**（改布局后必须用 `tools/coords-probe.py` 重测）。
观测用 `POCKETCOM_TRACE=1`。本机真机 e2e 已验证：串口全链路（M1）、TCP Client 回环（M2）、
终端模式（M3 滚轮/拖拽选区/Ctrl 控制码）、MCP 全链路含终端模式门控（M4）、设置弹窗全链路（coords.md §3）。

## MCP 集成测试

```sh
bun test host/macos/mcp/
```

前置：`npm run build` + `cargo build --release` 产物（缺失自动跳过）。脚本化 MCP client 经原生 fetch
走真实宿主+guest 全链路：401 鉴权 → initialize 会话 → tools/list → connect（bun TCP echo + loopback 回环）→
send → read 前缀断言（`[RX]`/`[SYS]`/i18n 手动前缀）→ force 语义 → disconnect → config 白名单
（token 不可触）→ 会话 DELETE；终端模式门控（SPEC §6.1）经 `--click` 脚本切模式验证停服/重启。

同目录 `flood.test.ts` 大流量 e2e：loopback + MCP 灌入 400 条小帧 + 6×48KiB 突发（超环形缓冲
256KiB 触发逐出），断言收/发字节对称、洪峰后连接与 MCP 存活、渲染收据出帧，并落 3 张窗口截图
（无屏幕录制权限的会话里截图断言降级为警告跳过，见 docs/e2e.md 常见坑 6）。

## UI 金样测试

PocketJS headless Bun host（byte-exact PNG golden）待落地；`--screenshot` 输出非确定性，不做 byte-exact 金样。

## UI feature 裁剪验证

`test/app/ui-features.test.ts` 覆盖 UI 全开/全关、九项逐项关闭的 Vapor 编译、控件/文案移除、
导入配置不激活禁用设置且导出保留、系统主题状态、普通文本编辑/剪贴板/发送快捷键与软键盘输入。
`settings-modal-layout.test.ts` 覆盖禁用行收拢及内容高/边界同步。软键盘真机 e2e 与坐标见
`docs/coords.md` 的软键盘条目，`docs/ui-feature-heap.md` 记录离板测量条件和结果。

## 共享窄屏连接配置回归

`test/app/serial-receive-clock.test.ts` 使用真实 Vue Vapor/core WASM 和模拟 UART1 原始回环事件，
覆盖 AIC/桌面两种 profile：RTC 冻结时 TX/RX 计数到接收文字的后续帧更新、RTC 回拨、
日志日历时间戳保留，以及 300 baud 仍按静默阈值合帧。会话泵必须传框架帧时钟毫秒值，
不能传未启用 RTC 的 AIC 上不可靠的 `Date.now()`。缺少 WASM 时显式跳过；验收前须先构建再运行，
不接受跳过。根因与固件见 [接收延迟记录](../../../docs/aic-uart-receive-delay-2026-10-26.md)。

`test/app/workspace-layout.test.ts` 验证宽窄屏工作区几何、非负边界及回到宽屏关闭抽屉；
`test/app/wheel.test.ts` 验证面板卸载时注销滚轮回调、旧作用域清理不覆盖新订阅。
第 2 步使用同一共享 App 的 480×272 桌面实机 e2e 验证抽屉/下拉/翻页/设置、未提交参数与发送草稿保留、
回环连接和收发计数连续；坐标及证据边界见 `docs/aic-narrow-panel-step2.md`。首次打开后面板复用，
关闭移出视口；隐藏字段不应截获工作区选区/焦点。此测试不能替代 AIC 触摸及内存验收。

AIC 触摸使用 bounds 命中，桌面鼠标使用 ink 命中；2026-10-24 修复 Vue Vapor Portal host
缺少 `hitPass: 1` 导致抽屉关闭后拦截触摸。引擎回归使用真实 Vue Vapor 与原生核心 WASM：

```sh
(cd vendor/pocketjs && bun tools/wasm.ts && bun test --conditions=browser tests/portal-hit.test.ts tests/portal-hit-vue-vapor.test.ts)
```

覆盖返回/遮罩交替关闭后重开、浮层显示时阻挡底层按钮、同一实例复用。实际 AIC 包还须用触摸输入
逐轮检查展开/收起后的命中结果；仅有 `frames=N/0` 和零分配失败不能证明点击成功。

`test/app/panel-touch.test.ts` 将共享 App 按 JSON `aic-diagnostic` profile 编译为真实 Vue Vapor，
用原生核心 WASM 的 down-edge bounds fact 驱动纵向拖动，检查内容位移、上下边界、横向拖动、
滑动不误触下拉、普通点击、头部/页脚/弹层隔离、隐藏时取消及复用后继续滚动。
此项在缺少 `vendor/pocketjs/hosts/web/pocketjs.wasm` 时显式跳过；触摸修复必须先构建再单独执行，不能把跳过当通过：

```sh
(cd vendor/pocketjs && bun tools/wasm.ts)
bun test test/app/panel-touch.test.ts
```

实际交付 AIC 包还须经 QuickJS/native core 连续触摸验证偏移，不能仅凭桌面 `--mouse d/u`
或 `--wheel` 验收手指拖动；本次前后包证据见 `docs/aic-narrow-panel-step2.md` 触摸滑动修复章节。

## 文本域二次点击软键盘

共享 `TextField` 第一次点击只聚焦，再次点击当前域展开，无双击时间限制；程序 `focus()` 不展开。
拖动/取消不展开，失焦/切换/卸载收起，键盘首次创建后移出视口复用；大小写更新同一组按键。
`test/app/soft-keyboard-touch.test.ts` 按 JSON 的 AIC/开启/关闭 profile 编译真实共享 App，
覆盖 AIC bounds 触摸（发送/自定义波特率/设置）、按住/拖动/CANCEL、桌面选区提前聚焦、
大小写/输入/退格/回车、反复开关复用、收起后底层命中及后创建弹层上的键盘层级。
自定义波特率用真实 Select 建立状态，因 480×272 下末项越屏而直接激活该选项；随后输入框和键盘均走 bounds 触摸。
缺少 WASM 时显式跳过；验收前必须先构建 WASM，再单独运行本测试，不能将跳过算作通过。
运行命令与 `panel-touch.test.ts` 相同，仅替换测试文件名；交付记录见
[软键盘修复](../../../docs/aic-soft-keyboard-2026-10-25.md)。

临时编辑面板增加 `test/app/keyboard-editor-layout.test.ts`：空值、首个换行、两行窗口、长行横向跟随、可见位置到原文索引。
`soft-keyboard-touch.test.ts` 同时检查字段名/原文/光标实时一致，点击预览移动光标并继续输入，1000 字符长行、
多行回车、单行提交及收起后光标保留。WASM harness 不含字体 atlas，命中几何用固定字宽；
交付包仍须用其真实 MiSans/JetBrains Mono 经 native core/RGB565 回放验证键帽居中与预览。
桌面 companion 鼠标在整个编辑面板内被门控，预览点击只移动当前域光标，不路由到背后的输入框。
详见 [临时编辑面板](../../../docs/aic-keyboard-editor-2026-10-25.md)。

`send-collapse.test.ts` 覆盖初始展开/持久化折叠、首次展开延后创建，之后 20 轮隐藏复用、草稿/光标、失焦和 bounds 命中隔离。
板端实际包的固定池 TLSF 对比及分配器 ASan/UBSan 用例见 [本次记录](../../../docs/aic-send-collapse-tlsf-2026-10-25.md)。

软键盘固定键位批量更新回归增加语言/主题/视口切换后节点身份、几何/颜色更新，以及键盘打开时卸载整个 App 后重新挂载输入。
原生 RGB565 前后回放像素一致；固定池无 GC 长时/快速压力与显式 GC 对照分别记结果，不将二者混作通过。

AIC 帧边界压力回收的 `test/host/rtthread/gc-policy.test.ts` 编译同源 C 策略并经 ASan/UBSan
验证首次回收、增长/压力边界、忙帧超时、不可回收常驻基线和 32 位时钟回卷。
实际包压力用 `python3 tools/aic-memory-stress.py --busy --gc compare --tag busy-7m`
及 `--rapid`，前置 `npm run package:aic`；它逐次核对触摸状态/节点身份。
busy 只是调度器无空闲输入，不代表真实串口/绘制；压力 GC 的独立历史结果见
[压力 GC 记录](../../../docs/aic-gc-pressure-2026-10-25.md)。

2026-10-26 组合修复增加 `--scenario combined --combined-cycles 50 --gc policy`（可加
`--busy`/`--rapid`），逐次检查设置输入/取消草稿重置和三类缓存节点身份；固定 7 MiB 三组各
420/420 通过。`soft-keyboard-touch.test.ts` 另覆盖设置隐藏命中、外部配置快照及 App 重挂载。
PocketJS 编译器普通 View/Text 路径的真实 Vapor/core 回归在
`vendor/pocketjs/tests/vapor-primitives.test.ts`，与 Portal/frame/action 等测试一起用
`bun test --conditions=browser` 从引擎目录执行。五张 native RGB565 前后回放零像素差异；
产物及真机待验收范围见 [组合修复记录](../../../docs/aic-combined-oom-2026-10-26.md)。

## 接收日志触摸滚动

`test/app/receive-touch.test.ts` 用 JSON AIC profile 的真实 Vue Vapor/core bounds 接触点回归日志纵向拖动、
上下边界、历史锁定与恢复贴底、横向/工具栏/发送区隔离、抽屉中断、下拉/设置遮挡及发送区折叠后的命中。
WASM 前置同面板触摸测试，执行 `bun test ./test/app/receive-touch.test.ts`；缺少 WASM 的跳过不算验收。
实际 AIC 包 QuickJS/native 连续触摸与真机内存仍需单独验收；记录见
[接收拖动修复](../../../docs/aic-receive-touch-2026-10-26.md)。

若dist保留了包含source/test的历史固件快照，Bun的路径过滤可能发现旧测试；回归应通过
`rg --files test -g '*.test.ts'` 列出当前源码测试并传入其绝对路径，避免把产物目录当源码。
本轮低内存节点改动的349源码测试、真实Vapor触摸及6状态RGB565对照见
[本轮记录](../../../docs/aic-perf-low-memory-2026-10-26.md)。

2026-10-26 临时TS创建诊断固件 `dist/aic/ts-create-perf/` 输出 `[PJS-TS]`，
使用宿主单调微秒时钟，组件/原语/样式/Vue flush/HostOps分开采样。inclusive不可相加；
console在span结束后输出，但仍计入C层JS总时间。普通离板probe没有诊断时钟时不会启用
此收集器；短测使用带时钟的独立native harness，不能把普通probe通过当作诊断已启用。
正常桌面入口不安装，产品堆/配额未变，当前真机结果待补。口径与删除清单见
[TS诊断记录](../../../docs/aic-ts-create-perf-2026-10-26.md)。

2026-10-27 inline style批量提交：固件 `dist/aic/style-batch/`；在package:aic之后运行
`bun tools/aic-prop-batch-test.ts` 验证实际QuickJS绑定（依赖离板probe原生构建前置）。
框架 `tests/style-batch.test.ts` 对照scalar/batch编码、顺序、变化项与错误前提交；
触摸测试的HostOps观察器必须同时记录setProp和setPropBatch，不能因漏采batch判为没滚动。
属性调用次数减少不等于真机提速比例，临时TS日志仍有开销；内存/像素/压力边界见
[本轮记录](../../../docs/aic-style-batch-2026-10-27.md)。

2026-10-27 后续性能复测已撤除tree/primitive/HostOps密集埋点，不再包装ui.*；
仅保留组件/键盘effect/Vue flush/frame，启动标识 `mode=coarse props=scalar/batch`。
对照固件在dist/aic/coarse-perf-scalar，正常batch在dist/aic/coarse-perf；临时控制入口随
产物保存，工作区与默认产物恢复batch，不新增产品feature开关。两版各重启后用同一序列，
比较同一组件/TS frame；仍有粗粒度探针开销，不接受旧密集版self作为直接净收益基线。
原生probe无诊断时钟不会启用收集器，应另检实际包带时钟路径。见
[粗粒度复测记录](../../../docs/aic-coarse-perf-2026-10-27.md)。

后续真机同口径A/B已否定自动style合批的净收益：本组配置/键盘慢18%–21%，已恢复
直接逐属性setProp，未删除可选C batch接口。当前固件dist/aic/scalar-style；启动行
`mode=coarse inline=scalar batch_api=1`，不能再由接口存在判断inline走法。
框架回归改名为tests/inline-style.test.ts，验证即便宿主支持batch，inline仍即时直接写入，
编码/差量/错误前提交一致；C接口集成测试保留。A/B档案不覆盖当前默认固件，见
[最新结论](../../../docs/aic-coarse-perf-2026-10-27.md)。
