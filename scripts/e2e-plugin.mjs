import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const home = resolve(".probe-home");
const workspace = resolve(home, "workspace");
const packageDir = resolve(".e2e-plugin");
await rm(packageDir, { recursive: true, force: true });
await mkdir(packageDir, { recursive: true });
await Promise.all([
  cp("kimi.plugin.json", resolve(packageDir, "kimi.plugin.json")),
  cp("commands", resolve(packageDir, "commands"), { recursive: true }),
  cp("dist", resolve(packageDir, "dist"), { recursive: true }),
]);
await mkdir(workspace, { recursive: true });

const child = spawn("kimi", ["web", "--no-open", "--port", "58927"], {
  env: { ...process.env, KIMI_CODE_HOME: home },
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
});

let sessionId = null;
let installed = false;
let server;
let token;
let baseUrl;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(`${method} ${path} 失败：${payload.msg ?? payload.code}`);
  }
  return payload.data;
}

async function waitForTurn(sessionId) {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/v1/ws`, [
    `kimi-code.bearer.${token}`,
  ]);
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("WebSocket 连接超时")), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolveOpen();
    };
    ws.onerror = () => rejectOpen(new Error("WebSocket 连接失败"));
  });
  const result = new Promise((resolveTurn, rejectTurn) => {
    const timer = setTimeout(() => rejectTurn(new Error("等待 turn.ended 超时")), 120_000);
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type === "turn.ended" || (frame.type === "event.session.work_changed" && frame.payload?.main_turn_active === false)) {
        clearTimeout(timer);
        resolveTurn(frame);
      }
    };
  });
  ws.send(JSON.stringify({ type: "subscribe_v2", id: "1", payload: { session_id: sessionId, transcript: { "*": "off" } } }));
  try {
    return await result;
  } finally {
    ws.close();
  }
}

try {
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("kimi web 启动超时")), 30_000);
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      const match = text.match(/(http:\/\/127\.0\.0\.1:\d+)[^\s"']*#token=([^\s"']+)/);
      if (match) {
        clearTimeout(timer);
        resolveReady({ url: match[1], token: match[2] });
      }
    });
    child.once("error", rejectReady);
  });
  const readyResult = await ready;
  baseUrl = readyResult.url;
  token = readyResult.token;

  const source = process.env.CACHE_KEEPER_E2E_SOURCE ?? packageDir;
  const plugin = await api("POST", "/api/v1/plugins", { source });
  installed = true;
  assert(plugin.commandCount === 4, `命令数量异常：${plugin.commandCount}`);
  assert(plugin.hookCount === 7, `hook 数量异常：${plugin.hookCount}`);
  assert(plugin.mcpServerCount === 1, `MCP 数量异常：${plugin.mcpServerCount}`);
  assert(!plugin.hasErrors, "插件安装报告了错误");

  console.log(JSON.stringify({
    status: "ok",
    plugin: {
      id: plugin.id,
      commandCount: plugin.commandCount,
      hookCount: plugin.hookCount,
      mcpServerCount: plugin.mcpServerCount,
    },
    installed: true,
  }, null, 2));
} finally {
  if (baseUrl && token) {
    try {
      if (sessionId) await api("POST", `/api/v1/sessions/${sessionId}:archive`, {});
      if (installed) await api("POST", "/api/v1/plugins/cache-keeper:remove", {});
    } catch {
      // 测试环境只读归档和插件记录清理失败时保留现场，主错误优先
    }
  }
  child.kill();
}
