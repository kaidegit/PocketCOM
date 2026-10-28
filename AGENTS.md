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
| 当前内存优化步骤与产物/真机结果 | [第 2 步连接配置延后创建](docs/aic-narrow-panel-step2.md)（真机启动/120 帧内存通过，完整交互采样待补）；[第 1 步](docs/aic-node-prototype-step1.md)真机 120 帧及基本交互通过 |
| 板端内存优化方案（A–G、P0–P3） | [docs/aic-memory-optimization.md](docs/aic-memory-optimization.md) |
| 共享 UI / TS 内存优化与编译期裁剪提案 | [docs/shared-ui-memory-optimization.md](docs/shared-ui-memory-optimization.md) |
| e2e 脚本用法 / 控件坐标 | [docs/e2e.md](docs/e2e.md) / [docs/coords.md](docs/coords.md) |
| MCP 服务手册 | [docs/mcp.md](docs/mcp.md) |
| 只读参考代码库 | COMTool、umeko_serial_mcp（见文末） |

脚本化 UI e2e 支持 `node tools/dev.mjs --resolution 480x272 -- <宿主 flags…>` 指定固定逻辑视口；
坐标按目标尺寸重测，截图探测工具支持实际像素比例/标题栏参数。该入口仍运行桌面包，详见 `docs/e2e.md`。

技术栈一句话：TypeScript（strict）+ PocketJS **Vue Vapor 适配器**（不用 Solid/Octane），无 DOM/运行时 CSS，UI 仅 `View/Text/Image` 原语。
分层依赖单向：`app → core → bridge`，`host/*` 实现 bridge 的 `com.*` HostOps 契约；core 保持纯 TS、可在 Bun/Node 下单测。

桌面构建选择 fork 的 `macos-gpui` catalog 目标（plan identity / 目录仍为 `macos-app`），
声明当前 GPUI/CoreText 宿主能力；上游 `macos-app` 是软件渲染宿主契约。桌面 manifest 必需
`text.layout.native`，错误目标必须在构建时拒绝，不能静默降级。

## 技术栈与硬性约束

- **字体**：UI 统一 MiSans（Regular/Medium/Semibold/Bold，vendor 在 `assets/fonts/`）；**mono 槽（接收区/终端网格）用 JetBrains Mono**——MiSans 非等宽，终端网格必须严格等宽。**mono 槽只承载数据内容**（日志行时间戳与 RX/TX 数据内容/终端网格/文本框输入/地址/计数；sys 行的前缀 `[系统]` 与内容是 i18n UI 文案，走 MiSans 槽渲染并以 UI 槽度量折行/选区）；空态/提示/占位与下拉选项等 UI 文案一律走 MiSans 槽——烘焙 mono 槽无 CJK，i18n 文案落 mono 槽在板端必豆腐（SPEC §5.4）。**UI 固定符号必须取 MiSans 已映射字形**（如 `▼ … — · ✓ →`；`▾`/`⏎` 不在 cmap，板端必豆腐），新增符号先过 `test/app/ui-glyph-coverage.test.ts`（SPEC §5.4）。桌面端经 `text.layout.native` 走 CoreText 运行时排版，任意 Unicode 可显示；**烘焙字形约束只对嵌入式目标成立**（SPEC §5.4）。桌面可用 `npm run dev:aic-sim`（`--baked-text`）以板端同源 atlas 模拟烘焙字形观感（密度锚定 AIC profile，见 `docs/e2e.md`）。
- **无内置串口/WebSocket/raw socket**：所有 IO 走 `bridge/` 的 `com.*` HostOps 契约，核心层不得直接 import 任何平台 API。
- 宿主事件只能在 **tick 边界**投递进 JS（FIFO 队列 drain），不得直接回调。
- **无 DOM、无运行时 CSS**：动态样式用 `style={{…}}` 或整体 class 字面量三元，**禁止拼接 class 片段**（编译错误）。
- i18n：所有用户可见文案必须走 `assets/i18n/` 语言包 key，禁止硬编码。当前语言 `zh-CN`、`en`。**同一 key 不得既是字符串又是嵌套对象**（JSON 重复 key 后者覆盖前者）。

