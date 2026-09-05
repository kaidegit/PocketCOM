// MCP 集成测试（M4，SPEC §6 / §7）：真实宿主二进制 + 真实 guest（构建产物）
// + 脚本化 MCP client（原生 fetch，Streamable HTTP）。覆盖：
//   认证（401）→ initialize（会话 id）→ tools/list → status → connect（bun
//   TCP echo）→ send → read（[RX]/[SYS] 前缀断言）→ force 语义 → disconnect
//   → config_read/write 白名单；
//   终端模式门控（SPEC §6.1）：脚本点击切到终端模式 → MCP 停服（连接拒绝 /
//   mcp-suspended）→ 点回收发模式 → 自动重启可用。
//
// 前置：`npm run build`（dist/pocketcom-main.js）+ `cargo build --release`
// （host/macos/target/release/pocketcom-host）。产物缺失时整体跳过（CI 在
// 前置步骤产出两者）。
import { describe, beforeAll, afterAll, test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
    `[mcp-e2e] skipped: build host + app first (missing ${HOST_BIN} or ${APP_JS})`,
  );
}

// 终端/收发 SegCtrl 点击坐标（960x640，默认串口参数块布局，layout 表推导：
// mode 块 top=351，控件 y=47+351+20=418，高 28 → 中心 432；右半 = 终端）。
const MODE_TERMINAL = "198,432";
const MODE_TRANSFER = "74,432";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface HostHandle {
  child: ChildProcess;
  port: number;
  token: string;
}

function spawnHost(opts: { clicks?: string[]; quitTicks: number }): HostHandle {
  const port = 20000 + (process.pid % 20000);
  const token = "test-token-123";
  const cfgDir = mkdtempSync(join(tmpdir(), "pocketcom-mcp-"));
  const cfgPath = join(cfgDir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      version: 1,
      language: "en",
      theme: "dark",
      mcp: { enabled: true, port, token },
    }),
  );
  const args = [
    "--app", "pocketcom-main",
    "--title", "PocketCOM",
    "--viewport", "960x640",
    "--density", "2",
    "--native-text",
    "--companions", "pocketcom",
    "--editor",
    "--quit-after", String(opts.quitTicks),
    ...(opts.clicks ?? []).flatMap((c, i) => ["--click", `${c}@${300 + i * 300}`]),
  ];
  const child = spawn(HOST_BIN, args, {
    env: { ...process.env, POCKETJS_DIST: DIST, POCKETCOM_CONFIG: cfgPath, RUST_LOG: "warn" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d: Buffer) => process.env.MCP_E2E_TRACE && process.stderr.write(d));
  return { child, port, token };
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

interface RpcResp {
  status: number;
  headers: Headers;
  json: any;
}

async function rpc(
  port: number,
  token: string,
  body: unknown,
  session?: string,
): Promise<RpcResp> {
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
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pocketcom-e2e", version: "0" } },
  });
  expect(r.status).toBe(200);
  expect(r.json.result.protocolVersion).toBe("2025-06-18");
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

function echoServer(port: number): { stop: () => void; connections: number[] } {
  const connections: number[] = [];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(socket) {
        connections.push(1);
        void socket;
      },
      data(socket, _bytes) {
        socket.write(_bytes); // echo
      },
    },
  });
  return { stop: () => server.stop(true), connections };
}

