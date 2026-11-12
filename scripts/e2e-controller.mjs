import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const home = resolve(".probe-home");
const workspace = resolve(home, "workspace");
await mkdir(workspace, { recursive: true });

const web = spawn("kimi", ["web", "--no-open", "--port", "58928"], {
  env: { ...process.env, KIMI_CODE_HOME: home },
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
});
let controller;

let sessionId = null;
let token;
let baseUrl;
let discovery;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const payload = await response.json();
  if (payload.code !== 0) throw new Error(`${method} ${path}：${payload.msg ?? payload.code}`);
  return payload.data;
}

async function control(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${discovery.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${discovery.controlToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.status === "error") {
    throw new Error(payload.error ?? `控制器返回 ${response.status}`);
  }
  return payload;
}

async function waitForTurn(sessionId) {
  const ws = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/v1/ws`, [
    `kimi-code.bearer.${token}`,
  ]);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.onopen = resolveOpen;
    ws.onerror = () => rejectOpen(new Error("WebSocket 连接失败"));
  });
  const completed = new Promise((resolveTurn, rejectTurn) => {
    const timeoutMs = Number(process.env.CACHE_KEEPER_E2E_TURN_TIMEOUT_MS ?? 120_000);
    const timer = setTimeout(() => rejectTurn(new Error("等待 turn.ended 超时")), timeoutMs);
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (process.env.CACHE_KEEPER_E2E_DEBUG === "1") console.error(frame);
      if (frame.type === "turn.ended" || (frame.type === "event.session.work_changed" && frame.payload?.main_turn_active === false)) {
        clearTimeout(timer);
        resolveTurn(frame);
      }
    };
  });
  ws.send(JSON.stringify({ type: "subscribe_v2", id: "1", payload: { session_id: sessionId, transcript: { "*": "off" } } }));
  try {
    await completed;
  } finally {
    ws.close();
  }
}

try {
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error("kimi web 启动超时")), 30_000);
    web.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/(http:\/\/127\.0\.0\.1:\d+)[^\s"']*#token=([^\s"']+)/);
      if (match) {
        clearTimeout(timer);
        resolveReady({ url: match[1], token: match[2] });
      }
    });
    web.once("error", rejectReady);
  });
  const readyResult = await ready;
  baseUrl = readyResult.url;
  token = readyResult.token;
  controller = spawn(process.execPath, ["dist/controller.js", "--home", home], {
    env: {
      ...process.env,
      CACHE_KEEPER_INTERVAL_MS: "1000",
      ...(process.env.CACHE_KEEPER_E2E_USE_ENV_WEB === "1"
        ? { KIMI_WEB_URL: baseUrl, KIMI_WEB_TOKEN: token }
        : {}),
    },
    stdio: process.env.CACHE_KEEPER_ACP_DEBUG === "1" ? ["ignore", "ignore", "inherit"] : "ignore",
    windowsHide: true,
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      discovery = JSON.parse(await readFile(resolve(home, "cache-keeper", "controller.json"), "utf8"));
      await control("GET", "/v1/status");
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(discovery, "控制器未生成 discovery 文件");

  const session = await api("POST", "/api/v1/sessions", { metadata: { cwd: workspace } });
  sessionId = session.id;
  const turn = waitForTurn(sessionId);
  await api("POST", `/api/v1/sessions/${sessionId}/prompts`, {
    model: "kimi-code/kimi-for-coding",
    permission_mode: "manual",
    content: [{ type: "text", text: "这是一次隔离测试，请只回复“1”，不要调用任何工具。" }],
  });
  await turn;

  await control("POST", `/v1/sessions/${sessionId}/on`, { cwd: workspace, title: "控制器验收" });

  let status;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    status = await control("GET", "/v1/status");
    if (status.sessions.find((session) => session.sessionId === sessionId)?.lastProbeAt) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const kept = status.sessions.find((session) => session.sessionId === sessionId);
  assert(kept?.lastProbeAt, "没有完成保活");
  assert(kept.hitRatio > 0.8, `缓存命中率异常：${kept.hitRatio}`);

  const children = await api("GET", `/api/v1/sessions/${sessionId}/children`);
  if (process.env.CACHE_KEEPER_E2E_DEBUG === "1") console.error(children);
  assert(Array.isArray(children.items) && children.items.length === 0, "保活 fork 未被永久删除");

  const messages = await api("GET", `/api/v1/sessions/${sessionId}/messages?page_size=50`);
  const serializedMessages = JSON.stringify(messages.items);
  const userMessages = messages.items.filter((message) =>
    message.role === "user" && JSON.stringify(message.content).includes("这是一次隔离测试"));
  assert(!serializedMessages.includes("这是一次缓存保活请求"), "父会话包含保活 prompt");
  assert(userMessages.length === 1, `父会话原始用户消息数量异常：${userMessages.length}`);

  await control("POST", `/v1/sessions/${sessionId}/off`, {});
  status = await control("GET", "/v1/status");
  assert(status.sessions.find((session) => session.sessionId === sessionId)?.enabled === false, "off 后当前会话仍处于启用状态");

  console.log(JSON.stringify({
    status: "ok",
    sessionId,
    hitRatio: kept.hitRatio,
    parentUserMessages: userMessages.length,
    stopped: true,
  }, null, 2));
} finally {
  if (baseUrl && token && sessionId) {
    try { await api("POST", `/api/v1/sessions/${sessionId}:archive`, {}); } catch {}
  }
  if (controller) controller.kill();
  web.kill();
}
