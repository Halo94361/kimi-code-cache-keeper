import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withKimiAcp } from "./acp-client.js";
import { ForkMap } from "./fork-map.js";
import { runKeepaliveOnce } from "./keepalive.js";
import { SessionCodes, SessionCodeError } from "./session-codes.js";
import { SessionRegistry, type KeeperSession, type ProbeResult } from "./session-registry.js";
import { WebClient } from "./web-client.js";
import { runWebKeepaliveOnce } from "./web-keepalive.js";
import { discoverWebRuntime } from "./web-discovery.js";

interface ControllerOptions {
  home: string;
  intervalMs?: number;
  maxIdleMs?: number;
  probe?: (session: KeeperSession, signal: AbortSignal) => Promise<ProbeResult>;
  web?: {
    baseUrl: string;
    token: string;
  };
  /** Web 状态校正周期；默认 30 秒，测试可缩短。 */
  reconcileMs?: number;
}

interface Discovery {
  apiVersion: number;
  pid: number;
  port: number;
  controlToken: string;
  updatedAt: string;
}

const STATE_VERSION = 1;

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function body(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16_384) throw new Error("请求体过大");
  }
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}

export async function startController(options: ControllerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const home = resolve(options.home);
  const dataDir = join(home, "cache-keeper");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const statePath = join(dataDir, "state.json");
  const discoveryPath = join(dataDir, "controller.json");
  const forkMap = new ForkMap(home);
  // 旧控制器留下的 fork 已不存在，启动时清空残留映射
  await forkMap.clear();
  const codes = new SessionCodes(home);
  await codes.prune().catch(() => undefined);
  const pruneTimer = setInterval(() => {
    void codes.prune().catch(() => undefined);
  }, 60 * 60_000);
  pruneTimer.unref();
  const discovered = options.probe === undefined && !options.web
    ? await discoverWebRuntime(home).catch(() => null)
    : null;
  const web = options.web ?? discovered;
  let saveQueue = Promise.resolve();
  const registry = new SessionRegistry({
    intervalMs: options.intervalMs ?? 20 * 60_000,
    maxIdleMs: options.maxIdleMs ?? 4 * 60 * 60_000,
    probe: options.probe ?? (async (session, signal) => {
      if (web) {
        const client = new WebClient(web);
        const report = await runWebKeepaliveOnce(client, {
          parentSessionId: session.sessionId,
          diagnosticsHome: home,
          forkMap,
          signal,
        });
        if (report.status !== "ok") throw new Error(report.error ?? "保活失败");
        return { hitRatio: report.diagnostics?.usage.cacheHitRatio ?? null };
      }
      const report = await withKimiAcp({ home }, (driver) => runKeepaliveOnce(driver, {
        parentSessionId: session.sessionId,
        cwd: session.cwd,
        diagnosticsHome: home,
        forkMap,
        signal,
      }));
      if (report.status !== "ok") throw new Error(report.error ?? "保活失败");
      return { hitRatio: report.diagnostics?.usage.cacheHitRatio ?? null };
    }),
    onChange: () => {
      saveQueue = saveQueue.then(async () => {
        await atomicJson(statePath, { version: STATE_VERSION, sessions: registry.snapshot() });
      }).catch(() => {});
    },
  });

  try {
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as { sessions?: KeeperSession[] };
    if (Array.isArray(persisted.sessions)) registry.restore(persisted.sessions);
  } catch {
    // 状态缺失或损坏时从空状态启动，不删除任何会话
  }

  // hook 可能漏送 TurnStarted/Stop；用 Web 会话的真实 busy 状态校正本地计时。
  const reconcileMs = options.reconcileMs ?? 30_000;
  let reconciling = false;
  const reconcile = async (): Promise<void> => {
    if (web === null || reconciling) return;
    reconciling = true;
    try {
      const client = new WebClient(web);
      for (const session of registry.snapshot()) {
        if (!session.enabled || session.state === "probing") continue;
        try {
          const info = await client.sessionInfo(session.sessionId);
          if (info.title !== null && info.title !== session.title) {
            registry.setTitle(session.sessionId, info.title);
          }
          if (info.busy && !session.busy) {
            registry.turnStarted(session.sessionId);
          } else if (!info.busy && (session.busy || session.nextProbeAt === null)) {
            registry.turnEnded(session.sessionId);
          }
        } catch {
          // 单个会话查询失败不影响其它会话，下一轮重试
        }
      }
    } finally {
      reconciling = false;
    }
  };
  const reconcileTimer = setInterval(() => {
    void reconcile();
  }, reconcileMs);
  reconcileTimer.unref();
  void reconcile();

  const token = randomBytes(32).toString("hex");
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}`) {
        json(res, 401, { status: "error", error: "未授权" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/status") {
        const sessions = registry.snapshot();
        json(res, 200, {
          status: "ok",
          enabled: sessions.some((session) => session.enabled),
          sessions: sessions.map((session) => ({
            ...session,
            nextProbeAt: iso(session.nextProbeAt),
            lastProbeAt: iso(session.lastProbeAt),
            lastRealActivityAt: iso(session.lastRealActivityAt),
          })),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/stop") {
        registry.stopAll();
        json(res, 200, { status: "ok" });
        return;
      }
      const codeAction = url.pathname.match(/^\/v1\/code\/(on|off)$/);
      if (req.method === "POST" && codeAction) {
        const action = codeAction[1] as "on" | "off";
        const input = await body(req);
        const code = typeof input["code"] === "string" ? input["code"] : "";
        const resolved = await codes.resolve(code);
        if (action === "on") registry.enable(resolved.sessionId, resolved.cwd);
        else registry.stop(resolved.sessionId);
        json(res, 200, {
          status: "ok",
          action,
          code: resolved.code,
          sessionId: resolved.sessionId,
          cwd: resolved.cwd,
        });
        return;
      }
      const codeStatus = url.pathname.match(/^\/v1\/code\/([^/]+)$/);
      if (req.method === "GET" && codeStatus) {
        const resolved = await codes.resolve(decodeURIComponent(codeStatus[1]!));
        const session = registry.snapshot().find((entry) => entry.sessionId === resolved.sessionId);
        json(res, 200, {
          status: "ok",
          code: resolved.code,
          session: session === undefined
            ? {
              sessionId: resolved.sessionId,
              title: null,
              cwd: resolved.cwd,
              enabled: false,
              busy: false,
              state: "disabled",
              nextProbeAt: null,
              lastProbeAt: null,
              lastRealActivityAt: null,
              hitRatio: null,
              error: null,
            }
            : {
              ...session,
              nextProbeAt: iso(session.nextProbeAt),
              lastProbeAt: iso(session.lastProbeAt),
              lastRealActivityAt: iso(session.lastRealActivityAt),
            },
        });
        return;
      }
      const match = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/(on|off|activity)$/);
      if (req.method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]!);
        const action = match[2];
        const input = await body(req);
        const cwd = typeof input["cwd"] === "string" ? input["cwd"] : undefined;
        const title = typeof input["title"] === "string" ? input["title"] : null;
        if (action === "on") {
          if (!cwd) throw new Error("on 需要 cwd");
          registry.enable(sessionId, cwd, title);
        } else if (action === "off") {
          registry.stop(sessionId);
        } else {
          const event = input["event"];
          if (event === "TurnStarted") registry.turnStarted(sessionId, title);
          else if (event === "SessionEnd") registry.stop(sessionId);
          else registry.turnEnded(sessionId, title);
        }
        json(res, 200, { status: "ok", action, sessionId });
        return;
      }
      json(res, 404, { status: "error", error: "未知接口" });
    } catch (error) {
      if (error instanceof SessionCodeError) {
        const status = error.kind === "invalid" ? 400 : error.kind === "unknown" ? 404 : 409;
        json(res, status, { status: "error", error: error.message });
        return;
      }
      json(res, 400, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("控制器监听失败");
  const discovery: Discovery = {
    apiVersion: 1,
    pid: process.pid,
    port: address.port,
    controlToken: token,
    updatedAt: new Date().toISOString(),
  };
  await atomicJson(discoveryPath, discovery);
  console.log(JSON.stringify({ status: "listening", port: address.port }));

  const close = async () => {
    clearInterval(pruneTimer);
    clearInterval(reconcileTimer);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    saveQueue = saveQueue.then(async () => {
      await atomicJson(statePath, { version: STATE_VERSION, sessions: registry.snapshot() });
    });
    await saveQueue;
    try {
      const current = JSON.parse(await readFile(discoveryPath, "utf8")) as Discovery;
      if (current.controlToken === token) await rm(discoveryPath, { force: true });
    } catch {
      // discovery 已不存在时不重复清理
    }
  };
  return { port: address.port, close };
}

async function main(): Promise<void> {
  const homeArg = process.argv.indexOf("--home");
  const home = homeArg >= 0
    ? process.argv[homeArg + 1]
    : process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
  if (!home) throw new Error("缺少 --home");
  const controller = await startController({
    home,
    ...(process.env.CACHE_KEEPER_INTERVAL_MS
      ? { intervalMs: Number(process.env.CACHE_KEEPER_INTERVAL_MS) }
      : {}),
    ...(process.env.CACHE_KEEPER_MAX_IDLE_MS
      ? { maxIdleMs: Number(process.env.CACHE_KEEPER_MAX_IDLE_MS) }
      : {}),
    ...(process.env.KIMI_WEB_URL && process.env.KIMI_WEB_TOKEN
      ? { web: { baseUrl: process.env.KIMI_WEB_URL, token: process.env.KIMI_WEB_TOKEN } }
      : {}),
  });
  const shutdown = () => {
    void controller.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
