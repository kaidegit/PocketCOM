# PocketCOM 规格说明书

版本：v0.1（草案）  
日期：2026-09-04  
状态：待评审

## 1. 概述

PocketCOM 是一个基于 [PocketJS](https://pocketjs.dev) 运行时的串口/网络调试助手，功能定位参考 [COMTool](/Volumes/aigo_1t/GitRepo/COMTool) 的精简复刻：只保留**收发模式**与**终端模式**两个核心功能，并内置 **MCP 服务**，允许 AI agent 接入共享收发数据。

- 首期目标平台：macOS（桌面宿主）
- 远期目标平台：RT-Thread（嵌入式宿主，本版本只做架构预留，不实现）

### 1.1 设计原则

1. **单页面**：不做多 Tab / 分页。一个页面 = 一条连接 + 一个模式（收发/终端由开关切换）。
2. **核心与宿主解耦**：连接状态机、消息总线、编解码、ANSI 解析全部为纯 TypeScript，不依赖任何平台 API；串口/网络/MCP 等能力通过宿主桥接层注入。
3. **一切消息有来源**：每条收发记录携带来源标记（手动/MCP/定时器等），UI 与 MCP 共用同一条消息总线。
4. **安全默认**：MCP 仅监听 loopback + token 鉴权；不复刻 umeko_serial_mcp 的裸绑 `0.0.0.0` 无鉴权方案。

### 1.2 非目标（首版不做）

- 多标签页 / 多连接并行
- 波形图、协议解析插件脚本、SSH 连接（COMTool 有，均砍掉）
- WebSocket server 模式（仅 client）
- 自动更新、多窗口
- RT-Thread 实际移植（仅架构预留）

## 2. 技术栈与平台约束

### 2.1 技术选型

| 项 | 选择 | 说明 |
|---|---|---|
| 运行时 | PocketJS 0.11.x（vendor 在 `vendor/pocketjs/`，git checkout） | QuickJS guest + Rust `no_std` 核心；npm 包 `@pocketjs/framework` 不含桌面宿主，必须保留 checkout |
| 工具链 | **bun**（构建/测试/serve 全部依赖 Bun API，node 不可替代）+ `@pocketjs/cli` + Rust stable | wasm32 target 仅浏览器宿主与金样测试需要，桌面开发可不装 |
| UI 框架 | **Vue Vapor 适配器**（约束，不用 Solid/Octane） | `vue` + `vue-jsx-vapor` + `@pocketjs/framework/vue-vapor` 组件 |
| 字体 | **MiSans**（Regular/Medium/Semibold/Bold 四个字重） | 源文件 vendor 进 `assets/fonts/`（来自 `/Users/kai/Downloads/MiSans`，本机路径不入库），构建期烘焙字形 |
| 语言 | TypeScript（strict） | 全部源码 |
| 桌面宿主 | **gpui 桌面宿主**（fork 自 `vendor/pocketjs/hosts/desktop`，gpui 0.2.2）+ 自研 `com.*` 扩展 | 串口/网络/MCP 不在 PocketJS 内核能力内，按 surface 模式自研（§4.2） |
| MCP server | 宿主进程内原生线程（Rust）+ tick 边界事件投递 | 不经 QuickJS guest；模式抄 `pocket-net` 的 poll/drain（§6.2） |

### 2.2 PocketJS 平台约束（本规格的重要前提）

调研自 PocketJS 源码（`vendor/pocketjs`，0.11.x）与官方文档，以下约束直接决定架构设计：

1. **无 DOM、无运行时 CSS**。UI 仅 `View` / `Text` / `Image` 原语 + flexbox；样式为编译期的 Tailwind 子集，动态样式必须用 `style={{…}}` 对象或"整体 class 字面量的三元表达式"，运行期拼接 class 片段是编译错误。
2. **字体烘焙（baked font atlas）为默认路径**。构建时扫描源码中出现的字符与字号生成字形图集，设备端没有字体光栅化器。**但 gpui 桌面宿主支持 per-app 声明 `enhances: ["text.layout.native"]`**：改走 CoreText 运行时排版（`TEXT_RUN`），字形覆盖 = OS 字体回退链（CJK/emoji 全有），任意 Unicode 可显示。嵌入式目标仍受烘焙约束。对策见 §5.4。
3. **NET 模块 v1 仅有 fetch 形态的 HTTP client**，明确不含 WebSocket、server、raw socket，串口更不在其内；桌面宿主默认甚至没有 mount `net`/`fs`。→ **本项目必须自研宿主桥接**（§4.2），官方扩展姿势：spec 契约（`contracts/spec/*.ts`）+ transport-neutral Rust core + 宿主 `guest.mount("com", …)`。
4. **帧（tick）投递模型**：原生线程不得直接回调 JS guest；异步完成事件在 tick 边界成批投递（FIFO）。串口 RX 数据也遵循该模型：宿主侧累积，tick 边界 drain。
5. **桌面宿主 = gpui 窗口 + QuickJS guest**（`pocket-mod`/rquickjs），与掌机跑同一 JS 环境；宿主为单进程单线程 supervisor 模型。键盘输入支持字符（IME 路径）、F1–F12 等命名键、修饰键与粘贴事件，按 tick 批进 guest——终端模式按键直发可行。

### 2.3 参考项目

| 项目 | 路径 | 借鉴内容 |
|---|---|---|
| COMTool | `/Volumes/aigo_1t/GitRepo/COMTool` | 收发/终端模式功能集、连接参数、帧合流策略、状态机 |
| umeko_serial_mcp | `/Volumes/aigo_1t/GitRepo/umeko_serial_mcp` | MCP tool 划分、来源标签设计、用户干预回灌 agent 读缓冲；同时规避其缺陷（缓冲无上限、无 hex、无鉴权、错误非结构化） |

两个参考项目均为**只读参考**，不得修改。

## 3. 功能规格

### 3.1 页面布局（单页面，左右布局）

```
┌────────────────┬───────────────────────────────────────────────┐
│ 左侧：配置面板  │ 右侧：收发区                                   │
│                │                                               │
│  连接类型 ▼     │  收发模式 → 接收区（只读，弹性高度）            │
│  连接参数区     │             ─────────────────                 │
│  （随类型切换， │             发送区 + 发送控制                   │
│   可滚动）      │                                               │
│                │  终端模式 → 终端视图（占满整个右区）            │
│  [打开/关闭] ⏻ │                                               │
│  状态灯 ●      │                                               │
│  ────────────  │                                               │
│  模式开关       │                                               │
│  [收发 | 终端]  │                                               │
│  ────────────  │                                               │
│  MCP 共享开关 ○│                                               │
│  (开启后显示    │                                               │
│   URL + token) │                                               │
│  ────────────  │                                               │
│  通用设置：     │                                               │
│  语言 ▼ 主题 ▼ │                                               │
│  字号          │                                               │
├────────────────┴───────────────────────────────────────────────┤
│ 状态栏：连接状态 │ Rx/Tx 字节计数 │ MCP: off / N 客户端          │
└────────────────────────────────────────────────────────────────┘
```

- **左配置、右收发**：左侧为固定宽度配置面板（约 260–320px，可折叠以让出主区空间）；右侧为主工作区，随模式开关整体切换。
- 模式开关在**收发模式 / 终端模式**间切换，**切换不断开连接**，已有接收数据保留（终端模式有独立屏幕缓冲）。
- 连接状态四态：`DISCONNECTED / CONNECTING / CONNECTED / LOST`（对齐 COMTool 的 `ConnectionStatus`），状态灯：灰/黄/绿/橙，同时显示在左面板与状态栏。
- 通用设置（语言/主题/字号）集中在左面板底部；状态栏只读展示当前值。

### 3.2 连接管理

连接类型下拉：`串口 / TCP Client / TCP Server / UDP / WebSocket Client`。

**串口参数**（对齐 COMTool `conn_serial`）：

- 端口枚举（显示 `设备名 - 描述 - 厂商 - VID/PID`；**macOS 仅枚举 `/dev/cu.*` 设备**——`/dev/tty.*` 与蓝牙串口不出现在列表中）
- 波特率：预设 9600–4500000 + 可编辑自定义
- 数据位 5/6/7/8；校验 None/Odd/Even/Mark/Space；停止位 1/1.5/2
- 流控 None / XON-XOFF / RTS-CTS / DSR-DTR
- DTR / RTS 电平复选框（连接前后均可切换）

**TCP Client**：目标 `host:port`（下拉历史）、本地地址显示、自动重连开关 + 间隔秒数。  
**TCP Server**：监听端口、客户端列表（可指定单客户端发送或广播、可踢除）。  
**UDP**：本地 bind 端口 + 目标 `host:port`（COMTool 的 UDP 模型）。  
**WebSocket Client**：URL（`ws://` / `wss://`）、子协议（可选）、自动重连。

**通用行为**：

- 切换连接类型时自动断开旧连接。
- 断线检测：TCP/WS 断开进入 `LOST` 并按配置自动重连；串口拔出进入 `LOST`，端口重新出现时自动重开（可关）。
- **帧合流（RX 分帧策略，对齐 COMTool）**：串口按"静默超过 2× 单字节传输时间"合帧（`单字节时间 = 1 / (baud / (bytesize + 2 + stopbits))`）；网络连接按固定 1ms 间隔合帧。合帧在纯 TS 核心层完成，宿主只上报原始字节流。

### 3.3 收发模式

**接收区**（等宽字体，只读）：

- ASCII / HEX 显示切换（HEX 大写、空格分隔）
- 时间戳开关：`[YYYY-MM-DD HH:MM:SS.mmm]`（开启则强制自动换行）
- 自动换行开关：按帧合流边界换行，间隔 ms 可配（默认 200ms）
- 转义显示开关：不可见字节显示为 `\x01` 形式
- ANSI 颜色开关：解析 `\x1b[31m` 等 SGR 序列着色（跨包缓冲不完整序列）
- 方向标记：记录发送时 `=>` 发送 / `<=` 接收（开启则强制自动换行）
- 暂停显示（数据继续入缓冲）、清屏、滚动锁定（用户上翻时不强制贴底）
- Rx / Tx 字节计数（状态栏，清屏归零）
- 日志保存：指定文件路径追加；可选"每次连接按时间戳建新文件"

**发送区**：

- ASCII / HEX 输入切换（切换时内容自动互转）
- 转义符支持：`\n \r \t \xNN \NNN`（八进制）
- `<CRLF>` 选项（`\n` → `\r\n`）、自动追加换行选项
- 发送按钮 + `Ctrl/Cmd+Enter` 快捷键
- 定时循环发送（默认 300ms，可配）
- 发送历史下拉（去重置顶、持久化、可清空）
- 发送文件（选择文件整块发出；macOS 限定）

**编码**：仅支持 **UTF-8**（不做多编码切换），解码失败的字节按替换符 `U+FFFD` 处理；HEX 视图始终无损。

### 3.4 终端模式

- 主区切换为终端视图：固定行列字符网格、等宽渲染、可回滚。
- **回滚行数可调**：设置项 `terminal.scrollbackLines`，默认 9999 行，范围 0–100000（0 = 不回滚），修改即时生效（超出新上限的旧行按新上限裁剪）。
- **ANSI/VT100 解析在纯 TS 核心层实现**（headless 终端模型：屏幕网格 + 光标 + 属性 + 回滚），不依赖 xterm.js（其依赖 DOM）。
- 按键直发、无本地回显；Backspace 发 `0x7F`；方向键/功能键/Home/End 等映射为对应转义序列（term 行为对齐 `linux`/`xterm`）。
- 粘贴即发；选中复制。
- 窗口尺寸变化时按当前字体度量重算行列数（预留将来向对端上报 `SIGWINCH` 语义的钩子）。

### 3.5 消息模型与来源前缀（核心数据契约）

全应用统一消息总线，每帧消息：

```ts
interface Message {
  id: number;                 // 单调递增
  ts: number;                 // ms 时间戳
  dir: "rx" | "tx" | "sys";   // 收 / 发 / 系统事件
  source: "manual" | "mcp" | "timer" | "history" | "system";
  payload: Uint8Array;        // 原始字节
  connId: string;             // 当前连接实例 id
}
```

- UI 接收区对 TX 消息显示来源前缀：**`[手动发送]` / `[MCP发送]`**（i18n 文案，见 §3.6）；`timer`/`history` 归入"手动发送"类但可区分显示样式（前缀文案仍按用户语义只分两类：手动/MCP，规格冻结为两类）。
- RX 消息显示 `[<=]` 方向标记；系统消息（连接/断开/错误）显示 `[--]`。
- 消息进入两处消费：UI 视图 + MCP 读缓冲（§6），单一事实源。
- 缓冲：消息总线为**有界环形缓冲**（默认 1000 帧 / 256 KiB，可配），溢出丢最旧帧并记 `sys` 溢出事件。规避 umeko_serial_mcp 缓冲无上限的缺陷。

### 3.6 i18n

- 资源文件：`assets/i18n/zh-CN.json`、`en.json`（首版）；预留 `zh-TW`、`ja`。
- 扁平 key + 点分嵌套：`receive.timestamp`、`mcp.toggle` 等；缺 key 回退 en，再回退 key 本身。
- **运行时切换、无需重启**（Vue Vapor 响应式即可做到，优于 COMTool 的重启方案）。
- 与字体烘焙联动：构建脚本汇总各语言包全部文案字符 + 界面固定字符，并入字形图集（见 §5.4）。

### 3.7 深色模式

- 三态：`浅色 / 深色 / 跟随系统`（macOS 经宿主读取系统外观）。
- 主题 token 表：`bg / fg / border / accent / rx-color / tx-color / source 前缀着色（manual、mcp、sys）/ 终端调色板`。
- 实现约束：因 PocketJS 无运行时 CSS，主题切换通过**响应式 style 对象绑定**实现；设计令牌定义为 TS 常量，组件绑定 `style={{ background: theme().bg }}`，禁止拼接 class。
- 终端视图调色板独立（默认深色 `#212121` 底 + 8 色 ANSI，对齐 COMTool 终端）。

### 3.8 设置与持久化

- 配置路径：macOS 存 Application Support：`~/Library/Application Support/PocketCOM/config.json`（RT-Thread 预留下载路径抽象）。
- 内容：语言、主题、字体大小、终端回滚行数（`terminal.scrollbackLines`）、最近连接参数（按类型）、发送历史、接收区开关项、日志路径、MCP 端口与 token。
- 支持配置导出 / 导入（JSON 文件）。
- 发送历史、连接历史上限各 50 条。

## 4. 架构

### 4.1 分层

```
┌─────────────────────────────────────────────┐
│ UI 层 (Vue Vapor 组件, app/)                 │  仅渲染 + 用户输入
├─────────────────────────────────────────────┤
│ 核心层 (纯 TS, core/)                        │  平台无关、可单测
│  连接状态机 │ 帧合流 │ 消息总线(环形缓冲)      │
│  编解码(hex/escape/utf8) │ ANSI/VT100 模型    │
├─────────────────────────────────────────────┤
│ 桥接契约层 (bridge/)                         │  com.* HostOps 接口定义
├─────────────────────────────────────────────┤
│ 宿主层 (host/macos/)                         │  串口/TCP/UDP/WS 原生 IO
│  MCP server (host/macos/mcp/)                │  Streamable HTTP + 鉴权
└─────────────────────────────────────────────┘
```

### 4.2 宿主桥接（`com.*` HostOps）

PocketJS 内核不含串口/raw socket/WebSocket（§2.2），按官方"product-specific runtime 自持 adapter"的模式自研。契约要点：

- **Ops**（JS → 宿主，请求/响应）：`serial.list / serial.open / serial.close / serial.write / serial.setSignals(DTR/RTS) / net.tcpConnect / net.tcpListen / net.udpBind / net.wsConnect / conn.write / conn.close`（统一连接句柄）。
- **Events**（宿主 → JS，tick 边界成批投递）：`conn.data(handle, bytes) / conn.closed(handle, reason) / conn.error(handle, code, msg) / serial.added / serial.removed`。
- 统一 `handle` 抽象：四类连接对核心层暴露同一 `IConnection` 接口（`write(bytes)`、`close()`、事件回调），对齐 COMTool 的 `COMM` 基类设计。
- 宿主线程绝不直接回调 JS，所有事件经队列在 tick 边界 drain（遵循 PocketJS 帧契约）。

### 4.3 桌面输入模型（svc companion 方言）

桌面宿主有两种输入模式：**console**（方向键/Z/Enter 映射 PSP 按键位掩码，无鼠标）与 **svc companion 方言**（`--editor`：键盘/IME/鼠标/滚动以 JSON 行逐 tick 投递）。PocketCOM 是桌面工具，必须采用后者：

- `app/pocket.json` 声明 `companions: ["pocketcom"]`；宿主以 `--companions pocketcom --editor` 启动（`tools/dev.mjs` 依据 plan 自动带参）。
- app 侧实现 `app/svc.ts`（参考 `vendor/pocketjs/apps/note/svc.ts`）：`svcOpen("pocketcom")` → 每 tick `svcPoll()` 取事件行 → 分发：鼠标点击经 `hitFocusable`/`focusNode`（`@pocketjs/framework/input`）转成 focusable 组件的 press；文本输入经 IME 行进输入框；滚轮进滚动区。
- 终端模式的按键直发也走此通道（命名键 `key` 行 + 字符 `ch` 行）。
- 该方言是 app 级协议而非宿主能力，可在嵌入式宿主上以触摸/按键复用同一 dispatcher。

### 4.4 RT-Thread 预留

- 核心层与桥接契约不引入任何桌面专有 API；RT-Thread 移植 = 新宿主（QuickJS + PocketJS 嵌入式核心 + UART/lwIP 适配桥接契约）。
- 目录预留：`host/rtthread/`，按 RT-Thread package 规范组织（`SConscript` + `Kconfig`），作为离线软件包引入固件工程，经 `scons` 编译；前期可用 QEMU（如 `qemu-vexpress-a9`）验证。详见 AGENTS.md 目录结构与构建节。
- 配置存储、日志、字体密度走平台抽象接口。

## 5. 关键专项设计

### 5.1 错误处理

- 核心层错误分类：`ParamError / StateError / IoError / ProtocolError`，带结构化 `code`。
- UI：toast + 状态栏错误指示；MCP：返回 `isError: true` + 结构化内容（不以纯文本字符串充当错误，规避 umeko 缺陷）。
- 连接类错误不 crash：IO 线程异常 → `conn.error` 事件 → 状态机转 `LOST`。

### 5.2 性能预算

- 接收路径：115200 波特满速（约 11.5 KB/s）无掉帧；UI 刷新按帧合流后批量更新，目标 60fps 下 JS 每帧 < 4ms（参考 PocketJS PSP 预算）。
- 终端模式：网格渲染只重绘脏行。

### 5.3 安全

- MCP 仅绑 `127.0.0.1`；token 鉴权（首启随机生成 32 字节，配置中可重置）；无 token 或错误 token → HTTP 401。
- 不持久化任何凭据类信息；配置文件权限 0600。
- 明确不做：`0.0.0.0` 监听（如未来需要，单独配置项 + 显式警告）。

### 5.4 文本渲染与字形策略

字体统一使用 **MiSans**（字重 Regular/Medium/Semibold/Bold；源文件 vendor 在 `assets/fonts/`）。注意 MiSans 非严格等宽字体，接收区与终端网格按最大字宽做单元格布局以保证列对齐。

**macOS 桌面端（首期目标平台）**：pocket.json 声明 `enhances: ["text.layout.native"]`，走 gpui 宿主的 CoreText 运行时排版——**任意 Unicode（含 CJK/emoji）可显示，无 tofu**，烘焙字形约束在桌面端不成立。MiSans 注册进宿主字体链作为首选 UI 字体。代价：放弃跨宿主字节级金样确定性（金样测试改在 gpui 宿主上比对，见 §7）。

**嵌入式/未来 RT-Thread 端**：仍受构建期烘焙约束，策略为：

1. 构建时强制烘焙：**可打印 ASCII 全集（0x20–0x7E）** + 常用符号 + 各 i18n 语言包全部文案字符 + 界面固定文案（MiSans 覆盖 GB 范围，UI 中文案无缺字风险）。
2. 接收数据显示时：未烘焙字形 → 替换符 ``；用户可切 HEX 显示获得无损视图。
3. CJK 大字符集不预烘焙（体积不可控），在 FAQ/文档中明示该限制。
4. 终端模式同样受此约束。

## 6. MCP 服务规格

### 6.1 开启方式与传输

- 左侧配置面板的 **MCP 共享开关**（默认关，见 §3.1）。开启后：
  - 宿主进程内启动 MCP server，transport = **Streamable HTTP**，监听 `127.0.0.1:<port>`（默认 `7960`，可配）。
  - 开关下方显示连接 URL + token（可复制）；状态栏显示 `MCP: on (N clients)`。
  - 关闭开关 → 拒绝新连接、通知并断开现有会话。
- Agent 侧配置示例（README 提供）：指向 `http://127.0.0.1:7960/mcp`，header 携带 `Authorization: Bearer <token>`。

### 6.2 架构位置

MCP server 实现于**宿主层**（fork 的桌面宿主 crate 内的原生线程，Rust），通过桥接与核心层消息总线交互。理由：MCP SDK 与 HTTP server 不适合跑在 QuickJS guest 内（guest realm 刻意无网络/文件/进程能力）；宿主实现可直接复用成熟 SDK，且与串口 IO 同层、延迟最低。

**事件流（遵循 PocketJS 帧契约，抄 `pocket-net` 的 poll/drain 模式）**：MCP 原生线程收到 agent 的 send/connect 等请求 → 入队 → tick 边界 drain 成事件批 → 经 `com.*` op 进 guest 核心层执行；核心层的消息总线变更（RX 帧、手动发送）反向入队 → MCP 线程消费响应 agent 的 `read`。核心层向宿主暴露：`sendBytes(bytes, source)`、`drainMessages(filter)`、`getStatus()`、`requestConnect(params)` 等。

### 6.3 Tools

| Tool | 参数 | 语义 |
|---|---|---|
| `status` | — | 连接状态、类型、参数、Rx/Tx 计数、MCP 客户端数 |
| `list_serial_ports` | — | 枚举串口（`设备 - 描述` 每行一条） |
| `connect` | `type, params…`（与 §3.2 参数一致） | 建立连接。已有连接时**默认拒绝**，`force: true` 才断开旧连接（规避 umeko 静默抢占） |
| `disconnect` | — | 断开当前连接 |
| `send` | `data: string, encoding: "utf8"\|"hex"\|"base64"`, `appendNewline?: boolean` | 发送字节。**不隐式追加 `\r\n`**（规避 umeko 缺陷），换行由参数显式控制。消息入总线，`source: "mcp"` |
| `read` | `maxBytes?: number, clear?: boolean = true` | 拉取读缓冲（read-and-drain）。返回带 `[ts] [来源] 内容` 的多行文本；空返回"无数据" |
| `config_read` / `config_write` | 限定 key 白名单 | 读写非敏感配置（不含 token） |

无 resources / prompts（与 umeko 一致，后续按需扩）。

### 6.4 读缓冲与来源可见性

- 读缓冲 = 消息总线的 MCP 侧视图：RX 帧 + **用户手动发送的 TX 帧**（标记 `手动发送`，让 agent 感知人工干预，借鉴 umeko `USER_OVERRIDE`）+ 系统事件。agent 自己 `send` 的数据不回灌其读缓冲。
- 有界（同 §3.5 环形缓冲）；`read` 默认取空，可选 `clear: false` 窥视。
- 多条 agent 会话共享同一读缓冲（首版简化：先到先得地 drain；多会话隔离列 v1.1）。

### 6.5 并发与互斥

- 多 MCP client 可并发连接；`send` 经 FIFO 队列串行化写入。
- `connect / disconnect` 为控制操作：需有效 token，且与 UI 手动操作等价（UI 实时反映状态变化）。
- MCP 操作与 UI 操作无优先级差：单一状态机，后到先生效（`connect` 除外，见上表）。

## 7. 测试策略

- **核心层纯 TS 单测**（Vitest/Bun test）：帧合流、hex/escape/UTF-8 解码（含截断序列与非法字节）、ANSI/VT100 模型（对齐经典用例）、环形缓冲、消息总线、状态机迁移。
- **UI 测试**：PocketJS headless Bun host + 帧金样（PNG golden），覆盖双模式、双主题、双语言。
- **脚本化 UI 截图**（宿主能力，配合 e2e/文档产出）：宿主 flag `--screenshot PATH@T` 在第 T tick（60Hz 虚拟时钟，与 `--mouse/--click/--key/--type` 的 `@T` 同基准，可重复传入）把主窗口当前内容导出为 PNG。实现走系统 `screencapture -l` 捕获本进程窗口——自窗口内容免 Screen Recording（TCC）授权，agent/CI 运行零弹窗；不采用 `CGWindowListCreateImage`（deprecated）与 CPU 光栅（跳过 TEXT_RUN，native-text 下丢全部文字）。截图为窗口实际渲染内容（含 28pt 标题栏、2x 物理像素），含 CoreText 排版与合成器结果，**非确定性，不做 byte-exact 金样**（金样仍走 headless 路线）；同 UI 状态下输出字节一致，可作 e2e 相等断言。该 flag 为 opt-in：CI 不传即不触发，宿主单测仅覆盖参数解析与 PNG 头校验纯函数。
- **桥接契约测试**：sim host（确定性 fixture）驱动核心层全链路。
- **MCP 集成测试**：脚本化 MCP client 走完整会话（connect → send → read → 前缀断言 → disconnect）。
- 真机回归：macOS 实机串口回环（USB 转串口 TX-RX 短接）。

## 8. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 技术验证 | 桌面宿主嵌入点确认；`com.serial.*` 桥接回环 demo；动态文本/字形验证；终端网格渲染性能验证 | demo 可跑，风险项有结论 |
| M1 | 收发模式 + 串口 + 帧合流 + 消息总线（macOS） | §3.2 串口、§3.3 全项 |
| M2 | TCP/UDP/WS + i18n + 深色模式 + 设置持久化 | §3.2 其余连接、§3.6/3.7/3.8 |
| M3 | 终端模式 | §3.4 |
| M4 | MCP 服务 | §6 全项 + 集成测试 |
| M5 | RT-Thread 预研（不实现） | 移植评估报告 |

## 9. 风险与开放问题

M0 桌面宿主调研已完成（2026-09-04），#1/#3 已关闭：

| # | 风险/问题 | 状态 | 结论/应对 |
|---|---|---|---|
| 1 | 桌面宿主 JS 引擎形态与扩展点 | ✅ 已关闭 | gpui 窗口 + QuickJS guest（`pocket-mod`）；扩展 = `contracts/spec/*.ts` + Rust core + `guest.mount("com", …)`；app 可放外部仓库（vendor + `--project-root`），宿主二进制支持 `--js/--pak` |
| 2 | 无内置 serial/socket/WS，全部桥接自研 | 开放 | 工作量最大项。契约先行；Rust 侧用成熟 crate（串口 `serialport`、异步 IO `tokio`、WS `tokio-tungstenite`），事件批按 `pocket-net` 的 poll/drain 模式 |
| 3 | 烘焙字体不支持任意字符 | ✅ 已关闭（桌面端） | gpui 后端 `enhances: ["text.layout.native"]` 走 CoreText，任意 Unicode 可显示；烘焙约束仅剩嵌入式目标（§5.4） |
| 4 | 终端网格渲染性能 | 开放 | M0 压测；native text 路径下按行渲染 `TEXT_RUN`，备选 `Image` 位图自绘网格 |
| 5 | MCP 多读缓冲的会话语义 | 开放 | 首版共享缓冲，v1.1 按 session 隔离 |
| 6 | RT-Thread 上 Rust `no_std` 核心构建与 lwIP/UART 适配 | 开放 | M5 预研，架构已预留 |
| 7 | 金样测试需要 wasm32 target + headless Bun host；native text 路径放弃跨宿主字节确定性 | 开放 | UI 金样在 gpui 宿主或 wasm host 二选一，M3 前定 |

## 10. 附录

- PocketJS 文档：https://pocketjs.dev/docs/ 、NET 模块说明：https://pocketjs.dev/docs/net/
- PocketJS 源码（vendor，`vendor/pocketjs/`，0.11.x）关键路径：`engine/backends/gpui/`（桌面渲染后端）、`hosts/desktop/`（桌面宿主，fork 起点）、`contracts/spec/net.ts`（surface 契约样板）、`engine/crates/pocket-net/`（transport trait + tick drain 样板）、`docs/RUNTIMES.md`（Runtime = ⟨Cores, Surfaces, Guest⟩ 扩展模型）、`docs/BACKENDS.md`（native text 说明）。
- COMTool 调研要点：连接/插件/装配三层解耦、帧合流公式、终端基于 pyte 的 headless 模型（本项目以纯 TS 重写等价物）。
- umeko_serial_mcp 调研要点：6 个 tool 的划分、来源标签（LLM/HARDWARE/USER_OVERRIDE/SYSTEM）、UI 发送回灌 agent 读缓冲；缺陷清单见 §1.1/§3.5/§6。
