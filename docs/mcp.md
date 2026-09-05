# PocketCOM MCP 服务手册

PocketCOM 内置一个 MCP（Model Context Protocol）server，让 AI agent（Claude
Code、Cursor 等任何支持 Streamable HTTP transport 的 MCP client）直接接入
当前的串口/网络连接：枚举串口、建立/断开连接、发送字节、读取响应、读写
非敏感配置。规格的权威定义见 [SPEC.md](../SPEC.md) §6；本手册面向使用者
与 agent 配置者。

```
AI agent ──Streamable HTTP (127.0.0.1:<port>/mcp, Bearer token)──▶ 宿主 MCP server
   ▲                                                                    │ 命令在 tick 边界
   └──── read ← 有界读缓冲（256 KiB） ◀── 消息总线（RX/手动TX/sys） ◀───┘ 进 guest 核心层执行
```

- server 跑在**宿主进程内**的原生线程，不占 guest JS 预算；所有连接操作
  与 UI 走同一个状态机与消息总线，UI 实时反映 agent 的操作，反之亦然。
- agent `send` 的帧在 UI 接收区标记为 `[MCP发送]`；agent 自己发的数据
  **不会**回灌它的读缓冲（不会读到自己的回声）。

## 1. 开启与界面

1. 构建并启动（需要自研宿主，stock 宿主没有 `com.*` 桥）：

   ```bash
   npm run build
   cargo build --release --manifest-path host/macos/Cargo.toml
   npm run dev
   ```

2. 左侧面板勾选 **MCP 共享**（默认关）。开启后（仅在收发模式）：
   - 面板显示 **URL**（`http://127.0.0.1:7960/mcp`）与 **Token**（截断展示），
     各带 **复制** 按钮；
   - 状态栏右侧显示 `MCP: on (N)`，N 为近 60 秒内活跃的 MCP 会话数；
   - 首次开启时自动生成 64 位 hex token（32 随机字节）并随配置持久化。

### 1.1 终端模式门控（重要）

**MCP 服务只在收发模式运行。** 切到终端模式会立即停服：拒绝新连接、断开
现有 MCP 会话、清空读缓冲；点回收发模式且开关为开时自动重启。终端是独占
的交互通道（按键直发连接），agent 与人工终端输入不应同时写入——这是刻意
设计，不是 bug。停服窗口内已入队的工具调用会收到 `mcp-suspended` 错误。

### 1.2 token 管理

- token 存于配置文件（macOS：`~/Library/Application Support/PocketCOM/
  config.json`，权限 0600）的 `mcp.token` 字段。
- **重置**：清空配置文件里的 `mcp.token`（置 `""`）后重启应用，会生成新
  token；或在重启前用 `config_write` 以外的任何方式修改——注意 `config_write`
  工具**不能读写 token**（白名单设计，SPEC §6.3）。
- **导出配置**（面板"导出配置"按钮）自动剥离 `mcp.token`，导出文件不含
  凭据。

### 1.3 端口

默认 `7960`。修改方式（二选一）：编辑配置文件 `mcp.port` 后重启；或让
agent 调 `config_write`（`{"config": {"mcp": {"port": 8123}}}`，立即重启
生效）。端口被占用时开启失败，接收区会出现 sys 提示且开关自动回退。

## 2. Agent 侧接入

任意支持 Streamable HTTP 的 MCP client，指向 `http://127.0.0.1:<port>/mcp`，
header 携带 `Authorization: Bearer <token>`。以 Claude Code 为例：

```bash
claude mcp add --transport http pocketcom http://127.0.0.1:7960/mcp \
  --header "Authorization: Bearer <token>"
```

或写入 `.mcp.json` / 客户端的 servers 配置：

