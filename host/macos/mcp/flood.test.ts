// 大流量收发 e2e（SPEC §3.3/§3.5）：真实宿主 + loopback 连接，经 MCP send
// 灌入两相流量洪峰——
//   Phase A：400 条高频小帧（~60B/条，逐条 RPC，无间隔）；
//   Phase B：6 × 48KiB 大字节突发（合计 288KiB > 总线环形缓冲 256KiB，
//             必然触发逐出/丢帧检测路径）。
// 功能断言：全部 send 成功、rxBytes === txBytes（回环对称）、洪峰后连接与
// MCP 服务仍存活、渲染管线持续出帧（退出收据）；另在洪峰后落 3 张窗口截图，
// 供人工/agent 检查接收框渲染（行重叠/换行/滚动条贴底/前缀着色/状态栏计数）。
//
// 前置：`npm run build` + `cargo build --release`（产物缺失整体跳过）。
// 截图目录默认 mkdtemp，可用 POCKETCOM_FLOOD_SHOT_DIR 指定；测试输出会打印。
// 截图依赖会话有屏幕录制权限且显示器已唤醒（docs/e2e.md 常见坑 6）；无权限
// 会话（远程 agent/CI）里 PNG 断言降级为警告跳过，功能断言不受影响。
import { describe, beforeAll, afterAll, test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 本文件位于 <root>/host/macos/mcp/ → 从文件路径上溯 4 级到仓库根。
const ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const HOST_BIN = join(ROOT, "host/macos/target/release/pocketcom-host");
const DIST = join(ROOT, "dist");
const APP_JS = join(DIST, "pocketcom-main.js");
const READY = existsSync(HOST_BIN) && existsSync(APP_JS);
if (!READY) {
  console.warn(
    `[flood-e2e] skipped: build host + app first (missing ${HOST_BIN} or ${APP_JS})`,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

interface FloodHost {
  child: ChildProcess;
  port: number;
  token: string;
  shotDir: string;
  stdout: () => string;
  stderr: () => string;
}

function spawnFloodHost(): FloodHost {
  const port = 41000 + (process.pid % 5000);
  const token = "flood-token-456";
  const cfgDir = mkdtempSync(join(tmpdir(), "pocketcom-flood-cfg-"));
  writeFileSync(
    join(cfgDir, "config.json"),
    JSON.stringify({
      version: 1,
      language: "en",
      theme: "dark",
      mcp: { enabled: true, port, token },
    }),
  );
  const shotDir =
    process.env.POCKETCOM_FLOOD_SHOT_DIR ?? mkdtempSync(join(tmpdir(), "pocketcom-flood-shots-"));
  // 截图时刻：洪峰（wall ~10s 内完成）落定后的三个稳态帧（tick≈60Hz 虚拟时钟）
  const shots = [900, 1500, 2000].flatMap((t) => [
    "--screenshot",
    `${join(shotDir, `flood-t${t}.png`)}@${t}`,
  ]);
  const args = [
    "--app", "pocketcom-main",
    "--title", "PocketCOM",
    "--viewport", "960x640",
    "--density", "2",
    "--native-text",
    "--companions", "pocketcom",
    "--editor",
    ...shots,
    "--quit-after", "2200",
  ];
  let stdout = "";
  let stderr = "";
  const child = spawn(HOST_BIN, args, {
    env: { ...process.env, POCKETJS_DIST: DIST, POCKETCOM_CONFIG: join(cfgDir, "config.json"), RUST_LOG: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString(); // 截图失败行在 stderr（宿主 eprintln!）
    if (process.env.MCP_E2E_TRACE) process.stderr.write(d);
  });
  return { child, port, token, shotDir, stdout: () => stdout, stderr: () => stderr };
}

async function waitReady(port: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", signal: AbortSignal.timeout(500) });
      return; // any HTTP response (even 401/415) means the server is up
    } catch {
      await sleep(300);
    }
  }
  throw new Error(`MCP server on 127.0.0.1:${port} did not come up within 30s`);
}

async function rpc(
  port: number,
  token: string,
  body: unknown,
  session?: string,
): Promise<{ status: number; headers: Headers; json: any }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (session) headers["mcp-session-id"] = session;
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await resp.text();
  return { status: resp.status, headers: resp.headers, json: text === "" ? null : JSON.parse(text) };
}

async function initialize(port: number, token: string): Promise<string> {
  const r = await rpc(port, token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pocketcom-flood", version: "0" } },
  });
  expect(r.status).toBe(200);
  const session = r.headers.get("mcp-session-id");
  expect(session).toBeTruthy();
  await rpc(port, token, { jsonrpc: "2.0", method: "notifications/initialized" }, session!);
  return session!;
}

async function tool(
  port: number, token: string, session: string, id: number, name: string, args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string }> {
  const r = await rpc(port, token, {
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name, arguments: args },
  }, session);
  expect(r.status).toBe(200);
  const result = r.json.result;
  return { isError: result.isError === true, text: result.content[0].text as string };
}

