# AGENTS.md

本文件是 agent 在本仓库工作的约定。功能与架构的权威定义见 [SPEC.md](SPEC.md)，任何与 SPEC 冲突的实现都以 SPEC 为准（或先改 SPEC）。

## 项目简介

PocketCOM：基于 [PocketJS](https://pocketjs.dev) 运行时的串口/网络调试助手（参考 COMTool 精简复刻）。单页面、收发/终端双模式开关切换；连接支持串口/TCP/UDP/WebSocket；i18n + 深色模式；内置 MCP server 供 AI agent 共享收发。首期平台 macOS，远期 RT-Thread。

## 技术栈与硬性约束

- TypeScript（strict）+ PocketJS **Vue Vapor 适配器**（`vue` + `vue-jsx-vapor` + `@pocketjs/framework/vue-vapor`），不使用 Solid/Octane。
- **引擎布局怪癖（实测，勿踩坑）**：
  - 嵌套 flex-col 的流式堆叠在组件深层会失效（子项重叠同位）；规避模式——**面板/列表内容一律 absolute + insetT 显式定位**（见 `app/panel.tsx` 的 layoutInfo 布局表、接收区行、TextField 行），flex 只用于浅层行容器。
  - **zIndex 只在兄弟间重排**，对孙层无效 → 下拉弹层不做内联 zIndex 抬升，一律走 `Portal`（overlay 根，zIndex 1000）+ 全屏透明遮罩（`#00000001`）+ 屏幕绝对坐标锚点（`Select` 的 `anchor` prop，由布局表算出）。参考 `app/widgets.tsx` 的 `PopupLayer`/`Select`。
  - **命中 = 绘制的 ink**：节点只在其真实绘制的像素上参与 hitTest——透明 View 不命中、Text 只在字形上命中。凡需整格可点的控件（下拉项、SegCtrl 分段、CheckRow 整行）必须给不透明或 `#00000001` 的底色，否则只能点到文字。
  - **style 对象 diff 只增不删**：条件性样式 key（如 borderWidth）必须常设、用透明色隐藏，不能时有时无。
  - **Vue Vapor 组件不得返回 null**（宿主 JSX 运行时 anchor 崩溃）；空态用 0 尺寸占位 View，条件渲染放在父级的表达式子节点里。
  - **焦点必须跟随指针**：mouse 事件分发时 `focusNode(hitFocusable(x, y))` 无条件调用（落空也要清焦点）——否则点空白处会把 CIRCLE press 发到上一次聚焦的控件上（"点空白触发了别处的选中"）。
- **无 DOM、无运行时 CSS**：只用 `View/Text/Image` 原语；动态样式用 `style={{…}}` 或整体 class 字面量三元，**禁止拼接 class 片段**（编译错误）。
- **字体**：统一使用 MiSans（Regular/Medium/Semibold/Bold，vendor 在 `assets/fonts/`）。桌面端经 `text.layout.native`（pocket.json 已声明）走 CoreText 运行时排版，任意 Unicode 可显示；**烘焙字形约束只对嵌入式目标成立**——嵌入式视图只允许使用已烘焙字符集，未知字形回退替换符并保证 HEX 视图无损（SPEC §5.4）。
- **无内置串口/WebSocket/raw socket**：所有 IO 走 `bridge/` 的 `com.*` HostOps 契约，核心层不得直接 import 任何平台 API。
- 宿主事件只能在 **tick 边界**投递进 JS（FIFO 队列 drain），不得直接回调。
- i18n：所有用户可见文案必须走 `assets/i18n/` 语言包 key，禁止硬编码。当前语言：`zh-CN`、`en`。**同一 key 不得既是字符串又是嵌套对象**（JSON 重复 key 后者覆盖前者，label 会退化成显示原始 key，如 `conn.parity` vs `conn.parityOpt.*`）。

## 目录结构（规划）

```
app/            # Vue Vapor 组件与页面状态（仅渲染 + 输入），pocket.json manifest 也在此
                #   app.tsx 主界面/onFrame 分发 + 弹层挂载；panel.tsx 左配置面板
                #   （layoutInfo 布局表：absolute 块定位 + 弹层锚点 + 滚动总高，三合一；
                #   块集合随连接类型/客户端列表动态伸缩）；transfer.tsx 接收区/发送区
                #   （字号三档/发送历史/tcps 定向发送）；widgets.tsx 基础控件（Btn/CheckRow/
                #   SegCtrl/Select+Portal 弹层/TextField（monoSize 字号档）/Scrollbar…）；
                #   session.ts 会话接线单例 + 连接参数仓库 + 设置持久化（加载/防抖回写/
                #   导入导出）；theme.ts 主题令牌（深色/浅色/跟随系统）；i18n.ts/locale.ts
                #   语言包；fontsize.ts 字号档位常量（mono 槽 12/14/16px）；fields.ts 活跃
                #   文本域路由；wheel.ts 滚轮分区路由；layout.ts 布局常量；statusbar.tsx
                #   状态栏；svc.ts 宿主事件行封装
core/           # 纯 TS：连接状态机(connection)、帧合流(framing)、消息总线(bus)、编解码(codec)、
                #   格式化(format)、日志视图(logview)、发送组装(send)、base64、统一会话
                #   （session：串口+四类网络+tcps 客户端表+自动重连）、设置持久化
                #   （config：schema/归一化/历史封顶 50）
bridge/         # com.* HostOps 契约：com.ts 命名空间探测/共享事件/枢纽 +
                #   serial.ts（串口）/net.ts（四类网络）/cfg.ts（设置持久化）
test/           # 单测，按源码分层镜像（test/core/* 对应 core/ 各模块；test/bridge/* 对应 bridge/；
                #   test/host/<系统>/* 对应 host/* 的 Rust 测试，经 #[path] 纳入宿主 crate 的
                #   cfg(test) 编译，cargo 过滤器不变；testutil.ts 为测试专用工具）
host/macos/     # macOS 宿主：串口/TCP/UDP/WS 原生 IO、设置持久化+外观事件、
                #   MCP server（fork 自 vendor hosts/desktop）。com.rs 只留命名空间
                #   挂载与共享设施（句柄计数/连接注册表/事件流），实现按协议分文件：
                #   com_serial.rs（串口）/com_tcp.rs（TCP+TCP Server）/com_udp.rs（UDP）/
                #   com_ws.rs（WebSocket）/com_env.rs（配置+外观）
host/rtthread/  # RT-Thread 宿主（预留）：UART/lwIP 适配 bridge 契约
assets/i18n/    # 语言包
assets/fonts/   # MiSans 字体文件（vendor，构建期烘焙字形）
docs/           # 调研与移植文档
vendor/pocketjs # PocketJS 上游（git submodule；引擎 crates 与桌面宿主来源）
SPEC.md         # 功能规格（权威）
```

分层依赖单向：`app → core → bridge`，`host/*`（host/macos、预留的 host/rtthread）实现 bridge 契约。core 必须保持纯 TS、可在 Bun/Node 下单测。

## 构建与测试

前置：bun（`~/.bun/bin` 需在 PATH）；首次克隆后执行 `git submodule update --init --depth 1 && cd vendor/pocketjs && bun install`。wasm32 target 仅浏览器宿主/金样测试需要，桌面开发不必装。

- 核心层单测：`bun test test/`（当前 126 例；源码在 `test/core/` 与 `test/bridge/`，与源码分层分离）
- 类型检查：`npm run typecheck`（tsc --noEmit，tsconfig 严格度对齐上游，不要私自加严 flags——构建会用同一份 tsconfig 编译上游框架源码）
- Manifest 校验：`npm run check`（= `bun vendor/pocketjs/tools/pocket.ts check --target macos-app --manifest app/pocket.json --project-root .`）
- 构建 app bundle：`npm run build`（输出 `dist/pocketcom-main.js` + `.pak`）
- 构建桌面宿主（fork 自 `vendor/pocketjs/hosts/desktop` + 自研 `com.*` 串口/网络/配置桥）：`cargo build --release --manifest-path host/macos/Cargo.toml`（输出 `host/macos/target/release/pocketcom-host`；首次全量编译 15–25 分钟；网络桥依赖 tungstenite(rustls)）
- 宿主桥接单测：`cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host`（当前 23 例，测试源在 `test/host/macos/`：serial_tests.rs 参数校验/事件格式/端口过滤、tcp_tests.rs 参数校验 + 127.0.0.1 TCP 回环（监听/接入/定向/广播/踢除/关停级联）、udp_tests.rs UDP 回环、ws_tests.rs 参数校验/握手失败/子协议头、env_tests.rs 配置原子写 0600/导出剥 token（`POCKETCOM_CONFIG` 重定向路径）+ main.rs 调度等，经 `#[path]` 编入宿主 crate；`--release` 复用既有 release 产物免 15–25 分钟全量重编）
- 宿主串口硬件回环测试（需 TX↔RX 短接的真实串口；未设 `POCKETCOM_LOOPBACK_PORT` 时自动跳过）：
  `POCKETCOM_LOOPBACK_PORT=/dev/cu.xxx POCKETCOM_LOOPBACK_BAUD=3000000 cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host com_serial::loopback -- --nocapture`
  （校验 serialList 枚举/打开/信号冒烟/回环逐字节（512B ramp、2048B 全字节域、64KiB 分块突发）/空闲 poll=None/close 语义/立即重开；波特率缺省 115200）
- 桌面运行：`node tools/dev.mjs`（默认用 fork 产物 `host/macos/target/release/pocketcom-host`，未构建时回退 vendor 的 `pocket-desktop-host` 并警告 `com.*` 不可用；flags 取自 `.pocket/macos-app/plan.json`）
- 打包分发：`tools/package-macos.sh`（前置 `npm run build` + `cargo build` 产物；组装 `dist/PocketCOM.app` 并打 `dist/PocketCOM-<版本>-macos-arm64.dmg`。launcher 设 `POCKETJS_DIST` 指向 `Resources/dist` 后 exec 宿主二进制，flags 从 `.pocket/macos-app/plan.json` 推导（同 dev.mjs）；`VERSION=x.y.z` 覆盖版本号。**仅 ad-hoc 签名**（未公证）：首次打开需右键→打开或 `xattr -cr`。不启用沙盒故无 entitlement；`NSLocalNetworkUsageDescription`（含 zh/en InfoPlist.strings）为未来 TCP/UDP/WS 连局域网设备的授权弹窗预留，监听 `127.0.0.1` 不触发该弹窗）
- CI/CD：`.github/workflows/macos.yml`（macos-latest=arm64；push main/PR/tag `v*`/手动触发。跑 typecheck + check + 核心单测 + 全量构建 + 打包；产物上传 artifact，`v*` tag 额外创建 GitHub Release 附 .dmg 与 .app.zip；宿主编译用 `Swatinem/rust-cache` 缓存）
- 脚本化 UI 验证：宿主 flags `--mouse X,Y@T`（hover）/`--click X,Y@T`（press）/`--key [cmd+]NAME@T`/`--type TEXT@T`/`--quit-after N`；注意 **press 必须用 `--click`**（`--mouse d/u` 只发 svc 行不产生 CIRCLE），且点击前必须先 `--mouse` hover 一帧聚焦；**脚本 flags 直接传给宿主二进制**（`node tools/dev.mjs` 不转发额外 flags，需 `POCKETJS_DIST=<repo>/dist` + plan 派生 flags 自行拼命令）；`--key`/cmd-chord 送小写原始键名，app 侧 `app.tsx KEY_ALIAS` 归一化。观测用 `POCKETCOM_TRACE=1`（dump 双向 svc 行 + com.serialList/serialOpen/write/tcpConnect/tcpListen/udpBind/wsConnect/cfgRead/cfgWrite）。本机真机 e2e 已验证：串口全链路（M1）与 TCP Client 回环（M2：选类型→填 host/port→打开→发送→echo 收到→关闭→lastConn/发送历史持久化 0600）。
- UI 金样测试：PocketJS headless Bun host（byte-exact PNG golden，待落地）
- MCP 集成测试：`bun test host/macos/mcp/`（待落地）
- RT-Thread 固件构建（预留）：`host/rtthread/` 按 RT-Thread package 规范组织（`SConscript` + `Kconfig`），在固件工程中经 `scons` 编译；前期可用 QEMU（如 `qemu-vexpress-a9` BSP）验证，命令落地后更新本节。

## 参考代码库（只读，禁止修改）

- `/Volumes/aigo_1t/GitRepo/COMTool` — 功能语义参考（收发/终端模式、连接参数、帧合流公式）
- `/Volumes/aigo_1t/GitRepo/umeko_serial_mcp` — MCP 设计参考（tool 划分、来源标签）；其缺陷（缓冲无上限、无 hex、无鉴权、字符串错误）**不得**复刻

## 工作守则

1. 最小改动；新功能先对齐 SPEC，SPEC 未覆盖的先补 SPEC 再写码。
2. 核心层逻辑必须配单测；改动核心层接口时同步更新 bridge 契约与 sim host。
3. 消息一律经消息总线并携带 `source` 标记（`manual`/`mcp`/…），UI 前缀文案只分"手动发送 / MCP发送"两类。
4. 安全默认：MCP 监听只绑 `127.0.0.1` + token 鉴权；不引入无鉴权监听。（TCP Server 监听 `0.0.0.0` 是用户显式打开连接的行为，对齐 COMTool，属例外；配置文件权限 0600，导出配置剥离 `mcp.token`。）
5. 提交信息：Conventional Commits，英文（如 `feat(core): add frame coalescing`）。
6. 修改了本文件提及的结构、命令、约定时，同步更新本文件。