```json
{
  "mcpServers": {
    "pocketcom": {
      "type": "http",
      "url": "http://127.0.0.1:7960/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

协议细节：JSON-RPC 2.0 over HTTP POST；支持协议版本 `2025-03-26` 与
`2025-06-18`；initialize 时下发 `Mcp-Session-Id`，后续请求需携带，
`DELETE /mcp` 结束会话；无 server→client SSE 流（`GET` 返回 405，符合
规范）；无鉴权或错误 token 一律 HTTP 401。仅监听 `127.0.0.1`，不提供
对外监听选项（SPEC §5.3）。

## 3. 工具参考

工具执行失败时返回 `isError: true` + 文本 `code: msg`（结构化，不用裸字符串
充当错误）。除 `read` 外的工具都在应用主循环（tick 边界）执行，延迟为毫秒
级；应用无响应时 10 秒超时返回 `guest-timeout`。

### 3.1 status

当前连接状态快照。无参数。返回单行 JSON：

```json
{"state":"CONNECTED","kind":"tcp","describe":"tcp 127.0.0.1:9000",
 "rxBytes":128,"txBytes":9,"mcpClients":1}
```

`state` ∈ `DISCONNECTED / CONNECTING / CONNECTED / LOST`；`kind` ∈
`serial / tcp / tcps / udp / ws` 或 `null`。

### 3.2 list_serial_ports

枚举本机串口，每行一条 `设备 — 描述`（macOS 仅 `/dev/cu.*`）。无串口返回
`(no serial ports)`。

### 3.3 connect

建立连接。**已有连接时默认拒绝**（`already-connected`），传 `force:true`
先断开旧连接再建新连接——agent 不会静默抢占人工连接。

| 参数 | 适用类型 | 说明 |
|---|---|---|
| `type`（必填） | 全部 | `serial` / `tcp` / `tcps` / `udp` / `ws` |
| `path` | serial | 设备路径，如 `/dev/cu.usbserial-XXX` |
| `baudRate` | serial | 默认 115200 |
| `dataBits` | serial | 5–8，默认 8 |
| `parity` | serial | `none`（默认）/ `odd` / `even`（mark/space 宿主不支持） |
| `stopBits` | serial | 1（默认）/ 2 |
| `flowControl` | serial | `none`（默认）/ `xonxoff` / `rtscts` / `dsrdtr` |
| `dtr` / `rts` | serial | 打开后设置信号电平 |
| `host` / `port` | tcp / udp | 远端地址 |
| `bindPort` | udp | 本地绑定端口，默认 = `port` |
| `port` | tcps | 监听端口 |
| `url` | ws | `ws://` / `wss://` |
| `autoReconnect` / `reconnectSec` | tcp / ws / udp / ws | 掉线自动重连（默认关/5s） |
| `force` | 全部 | 先断开现有连接 |

示例：

```json
{"name": "connect", "arguments": {"type": "serial", "path": "/dev/cu.usbserial-A50285BI", "baudRate": 115200}}
{"name": "connect", "arguments": {"type": "tcp", "host": "192.168.1.50", "port": 9000}}
```

返回 `connected: <人读摘要>`；打开失败透传核心层结构化 code（如
`IO_CONNECT_FAILED`）。

### 3.4 disconnect

断开当前连接（幂等；未连接返回 `not connected` 仍算成功）。LOST 状态下
等价于"确认掉线"。

### 3.5 send

在当前连接上发送字节。**不隐式追加换行**（规避常见静默数据污染）；
`appendNewline: true` 时在末尾追加 `\r\n`。

| 参数 | 说明 |
|---|---|
| `data`（必填） | 按所选编码给出载荷 |
| `encoding`（必填） | `utf8` / `hex`（容忍空格与 `0x` 前缀）/ `base64` |
| `appendNewline` | 追加 `\r\n`，默认 false |

要求连接已 `CONNECTED`，否则 `not-connected`。发送成功返回
`sent N byte(s)`；UI 接收区出现 `[MCP发送]` 帧并发送历史不记录 agent 发送。

### 3.6 read

读取 MCP 读缓冲（RX 帧 + **用户手动发送的 TX 帧** + 系统事件），返回多行
文本：

```
[2026-09-05 20:15:42.123] [RX] AT
[2026-09-05 20:15:42.210] [RX] OK
[2026-09-05 20:15:43.001] [SYS] connected: /dev/cu.usbserial-A50285BI @ 115200
[2026-09-05 20:15:44.512] [手动发送] reset
```