### 引擎布局怪癖（实测，勿踩坑）

以下均为 PocketJS/Vue Vapor 引擎实测行为，示例实现见所指文件：

1. **深层嵌套 flex-col 流式堆叠会失效**（子项重叠同位）→ 面板/列表内容一律 absolute + inset 显式定位（`app/panel.tsx` layoutInfo 布局表）；flex 只用于浅层行容器。
2. **zIndex 只在兄弟间重排** → 下拉弹层不做内联 zIndex，一律走 `Portal` + 全屏透明遮罩 + 屏幕绝对坐标锚点（`app/widgets.tsx` PopupLayer/Select）。
3. **桌面鼠标命中 = 绘制的 ink；AIC 触摸按 bounds 命中**：鼠标下透明 View 不命中、Text 只在字形上命中 → 整格可点控件必须给不透明或 `#00000001` 底色（下拉项/SegCtrl/CheckRow）。触摸下透明容器仍可截获命中，不能只用桌面鼠标验证浮层关闭。
4. **style 对象 diff 只增不删**：条件性样式 key 必须常设、用透明色隐藏，不能时有时无。
5. **Vue Vapor 组件不得返回 null**（宿主 JSX 运行时 anchor 崩溃）→ 空态用 0 尺寸占位 View，条件渲染放父级表达式子节点。
6. **焦点必须跟随指针**：mouse 分发时 `focusNode(hitFocusable(x, y))` 无条件调用（落空也要清焦点），否则点空白会把 press 发到上一次聚焦的控件。
7. **Vue Vapor Portal host 固定为规格屏 480×272**（不读实时视口）→ 全屏遮罩弹层须按 `viewportSize` 显式给 width/height 自撑，不能 `inset 0` 寄生（`PopupLayer` 遮罩）。host 必须设置 `hitPass: 1`，使空容器自身不拦触摸、子节点仍正常命中；2026-10-24 已修复复用连接抽屉关闭后无法再打开的问题（本地通过，真机待复验）。
8. **条件读取 getter 会漏注册响应式依赖**：数据源为非响应式宿主对象（logView.rows、terminal.totalLines）的纯指示组件，用 **onFrame 轮询 + 本地 ref**（值不变不写 ref），见 `Scrollbar`。
9. **触摸拖动不会生成 companion 滚轮事件**：滚动内容需显式接 `createGesture` 的纵向 pan，区域绑定被裁剪的内容节点子树（`nodeRef`），避免头部/页脚/覆盖弹层也带动面板。pan 认领自动取消 tap；复用面板隐藏时取消进行中的手势，见 `app/panel.tsx` 与 `test/app/panel-touch.test.ts`。

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
                #   Scrollbar）；soft-keyboard.tsx 可裁剪 ASCII 软键盘（所有文本域首次点击聚焦、再次点击展开，首次创建后隐藏复用）；keyboard-editor.tsx 临时编辑面板（直接复用原域文本/光标，keyboard-editor-layout.ts 限制两行可见窗口）；textsel.ts 文本选区纯几何；sendlayout.ts 发送区选项行流式几何；workspace-layout.ts 宽窄屏工作区几何；
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
- **低内存性能优化**（2026-10-26）：原生节点 DOM 兼容容器按需创建、Vapor slot 减少临时闭包，GE A8 仅清 padding，无 damage 帧跳过 cache clean/PAN 并保留 vsync。FPS 改为实际窗口归一化，新增88 B固定分段计数（`PJS-PERF`）；`turn_max` 包含完整 UI turn，不能当纯JS。LP64固定7 MiB同条件10轮系统峰值减少191736 B，忙帧/快速各50轮420/420、无分配失败，6状态RGB565零差异；真机120帧系统占用减少64780 B，交互峰值5655204 B（不同输入仅作观测），首开配置JS1860ms/键盘684ms，首次创建卡顿仍待优化。固件 `dist/aic/perf-low-memory/`，见 [本轮记录](docs/aic-perf-low-memory-2026-10-26.md)。
- **时钟/缓存核查**（2026-10-26）：CPU 配置 396 MHz，GE/DE 按实际 IP 分支及整数分频推算约 147/98 MHz，I/D Cache 初始化启用、D-Cache 预取沿用 SDK 默认关闭。新增只读 `pjs_hw` 与首帧前 `[PJS-HW]` 自动读回；未修改频率或缓存设置。用户读回确认 CPU396/GE147/DE98 MHz、MHCR=0x103f；旧 SYSMAP 打印位域错误已按 E907 bit4/3/2 修正，PSRAM/FLASH raw attr=0x0c 为可缓存/可缓冲。见 [核查记录](docs/aic-clock-cache-audit-2026-10-26.md)，诊断固件 `dist/aic/clock-cache-audit/`。
- **GE 2D 加速已接入**（2026-10-24，fork `hosts/aic/port/pocketjs_ge.c`）：RGB565 渲染器的不透明填充走 GE fillrect、1:1 PSM 5650 搬运走 GE bitblt（BGR_565 源交换），A8 掩码经 CPU 转 ARGB8888 后可走 GE（按 padding 后 8192 像素上限，首次使用约 48 KiB MEM_CMA 暂存区，行 stride 按 SDK 要求对齐 8 B，成功才写回，超限/失败回退 CPU；本次硬件舍入/性能待验收，见 `docs/aic-ge-a8-2026-10-26.md`）；DMA 前后 clean/invalidate（A8 使用独立对齐暂存面），失败按 DrawList 顺序软件回退，`POCKETJS_GE=0` 可编译关闭。原填充/搬运真机验证颜色/出帧/交互正常；2026-10-26 A8 修正版用户回传确认黑屏恢复、首帧/120 帧及触摸后出帧，frame120 caps_fails=0，CMA 增加 49240 B。首次触摸 turn_max=1763 ms、部分重绘样本 fps=1，perf A/B 与长时数据未采。详见 [host/rtthread/README.md](host/rtthread/README.md) GE 章节。
- **LCD 静态字边跳动已修复**（2026-10-24）：产品 defconfig 的 RGB pixel clock 相位从 0° 恢复到 SDK 同板参考的 90°（`AIC_DEGREE_90` / `AIC_RGB_CLK_CTL=1`）。实际 AIC 包经原生 RGB565 离板回放，空闲双缓冲像素一致；修正相位后用户真机确认“确实好了”。固件与证据见 [字体显示排查](docs/aic-font-rendering-2026-10-24.md)；本次反馈仅验收字体观感/静态字边跳动，不扩展为长时或业务负载验收。
- **WiFi 已点亮**（2026-10-11）：RTL8189FTV（SDIO/SDMC0，4-bit @40MHz）+ third-party lwIP
  （netif `WL0`），验证至 AP 扫描；驱动 `.bss` ≈259 KiB 进 PSRAM，运行时缓冲吃统一堆——
  恢复收发功能前必须补 WiFi 开/连 AP/断开状态下的堆基线测量。
