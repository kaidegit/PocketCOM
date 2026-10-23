# AGENTS.md

本文件是 agent 在本仓库工作的约定。功能与架构的权威定义见 [SPEC.md](SPEC.md)，任何与 SPEC 冲突的实现都以 SPEC 为准（或先改 SPEC）。

## 项目简介

PocketCOM：基于 [PocketJS](https://pocketjs.dev) 运行时的串口/网络调试助手（参考 COMTool 精简复刻）。单页面、收发/终端双模式开关切换；连接支持串口/TCP/UDP/WebSocket/回环（loopback，测试用）；i18n + 深色模式；内置 MCP server 供 AI agent 共享收发。

- **桌面（macOS）**：全功能已交付并经真机 e2e 验证（M1–M4）。
- **板端（AIC D12x + RT-Thread）**：应用打包/固件构建/XIP/统一堆/WiFi 已接入，当前为按 JSON 裁剪的共享 UI 内存 perf 入口；2026-10-23 节点共享原型优化后，真机挂载/首帧/120 帧短时空闲通过，用户确认画面和触摸下拉正常，长时/IO/WiFi 组合验收待补（详见下文"AIC port"）。

## 总览

| 事项 | 位置 |
|---|---|
| 功能与架构权威定义 | [SPEC.md](SPEC.md) |
| 产品 feature / heap 对比 | `pocket.features.json` / `npm run probe:features`（离板实验，详见 skill `mem-probe`） |
| 桌面构建/运行/打包 | skill `desktop-build`（.agents/skills/desktop-build/SKILL.md） |
| 桌面测试/e2e/MCP 集成 | skill `desktop-test`（.agents/skills/desktop-test/SKILL.md） |
| 板端构建/烧录/内存报告 | skill `aic-build`（.agents/skills/aic-build/SKILL.md） |
| 板端接入全记录（XIP/TLSF/WiFi） | [host/rtthread/README.md](host/rtthread/README.md) |
| 优化前板端失败基线与原始日志 | [docs/aic-memory-perf-2026-10-23.md](docs/aic-memory-perf-2026-10-23.md) |
| 当前内存优化步骤与产物/真机结果 | [第 2 步连接配置延后创建](docs/aic-narrow-panel-step2.md)（本地通过、待上板）；[第 1 步](docs/aic-node-prototype-step1.md)真机 120 帧及基本交互通过 |
| 板端内存优化方案（A–G、P0–P3） | [docs/aic-memory-optimization.md](docs/aic-memory-optimization.md) |
| 共享 UI / TS 内存优化与编译期裁剪提案 | [docs/shared-ui-memory-optimization.md](docs/shared-ui-memory-optimization.md) |
| e2e 脚本用法 / 控件坐标 | [docs/e2e.md](docs/e2e.md) / [docs/coords.md](docs/coords.md) |
| MCP 服务手册 | [docs/mcp.md](docs/mcp.md) |
| 只读参考代码库 | COMTool、umeko_serial_mcp（见文末） |

技术栈一句话：TypeScript（strict）+ PocketJS **Vue Vapor 适配器**（不用 Solid/Octane），无 DOM/运行时 CSS，UI 仅 `View/Text/Image` 原语。
分层依赖单向：`app → core → bridge`，`host/*` 实现 bridge 的 `com.*` HostOps 契约；core 保持纯 TS、可在 Bun/Node 下单测。

桌面构建选择 fork 的 `macos-gpui` catalog 目标（plan identity / 目录仍为 `macos-app`），
声明当前 GPUI/CoreText 宿主能力；上游 `macos-app` 是软件渲染宿主契约。桌面 manifest 必需
`text.layout.native`，错误目标必须在构建时拒绝，不能静默降级。

## 技术栈与硬性约束

- **字体**：UI 统一 MiSans（Regular/Medium/Semibold/Bold，vendor 在 `assets/fonts/`）；**mono 槽（接收区/终端网格）用 JetBrains Mono**——MiSans 非等宽，终端网格必须严格等宽。桌面端经 `text.layout.native` 走 CoreText 运行时排版，任意 Unicode 可显示；**烘焙字形约束只对嵌入式目标成立**（SPEC §5.4）。
- **无内置串口/WebSocket/raw socket**：所有 IO 走 `bridge/` 的 `com.*` HostOps 契约，核心层不得直接 import 任何平台 API。
- 宿主事件只能在 **tick 边界**投递进 JS（FIFO 队列 drain），不得直接回调。
- **无 DOM、无运行时 CSS**：动态样式用 `style={{…}}` 或整体 class 字面量三元，**禁止拼接 class 片段**（编译错误）。
- i18n：所有用户可见文案必须走 `assets/i18n/` 语言包 key，禁止硬编码。当前语言 `zh-CN`、`en`。**同一 key 不得既是字符串又是嵌套对象**（JSON 重复 key 后者覆盖前者）。

### 引擎布局怪癖（实测，勿踩坑）

以下均为 PocketJS/Vue Vapor 引擎实测行为，示例实现见所指文件：

1. **深层嵌套 flex-col 流式堆叠会失效**（子项重叠同位）→ 面板/列表内容一律 absolute + inset 显式定位（`app/panel.tsx` layoutInfo 布局表）；flex 只用于浅层行容器。
2. **zIndex 只在兄弟间重排** → 下拉弹层不做内联 zIndex，一律走 `Portal` + 全屏透明遮罩 + 屏幕绝对坐标锚点（`app/widgets.tsx` PopupLayer/Select）。
3. **命中 = 绘制的 ink**：透明 View 不命中、Text 只在字形上命中 → 整格可点控件必须给不透明或 `#00000001` 底色（下拉项/SegCtrl/CheckRow）。
4. **style 对象 diff 只增不删**：条件性样式 key 必须常设、用透明色隐藏，不能时有时无。
5. **Vue Vapor 组件不得返回 null**（宿主 JSX 运行时 anchor 崩溃）→ 空态用 0 尺寸占位 View，条件渲染放父级表达式子节点。
6. **焦点必须跟随指针**：mouse 分发时 `focusNode(hitFocusable(x, y))` 无条件调用（落空也要清焦点），否则点空白会把 press 发到上一次聚焦的控件。
7. **Portal host 固定为规格屏 480×272**（不读实时视口）→ 全屏遮罩弹层须按 `viewportSize` 显式给 width/height 自撑，不能 `inset 0` 寄生（`PopupLayer` 遮罩）。
8. **条件读取 getter 会漏注册响应式依赖**：数据源为非响应式宿主对象（logView.rows、terminal.totalLines）的纯指示组件，用 **onFrame 轮询 + 本地 ref**（值不变不写 ref），见 `Scrollbar`。

## 架构与目录结构

```
app/            # Vue Vapor 组件与页面状态（仅渲染 + 输入），pocket.json manifest 也在此
                #   app.tsx 主界面/onFrame 分发 + 弹层/设置弹窗挂载（键盘/粘贴直发、鼠标选区与
                #   Cmd+C 复制路由、右键路由、overlayOpen 浮层门控）；panel.tsx 左配置面板
                #   （layoutInfo 布局表四合一：absolute 块定位 + 弹层锚点 + 滚动总高 + 文本框选区
                #   命中区）；settings-modal.tsx "应用配置"草稿模态（settings-modal-layout.ts 纯几何
                #   headless 可测）；transfer.tsx 接收区/发送区；terminal.tsx 终端视图（字符网格
                #   按 run 合并渲染/光标/拖拽选区/滚轮回滚，几何与选区 helper 导出给 app.tsx 命中）；
                #   widgets.tsx 基础控件（Btn/CheckRow/SegCtrl/Select+Portal/TextField（拖动选区）/
                #   Scrollbar）；soft-keyboard.tsx 可裁剪 ASCII 软键盘（复用活跃文本域协议）；textsel.ts 文本选区纯几何；sendlayout.ts 发送区选项行流式几何；workspace-layout.ts 宽窄屏工作区几何；
                #   session.ts 会话接线单例 + 连接参数仓库 + 设置持久化 + uiMode/终端模型装配
                #   （bus→term 持续灌入、DSR/DA 应答泵）；theme.ts 主题令牌（深色/浅色/跟随系统 +
                #   终端独立调色板）；i18n.ts/locale.ts 语言包；fontsize.ts 字号档位（mono 槽
                #   12/14/16px）；fields.ts 活跃文本域路由；wheel.ts 滚轮分区路由；layout.ts 布局
                #   常量；statusbar.tsx 状态栏；svc.ts 宿主事件行封装
core/           # 纯 TS：连接状态机(connection)、帧合流(framing)、消息总线(bus)、编解码(codec)、
                #   格式化(format)、日志视图(logview：增量排版、行数/字节上限运行时可调、ANSI 头
                #   检查点、隐藏时延迟排版)、ANSI 前景色扫描(ansicolor)、发送组装(send)、base64、
                #   统一会话（session：串口+四类网络+回环+tcps 客户端表+自动重连）、设置持久化
                #   （config：schema/归一化/历史封顶 50）、headless 终端模型（term：VT100/xterm
                #   解析 + 网格/光标/属性/滚动区域/alt 屏/环形回滚 + 按键/粘贴编码 + DSR/DA 应答
                #   队列，SPEC §3.4）、MCP 命令执行器/读行格式化/终端模式门控/config 白名单
                #   （mcp，SPEC §6）
bridge/         # com.* HostOps 契约：com.ts 命名空间探测/共享事件/枢纽 + serial.ts（串口契约/兼容适配）/
                #   net.ts（兼容全协议装配）+ transport-serial/tcp-client/tcp-server/udp/websocket.ts（可裁剪装配）/
                #   cfg.ts（设置持久化）；app/transports.ts 按产品 feature 装配并约束会话协议
test/           # 单测，按源码分层镜像（test/core/* ↔ core/；test/bridge/* ↔ bridge/；
                #   test/app/* ↔ app/ 少量 headless 约定；test/host/<系统>/* ↔ host/* 的 Rust
                #   测试经 #[path] 编入宿主 crate；testutil.ts 测试工具）
host/macos/     # macOS 宿主：串口/TCP/UDP/WS 原生 IO、设置持久化+外观事件、MCP server。
                #   com.rs 只留命名空间挂载与共享设施，实现按协议分文件：com_serial.rs /
                #   com_tcp.rs（TCP+TCP Server）/ com_udp.rs / com_ws.rs / com_env.rs /
                #   com_mcp.rs（手写 Streamable HTTP + JSON-RPC，仅绑 127.0.0.1 + Bearer token，
                #   工具命令经 mcpCmds/mcpResults 在 tick 边界进 guest，读缓冲有界 256KiB，
                #   客户端数变化经 {t:"mcp",on,clients} 事件回推 UI）
                #   fork 差异：on_key_down 转发 Ctrl 修饰单字符键（终端控制码如 Ctrl+C 依赖此）；
                #   右键鼠标事件（b:2 行）对 pocketcom companion 放行
host/rtthread/  # AIC/RT-Thread 产品接入：manifest/profile、构建编排与内存报告（详见下文"AIC port"）
assets/i18n/    # 语言包；assets/fonts/ MiSans + JetBrains Mono（构建期烘焙字形）
vendor/pocketjs # kaidegit/pocketjs fork（submodule，feat/aic；桌面引擎与 AIC 宿主）
vendor/luban-lite # 局域网 yekai/luban-lite SDK（submodule，feat/pocketjs；RT-Thread/驱动/镜像）
docs/           # 调研、移植、脚本化 UI 验证与性能文档
SPEC.md         # 功能规格（权威）
```

## AIC port（D12x + RT-Thread）

权威细节在 [host/rtthread/README.md](host/rtthread/README.md)（接入与改造全文）和
[docs/aic-memory-optimization.md](docs/aic-memory-optimization.md)（内存路线），此处只汇总工作约定。

### 现状

- 固件 **XIP 运行**：`.text/.rodata`（含内联包）链接进 SPI NOR 0x60000000 窗口原地执行，
  仅 `.data/.bss` 由 bootloader 拷入/清零 PSRAM；QSPI0 运行期归 XIP 缓存，无 FAL/SFUD/userid
  运行时 flash 访问。
- **统一 TLSF 系统堆**：PSRAM 8 MiB = CMA 1 MiB（`.data/.bss` + 双 RGB565 framebuffer）+
  SW 7 MiB（RT-Thread TLSF，QuickJS/Rust guest 与系统线程共用，无 PocketJS 私有池）；
  guest JS 配额 5 MiB。
- 板端入口 `app/main.aic.tsx → app/app.tsx` 自 2026-10-23 起用于 **480×272 共享 UI 真机内存 perf**，功能只读取 JSON 的 `aic-diagnostic` profile；本次切换由用户明确要求，2026-10-23 优化前真机 S4 底层 OOM，见 [历史复测记录](docs/aic-memory-perf-2026-10-23.md)；节点共享原型优化后已进入首帧并完成 120 帧零错误、零分配失败，用户确认画面与触摸下拉正常，阶段数据见 [第 1 步记录](docs/aic-node-prototype-step1.md)。保留 `app/aic.tsx` 精简页作历史诊断基线。此前未裁剪完整 UI 常驻工作集 ≈8.1 MiB，挂载 OOM 可能伪装成 `TypeError: not a function`；不得把构建通过当成板端内存验收。
- **WiFi 已点亮**（2026-10-11）：RTL8189FTV（SDIO/SDMC0，4-bit @40MHz）+ third-party lwIP
  （netif `WL0`），验证至 AP 扫描；驱动 `.bss` ≈259 KiB 进 PSRAM，运行时缓冲吃统一堆——
  恢复收发功能前必须补 WiFi 开/连 AP/断开状态下的堆基线测量。
- **内存优化按步交付**：第 2 步已实现共享窄屏连接配置抽屉：默认不创建，首次打开后复用，以限制快速开关峰值；本地验证/固件已完成、待用户上板（`docs/aic-narrow-panel-step2.md`）。启动空闲收益不代表首次打开后的常驻收益，高级收发工具栏窄屏折叠仍待做。2026-10-23 第 1 步节点共享原型已完成离板 A/B、桌面回归、固件构建及用户真机 120 帧/基本交互验证，记录见 `docs/aic-node-prototype-step1.md`；本轮系统历史峰值 5,810,936 bytes、caps 峰值 5,345,447 bytes，无分配失败。用户负责烧录并回传日志，每步记录后再推进下一项；本次通过仅限启动/短时空闲与已反馈交互，长时/业务流量/WiFi 矩阵仍待验收。

### 恢复路线（内存约束下的推进顺序）

已接入统一 `pocket.features.json` 与 terminal / mcp.server / transport.* / ui.* 的编译期裁剪；平台启停值只查该 JSON。
`terminal-on` / `terminal-off`、`mcp-on` / `mcp-off`、`transport-all` / `transport-serial` 和 `ui-on` / `ui-off` 仅供共享 App
离板对比（传输对比用 `npm run probe:features -- --feature transport`，见 `docs/transport-feature-heap.md`），
UI 对比用 `npm run probe:features -- --feature ui`，见 `docs/ui-feature-heap.md`；
不替代正式板端入口。产品功能
用 `@pocketcom/features` 的字面量 `hasAppFeature()`；产品功能目录和 profile 只以该 JSON 为准，禁止在代码、环境变量或文档中另设启停表。
新增项可先标记 `status: "planned"`，此时不可写入 profile、调用或声明模块/文案所有权；
接齐装配、UI、模块/文案归属和测试后改为 `implemented`，再补齐各 profile 的布尔值。详见 SPEC §4.5 与 `docs/terminal-feature-heap.md`。

后续按[共享 UI 与编译期裁剪提案](docs/shared-ui-memory-optimization.md)推进：AIC / macOS 共用
`app/`、`core/` 和控件，优化 TS 节点表示与显式装配，通过构建功能标记、共享窄屏布局和容量配置
控制板端工作集，不另起一套产品 UI。现有 `app/aic.tsx` 保留作诊断基线；提案实施前先更新 SPEC
相应平台差异，当前共享入口仅供用户要求的真机内存复测，产品验收仍须真机内存验证。原内存方案的数据、全链路限额（D）及字节码（B）/
realloc（C）研究仍有效，每步以板端实测峰值/稳态验收，桌面大容量默认值不得直接照搬。

### 构建与烧录

命令、产物、内存报告解读、烧录要点全部在 skill `aic-build`；`npm run probe:aic` 为离板内存探针（字段与板端 `[PJS-DIAG]` 一致，粗测不替代板端验收）；板端测试 `bun test test/host/rtthread/`。

## 构建与测试索引

命令细节按场景进 skill，不要在本文件复制：

| 场景 | 入口 |
|---|---|
| 桌面构建/运行/打包/安装 | skill `desktop-build` |
| 单测/typecheck/e2e/MCP 集成/性能复测 | skill `desktop-test` |
| 板端校验/打包/构建/烧录/内存报告 | skill `aic-build` |
| 离板内存探针（无板粗测包占用/峰值/裁剪对比） | skill `mem-probe` |

## 参考代码库（只读，禁止修改）

- `/Volumes/aigo_1t/GitRepo/COMTool` — 功能语义参考（收发/终端模式、连接参数、帧合流公式）
- `/Volumes/aigo_1t/GitRepo/umeko_serial_mcp` — MCP 设计参考（tool 划分、来源标签）；其缺陷（缓冲无上限、无 hex、无鉴权、字符串错误）**不得**复刻

## 工作守则

1. 最小改动；新功能先对齐 SPEC，SPEC 未覆盖的先补 SPEC 再写码。
2. 核心层逻辑必须配单测；改动核心层接口时同步更新 bridge 契约与 sim host。
3. 消息一律经消息总线并携带 `source` 标记（`manual`/`mcp`/…），UI 前缀文案只分"手动发送 / MCP发送"两类，且仅 MCP server 运行中显示；未运行时接收区只显示接收数据与系统事件（TX 行整行隐藏，RX 行无 `<=` 标记）；sys 事件标记为 i18n `[系统]`/`[SYS]`。
4. 安全默认：MCP 监听只绑 `127.0.0.1` + token 鉴权；不引入无鉴权监听。（TCP Server 监听 `0.0.0.0` 是用户显式打开连接的行为，对齐 COMTool，属例外；配置文件权限 0600，导出配置剥离 `mcp.token`。）
5. 提交信息：Conventional Commits，英文（如 `feat(core): add frame coalescing`）。
6. 修改了本文件提及的结构、命令、约定时，同步更新本文件与各 skill（`.agents/skills/*/SKILL.md`）。
