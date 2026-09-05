# PocketCOM

基于 [PocketJS](https://pocketjs.dev) 运行时的串口/网络调试助手。单页面、收发/终端双模式切换，内置 MCP server，让 AI agent 可以直接接入共享收发数据。

- 首期平台：macOS（桌面宿主）
- 远期平台：RT-Thread（架构预留，不实现）

## 功能特性

- **双模式**：收发模式 / 终端模式开关切换，切换不断开连接
- **多连接类型**：串口、TCP Client、TCP Server、UDP、WebSocket Client
- **收发模式**：ASCII/HEX 显示与输入互转、时间戳、自动换行、ANSI 颜色、转义符（`\n \r \t \xNN \NNN`）、定时循环发送、发送历史、发送文件、日志保存
- **终端模式**：纯 TS 实现的 ANSI/VT100 headless 终端模型，按键直发、可回滚（默认 9999 行）
- **帧合流**：串口按静默间隔（2× 单字节传输时间）合帧，网络连接按 1ms 固定间隔合帧
- **i18n**：简体中文 / English，运行时切换无需重启
- **深色模式**：浅色 / 深色 / 跟随系统
- **MCP 服务**：Streamable HTTP transport，仅绑 `127.0.0.1` + token 鉴权，AI agent 可枚举串口、建立连接、收发数据、读取状态

## 架构

分层依赖单向：`app → core → bridge`，`host/*` 实现 bridge 契约。

```
app/            # Vue Vapor 组件与页面状态（仅渲染 + 输入），pocket.json manifest
core/           # 纯 TS：连接状态机、帧合流、消息总线（有界环形缓冲）、编解码、
                #   格式化、ANSI/VT100 终端模型、发送组装
bridge/         # com.* HostOps 契约（类型 + sim host fixture）
test/           # 单测，按源码分层镜像（test/core、test/bridge、test/host）
host/macos/     # macOS 宿主：串口/TCP/UDP/WS 原生 IO、MCP server
host/rtthread/  # RT-Thread 宿主（预留）
assets/         # i18n 语言包、MiSans 字体
vendor/pocketjs # PocketJS 上游（git submodule）
SPEC.md         # 功能规格（权威定义）
```

核心层为纯 TypeScript，不依赖任何平台 API，可在 Bun/Node 下独立单测；所有 IO 经 `bridge/` 的 `com.*` HostOps 契约由宿主注入，宿主事件只在 tick 边界投递进 JS。

## 构建与运行

前置依赖：**bun**（`~/.bun/bin` 需在 PATH）+ Rust stable。

```bash
# 首次克隆：拉取 submodule 并安装依赖
git submodule update --init --depth 1
cd vendor/pocketjs && bun install && cd ../..

# 核心层单测
bun test test/

# 类型检查 / manifest 校验
npm run typecheck
npm run check

# 构建 app bundle（输出 dist/pocketcom-main.js + .pak）
npm run build

# 构建 macOS 桌面宿主（首次全量编译约 15–25 分钟）
cargo build --release --manifest-path host/macos/Cargo.toml

# 桌面运行（构建 + 启动）
npm run dev
```

打包分发：

```bash
tools/package-macos.sh   # 产出 dist/PocketCOM.app 与 dist/PocketCOM-<版本>-macos-arm64.dmg
```

> 分发包为 ad-hoc 签名（未公证），首次打开需右键 → 打开，或执行 `xattr -cr dist/PocketCOM.app`。

## MCP 接入

在左侧面板打开 **MCP 共享开关**后，界面会显示连接 URL 与 token（可复制）。MCP 服务仅在**收发模式**运行：切到终端模式自动停服（断开全部 MCP 会话），切回且开关为开时自动重启——终端是独占交互通道，agent 不得同时写入。

Agent 侧配置示例：

```json
{
  "mcpServers": {
    "pocketcom": {
      "url": "http://127.0.0.1:7960/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

提供的 tools：`status` / `list_serial_ports` / `connect` / `disconnect` / `send` / `read` / `config_read` / `config_write`。详见 [SPEC.md](SPEC.md) §6。

## 测试

```bash
bun test test/                          # 核心层 + 桥接单测
bun test host/macos/mcp/                # MCP 集成测试（脚本化 MCP client 走真实宿主+guest 全链路，
                                        #   含终端模式门控；需先 npm run build + cargo build --release）
cargo test --release --manifest-path host/macos/Cargo.toml --bin pocketcom-host   # 宿主桥接单测（含 MCP 协议单测）

# 串口硬件回环测试（需 TX↔RX 短接的真实串口，未设环境变量时自动跳过）
POCKETCOM_LOOPBACK_PORT=/dev/cu.xxx cargo test --release \
  --manifest-path host/macos/Cargo.toml --bin pocketcom-host com::loopback -- --nocapture
```

## License

ISC