describe.skipIf(!READY)("MCP e2e: protocol + tools over the live host", () => {
  let h: HostHandle;
  let echo: ReturnType<typeof echoServer> | null = null;

  beforeAll(async () => {
    h = spawnHost({ quitTicks: 6000 });
    await waitReady(h.port);
    echo = echoServer(31000 + (process.pid % 20000));
  }, 60_000);

  afterAll(() => {
    h?.child.kill("SIGKILL");
    echo?.stop();
  });

  test("auth: missing / wrong token → 401", async () => {
    const noAuth = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: "{}",
    });
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: "Bearer nope",
      },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  test("tools/list exposes the §6.3 tool set", async () => {
    const session = await initialize(h.port, h.token);
    const r = await rpc(h.port, h.token, { jsonrpc: "2.0", id: 2, method: "tools/list" }, session);
    expect(r.status).toBe(200);
    const names = (r.json.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual([
      "status", "list_serial_ports", "connect", "disconnect", "send", "read",
      "config_read", "config_write",
    ]);
  });

  test("connect → send → read → force → disconnect → config (full session)", async () => {
    const session = await initialize(h.port, h.token);
    const echoPort = 31000 + (process.pid % 20000);

    const st0 = await tool(h.port, h.token, session, 10, "status");
    expect(st0.isError).toBe(false);
    const st0v = JSON.parse(st0.text);
    expect(st0v.state).toBe("DISCONNECTED");

    const conn = await tool(h.port, h.token, session, 11, "connect", {
      type: "tcp", host: "127.0.0.1", port: echoPort,
    });
    expect(conn.isError).toBe(false);
    expect(conn.text).toContain(`tcp 127.0.0.1:${echoPort}`);
    await sleep(400);

    const st1 = await tool(h.port, h.token, session, 12, "status");
    expect(JSON.parse(st1.text).state).toBe("CONNECTED");

    const sent = await tool(h.port, h.token, session, 13, "send", {
      data: "hello-mcp", encoding: "utf8", appendNewline: false,
    });
    expect(sent.text).toBe("sent 9 byte(s)");
    await sleep(500); // echo 回包 → 帧合流 → 总线 → MCP 读缓冲（逐帧 relay）

    const read1 = await tool(h.port, h.token, session, 14, "read");
    expect(read1.isError).toBe(false);
    expect(read1.text).toContain("[RX] hello-mcp"); // SPEC §6.4 行格式
    expect(read1.text).toContain("[SYS]");          // 连接 sys 事件可见

    const read2 = await tool(h.port, h.token, session, 15, "read");
    expect(read2.text).toBe("(no data)"); // drain 语义

    // 已有连接默认拒绝；force 先断开（SPEC §6.3）
    const refused = await tool(h.port, h.token, session, 16, "connect", {
      type: "tcp", host: "127.0.0.1", port: echoPort,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("already-connected");
    expect(refused.text).toContain("force:true");

    const forced = await tool(h.port, h.token, session, 17, "connect", {
      type: "tcp", host: "127.0.0.1", port: echoPort, force: true,
    });
    expect(forced.isError).toBe(false);
    await sleep(300);

    const hex = await tool(h.port, h.token, session, 18, "send", {
      data: "01 FF", encoding: "hex", appendNewline: true,
    });
    expect(hex.text).toBe("sent 4 byte(s)");

    const disc = await tool(h.port, h.token, session, 19, "disconnect");
    expect(disc.text).toBe("disconnected");
    const st2 = await tool(h.port, h.token, session, 20, "status");
    expect(JSON.parse(st2.text).state).toBe("DISCONNECTED");

    // config_read：白名单快照，token 永不出现（SPEC §6.3/§5.3）
    const cfg = await tool(h.port, h.token, session, 21, "config_read");
    const cfgv = JSON.parse(cfg.text);
    expect(cfgv.language).toBe("en");
    expect(JSON.stringify(cfgv)).not.toContain("test-token-123");

    // config_write：白名单补丁生效（fontSize 12 → 16）
    const patched = await tool(h.port, h.token, session, 22, "config_write", {
      config: { fontSize: 16 },
    });
    expect(patched.isError).toBe(false);
    const cfg2 = JSON.parse((await tool(h.port, h.token, session, 23, "config_read")).text);
    expect(cfg2.fontSize).toBe(16);

    // 未知工具 → isError
    const unknown = await tool(h.port, h.token, session, 24, "nope");
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("unknown-tool");

    // DELETE 会话 → 204；随后旧会话 404
    const del = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${h.token}`, "mcp-session-id": session },
    });
    expect(del.status).toBe(204);
    const stale = await rpc(h.port, h.token, { jsonrpc: "2.0", id: 30, method: "ping" }, session);
    expect(stale.status).toBe(404);
  });
});

describe.skipIf(!READY)("MCP e2e: terminal-mode gate (SPEC §6.1)", () => {
  // 脚本点击：@300（≈5s）切终端 → 停服；@600（≈10s）点回收发 → 自动重启。
  let h: HostHandle;
  let t0 = 0;

  beforeAll(async () => {
    t0 = Date.now();
    h = spawnHost({ quitTicks: 6000, clicks: [MODE_TERMINAL, MODE_TRANSFER] });
    await waitReady(h.port);
  }, 60_000);

  afterAll(() => {
    h?.child.kill("SIGKILL");
  });

  test("terminal mode stops the server; switching back restarts it", async () => {
    const session = await initialize(h.port, h.token);

    // 5s 后（tick 300 已过）服务应已停：连接拒绝，或竞态窗口内返回 mcp-suspended。
    while (Date.now() - t0 < 6000) await sleep(200);
    let stopped = false;
    try {
      const r = await tool(h.port, h.token, session, 40, "send", { data: "x", encoding: "utf8" });
      stopped = r.isError && r.text.includes("mcp-suspended");
    } catch {
      stopped = true; // ECONNREFUSED：server listener 已关
    }
    expect(stopped).toBe(true);

    // 10s 后（tick 600 已过）切回收发模式：自动重启，重新 initialize 可用。
    while (Date.now() - t0 < 12000) await sleep(200);
    const session2 = await initialize(h.port, h.token);
    const st = await tool(h.port, h.token, session2, 41, "status");
    expect(st.isError).toBe(false);
    expect(JSON.parse(st.text).state).toBe("DISCONNECTED");
  }, 60_000);
});
