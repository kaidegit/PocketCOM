# 脚本化 UI 验证（e2e）

PocketCOM 桌面宿主（`host/macos`，fork 自 vendor desktop）内置一套脚本化输入
flags，用于在真机上做确定性 e2e：不碰可访问性、不发系统输入事件，全部输入在
**tick 边界**转成 svc JSON 行灌进 guest——与真实键鼠走完全相同的 app 侧路径
（同一 `svcPoll` FIFO、同一事件分发）。本文是各参数的权威说明；概要见
AGENTS.md「脚本化 UI 验证」条目。

## 运行方式

脚本 flags 是宿主二进制的运行时参数。开发期经 dev.mjs 的 `--` 分隔符转发：

```bash
node tools/dev.mjs -- --click 135,44@60 --screenshot out.png@70 --quit-after 80
```

`--` 之后的参数原样追加给宿主二进制；不带 `--` 时行为不变。也可直接调二进制
（需自拼 plan 派生 flags）：

```bash
POCKETJS_DIST=<repo>/dist host/macos/target/release/pocketcom-host \
  --app pocketcom-main --title PocketCOM --viewport 960x640 --density 2 \
  --native-text --companions pocketcom --editor \
  <脚本 flags…>
```

plan 派生 flags（`--app/--title/--viewport/--density/--fixed/--native-text/
--companions/--editor`）由 `node tools/dev.mjs` 与打包 launcher 自动生成，e2e
脚本一般不需要手写。

## 时间基准：tick（60Hz 虚拟时钟）

- `@T` 的单位是 **tick 序号**，不是秒。宿主用固定 60Hz 虚拟时钟驱动 guest
  （`TICK_HZ = 60`，1 tick ≈ 16.7ms，从 boot 起算，第一个 pump 的 `ticks` 为 0）。
- 事件在 `ticks == T` 的那次 pump 里投递（`--quit-after N` 则在 `ticks >= N`
  后退出，`--screenshot` 与输入事件同基准判定）。
- 绘制是 demand-driven：内容哈希变化的 tick 才触发重绘，滞后 1–2 帧。**交互
  事件之后截图/退出，建议留 2–3 tick 余量**（如 click@60 → screenshot@63 以后）。
- 墙钟换算：tick 120 ≈ 2s。等待类动作（如串口插拔）不要用长 tick 阻塞——
  tick 是虚拟时钟，会追帧（上限 `MAX_CATCHUP_TICKS = 6`），长等待应交给
  外部脚本 sleep。

## 坐标系

- `--mouse/--click/--wheel` 的 X,Y 是**画布逻辑像素**（plan 的 logical
  viewport，默认 960x640），原点在窗口内容区左上角（标题栏之下）。
- 从 `--screenshot` PNG 反推：`画布坐标 = (截图像素 - 标题栏) / density`。
  默认 2x 下标题栏高 56 物理像素（28pt），即 `(px - 56) / 2`。
- 控件坐标以 `app/panel.tsx` / `app/transfer.tsx` 的布局表（`layoutInfo`）为
  权威：块顶 = 头部高 + 累计块高，控件在块内 `LABEL_H+LABEL_GAP` 偏移处。

## 输入 flags

| flag | 形态 | 作用 |
|---|---|---|
| `--mouse` | `X,Y[,d\|u\|m\|r]@T` | 原始指针行：hover（缺省=移动）/按下 d/抬起 u/拖动 m/右键一次 r |
| `--click` | `X,Y@T` | 一次"聚焦 + 按压"（app 内产生 CIRCLE press） |
| `--wheel` | `X,Y,DY@T` | 滚轮滚动，DY 逻辑 px，**负值向下** |
| `--key` | `[cmd+][alt+][ctl+][sh+]NAME@T` | 键盘键/组合键（和弦） |
| `--type` | `TEXT@T` | 整段文本注入（svc `ch` 行，走真实编辑路径） |
| `--press` | `NAME@T` | 控制台按键（PSP 映射），按住 6 tick 自动释放 |
| `--storm` | `CPS@START+DUR` | 打字风暴基准：从 START 起 DUR 个 tick 内按 CPS 匀速注入字符 |
| `--screenshot` | `PATH@T` | 第 T tick 导出窗口 PNG（可重复） |
| `--quit-after` | `N` | `ticks >= N` 后退出并打印收据 |
| `--announce-ready` | （无值） | 首个绘制帧打印 `READY <epoch_ms>`（冷启动基准） |

