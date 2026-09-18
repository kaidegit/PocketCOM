#!/usr/bin/env node
// dev.mjs — run the built PocketCOM bundle on the PocketCOM wgpu desktop host.
// Flags derive from .pocket/macos-app/plan.json (same logic as upstream
// tools/macos.ts): viewport, density, fixed, companions.
//
// Host binary: our fork (host/macos, binary pocketcom-host — the stock
// wgpu desktop host plus the com.* serial bridge, SPEC §4.2) wins; fall back
// to the vendored stock pocket-desktop-host with a warning when the fork is
// not built yet.
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const planPath = resolve(root, ".pocket/macos-app/plan.json");

if (!existsSync(planPath)) {
  const submodulePkg = resolve(root, "vendor/pocketjs/package.json");
  if (!existsSync(submodulePkg)) {
    console.error(
      `[dev] 错误：未找到构建清单文件 (.pocket/macos-app/plan.json)\n\n` +
        `原因：PocketJS 引擎子模块尚未初始化。\n\n` +
        `解决办法：\n` +
        `  1. 初始化子模块并安装其依赖：\n` +
        `     git submodule update --init --depth 1\n` +
        `     (cd vendor/pocketjs && bun install)\n\n` +
        `  2. 编译应用前端产物：\n` +
        `     npm run build\n\n` +
        `  3. 启动开发命令：\n` +
        `     npm run dev\n`,
    );
    process.exit(1);
  }

  console.error(
    `[dev] 错误：未找到构建清单文件 (.pocket/macos-app/plan.json)\n\n` +
      `原因：应用前端代码尚未编译。\n\n` +
      `解决办法：\n` +
      `  1. 编译前端产物：\n` +
      `     npm run build\n\n` +
      `  2. 或者直接运行完整开发命令（自动编译前端并启动）：\n` +
      `     npm run dev\n\n` +
      `  提示：构建依赖 bun 环境，如遇找不到 bun 命令，请确保 ~/.bun/bin 已添加到 PATH。`,
  );
  process.exit(1);
}

let plan;
try {
  plan = JSON.parse(readFileSync(planPath, "utf8"));
} catch (err) {
  console.error(
    `[dev] 错误：解析构建清单文件 (${planPath}) 失败：${err.message}\n\n` +
      `解决办法：\n` +
      `  清单文件可能已损坏，请重新编译前端产物：\n` +
      `    npm run build\n`,
  );
  process.exit(1);
}

const appOutput = plan.app?.output ?? "pocketcom-main";
const bundleJs = resolve(root, "dist", `${appOutput}.js`);
const bundlePak = resolve(root, "dist", `${appOutput}.pak`);
if (!existsSync(bundleJs) || !existsSync(bundlePak)) {
  console.error(
    `[dev] 错误：未找到前端构建产物 (dist/${appOutput}.js 或 .pak)\n\n` +
      `解决办法：\n` +
      `  请先编译前端产物：\n` +
      `    npm run build\n`,
  );
  process.exit(1);
}

const fork = resolve(root, "host/macos/target/release/pocketcom-host");
const stock = resolve(root, "vendor/pocketjs/hosts/desktop/target/release/pocket-desktop-host");

let bin;
if (existsSync(fork)) {
  bin = fork;
} else if (existsSync(stock)) {
  bin = stock;
  console.warn(
    `[dev] 提示：PocketCOM 宿主 (host/macos/target/release/pocketcom-host) 尚未编译。\n` +
      `[dev] 当前回退至 PocketJS 官方宿主：vendor/pocketjs/hosts/desktop/target/release/pocket-desktop-host\n` +
      `[dev] 注意：com.* 串口/网络桥接在此宿主下不可用（界面将显示“桥接不可用”）。\n` +
      `[dev] 如需使用完整串口/网络功能，请先编译 PocketCOM 宿主：\n` +
      `[dev]   cargo build --release --manifest-path host/macos/Cargo.toml\n`,
  );
} else {
  console.error(
    `[dev] 错误：未找到可用的桌面宿主程序二进制文件。\n\n` +
      `已检查以下路径，均不存在：\n` +
      `  - 首选 (PocketCOM 宿主): host/macos/target/release/pocketcom-host\n` +
      `  - 备选 (PocketJS 官方宿主): vendor/pocketjs/hosts/desktop/target/release/pocket-desktop-host\n\n` +
      `解决办法：\n` +
      `  请先编译 PocketCOM 桌面宿主程序：\n` +
      `    cargo build --release --manifest-path host/macos/Cargo.toml\n`,
  );
  process.exit(1);
}

const flags = [
  "--app", plan.app.output,
  "--title", plan.app.title,
  "--viewport", `${plan.viewport.logical[0]}x${plan.viewport.logical[1]}`,
  "--density", String(plan.viewport.rasterDensity),
  ...(plan.viewport.policy === "fixed" ? ["--fixed"] : []),
  ...(plan.companions?.length ? ["--companions", plan.companions.join(",")] : []),
  // editor dialect (svc: keyboard/IME/pointer/scroll) once a companion is declared
  ...(plan.companions?.length ? ["--editor"] : []),
];

// `--` ends dev.mjs's own args; the rest are forwarded verbatim to the host
// binary (scripted UI verification flags, e.g.
// `node tools/dev.mjs -- --screenshot out.png@120 --quit-after 130`).
const sep = process.argv.indexOf("--");
const extra = sep === -1 ? [] : process.argv.slice(sep + 1);

const child = spawn(bin, [...flags, ...extra], {
  stdio: "inherit",
  env: { ...process.env, POCKETJS_DIST: resolve(root, "dist"), RUST_LOG: process.env.RUST_LOG ?? "info" },
});
child.on("error", (err) => {
  console.error(`[dev] 错误：启动桌面宿主程序失败 (${bin}):`, err.message);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
