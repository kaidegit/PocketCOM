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