- **内存优化按步交付**：第 2 步已实现共享窄屏连接配置抽屉：默认不创建，首次打开后复用，以限制快速开关峰值；本地验证/固件及本轮真机启动/120 帧内存验证已完成；系统峰值 4,760,220 bytes、frame120 系统占用 3,534,768 bytes。首次触摸后观察系统峰值 5,331,368 bytes，3091 ms 卡顿按用户要求后置处理；完整反复开关内存采样待补（`docs/aic-narrow-panel-step2.md`）。启动空闲收益不代表首次打开后的常驻收益，高级收发工具栏窄屏折叠仍待做。2026-10-23 第 1 步节点共享原型已完成离板 A/B、桌面回归、固件构建及用户真机 120 帧/基本交互验证，记录见 `docs/aic-node-prototype-step1.md`；本轮系统历史峰值 5,810,936 bytes、caps 峰值 5,345,447 bytes，无分配失败。用户负责烧录并回传日志，每步记录后再推进下一项；本次通过仅限启动/短时空闲与已反馈交互，长时/业务流量/WiFi 矩阵仍待验收。
- **连接配置触摸滑动**（2026-10-24）：共享面板内容区已接纵向 pan，补齐滚轮之外的触摸输入路径（原页脚上翻/下翻按钮已于 2026-10-25 移除，滚动路径只剩滚轮 + 触摸拖动）；真实 Vue Vapor/核心 WASM 回归、实际 AIC 包 QuickJS 连续触摸检查及固件构建通过，真机待用户复验。产物与证据见 `docs/aic-narrow-panel-step2.md` 的触摸滑动修复章节。
- **软键盘二次点击**（2026-10-25）：共享 `TextField` 首次点击聚焦、再次点击当前域展开 ASCII 软键盘，无双击时限；程序 `focus()` 不展开，拖动/取消不展开。键盘首次使用创建、之后隐藏复用，失焦/切换域/卸载收起；按键不清除文本域。范围及启停只查 JSON，真实 Vue Vapor/core bounds 触摸测试见 `test/app/soft-keyboard-touch.test.ts`，交付/内存及真机待验收边界见 [本次记录](docs/aic-soft-keyboard-2026-10-25.md)。 后续已加入字段名称/两行实时文本/光标的临时编辑面板及键帽居中，见 [临时编辑面板记录](docs/aic-keyboard-editor-2026-10-25.md)。
- **发送框折叠与离板 TLSF**（2026-10-25）：发送区首次展开创建、之后移出视口隐藏复用，收起清焦点/键盘/下拉并暂停定时发送，保留草稿/光标。旧包反复重建峰值触发系统堆碎片失败；另将软键盘 45 个键的响应更新合并，首次键盘/发送折叠短测在 LP64 7 MiB 固定池通过；9 MiB 无额外 GC 三组各 48,000 帧/200 轮通过，7/8 MiB 更长无 GC 压测仍有失败，真机待复验，见 [本次记录](docs/aic-send-collapse-tlsf-2026-10-25.md)。
- **帧边界压力 GC**（2026-10-25）：AIC 挂载后首帧前回收一次，之后按 caps 增长/系统堆余量在完整帧末回收，低余量时持续重绘也最多等 2 秒；不改堆、配额或 allocator。探针 `--aic-gc` 与固件同源，`--aic-gc-idle` 比较旧策略；`tools/aic-memory-stress.py` 逐次检查实际包触摸/节点复用。LP64 7 MiB 无空闲机会的三组各 48,000 帧/200 轮和快速组通过，当时抽屉+设置组合仍失败；历史固件 `dist/aic/oom-gc/`，见 [本次记录](docs/aic-gc-pressure-2026-10-25.md)。
- **组合面板 OOM**（2026-10-26）：PocketJS 编译器按导入绑定降低普通 View/Text 的组件/属性代理开销，同作用域批量更新；展开属性、组件 ref、动态 slot 等保留普通路径。设置弹窗首次创建后隐藏复用，每次打开重置配置草稿，隐藏时禁用选区命中。LP64 固定 7 MiB 下旧包复现失败，新包首次组合 20/20、正常/无空闲/快速三组各 50 轮 420/420、零分配失败；五张 RGB565 对照零像素差异，桌面回归/固件构建通过。固件 `dist/aic/combined-oom-fix/`；真机峰值、GC 停顿及 UART/WiFi 组合仍待验收，见 [本次记录](docs/aic-combined-oom-2026-10-26.md)。
- **接收区系统消息豆腐修复**（2026-10-25）：sys 行的 `[系统]` 前缀与 i18n 内容改走 MiSans 槽渲染（时间戳段与 RX/TX 数据内容保持 mono，数据豆腐仍属 SPEC 允许），折行/选区度量按行类别分派 UI 槽；本地单测/烘焙观感验证完成，真机待烧录复验，见 [本次记录](docs/aic-sys-tofu-2026-10-25.md)。
- **com 串口桥**（2026-10-24）：fork 宿主经 `pocketjs_guest_quickjs_install_once` 挂载 `globalThis.com`（`hosts/aic/port/pocketjs_com.c`，`POCKETJS_COM=0` 可编译关闭），仅 uart1（PA.2/PA.3，与桌面 op 语义一致，RX 走 poll 事件，无网络/cfg/MCP 桥）；共享 App 在 `aic-diagnostic` profile 下据此解锁收发界面。板端 UART 引脚以官方数据手册为准（SDK `aic_gpio_id.h` 枚举有错，见 host/rtthread/README "UART 引脚"）；真机收发验收待用户烧录确认。
- **接收区触摸拖动**（2026-10-26）：原接收区仅有滚轮/桌面鼠标选区，AIC 手指拖动无滚动路径；现共享日志内容区增加纵向 pan，复用边界与贴底锁定，工具栏/发送区/弹层隔离，弹层打开取消手势。真实 Vue Vapor/core bounds 回归与固件构建通过，真机及实际包连续触摸待复验；固件 `dist/aic/receive-touch-fix/`，见 [本次记录](docs/aic-receive-touch-2026-10-26.md)。
- **自动样式合批撤回**（2026-10-27）：同口径粗粒度真机A/B，scalar/batch配置首开1524/1802ms、键盘556/670ms，batch本组慢18%–21%，不保留自动inline style打包。当前renderer恢复直接setProp，可选C setPropBatch仅供显式调用；启动日志区分inline=scalar与batch_api=1。恢复固件 `dist/aic/scalar-style/`，其他已验证内存/GE优化保留，详见 [A/B记录及恢复版](docs/aic-coarse-perf-2026-10-27.md)。
- **粗粒度性能复测**（2026-10-27）：撤掉tree/primitive/HostOps密集TS埋点，不包装ui.*，仅保留组件/键盘effect/Vue flush/frame。两份同口径固件：`dist/aic/coarse-perf-scalar/`为可选batch接口缺失的兼容对照，`dist/aic/coarse-perf/`为默认batch；该对照生成时工作区与dist默认曾恢复batch，后续已撤回自动合批（见上一条）。351项源码/14项fork、两份固件、实际包与6状态像素通过；真机净收益待A/B，离板时序不显示提速，不能据此推定板上结果。见 [复测记录](docs/aic-coarse-perf-2026-10-27.md)。
- **Inline style批量提交**（2026-10-27）：AIC/ESP-IDF QuickJS补齐既有可选setPropBatch，共享renderer按单个style的变化属性同步合批，无batch宿主回退；临时packet不常驻节点。离板配置属性HostOp254→82、键盘413→54，同7MiB/10轮峰值未增加，busy/rapid各50轮420/420及6状态RGB565零差异；真机确认配置254→82、键盘414→54；带探针首开TS帧约3055→2562ms、1611→1127ms，120帧caps_fails=0，净延迟仍须撤掉密集探针复测。固件 `dist/aic/style-batch/`，见 [本轮记录](docs/aic-style-batch-2026-10-27.md)。
- **TS 创建分段诊断**（2026-10-26）：按用户要求允许临时perf开销；AIC诊断时钟驱动TS组件/原语/样式/Vue flush/HostOps的调用次数、inclusive/self/max日志（`PJS-TS`），正常桌面不安装。351项源码/13项fork回归、实际包7MiB短时诊断与固件构建通过；尚未真机采样，不声称首开加速。固件 `dist/aic/ts-create-perf/`，口径及删除边界见 [本轮记录](docs/aic-ts-create-perf-2026-10-26.md)。
- **UART 接收显示延迟**（2026-10-26）：用户以 UART1 TX/RX 跳线短接发送 `aaa`，反馈 TX/RX 立即各为 3 B、文本延后显示。当前 AIC 未启用 RTC，`gettimeofday()` 失败且 QuickJS 未检查返回值，旧会话泵用不可靠的 `Date.now()` 驱动合流静默超时；现改用 `virtualNow() × 1000`，消息日历时间戳来源保留。真实 Vue Vapor/core 的 AIC/桌面 profile 回归覆盖冻结/回拨时钟、接收文字及低波特率阈值；修复后真机延迟待烧录复验，见 [排查记录](docs/aic-uart-receive-delay-2026-10-26.md)。

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

命令、产物、内存报告解读、烧录要点全部在 skill `aic-build`；`npm run probe:aic` 为固定连续区 + SDK 同源 TLSF 离板内存探针（默认 7 MiB，`--heap` 指定池大小，无 malloc 回退；报告最大连续块/碎片及失败瞬间，64 位与系统负载差异仍不替代板端验收）；板端测试 `bun test test/host/rtthread/`。

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