### --mouse 与拖拽

`--mouse X,Y[,kind]@T` 直接发 svc `mouse` 行；kind 缺省为 `m`（移动，携带当前
脚本按下态）。

- **hover**：`--mouse X,Y@T`——移动指针。app 侧焦点跟随指针（落空清焦点），
  因此**任何点击/滚轮前必须先 hover 一帧**聚焦目标。
- **拖拽** = 按下 → 拖动 → 抬起，移动自动携带按下态：
  ```bash
  --mouse 100,100,d@60 --mouse 150,120,m@62 --mouse 200,140,m@64 --mouse 200,140,u@66
  ```
- **右键**：`--mouse X,Y,r@T`——一次按下+抬起（svc `b:2` 行）。
- **不要用 `--mouse d/u` 代替 `--click`**：`d/u` 只发 svc 行，不产生 CIRCLE
  press，控制台按钮与"借焦"语义不会触发。

### --click

`--click X,Y@T` = hover 聚焦 + 按压释放，等价于用户单击。标准点击配方：

```bash
--mouse X,Y@T-2 --click X,Y@T
```

### --wheel

`--wheel X,Y,DY@T`：先发 mouse 行把指针定位到 (X,Y)（svc scroll 行不带坐标，
app 按最近指针位置把 DY 路由到 面板/日志/终端 三区之一，弹层打开时滚弹层），
再发 `{"t":"scroll","dy":DY}`。DY 单位逻辑像素；面板/日志区公式为
`scroll -= dy`，即 **DY 为负 = 内容向下滚**，与真实滚轮的像素增量同号。

### --key（组合键/和弦）

`--key [cmd+][alt+][ctl+][sh+]NAME@T`，前缀可自由组合（顺序不限）。键名送
**小写原始名**，app 侧 `app.tsx KEY_ALIAS` 归一化为 Pascal 名：

```
enter/return→Enter  backspace→Backspace  delete→Delete  left/right/up/down→…
home→Home  end→End  pageup→PageUp  pagedown→PageDown  escape→Escape  tab→Tab
其余（字母/符号）原样透传
```

- 例子：`--key cmd+enter@64`（送框 Cmd+Enter 提交）、
  `--key sh+pageup@10`（终端本地回滚）、`--key ctl+c@20`（终端 Ctrl 控制码）。
- 带任一前缀的按键跳过控制台按钮映射，直接作为带 mods 的 key 行进 app；
  纯键名（无前缀）在控制台语境可能先被按钮映射吃掉（见 `--press`）。
- **与真实键盘的保留键差异**：真实 cmd 和弦在宿主有保留表（editor 语境
  cmd+q/w=退出、cmd+v=读剪贴板粘贴、cmd+c/x=Copy/Cut、cmd+z=Undo/Redo，
其余转发为 cmd-flagged key 行）；脚本 `--key` 不经保留表，一律直发 key 行——
  需要保留键的语义时用语义键名（如 `--key Copy@T`，KEY_ALIAS 查不到会原样
  透传，app 按 `k === "Copy"` 识别）。

### --type

`--type TEXT@T`：一次投递整段字符（svc `ch` 行），等价真实键入。tick 分隔取
**最后一个 `@`**，所以 TEXT 内可以含 `@`（`--type a@b.com@30` 投递
`a@b.com`）；但 `TEXT@`（空 tick）会报解析错误。含空格/引号等特殊字符时注意
shell 转义。

### --press（控制台按键）

`--press NAME@T`，按住 6 tick 自动释放（边缘检测型按钮处理器可靠闩锁）。
NAME → 按钮映射：

