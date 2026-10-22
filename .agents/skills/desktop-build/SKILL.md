---
name: desktop-build
description: 构建、运行、打包、安装 PocketCOM 桌面端（macOS）。当需要 npm run build、cargo 构建宿主、node tools/dev.mjs 运行、package-macos.sh 打包或安装到 /Applications 时使用。
---

# PocketCOM 桌面端构建

## 前置（首次克隆）

```sh
git submodule update --init --depth 1 vendor/pocketjs   # 桌面只需这个 submodule（公开 GitHub）
npm ci
(cd vendor/pocketjs && bun install --frozen-lockfile)
```

顺序不能反：npm 会移除本地链接包内的嵌套依赖，而编译器需要 vendor 内的 runtime bundles。
根 framework 是本地 fork（`.npmrc` 用 legacy peer resolution，因为 Vapor 的 `^3` peer 范围排除 fork 固定使用的 Vue RC）。
bun（`~/.bun/bin`）需在 PATH；wasm32 target 仅浏览器宿主/金样测试需要，桌面开发不必装。

## 构建

```sh
npm run check        # manifest 校验（bun vendor/pocketjs/tools/pocket.ts check --target macos-gpui …）
npm run build        # 输出 dist/pocketcom-main.js + dist/pocketcom-main.pak
cargo build --release --manifest-path host/macos/Cargo.toml
                     # 桌面宿主（fork 自 vendor/pocketjs/hosts/desktop + 自研 com.* 桥）
                     # 输出 host/macos/target/release/pocketcom-host；首次全量 15–25 分钟
```

`npm run check/build` 显式传入根目录 `pocket.features.json` 和 `desktop` profile；
编译器在 Vue 转换前特化 `hasAppFeature()`，按 JSON 装配终端、MCP 与五类 transport，保留完整桌面语义，输出
`dist/pocketcom-main.features.json` 供审查。仅 `implemented` 项允许写入 profile；`planned` 项只登记。类型直接从有效 profile 推导，
修改目录不需要手动同步常量/枚举，代码和文档不另设产品启停表。

`macos-gpui` 是 fork 保留的 GPUI/CoreText 宿主契约（plan identity 仍为 `macos-app`，
输出仍在 `.pocket/macos-app/`）。上游 `macos-app` 描述软件渲染宿主，不适用于 PocketCOM；
桌面 manifest 必需 `text.layout.native`，避免错误目标静默关闭原生文字。

## 运行 / 打包 / 安装

```sh
node tools/dev.mjs     # 桌面运行；默认用 fork 产物 pocketcom-host，
                       # 未构建时回退 vendor 的 pocket-desktop-host 并警告 com.* 不可用；
                       # flags 取自 .pocket/macos-app/plan.json

tools/package-macos.sh # 前置：npm run build + cargo build 产物；组装 dist/PocketCOM.app
                       # 并打 dist/PocketCOM-<版本>-macos-arm64.dmg；VERSION=x.y.z 覆盖版本号
                       # 仅 ad-hoc 签名（未公证）：首次打开需右键→打开或 xattr -cr

pnpm install:macos     # 一键：重建两份产物 + 打包 + 安装到 /Applications
tools/install-macos.sh # 单独重装既有包（ditto 整包替换 + 去 quarantine 兜底）
```

打包细节：launcher 设 `POCKETJS_DIST` 指向 `Resources/dist` 后 exec 宿主二进制；flags 从
`.pocket/macos-app/plan.json` 推导（同 dev.mjs）。不启用沙盒故无 entitlement；
`NSLocalNetworkUsageDescription`（含 zh/en InfoPlist.strings）为将来连局域网设备的授权弹窗预留，
监听 127.0.0.1 不触发。

## CI

`.github/workflows/macos.yml`（macos-latest=arm64；push main/PR/tag `v*`/手动触发）：typecheck + check +
核心单测 + 全量构建 + 打包；产物上传 artifact，`v*` tag 额外创建 Release 附 .dmg 与 .app.zip；
宿主编译用 `Swatinem/rust-cache` 缓存。

## 测试

见 skill `desktop-test`。板端（AIC）构建见 skill `aic-build`。
