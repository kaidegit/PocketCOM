# AGENTS.md

本文件是 agent 在本仓库工作的约定。功能与架构的权威定义见 [SPEC.md](SPEC.md)，任何与 SPEC 冲突的实现都以 SPEC 为准（或先改 SPEC）。

## 项目简介

PocketCOM：基于 [PocketJS](https://pocketjs.dev) 运行时的串口/网络调试助手（参考 COMTool 精简复刻）。单页面、收发/终端双模式开关切换；连接支持串口/TCP/UDP/WebSocket/回环（loopback，测试用）；i18n + 深色模式；内置 MCP server 供 AI agent 共享收发。

- **桌面（macOS）**：全功能已交付并经真机 e2e 验证（M1–M4）。
- **板端（AIC D12x + RT-Thread）**：应用打包/固件构建/XIP/统一堆/WiFi 已接入，当前为精简验证页（详见下文"AIC port"）。

## 总览

| 事项 | 位置 |
|---|---|
| 功能与架构权威定义 | [SPEC.md](SPEC.md) |
| 桌面构建/运行/打包 | skill `desktop-build`（.agents/skills/desktop-build/SKILL.md） |
| 桌面测试/e2e/MCP 集成 | skill `desktop-test`（.agents/skills/desktop-test/SKILL.md） |
| 板端构建/烧录/内存报告 | skill `aic-build`（.agents/skills/aic-build/SKILL.md） |
| 板端接入全记录（XIP/TLSF/WiFi） | [host/rtthread/README.md](host/rtthread/README.md) |
| 板端内存优化方案（A–G、P0–P3） | [docs/aic-memory-optimization.md](docs/aic-memory-optimization.md) |
| e2e 脚本用法 / 控件坐标 | [docs/e2e.md](docs/e2e.md) / [docs/coords.md](docs/coords.md) |
| MCP 服务手册 | [docs/mcp.md](docs/mcp.md) |
| 只读参考代码库 | COMTool、umeko_serial_mcp（见文末） |

技术栈一句话：TypeScript（strict）+ PocketJS **Vue Vapor 适配器**（不用 Solid/Octane），无 DOM/运行时 CSS，UI 仅 `View/Text/Image` 原语。
分层依赖单向：`app → core → bridge`，`host/*` 实现 bridge 的 `com.*` HostOps 契约；core 保持纯 TS、可在 Bun/Node 下单测。

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
                #   Scrollbar）；textsel.ts 文本选区纯几何；sendlayout.ts 发送区选项行流式几何；
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
bridge/         # com.* HostOps 契约：com.ts 命名空间探测/共享事件/枢纽 + serial.ts（串口）/
                #   net.ts（四类网络）/cfg.ts（设置持久化）
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
- 板端入口 `app/main.aic.tsx → app/aic.tsx` 是 **480×272 精简验证页**（帧计数 + 触摸计数），
  真机验证通过（启动/持续出帧/触摸一致，无 OOM）。**不得未经内存验证重新引入完整
  App/session 启动图**：完整桌面 UI 常驻工作集 ≈8.1 MiB，超出板上 guest 可用约 6.0–6.4 MiB
  （WiFi 前口径），挂载失败会伪装成 `TypeError: not a function`。
- **WiFi 已点亮**（2026-10-11）：RTL8189FTV（SDIO/SDMC0，4-bit @40MHz）+ third-party lwIP
  （netif `WL0`），验证至 AP 扫描；驱动 `.bss` ≈259 KiB 进 PSRAM，运行时缓冲吃统一堆——
  恢复收发功能前必须补 WiFi 开/连 AP/断开状态下的堆基线测量。

### 恢复路线（内存约束下的推进顺序）

方案 A（板端专用装配 + 紧凑 UI）是唯一可行主路线：共用纯 TS `core/`，会话装配显式化，
日志/回滚/IO 队列设板端上限（方案 D 为收发前置）；字节码（B）与 realloc（C）作为配套优化。
推进阶段 **P0 分阶段测量 → P1 板端收发闭环 → P2 选定功能恢复 → P3 平台优化或取舍**；
每步以板端实测峰值/稳态验收，桌面大容量默认值不得直接照搬。

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