| NAME | 按钮 | NAME | 按钮 |
|---|---|---|---|
| `up/down/left/right` | 方向键 | `z` / `enter` | CROSS |
| `x` / `backspace` | CIRCLE | `a` / `s` | SQUARE / TRIANGLE |
| `q` / `l`、`w` / `r` | L / R 触发 | `tab` / `space` | SELECT / START |

### --screenshot

`--screenshot PATH@T`，可重复传入导出多个时刻（`--screenshot a.png@30
--screenshot b.png@90`）。机制与性质：

- 走系统 `screencapture -l` 捕获**本进程窗口**（窗口服务器合成，gpui Metal
  内容完整）。自进程窗口免 Screen Recording（TCC）授权——CI/agent 运行零弹窗。
  不要改回 AppKit 自绘：`drawViewHierarchyInRect:` 是 iOS-only（运行时
  unrecognized selector），`cacheDisplayInRect:` 拿不到 Metal 层内容（全黑），
  `CGWindowListCreateImage` 已 deprecated。
- PNG 含 28pt 标题栏，尺寸 = 物理像素（2x 下 1920x1336）。父目录自动创建。
- 成功打印回执 `pocket-desktop-host: screenshot <path> (WxH)`，失败打印错误
  不中断运行。
- 同一 UI 状态下输出**字节一致**，可做 e2e 相等断言；但不同状态/时序不保证
  确定（CoreText 抗锯齿、合成器时序），**不做 byte-exact 金样**——金样走
  headless wasm 路线（SPEC §7）。
- CI 不跑截图：opt-in flag 不传即不触发；宿主单测仅覆盖解析与 PNG 头校验。

## 观测

- `POCKETCOM_TRACE=1`：dump 双向 svc 行（`pocketcom-trace: svc ->/<-`）+
  `com.*` 调用（serialList/serialOpen/write/tcpConnect/tcpListen/udpBind/
  wsConnect/cfgRead/cfgWrite）。注入类验证先看 trace 确认行已投递、形态正确。
- 退出收据：`pocket-desktop-host: N ticks, M frames rendered (P%)`——M 反映
  demand-driven 重绘次数，可粗查交互是否引发了重绘。

## 已验证场景（本机真机 e2e）

- **M1**：串口全链路（serialList→打开→收发→关闭）。
- **M2**：TCP Client 回环（选类型→填 host/port→打开→发送→echo 收到→关闭→
  lastConn/发送历史持久化 0600）；`--screenshot` 全链路（多时刻/交互后截图/
  语言切换捕获）；`--wheel` 面板滚动（前后帧差）；`--key cmd+enter`（断连
  发送提示出现）。
- **M3**：终端模式（TCP 回环 echo 下切终端→ANSI 16 色/256 色/粗体/下划线/
  反显/OSC 吞掉渲染、按键直发回显、方向键经回显驱动光标、40 行溢出贴底跟随
  与回滚积累、空屏提示）；滚轮本地滚动经 `--wheel` 注入、拖拽选区 =
  `--mouse d` + `--mouse m` + `--mouse u`、Ctrl 控制码经 `--key ctl+NAME` 注入。

## 常见坑

1. **改了宿主代码后先 `cargo build --release` 再跑脚本**：`cargo test` 只编译
   test harness 二进制，不重建 `target/release/pocketcom-host`——旧产物会让
   新 flag 报 `unknown flag`。
2. 点击无效果：先检查是否 hover 聚焦（`--mouse` 一帧），再看坐标是否画布
   逻辑坐标（截图像素要 `/2` 且减标题栏 56px）。
3. 事件没到 guest：`POCKETCOM_TRACE=1` 看 svc 行；行到了但 UI 没变，多半是
   坐标命中落空或该功能尚未实装（如 M4 的 MCP 开关）。
4. `--wheel` 不滚动：指针未落在目标分区（面板 x<270 / 日志 / 终端），或该区
   已在滚动边界。