/** Phase A 小帧内容：编号 + 定长填充，60B/条。 */
function smallPayload(i: number): string {
  return `FLOOD-${String(i).padStart(4, "0")}:${"abcdefghij".repeat(5)}`.slice(0, 60);
}

/** Phase B 突发内容：正好 48KiB 的可辨识 ASCII 纹样。 */
function burstPayload(k: number): string {
  const tag = `BURST-${k}:`;
  const body = "0123456789ABCDEF".repeat(Math.ceil((48 * 1024 - tag.length) / 16));
  return (tag + body).slice(0, 48 * 1024);
}

const SMALL_N = 400;
const BURST_N = 6;
const TOTAL_BYTES = SMALL_N * 60 + BURST_N * 48 * 1024;

describe.skipIf(!READY)("flood e2e: high-volume traffic over loopback", () => {
  let h: FloodHost;

  beforeAll(async () => {
    h = spawnFloodHost();
    console.log(`[flood-e2e] screenshots → ${h.shotDir}`);
    await waitReady(h.port);
  }, 60_000);

  afterAll(() => {
    h?.child.kill("SIGKILL");
  });

  test("message flood + byte burst: counters symmetric, host survives", async () => {
    const session = await initialize(h.port, h.token);

    const conn = await tool(h.port, h.token, session, 10, "connect", { type: "loopback" });
    expect(conn.isError).toBe(false);

    // Phase A：400 条小帧洪峰（逐条 await，等价 agent 全速灌入）
    let id = 100;
    const t0 = Date.now();
    for (let i = 0; i < SMALL_N; i++) {
      const r = await tool(h.port, h.token, session, id++, "send", {
        data: smallPayload(i), encoding: "utf8", appendNewline: false,
      });
      expect(r.isError).toBe(false);
      expect(r.text).toBe("sent 60 byte(s)");
    }
    const phaseAms = Date.now() - t0;

    // Phase B：6 × 48KiB 突发（合计 288KiB > 环形缓冲 256KiB，触发逐出）
    for (let k = 0; k < BURST_N; k++) {
      const r = await tool(h.port, h.token, session, id++, "send", {
        data: burstPayload(k), encoding: "utf8", appendNewline: false,
      });
      expect(r.isError).toBe(false);
      expect(r.text).toBe("sent 49152 byte(s)");
    }
    console.log(`[flood-e2e] phase A: ${SMALL_N} sends in ${phaseAms}ms`);

    await sleep(800); // 回灌 → 合流 → 总线 → 计数落定

    // 回环对称：rxBytes === txBytes === 全部注入字节（SPEC §3.5 计数语义）
    const st = await tool(h.port, h.token, session, id++, "status");
    expect(st.isError).toBe(false);
    const stv = JSON.parse(st.text);
    expect(stv.state).toBe("CONNECTED");
    expect(stv.txBytes).toBe(TOTAL_BYTES);
    expect(stv.rxBytes).toBe(TOTAL_BYTES);

    // 读缓冲仍可 drain（有界 256KiB，洪峰下丢旧属正常，应答不得出错）
    const read = await tool(h.port, h.token, session, id++, "read");
    expect(read.isError).toBe(false);

    // 宿主进程在洪峰后仍存活
    expect(h.child.exitCode).toBeNull();
  }, 90_000);

  test("rendering pipeline kept drawing; screenshots captured", async () => {
    // 等宿主按 --quit-after 2200（≈37s）自然退出
    await new Promise<void>((resolvePromise) => {
      if (h.child.exitCode !== null) return resolvePromise();
      h.child.on("exit", () => resolvePromise());
    });

    // 退出收据：M frames rendered > 0（渲染管线全程出帧，未卡死）
    expect(h.stdout()).toContain("frames rendered");
    const m = h.stdout().match(/(\d+) ticks, (\d+) frames rendered/);
    expect(m).toBeTruthy();
    expect(Number(m![2])).toBeGreaterThan(0);
    console.log(`[flood-e2e] host receipt: ${m![0]}`);

    // 截图依赖运行会话有屏幕录制权限且显示器已唤醒（docs/e2e.md 常见坑 6）。
    // 无权限/锁屏会话（远程 agent、CI）里 screencapture -l 必败——有失败行且
    // 零成功回执时降级为警告跳过文件断言，不作为产品缺陷。
    const receipts = h.stdout().match(/pocket-desktop-host: screenshot .+ \(\d+x\d+\)/g) ?? [];
    const failures = h.stderr().match(/pocket-desktop-host: screenshot .+ failed/g) ?? [];
    if (receipts.length === 0 && failures.length > 0) {
      console.warn(
        "[flood-e2e] screenshots unavailable in this session (no Screen Recording " +
          "permission or display asleep) — skipping PNG assertions",
      );
      return;
    }

    for (const t of [900, 1500, 2000]) {
      const p = join(h.shotDir, `flood-t${t}.png`);
      expect(existsSync(p)).toBe(true);
      const head = readFileSync(p).subarray(0, 4);
      expect(head.equals(PNG_MAGIC)).toBe(true);
    }
  }, 90_000);
});