- 行格式 `[时间戳] [来源] 内容`；内容为 UTF-8 文本，控制字符转义为
  `\n \r \t \\ \xNN`（保证一条消息一行），非法 UTF-8 序列为 U+FFFD。
  `[RX]`/`[SYS]` 为固定标记；手动 TX 的标签随界面语言（简体中文
  `手动发送` / English `Manual TX`）——它提示 agent：**有人为干预**。
- 默认 **drain**（取空缓冲）；`clear: false` 只窥视不清空。
- `maxBytes`（默认 65536，上限 262144）超限时保留**最新**字节并在开头注明
  截断。
- 缓冲为空返回 `(no data)`。缓冲总量有界（256 KiB），超限丢最旧整行——
  agent 应及时轮询读取，不要指望无限历史。
- UI"清屏"只清显示与计数，不清 MCP 读缓冲。

### 3.7 config_read / config_write

读写**白名单内**的配置（token 不可读出亦不可写入）：

`language`（`zh-CN`/`en`）、`theme`（`light`/`dark`/`system`）、`fontSize`
（12/14/16）、`terminal.scrollbackLines`（0–100000）、`receive.{hex,escape,
timestamp,wrap}`、`send.{escape,crlf,appendNewline}`、`mcp.{enabled,port}`。

```json
{"name": "config_write", "arguments": {"config": {"receive": {"hex": true}, "mcp": {"enabled": true}}}}
```

`config_write` 立即持久化并生效（含 MCP 开关/端口的启停联动）；白名单外的
键（如 `sendHistory`、`mcp.token`）返回 `invalid-param`。

## 4. 典型工作流

**串口 AT 调试：**

```
list_serial_ports → connect{type:"serial", path:"…", baudRate:115200}
→ send{data:"AT", encoding:"utf8", appendNewline:true}
→ read → （预期 [RX] OK）→ disconnect
```

**固件日志观察（人工同机操作）：** agent `connect` 后只 `read` 轮询日志；
期间用户在 UI 手动发送的每条命令都会以 `[手动发送]` 出现在 read 结果里，
agent 能感知人工干预而不与之冲突。需要交互输入时切终端模式（MCP 自动
停服），完毕切回。

**协议探测：** `connect{type:"udp", …}` → `send{encoding:"hex"}` 发原始
字节 → `read` 看回包（二进制以 `\xNN` 转义呈现）→ 必要时 `config_write`
切 HEX 显示对照 UI。

## 5. 疑难排查

| 现象 | 原因与处理 |
|---|---|
| HTTP 401 | token 缺失/不匹配。面板复制最新 token；确认 header 为 `Bearer <token>` |
| 连接被拒（ECONNREFUSED） | 服务未开或处于终端模式（门控停服）。查面板开关与状态栏；模式切回收发 |
| 工具返回 `mcp-suspended` | 停服竞态窗口内已入队的命令；重试即可 |
| `already-connected` | 已有连接。确认是抢占意图后加 `force: true` |
| `not-connected` | send 时未连接；先 connect |
| `guest-timeout` | 应用主循环 10s 无响应（窗口被系统挂起等）；恢复应用后重试 |
| read 一直 `(no data)` | 对端确实无回包，或此前处于终端模式期间缓冲被清空；重连后重试 |
| 开启即回退且报错 | 端口被占用（`io-error: binding …`）；换 `mcp.port` |
| 旧会话 404 | server 重启后会话失效；重新 initialize |

观测：宿主以 `POCKETCOM_TRACE=1` 启动可看到 `com.mcpStart/mcpCmds/
mcpResults` 等桥接 trace。

## 6. 测试

```bash
# 宿主 MCP 协议单测（HTTP 解析/鉴权/JSON-RPC/读缓冲/命令往返）
cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host

# 集成测试：脚本化 MCP client 走真实宿主+guest 全链路（含终端模式门控）
#   前置：npm run build && cargo build --release --manifest-path host/macos/Cargo.toml
bun test host/macos/mcp/
```
