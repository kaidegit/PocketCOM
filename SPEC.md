# PocketCOM 规格说明书

版本：v0.2（草案）  
日期：2026-10-23
状态：随实现持续更新（M1–M4 已交付并真机验证，M5 板端构建/渲染已交付，详见 §8）

## 1. 概述

PocketCOM 是一个基于 [PocketJS](https://pocketjs.dev) 运行时的串口/网络调试助手，功能定位参考 [COMTool](/Volumes/aigo_1t/GitRepo/COMTool) 的精简复刻：只保留**收发模式**与**终端模式**两个核心功能，并内置 **MCP 服务**，允许 AI agent 接入共享收发数据。

- 首期目标平台：macOS（桌面宿主）
- 嵌入式目标平台：AIC D12x + RT-Thread（本期接入构建与渲染；2026-10-24 起宿主实现 `com.*` 串口桥，仅 uart1（PA.2/PA.3），无网络/cfg/MCP 桥；ASCII 软键盘已接入，真机验收待补）

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
- RT-Thread 网络/MCP 桥、完整窄屏收发工具栏仍待实现；板端软键盘已接入，真机交互与内存验收待补。第 2 步内存优化接入共享窄屏连接配置浮层；板端 WiFi（RTL8189FTV + lwIP）已于 2026-10-11 点亮至 AP 扫描，但设备 IO 桥仍不做

**待实现清单**（SPEC 已声明、代码尚未实现，保留描述供后续版本）：

- 接收区日志保存（指定路径追加 / 按连接时间戳建新文件；`logPath` 配置字段已预留）
- TCP Client 目标 host:port 下拉历史
- 宽屏左配置面板手动折叠（窄屏连接配置按下述共享布局规则按需挂载）
- 串口拔出自动重开（依赖 `serial.added/removed` 事件，见 §4.2）
- 串口列表显示厂商 / VID/PID（宿主已上报，UI 未渲染）
- 连接历史上限 50 条（当前仅有每类型一份 `lastConn`，发送历史上限 50 已实现）

## 2. 技术栈与平台约束

### 2.1 技术选型

| 项 | 选择 | 说明 |
|---|---|---|
| 运行时 | PocketJS 0.15.0（vendor 在 `vendor/pocketjs/`，git checkout） | QuickJS guest + Rust `no_std` 核心；npm 包 `@pocketjs/framework` 不含桌面宿主，必须保留 checkout |
| 工具链 | **bun**（构建/测试/serve 全部依赖 Bun API，node 不可替代）+ `@pocketjs/cli` + Rust stable | wasm32 target 仅浏览器宿主与金样测试需要，桌面开发可不装 |
| UI 框架 | **Vue Vapor 适配器**（约束，不用 Solid/Octane） | `vue` + `vue-jsx-vapor` + `@pocketjs/framework/vue-vapor` 组件 |
| 字体 | **MiSans**（Regular/Medium/Semibold/Bold 四个字重） | 源文件 vendor 进 `assets/fonts/`（来自 `/Users/kai/Downloads/MiSans`，本机路径不入库），构建期烘焙字形 |
| 语言 | TypeScript（strict） | 全部源码 |
| 桌面宿主 | **gpui 桌面宿主**（fork 自 `vendor/pocketjs/hosts/desktop`，gpui 0.2.2）+ 自研 `com.*` 扩展 | 串口/网络/MCP 不在 PocketJS 内核能力内，按 surface 模式自研（§4.2） |
| MCP server | 宿主进程内原生线程（Rust）+ tick 边界事件投递 | 不经 QuickJS guest；模式抄 `pocket-net` 的 poll/drain（§6.2） |

### 2.2 PocketJS 平台约束（本规格的重要前提）

桌面构建使用 fork 的 `macos-gpui` catalog 目标，plan/宿主 identity 仍为 `macos-app`（ABI 4）。
该 profile 声明 GPUI 的原生文字、键鼠、IME 和剪贴板能力；上游同名 `macos-app` catalog 目标
描述软件渲染宿主。桌面 manifest 将 `text.layout.native` 作为必需能力，错误目标在构建时拒绝。

调研自 PocketJS 源码（`vendor/pocketjs`，当前合入 0.15.0）与官方文档，以下约束直接决定架构设计：

1. **无 DOM、无运行时 CSS**。UI 仅 `View` / `Text` / `Image` 原语 + flexbox；样式为编译期的 Tailwind 子集，动态样式必须用 `style={{…}}` 对象或"整体 class 字面量的三元表达式"，运行期拼接 class 片段是编译错误。
2. **字体烘焙（baked font atlas）为默认路径**。构建时扫描源码中出现的字符与字号生成字形图集，设备端没有字体光栅化器。**但 gpui 桌面宿主支持 per-app 声明 `requires: ["text.layout.native"]`**：改走 CoreText 运行时排版（`TEXT_RUN`），字形覆盖 = OS 字体回退链（CJK/emoji 全有），任意 Unicode 可显示。嵌入式目标仍受烘焙约束。对策见 §5.4。
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
│  [打开/关闭]   │                                               │
│  [应用配置]    │                                               │
│  ────────────  │                                               │
│  模式开关       │                                               │
│  [收发 | 终端]  │                                               │
│  ────────────  │                                               │
│  MCP 共享开关 ○│                                               │
│  (开启后显示    │                                               │
│   URL + token) │                                               │
├────────────────┴───────────────────────────────────────────────┤
│ 状态栏：连接状态 │ Rx/Tx 字节计数 │ MCP: off / N 客户端 │ ▼     │
└────────────────────────────────────────────────────────────────┘
```

- **宽屏左配置、右收发**：视口宽度 ≥720px 时，左侧为固定宽度配置面板（272px），右侧为主工作区，随模式开关整体切换；宽屏手动折叠仍见 §1.2 待实现清单。
- **共享窄屏连接配置**：视口宽度 <720px 时，顶部保留 32px 高操作栏，通过“连接配置”打开同页侧面浮层；默认不挂载配置面板，工作区使用全宽。浮层复用同一个 `LeftPanel`，宽 272px、左上角锚定、按视口高度撑开；全屏遮罩使用 Portal 和显式视口尺寸。返回按钮、点遮罩或 Escape 关闭浮层。首次打开才创建配置控件；之后移出视口并复用同一实例，以约束快速反复开关的创建峰值；Escape 仍先收软键盘、下拉和应用配置弹窗。内容区支持手指纵向拖动，内容跟随手指移动并限制在滚动边界内；滑动不触发起点控件的点击，头部、页脚及覆盖其上的弹层不参与面板拖动。
- 浮层开关不卸载工作区，不重建会话、终端或日志模型，不改变连接、计数、发送编辑内容和定时发送；关闭时提交未按 Enter 的参数文本并清除输入焦点，重开恢复参数；切回宽屏时卸载窄屏实例并释放字段句柄、滚轮订阅。进入应用配置时收起连接配置浮层。窄/宽屏切换关闭浮层及陈旧下拉，几何、选区、终端网格、收发宽度和滚轮分区使用同一布局结果。视口分支与 JSON 产品功能开关独立。
- 第 2 步仅交付上述连接配置浮层与共享工作区几何；高级收发工具栏的完整窄屏折叠、设备 IO 与软键盘按后续独立步骤验证（2026-10-25 已启用 ASCII 软键盘，真机待验收）。本步收益主要在首次打开配置前，打开后的常驻量另记；内存测量同时覆盖默认收起、展开、快速反复开关及触摸记录环回卷，不能用默认空闲下降代替操作峰值验收。
- 模式开关在**收发模式 / 终端模式**间切换，**切换不断开连接**，已有接收数据保留（终端模式有独立屏幕缓冲）。
- 连接状态四态：`DISCONNECTED / CONNECTING / CONNECTED / LOST`（对齐 COMTool 的 `ConnectionStatus`），状态灯：灰/黄/绿/橙，只在主页底部状态栏显示（左面板页脚不重复；页脚仅"打开/关闭 + 应用配置"两个按钮）。
- 通用设置（语言/主题/字号/终端回滚行数、导入/导出）收入**"应用配置"模态弹窗**：入口为左面板页脚"应用配置"按钮（"打开/关闭"下方、同样式）；弹窗为 msgbox 形态——四周半透明遮罩（点击丢弃）、中间居中圆角框；**草稿模式**：框内修改先暂存，点"应用"一次性生效并关闭，"取消"/点遮罩/Escape 丢弃；状态栏只读展示当前值。
- 应用配置首次打开后隐藏复用，同一 App 内不反复创建/销毁整棵设置控件树。每次打开重新快照当前配置，取消的输入草稿不能复活；隐藏时清焦点/键盘/下拉，文本选区命中区失效，卸载 App 时释放句柄。
- 共享基础控件可由编译器按真实导入绑定将普通 View/Text JSX 降为原生节点，同一 Vue Vapor 作用域共用属性更新 effect，减少每个装饰节点的组件实例和属性代理；同名局部变量、展开属性、组件 ref 和动态/命名 slot bag 保留普通组件路径。保持节点几何、MiSans 字体、完整区域命中、禁用/借焦、语言/主题更新和卸载清理语义；不能以裁掉控件或扩大堆替代组合面板内存验收。

### 3.2 连接管理

连接类型下拉：`串口 / TCP Client / TCP Server / UDP / WebSocket Client / 回环（Loopback）`。

**串口参数**（对齐 COMTool `conn_serial`）：

- 端口枚举（显示 `设备名 - 描述`；厂商/VID/PID 宿主已上报但 UI 未渲染——未实现，见 §1.2 待实现清单。**macOS 仅枚举 `/dev/cu.*` 设备**——`/dev/tty.*` 与蓝牙串口不出现在列表中）。启动与下拉展开时自动刷新（无手动刷新按钮）；保存的上次端口不在枚举结果中时启动显示为未选择（`lastConn` 配置保留，设备插回后下次启动仍恢复）
- 波特率：预设 9600–6000000 + 可编辑自定义
- 数据位 5/6/7/8；校验 None/Odd/Even（**Mark/Space 不支持**：serialport 4 无该能力，UI 选项禁用、宿主打开与 MCP connect 均拒绝；config 类型保留五值备用）；停止位 1/2（**1.5 不支持**，同因）
- 流控 None / XON-XOFF / RTS-CTS / DSR-DTR
- DTR / RTS 电平复选框（连接前后均可切换）

**TCP Client**：目标 `host:port`（下拉历史——未实现，见 §1.2 待实现清单）、本地地址显示、自动重连开关 + 间隔秒数。  
**TCP Server**：监听端口、客户端列表（可指定单客户端发送或广播、可踢除）。  
**UDP**：本地 bind 端口 + 目标 `host:port`（COMTool 的 UDP 模型）。  
**WebSocket Client**：URL（`ws://` / `wss://`）、子协议（可选；输入框已存在但**尚未接线**——app 打开连接时不传 `protocols`、不持久化，修复前不生效）、自动重连。  
**回环（Loopback）**：无参数的纯核心层测试连接（不触宿主 IO），打开即 CONNECTED；发送的字节在下一帧原样回灌为一帧 RX（走与真实连接相同的合流/总线/字节计数路径），供无硬件/无网络的 e2e 与功能验证；MCP `connect` 同样支持 `type: "loopback"`。

**通用行为**：

- 切换连接类型时自动断开旧连接。
- 断线检测：TCP/WS 断开进入 `LOST` 并按配置自动重连；串口拔出进入 `LOST`（端口重新出现时自动重开——未实现，见 §1.2 待实现清单）。
- **帧合流（RX 分帧策略，对齐 COMTool）**：串口按"静默超过 2× 单字节传输时间"合帧（`单字节时间 = 1 / (baud / (bytesize + 2 + stopbits))`）；网络连接按固定 1ms 间隔合帧。合帧在纯 TS 核心层完成，宿主只上报原始字节流。会话泵的静默超时与重连期限使用框架帧时钟（`virtualNow() × 1000`），日志消息时间戳仍使用日历时间；避免无 RTC、RTC 精度不足或校时造成收帧延迟。常用串口波特率下，已收到的孤立短包在下一次超过静默阈值的帧泵产出，无需等待日历时钟变化或追加换行；实际显示延迟仍受帧执行/绘制耗时约束。

### 3.3 收发模式

**接收区**（等宽字体，只读）：

- ASCII / HEX 显示切换（HEX 大写、空格分隔；仅作用于 RX/TX 数据帧——系统消息（`[系统]` 标记，i18n）为 UI 生成的完整 UTF-8 文本，不受 HEX/转义开关影响，始终按文本显示）
- 时间戳开关：`[YYYY-MM-DD HH:MM:SS.mmm]`
- 自动换行：始终开启，按接收区可视宽度软折行（超宽逻辑行折为多条显示行，续行无方向前缀；接收区无横向滚动，折行是长行内容完整可见的唯一手段）
- 转义显示开关：不可见字节显示为 `\x01` 形式
- 帧内换行符拆分：ASCII 非转义显示下，数据帧内嵌的 `\r\n` / `\n` / `\r` 按硬换行拆成独立显示行（拆分出的后续行与折行续行一致：无方向前缀）；帧末换行不产生多余空行。HEX / 转义显示下换行字节以 `\x0A` 等形式可见，不受影响。行内禁止出现控制字符直接渲染（多行文本会在固定行高内溢出，与后续行重叠）
- 接收区显示行数可调：设置项 `receive.historyLines`，默认 10000 行，范围 1–100000，修改即时生效（超出新上限的旧行按新上限裁剪）。用于格式切换重放的原始历史与显示行同上限（帧数 ≤ 行数设置），字节预算 = max(256 KiB, 行数 × 256 B)（含隐藏 TX），超限逐出最旧整帧并同步释放对应显示行。单帧超出预算不保留，不截断为伪完整帧；历史裁剪不计接收丢帧。ANSI 历史头保留解析状态，重排不会丢失已消费的颜色状态。新增数据增量排版，内容变化独立于行数净增量通知 UI。终端模式仍消费有界日志历史，但推迟日志排版至重新可见；暂停仍不消费，恢复时检测消息断档。
- ANSI 颜色开关：勾选后数据行默认色切换为主题正文色（深色白/浅色黑），内容解析 `\x1b[31m` 等 SGR 序列按前景色着色（30–37 / 90–97 / 38;5 与 38:5 的 256 色 / 38;2 与 38:2 的 24-bit RGB，`0`/`39`/`ESC[m` 复位；仅前景，背景与加粗等属性忽略；调色板与终端视图共用 §3.7 token）；行尾被截断的不完整序列跨包缓冲，与后续帧续接；状态跨行/跨帧持续，sys 行不参与解析；HEX / 转义显示下无原始 ESC 可解析（序列以 `\x1B` 字节可见），仅默认色生效
- 方向标记：记录发送时 `=>` 发送 / `<=` 接收；显示与否按 §3.5 的 MCP 运行态门控（无独立开关）
- 暂停显示（数据继续入缓冲）、清屏、滚动锁定（用户上翻时不强制贴底）
- 接收日志内容区支持手指纵向拖动，内容跟随手指并限制在滚动边界内；上翻后新数据不强制贴底，拖回底部恢复跟随。横向拖动、工具栏、发送区及覆盖弹层不参与日志拖动；弹层打开时取消进行中的日志手势。桌面鼠标拖动仍用于文本选区。
- Rx / Tx 字节计数（状态栏，清屏归零）
- 日志文本鼠标拖动选中，`Cmd/Ctrl+C` 复制（按行拼接；新数据入流时已选行号随内容滚动）
- 日志保存：指定文件路径追加；可选"每次连接按时间戳建新文件"（**未实现**，`logPath` 配置字段已预留，见 §1.2 待实现清单）

**发送区**：

- ASCII / HEX 输入切换（切换时内容自动互转）
- 转义符支持：`\n \r \t \xNN \NNN`（八进制）
- `<CRLF>` 选项（`\n` → `\r\n`）、自动追加换行选项
- 发送按钮 + `Ctrl/Cmd+Enter` 快捷键
- 定时循环发送（默认 300ms，可配）
- 发送历史下拉（去重置顶、持久化、可清空）
- 发送文件（选择文件整块发出；macOS 限定）
- 输入框鼠标点击定位光标、拖动选中，选中后输入替换、`Cmd/Ctrl+C` 复制（左面板各输入框同）
- 发送区可折叠：状态栏最右端按钮（`▼`/`▲`，仅收发模式显示）切换；收起时接收区占满剩余高度、发送区控件首次展开创建、之后移出视口隐藏复用（不可见即不可命中，避免重复挂载的内存峰值），收起时清理输入焦点及软键盘/下拉弹层，输入草稿与光标保留，定时发送暂停（重新展开恢复）；折叠状态随配置持久化（`send.collapsed`，默认展开），不进 MCP 配置白名单

**编码**：仅支持 **UTF-8**（不做多编码切换），解码失败的字节按替换符 `U+FFFD` 处理；HEX 视图始终无损。

### 3.4 终端模式

- 主区切换为终端视图：固定行列字符网格、等宽渲染、可回滚。
- **回滚行数可调**：设置项 `terminal.scrollbackLines`，默认 10000 行，范围 0–100000（0 = 不回滚），修改即时生效（超出新上限的旧行按新上限裁剪）。
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

- UI 接收区的收发显示**按 MCP server 运行态分档**。运行中：RX 行显 `<=` 方向标记，TX 行显 **`[手动发送]` / `[MCP发送]`** 来源前缀（i18n 文案，见 §3.6）；`timer`/`history` 归入"手动发送"类（前缀文案按用户语义只分两类：手动/MCP，规格冻结为两类；当前实现仅 `manual`/`mcp`/`system` 三个 source 被实际发出，`timer`/`history` 为预留枚举）。未运行（开关关闭 / 启动失败 / 终端模式门控停服）时全部收发均为本地手动行为，接收区**只显示接收数据与系统事件**：TX 行整行不显示，RX 行不显示 `<=` 标记；已显示的收发历史行随开关切换隐藏/恢复。
- 系统消息（连接/断开/错误）恒显示 `[系统]` 标记（i18n：zh `系统` / en `SYS`；旧 `[--]` 紧跟时间戳易被误读为损坏的时间占位，已废弃）。
- 消息进入两处消费：UI 视图 + MCP 读缓冲（§6），单一事实源。
- 缓冲：消息总线为**有界环形缓冲**（默认 1000 帧 / 256 KiB，可配），溢出丢最旧帧属正常历史裁剪，**不注入事件**。真实丢帧由消费端按消息 id 连续性检测（断档 = 有帧在消费前被裁）：UI 接收区记一条 i18n `sys` 提示（`[系统] 缓冲溢出，已丢弃 N 帧`）；MCP 读行前置一条 `[SYS] buffer overflow, dropped N frame(s)`（稳定英文，§6.3）。规避 umeko_serial_mcp 缓冲无上限的缺陷。

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
- 内容：语言、主题、字体大小、接收区历史行数（`receive.historyLines`）、终端回滚行数（`terminal.scrollbackLines`）、最近连接参数（按类型）、发送历史、接收区开关项、发送区开关项（转义/CRLF/追加换行/折叠 `send.collapsed`）、日志路径、MCP 端口与 token。
- 支持配置导出 / 导入（JSON 文件）。
- **"应用配置"弹窗语义**（§3.1）：弹窗内修改为草稿、不落盘，点"应用"才写入各状态并触发既有防抖回写；导入/导出是即时动作（不经草稿），导入成功后立即生效并把弹窗草稿重同步为导入值（未应用的其它草稿修改被丢弃）；回滚行数缩小导致的终端历史裁剪不可逆（§3.4）。
- 发送历史上限 50 条（已实现）；连接历史上限 50 条**未实现**（当前仅有每类型一份 `lastConn` 当前参数，见 §1.2 待实现清单）。

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

- **Ops**（JS → 宿主，请求/响应；实际清单以 `bridge/com.ts` 为准）：`serialList / serialOpen / write(handle) / setSignals / close / poll / tcpConnect / tcpListen / udpBind / wsConnect / cfgRead / cfgWrite / cfgExport / cfgImport / mcpStart / mcpStop / mcpFeed / mcpCmds / mcpResults`（cfg.* 为设置持久化桥，mcp.* 为 MCP server 桥，M2/M4 后补；四类连接共用统一 `write(handle)`）。
- **Events**（宿主 → JS，tick 边界成批投递）：`conn.data(handle, bytes) / conn.closed(handle, reason) / conn.error(handle, code, msg) / conn.opened / conn.accepted（TCP Server 新客户端）/ appearance（系统外观）/ mcp（server 运行态与客户端数）`。`serial.added / serial.removed`（热插拔通知）**未实现**，串口拔出自动重开依赖该能力（见 §1.2 待实现清单）。
- 统一 `handle` 抽象：四类连接对核心层暴露同一 `IConnection` 接口（`write(bytes)`、`close()`、事件回调），对齐 COMTool 的 `COMM` 基类设计。
- 宿主线程绝不直接回调 JS，所有事件经队列在 tick 边界 drain（遵循 PocketJS 帧契约）。

### 4.3 桌面输入模型（svc companion 方言）

桌面宿主有两种输入模式：**console**（方向键/Z/Enter 映射 PSP 按键位掩码，无鼠标）与 **svc companion 方言**（`--editor`：键盘/IME/鼠标/滚动以 JSON 行逐 tick 投递）。PocketCOM 是桌面工具，必须采用后者：

- `app/pocket.json` 声明 `companions: ["pocketcom"]`；宿主以 `--companions pocketcom --editor` 启动（`tools/dev.mjs` 依据 plan 自动带参）。
- app 侧实现 `app/svc.ts`（参考 `vendor/pocketjs/apps/note/svc.ts`）：`svcOpen("pocketcom")` → 每 tick `svcPoll()` 取事件行 → 分发：鼠标点击经 `hitFocusable`/`focusNode`（`@pocketjs/framework/input`）转成 focusable 组件的 press；文本输入经 IME 行进输入框；滚轮进滚动区。
- 终端模式的按键直发也走此通道（命名键 `key` 行 + 字符 `ch` 行）。
- 该方言是 app 级协议而非宿主能力，可在嵌入式宿主上以触摸/按键复用同一 dispatcher。

### 4.4 AIC + RT-Thread 接入

- PocketCOM 负责产品源码、板端 manifest/host profile、启动入口和构建编排；PocketJS fork 的 `hosts/aic` 负责 QuickJS、触摸、RGB565 渲染和帧循环；luban-lite SDK 负责 RT-Thread、MPP、硬件驱动、链接与镜像打包。
- `vendor/pocketjs` 跟踪 `kaidegit/pocketjs` 的 `feat/aic`，`vendor/luban-lite` 跟踪局域网 Gitea `yekai/luban-lite` 的 `feat/pocketjs`。显式 `git submodule update --remote` 更新分支；构建不拉取更新。父仓库 gitlink 仍按 Git 机制记录提交。
- `host/rtthread/` 放产品配置与接入文档；复用 SDK 的 `application/rt-thread/pocketjs` 和 `d12x_demo68-nor_rt-thread_pocketjs_defconfig`，不复制通用宿主。板级显示时序在 SDK 的产品 defconfig 中维护，修正时保留为 SDK submodule 改动，不在应用层绕过。
- 板端 Vue Vapor 应用使用 480×272、native presentation、density 1、60Hz，mount 前初始化视口。2026-10-23 起为新一轮真机内存 perf，`app/main.aic.tsx` 挂载共享 `app/app.tsx`（包含 session/连接面板/收发区/设置弹窗），按 `pocket.features.json` 的 `aic-diagnostic` profile 编译裁剪，不另设功能开关。保留 `app/aic.tsx` 精简页作历史诊断基线。此前未裁剪完整 UI 与 JSON 裁剪后的优化前版本曾挂载 OOM（见 docs/aic-memory-perf-2026-10-23.md）；节点共享原型优化后，本轮真机挂载/首帧/120 帧短时空闲通过，分配失败为 0，用户确认画面和触摸下拉正常（见 docs/aic-node-prototype-step1.md）。长时、业务负载与 WiFi 组合场景仍待验收；此结果不代表设备 IO 桥已实现；宿主无 `com.*` 时按共享 App 现有能力探测降级。保持现有内存配额和容量，以便比较；紧凑布局与板端设备桥仍按共享 UI 路线推进。
- **板端 WiFi（2026-10-11 点亮，验证至 AP 扫描）**：RTL8189FTV（SDIO 接 SDMC0，4-bit @40MHz）+ third-party lwIP（netif `WL0`，`AIC_WLAN_REALTEK`/`AIC_USING_RTL8189_WLAN0` 配置链，非 RT-Thread wlan 框架/内核 lwIP）。驱动 `.bss` ≈259 KiB 静态落在 PSRAM，运行时收发缓冲吃统一堆；恢复网络功能前必须补 WiFi 开/关、连 AP/断开状态下的堆基线与峰值测量。模组 EN 与 SoC 断开（载板保证使能），固件不做电源控制；PM 睡眠驱动未编入。
- `check:aic` 校验配置/类型；`package:aic` 生成 JS/PAK/.pocket、宿主契约头和内联 C 数组；`build:aic` 重新打包后经 SCons 构建固件。默认 SDK 为 submodule，支持 `--sdk <路径>` 和 `-- <scons 参数>`，工具链遵循 `RTT_EXEC_PATH`。产物在 `dist/aic`，中间文件在 `.pocket/aic`，宿主生成文件在其已忽略的 `hosts/aic/generated`。
- 板端固件 XIP 运行：`.text/.rodata`（含内联包）链接进 SPI NOR 的 0x60000000 XIP 窗口原地执行，仅 `.data/.bss` 由 bootloader 拷入/清零 PSRAM；分区表去掉未使用的 `data` 分区，QSPI0 运行期归 XIP 缓存，OS 侧不挂 spinor 设备（无 FAL/SFUD/userid 运行时 flash 访问）。
- 节点表示优化采用 PocketJS 共享的 DOM 兼容接口原型：访问器与方法使用接收者，children、属性缓存和可变 facade 容器按节点独立；保留克隆、原生根、retain/release、sweep、焦点与事件生命周期。2026-10-23 已完成本地 A/B、桌面回归及用户真机启动/120 帧零错误验证，用户确认画面和触摸下拉正常；本步不改变功能、容量或设备桥语义，记录见 `docs/aic-node-prototype-step1.md`。
- PSRAM 8 MiB 统一堆：底部约 1 MiB 为 CMA 区（`.data/.bss` + 双 RGB565 framebuffer），其余约 7 MiB 为 RT-Thread 系统堆，算法为 TLSF（SDK `RT_USING_USERHEAP` + `bsp/artinchip/drv/mem/rt_tlsf_heap.c`），QuickJS/Rust guest 与系统线程共用，不再划分 PocketJS 私有池；guest JS 配额 5 MiB 为软上限。构建报告实际 ELF/map 的包大小、XIP/PSRAM 段拆分、CMA/SW 边界、framebuffer 与统一堆预算（guest 配额 + 系统预留）及 OS 分区占用，并校验 ITS XIP 段地址与 `XIP_FW_OFFSET = os 分区偏移 + 0x800` 一致；超限失败，不自动调整分区或提高配额，不自动烧录。
- AIC 在挂载完成后、首帧前回收一次循环垃圾；之后只在完整帧结束的安全边界回收：guest+Rust 占用自上次回收增长 128 KiB 时触发，系统堆余量 ≤1 MiB 时增长门槛降至 32 KiB。保留 2 秒空闲回收，低余量下即使持续重绘也最多等 2 秒。每次回收后重测基线，避免不可回收的常驻对象导致逐帧 GC；统计 GC 次数和最大耗时。不得在分配器/宿主回调中重入 JS 回收，不改变堆/JS 配额或产品功能值。
- 字体 UI 使用 MiSans，mono 使用 JetBrains Mono；显式烘焙中英文语言包字符，未知字形遵守 §5.4。AIC 包独立压缩标识符与空白（不折叠表达式、不改宿主属性名、不再套一层 IIFE），降低 QuickJS 编译峰值；桌面构建不变。未来桥接仍由产品宿主实现，设备事件仅在 tick 边界进入 JS，core 保持纯 TS。
- AIC GE 在同步 normal 模式下加速不透明填充、1:1 PSM5650 搬运和 A8 遮罩混合。A8 先在 CPU 将覆盖率与全局 alpha 合成为 ARGB8888，GE 混合到私有 RGB565 暂存面，成功后才写回；失败时原目标保持不变，由渲染器软件重放。暂存区按 SDK 示例从 MEM_CMA 首次使用分配并复用，源和目标行 stride 均按 8 字节对齐（共用 4 像素对齐 pitch），上限按补齐后的 8192 像素计算、49152 字节加最多 63 字节首地址对齐；超限、分配失败或不支持的几何保留 CPU 路径。不改变产品堆或 JS 配额；硬件混合舍入、真机峰值和性能收益需实测。
- demo68-nor 的 480×272 RGB 屏使用与 SDK 同板参考方案一致的 **90° pixel clock 输出相位**（`AIC_DEGREE_90` / `AIC_RGB_CLK_CTL=1`）。2026-10-24 修正相位后，用户真机确认字体发虚/静态字边跳动已恢复正常。静止字边彩点/跳动须区分 framebuffer 像素变化与 LCD 采样不稳；软件像素一致或固件构建通过均不等于真机显示验收。

### 4.5 产品 feature 与离板裁剪实验

- 根目录 `pocket.features.json` 是产品功能、依赖、模块所有权、文案归属和 profile 的唯一来源；`status: "implemented"` 表示已接入裁剪（缺省兼容该状态），`status: "planned"` 仅登记待接入项，和功能本身是否已经实现无关。当前 `terminal`、`mcp.server`、五个 `transport.*` 与九个 `ui.*` 接入裁剪，其余产品功能目录以该 JSON 为准。
- profile 必须且只能为所有 implemented 项提供布尔值；planned 项不能写入 profile、拥有裁剪模块/文案或用于 `hasAppFeature()`，避免产生无效开关。implemented 项也不能依赖 planned 项；依赖名称与循环对整个目录校验。文档不得另行维护平台启停表，代码不得增加独立产品开关常量或环境变量。用户运行时设置和真实宿主能力探测保持各自语义，不充当编译裁剪配置。
- `desktop` 启用已接入功能，`aic-diagnostic` 的配置以 JSON 为准，用于共享 UI 真机内存 perf；`terminal-on` / `terminal-off` 是离板实验组合，使用同一共享 App、480×272、相同宿主能力、容量与字体，仅终端功能取值不同。实验不切换正式板端入口，不代表板端 UART/网络桥已实现。
- 产品功能通过 `@pocketcom/features` 的字面量 `hasAppFeature()` 调用引用；构建必须显式选择 profile，未知功能、缺项、依赖冲突与动态功能名报错。宿主 capability 与内存容量不与产品开关混用。
- PJS 在 Vue 转换、样式/字形收集和依赖遍历之前对 TS/TSX 作 AST 特化；禁用终端同时关闭模型创建、RX 订阅、应答泵、版本同步、输入/鼠标/滚轮路由、模式切换与回滚设置。桌面开启时保持持续消费 RX 和查询应答语义。
- 禁用功能声明拥有的模块只有在无存活引用且特化后无顶层执行副作用时才能剔除；被剔除模块的非功能依赖保留为副作用导入，不对全仓库设置 `sideEffects: false`。颜色定义提取为共享叶子模块，保留原 `core/term.ts` 导出兼容性。
- 文案字典和额外烘焙字符使用同一 feature 过滤结果。构建单独输出含配置指纹、参与/剔除模块、资源与 JS/PAK 字节数的 feature receipt，不改变已有宿主 plan/capability 契约；转换缓存包含特化配置身份，依赖记录包含配置文件。
- `mcp.server` 关闭时剔除核心命令执行器、服务响应式状态/watcher、启停/配置/每帧中继、面板及状态栏与专属文案；忽略宿主 MCP 事件，配置中的 MCP 字段保留但不激活服务。共享 `com.*` 契约和配置 schema 保持兼容；macOS 原生 server 随宿主保留，产品 profile 控制 guest 装配。`mcp-on` / `mcp-off` 固定关闭终端，仅改变 MCP 取值以测量其独立收益。
- `transport.*` 在 guest 装配时裁剪协议专属面板、参数 ref、配置恢复/快照、桥接适配器与专属文案；关闭的协议不出现在选择器中，直接调用（含 MCP）须在触及宿主及改变连接状态前拒绝。配置 schema 和已有配置保留，loopback 作为测试连接保持可用；共享会话的帧合流/事件路由/重连状态机保持纯 TS，macOS 原生协议实现随宿主保留。`transport-all` / `transport-serial` 固定关闭 terminal/MCP，用同一共享 App 比较传输裁剪；不切换正式 AIC 入口。
- `ui.*` 在 Vue 转换前裁剪选区、剪贴板（复制/粘贴）、右键菜单、快捷组合键、语言/主题/字号切换及软键盘。关闭选区保留文本输入与光标；关闭快捷键保留普通编辑键及终端协议按键。右键菜单依赖选区，系统主题依赖主题切换。关闭语言/主题/字号切换固定为 zh-CN/深色/14px，忽略导入及 MCP 对这些设置的修改，但保留原配置字段。关闭系统主题时不订阅外观响应状态，system 配置按深色处理。软键盘为 ASCII 输入浮层，所有文本域首次点击仅聚焦，再次点击同一活跃域展开软键盘（两次独立点击，无时间限制）；已展开时再点保持展开，收起后再点当前域重新展开。程序调用 focus() 不展开，拖动/取消不展开；切换文本域、失焦或卸载时收起并清除旧目标。仍可由状态栏展开，支持大小写、数字、符号、空格、退格、回车和收起；按键复用文本域协议，不清除输入焦点。键盘首次展开才创建，之后移出视口隐藏并复用；大小写仅更新固定键位的标签和输入值，不重建按键。固定键位以共享渲染器批量创建 Text 原语，布局/主题与标签分别批量响应更新，避免为每个键分配独立列表/组件响应式作用域。键盘 Portal host 的层级高于抽屉和设置弹窗，收起后不截获底层触摸。展开时进入临时编辑面板：480×272 下顶部 24px 显示字段名称，中部 56px 显示当前文本与光标，下方 164px 键盘，保留 28px 状态栏；面板直接复用原文本域状态，长行横向跟随光标、多行显示光标附近两行，可点击可见文本调整光标。收起返回原界面并保留内容/光标；回车沿用原域语义，发送仍通过原发送按钮执行。键帽文字水平、垂直居中。`ui-on` / `ui-off` 仅改变 ui 功能，用共享 App 离板比较；不切换正式板端入口。
- 离板 `probe:aic` 从一次性分配的固定连续内存区运行 SDK 同源 TLSF，默认 7,340,032 bytes，`--heap N` 只调整该区大小，不允许退回系统 malloc 或自动扩池。保留板端 3 槽包装头与 realloc 先分配后释放语义；采样及失败时报告总量、已用/峰值、空闲总量、最大连续空闲块和碎片数。包文件缓冲模拟 XIP 留在池外；系统线程/WiFi 和 RV32 指针宽度仍不模拟。功能 A/B 实验显式固定 16 MiB 池以量完整峰值，并在报告中保存池大小与分配器身份。
- 探针 `--aic-gc` 使用与固件同源的帧边界回收策略，`--aic-gc-idle` 保留旧版仅 2 秒空闲回收作对照；均按契约帧率推进虚拟时钟，以 raster revision 未变化近似空闲，不模拟实际渲染耗时/系统分配。默认无额外回收及手动 `--collect` 实验仍独立记录，不得混作固件策略结果。
- `probe:features` 默认顺序生成 terminal 两个独立实验包，`--feature mcp.server` 选择 MCP 对比组，`--feature transport` 选择传输对比组，`--feature ui` 选择 UI 对比组，使用同一原生探针各运行独立进程，记录 S2/S3/S4/S5 live/peak、QuickJS 与失败计数，保存日志/包 hash/版本/配置及对比报告。无板实验不替代 WiFi 开启后的 TLSF 真机验收。

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

字体：UI 统一使用 **MiSans**（字重 Regular/Medium/Semibold/Bold；源文件 vendor 在 `assets/fonts/`）。**mono 槽（`font-mono`）使用 JetBrains Mono**（Regular，OFL，随 `assets/fonts/JetBrainsMono-Regular.ttf` vendor；嵌入式烘焙的 mono 槽本来就用它）——MiSans 非等宽字体，终端网格必须严格等宽才能保证列对齐与格宽度量一致。

**mono 槽只承载"数据内容"，不承载 UI 文案**（2026-10-24 定，修复烘焙字形下 mono 槽 CJK 豆腐）：

- **必须 mono**（等宽/列对齐/度量一致性所需）：接收区日志行的时间戳段与 RX/TX 数据内容、TX 来源前缀 `[手动发送]`/`[MCP发送]`（仅 MCP server 运行中显示；嵌入式目标不装配 mcp.server，无板端豆腐风险）、终端网格、文本框内已输入的内容与预编辑、状态栏 Rx/Tx 计数与连接摘要、客户端地址、MCP URL/token 等机器生成值。
- **必须 MiSans 槽**：空态/占位/提示文案（接收区空态、终端就绪提示、文本框 placeholder）、下拉控件的 display 与选项标签（含纯数字/地址类选项）、按钮与标签等一切 `t()`/固定 UI 文案，**含接收区 sys 行的来源前缀 `[系统]`/`[SYS]` 与消息内容**（2026-10-25 定，修复板端系统消息豆腐：sys 文案是 i18n UI 文案，落 mono 槽在板端必豆腐；sys 行的折行度量与选区几何须用 UI 槽同口径，见 core/logview measureUi）——禁止对这些文案使用 `font-mono`。烘焙器每槽单一字体，mono 槽不烘 CJK，i18n 文案落在 mono 槽在板端必然豆腐。

**UI 固定符号必须取 MiSans 已映射的字形**（2026-10-24 定，修复下拉箭头豆腐）：源码字面量与 i18n 文案里的每个非 ASCII 字符都必须被 MiSans Regular/Bold 的 cmap 覆盖——烘焙器只收字符进集，MiSans 不映射的字形烘不出来，板端渲染为替换符；桌面 CoreText 系统回退会掩盖缺字。已映射可用：`▼ ▲ … — – · × ✓ →` 等；**不得使用** `▾`（U+25BE）、`⏎`（U+23CE）等 MiSans 缺映射符号。守卫测试 `test/app/ui-glyph-coverage.test.ts` 以烘焙器同口径扫描 app 字面量与全部 i18n 语言包并断言双面映射，新增 UI 符号前先过该测试。

**macOS 桌面端（首期目标平台）**：pocket.json 声明 `requires: ["text.layout.native"]`，走 gpui 宿主的 CoreText 运行时排版——**任意 Unicode（含 CJK/emoji）可显示，无 tofu**，烘焙字形约束在桌面端不成立。MiSans 与 JetBrains Mono 注册进宿主字体链（`register_fonts` + `TextConfig::new("MiSans")`，mono 槽解析到 `mono_family` JetBrains Mono；CJK 等未覆盖字符走系统回退）。代价：放弃跨宿主字节级金样确定性（金样测试改在 gpui 宿主上比对，见 §7）。

**嵌入式/未来 RT-Thread 端**：仍受构建期烘焙约束，策略为：

1. 构建时强制烘焙：**可打印 ASCII 全集（0x20–0x7E）** + 常用符号 + 各 i18n 语言包全部文案字符 + 界面固定文案（MiSans 覆盖 GB 范围，UI 中文案无缺字风险——前提是 UI 文案按上文走 MiSans 槽；mono 槽只烘 ASCII 等 JetBrains Mono 字形，不含 CJK）。
2. 接收数据显示时：未烘焙字形 → 替换符 ``；用户可切 HEX 显示获得无损视图。**允许豆腐的仅限"数据内容"**（RX/TX 行的接收/发送数据内容、终端输出、宿主枚举的端口描述等运行时字符串）；sys 行的来源前缀与内容自 2026-10-25 起走 MiSans 槽，不得豆腐；空态/占位/提示与下拉选项等 UI 文案不得出现豆腐（走 MiSans 槽）。
3. CJK 大字符集不预烘焙（体积不可控），在 FAQ/文档中明示该限制。
4. 终端模式同样受此约束。

## 6. MCP 服务规格

### 6.1 开启方式与传输

- 左侧配置面板的 **MCP 共享开关**（默认关，见 §3.1）。开启后：
  - 宿主进程内启动 MCP server，transport = **Streamable HTTP**，监听 `127.0.0.1:<port>`（默认 `7960`，可配）。
  - 开关下方显示连接 URL + token（可复制）；状态栏显示 `MCP: on (N clients)`。
  - 关闭开关 → 拒绝新连接、通知并断开现有会话。
- **终端模式门控（§3.1 模式开关）**：MCP server 仅在**收发模式**运行。切入终端模式即自动停服（等价关闭开关：拒绝新连接、断开现有会话）；切回收发模式且开关为开时自动重启。开关本身记录用户偏好（随配置持久化），有效运行态 = `开关开 && 收发模式`；终端是独占交互通道，agent 不得同时写入。
- Agent 侧配置示例（README 提供）：指向 `http://127.0.0.1:7960/mcp`，header 携带 `Authorization: Bearer <token>`。

### 6.2 架构位置

MCP server 实现于**宿主层**（fork 的桌面宿主 crate 内的原生线程，Rust），通过桥接与核心层消息总线交互。理由：MCP SDK 与 HTTP server 不适合跑在 QuickJS guest 内（guest realm 刻意无网络/文件/进程能力）；宿主实现可直接复用成熟 SDK，且与串口 IO 同层、延迟最低。

**事件流（遵循 PocketJS 帧契约，抄 `pocket-net` 的 poll/drain 模式）**：MCP 原生线程收到 agent 的 send/connect 等请求 → 入队 → tick 边界 drain 成事件批 → 经 `com.*` op 进 guest 核心层执行；核心层的消息总线变更（RX 帧、手动发送）反向入队 → MCP 线程消费响应 agent 的 `read`。核心层向宿主暴露：`sendBytes(bytes, source)`、`drainMessages(filter)`、`getStatus()`、`requestConnect(params)` 等。

### 6.3 Tools

| Tool | 参数 | 语义 |
|---|---|---|
| `status` | — | 连接状态、类型、参数、Rx/Tx 计数、MCP 客户端数 |
| `list_serial_ports` | — | 枚举串口（`设备 - 描述` 每行一条） |
| `connect` | `type, params…`（与 §3.2 参数一致） | 建立连接。已有连接时**默认拒绝**，`force: true` 才断开旧连接（规避 umeko 静默抢占）。serial 打开后应用 DTR/RTS：未传 `dtr`/`rts` 参数也显式去使能（deassert，TTL 侧拉高），与 UI 打开一致——ESP32 USB Serial/JTAG 等设备依赖该电平跳变边沿复位并开始输出 |
| `disconnect` | — | 断开当前连接 |
| `send` | `data: string, encoding: "utf8"\|"hex"\|"base64"`, `appendNewline?: boolean` | 发送字节。**不隐式追加 `\r\n`**（规避 umeko 缺陷），换行由参数显式控制。消息入总线，`source: "mcp"` |
| `read` | `maxBytes?: number, clear?: boolean = true` | 拉取读缓冲（read-and-drain）。返回带 `[ts] [来源] 内容` 的多行文本；空返回"无数据" |
| `config_read` / `config_write` | 限定 key 白名单 | 读写非敏感配置（不含 token） |

无 resources / prompts（与 umeko 一致，后续按需扩）。

约定：tool 输出为面向 agent 的稳定英文短句（不随 UI 语言切换）；`read` 行的来源标签除外（随 i18n，与 UI 前缀同源，见 §6.4）。tool 执行失败返回 `isError: true` + `content[{type:"text"}]`（`code: msg` 格式），协议层错误（未知 tool、参数缺失）走 JSON-RPC error。`send` 的 `appendNewline` 追加 `\r\n`。`config_read`/`config_write` 白名单：`language / theme / fontSize / terminal.scrollbackLines / receive.{hex,escape,timestamp,color,historyLines} / send.{escape,crlf,appendNewline} / mcp.{enabled,port}`（token 不可读出亦不可写入）。

### 6.4 读缓冲与来源可见性

- 读缓冲 = 消息总线的 MCP 侧视图：RX 帧 + **用户手动发送的 TX 帧**（标记 `手动发送`，让 agent 感知人工干预，借鉴 umeko `USER_OVERRIDE`）+ 系统事件。agent 自己 `send` 的数据不回灌其读缓冲。
- 行格式 `[YYYY-MM-DD HH:MM:SS.mmm] [来源标签] 内容`，内容为 UTF-8 文本（不可见字节转义 `\xNN`，非法序列 U+FFFD）；来源标签：RX=`[RX]`、手动 TX=UI 前缀文案（§3.5）、sys=`[SYS]`。
- 有界（同 §3.5 环形缓冲；宿主侧同样 256 KiB 封顶，超限丢最旧整行）；`read` 默认取空，可选 `clear: false` 窥视；`maxBytes` 超限时保留最新字节。
- 多条 agent 会话共享同一读缓冲（首版简化：先到先得地 drain；多会话隔离列 v1.1）。

### 6.5 并发与互斥

- 多 MCP client 可并发连接；`send` 经 FIFO 队列串行化写入。
- `connect / disconnect` 为控制操作：需有效 token，且与 UI 手动操作等价（UI 实时反映状态变化）。
- MCP 操作与 UI 操作无优先级差：单一状态机，后到先生效（`connect` 除外，见上表）。

## 7. 测试策略

- **核心层纯 TS 单测**（Vitest/Bun test）：帧合流、hex/escape/UTF-8 解码（含截断序列与非法字节）、ANSI/VT100 模型（对齐经典用例）、环形缓冲、消息总线、状态机迁移。
- **UI 测试**：PocketJS headless Bun host + 帧金样（PNG golden），覆盖双模式、双主题、双语言。
- **脚本化 UI 截图**（宿主能力，配合 e2e/文档产出）：宿主 flag `--screenshot PATH@T` 在第 T tick（60Hz 虚拟时钟，与 `--mouse/--click/--key/--type` 的 `@T` 同基准，可重复传入）把主窗口当前内容导出为 PNG。实现走系统 `screencapture -l` 捕获本进程窗口——自窗口内容免 Screen Recording（TCC）授权，agent/CI 运行零弹窗；不采用 `CGWindowListCreateImage`（deprecated）与 CPU 光栅（跳过 TEXT_RUN，native-text 下丢全部文字）。截图为窗口实际渲染内容（含 28pt 标题栏、2x 物理像素），含 CoreText 排版与合成器结果，**非确定性，不做 byte-exact 金样**（金样仍走 headless 路线）；同 UI 状态下输出字节一致，可作 e2e 相等断言。该 flag 为 opt-in：CI 不传即不触发，宿主单测仅覆盖参数解析与 PNG 头校验纯函数。
- **AIC 尺寸 e2e**：桌面启动器支持 `--resolution WxH`，以指定的固定逻辑视口运行现有桌面包；480×272 用于板端尺寸的共享 UI 验证，density 默认沿用桌面 plan。输入坐标保持逻辑像素，截图探测可配置实际截图像素比例与标题栏高度。此入口仅验证共享 UI 布局/交互，不替代 AIC profile、设备 IO 或真机内存验收。
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
| M5 | AIC + RT-Thread 构建与宿主接入 | 应用包、固件构建、内存报告、串口设备桥（仅 uart1）；网络/MCP 桥、紧凑布局后续实现；ASCII 软键盘已接入，真机待验收 |

M5 当前状态（2026-10-23）：应用打包、固件构建、内存报告、**XIP 固件 + 统一 TLSF 堆（2026-10-10 真机验证）**、精简验证页真机通过（启动/出帧/触摸）、**WiFi RTL8189FTV + lwIP 点亮至 AP 扫描（2026-10-11）**均已交付；共享 UI 已按 JSON 裁剪切回板端入口用于内存 perf，2026-10-23 优化前真机 S4 挂载 OOM 的历史记录保留；节点共享原型优化后真机已完成 120 帧零错误、零分配失败，用户确认画面和触摸下拉正常（详见 docs/aic-node-prototype-step1.md）。长时/IO/WiFi 组合验收待补；精简页保留为基线。2026-10-24 起宿主实现 `com.*` 串口桥（仅 uart1，PA.2/PA.3，`POCKETJS_COM=0` 可编译关闭）：op 语义与桌面一致（serialList/serialOpen/setSignals/write/close/poll，RX 事件 `{t:"data",h,b64}` 每 tick 经 poll 进 JS），无网络/cfg/MCP 桥，DTR/RTS 接受为 no-op；真机收发验收待用户烧录确认。

## 9. 风险与开放问题

M0 桌面宿主调研已完成（2026-09-04），#1/#3 已关闭：

| # | 风险/问题 | 状态 | 结论/应对 |
|---|---|---|---|
| 1 | 桌面宿主 JS 引擎形态与扩展点 | ✅ 已关闭 | gpui 窗口 + QuickJS guest（`pocket-mod`）；扩展 = `contracts/spec/*.ts` + Rust core + `guest.mount("com", …)`；app 可放外部仓库（vendor + `--project-root`），宿主二进制支持 `--js/--pak` |
| 2 | 无内置 serial/socket/WS，全部桥接自研 | 开放 | 工作量最大项。契约先行；Rust 侧用成熟 crate（串口 `serialport`、异步 IO `tokio`、WS `tokio-tungstenite`），事件批按 `pocket-net` 的 poll/drain 模式 |
| 3 | 烘焙字体不支持任意字符 | ✅ 已关闭（桌面端） | gpui 后端 `requires: ["text.layout.native"]` 走 CoreText，任意 Unicode 可显示；烘焙约束仅剩嵌入式目标（§5.4） |
| 4 | 终端网格渲染性能 | 开放 | M0 压测；native text 路径下按行渲染 `TEXT_RUN`，备选 `Image` 位图自绘网格 |
| 5 | MCP 多读缓冲的会话语义 | 开放 | 首版共享缓冲，v1.1 按 session 隔离 |
| 6 | AIC/RT-Thread 设备 IO 与内存预算 | 部分关闭 | Rust/固件构建与真机启动已验证（精简页，XIP + 统一 TLSF 堆）；WiFi/lwIP 已 bring-up 至 AP 扫描；**串口桥（仅 uart1）已实现（2026-10-24，真机验收待烧录确认）**；网络/MCP 桥、紧凑布局待实现；ASCII 软键盘已接入（真机待验收）；历史未裁剪完整 UI 常驻工作集约 8.1 MiB；当前裁剪诊断包经节点优化已通过真机 120 帧，caps 峰值约 5.10 MiB，长时/业务负载验收与紧凑装配待推进 |
| 7 | 金样测试需要 wasm32 target + headless Bun host；native text 路径放弃跨宿主字节确定性 | 开放 | UI 金样在 gpui 宿主或 wasm host 二选一，M3 前定 |

## 10. 附录

- PocketJS 文档：https://pocketjs.dev/docs/ 、NET 模块说明：https://pocketjs.dev/docs/net/
- PocketJS 源码（vendor，`vendor/pocketjs/`，0.14.0）关键路径：`engine/backends/gpui/`（桌面渲染后端）、`hosts/desktop/`（桌面宿主，fork 起点）、`contracts/spec/net.ts`（surface 契约样板）、`engine/crates/pocket-net/`（transport trait + tick drain 样板）、`docs/RUNTIMES.md`（Runtime = ⟨Cores, Surfaces, Guest⟩ 扩展模型）、`docs/BACKENDS.md`（native text 说明）。
- 本项目文档导航：`docs/e2e.md`（脚本化 UI 验证）、`docs/coords.md`（控件坐标速查）、`docs/mcp.md`（MCP 服务手册）、`docs/aic-memory-optimization.md`（D12x 内存优化方案）、`docs/rtthread-d12x.md`（移植预研）、`docs/performance/`（性能基准原始数据）。
- COMTool 调研要点：连接/插件/装配三层解耦、帧合流公式、终端基于 pyte 的 headless 模型（本项目以纯 TS 重写等价物）。
- umeko_serial_mcp 调研要点：6 个 tool 的划分、来源标签（LLM/HARDWARE/USER_OVERRIDE/SYSTEM）、UI 发送回灌 agent 读缓冲；缺陷清单见 §1.1/§3.5/§6。
