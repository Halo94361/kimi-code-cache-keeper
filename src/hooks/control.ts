import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface Discovery {
  apiVersion: number;
  port: number;
  controlToken: string;
}

function discoveryPath(home: string): string {
  return `${home}/cache-keeper/controller.json`;
}

async function readDiscovery(home: string): Promise<Discovery | null> {
  try {
    const value = JSON.parse(await readFile(discoveryPath(home), "utf8")) as Discovery;
    return value.apiVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

async function reachable(discovery: Discovery): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/status`, {
      headers: { Authorization: `Bearer ${discovery.controlToken}` },
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 控制器脚本定位：打包后 mcp.js 在 dist/ 根、hooks 在 dist/hooks/，
 * 固定按 ../ 上跳一级在 mcp.js 里会解析到插件根目录导致拉起失败；
 * 按文件存在性在两种布局中选择。
 */
export function resolveControllerScript(metaUrl: string): string {
  const dir = dirname(fileURLToPath(metaUrl));
  const candidates = [join(dir, "controller.js"), join(dir, "..", "controller.js")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[1]!;
}

/**
 * 拉起控制器用的 node：部分客户端把插件 MCP 托管在自身二进制进程里，
 * process.execPath 指向 kimi 而非 node，直接拿来执行脚本会报 unknown command，
 * 这种情形回退到 PATH 中的 node。
 */
export function resolveNodeRuntime(execPath: string = process.execPath): string {
  return /(^|[\\/])node(\.exe)?$/i.test(execPath) ? execPath : "node";
}

async function ensureController(home: string): Promise<Discovery> {
  let discovery = await readDiscovery(home);
  if (discovery && await reachable(discovery)) return discovery;

  const controllerPath = resolveControllerScript(import.meta.url);
  spawn(resolveNodeRuntime(), [controllerPath, "--home", home], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    discovery = await readDiscovery(home);
    if (discovery && await reachable(discovery)) return discovery;
  }
  throw new Error("无法启动缓存保活控制器");
}

export async function controllerActivity(
  home: string,
  event: string,
  sessionId: string,
  cwd: string,
  title: string | null,
): Promise<void> {
  const discovery = await ensureController(home);
  await fetch(`http://127.0.0.1:${discovery.port}/v1/sessions/${encodeURIComponent(sessionId)}/activity`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${discovery.controlToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event, cwd, title }),
    signal: AbortSignal.timeout(5_000),
  });
}

export async function controllerCodeStatus(home: string, code: string): Promise<unknown> {
  const discovery = await ensureController(home);
  const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/code/${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${discovery.controlToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  return response.json();
}

export async function controllerCodeCommand(
  home: string,
  action: "on" | "off",
  code: string,
): Promise<unknown> {
  const discovery = await ensureController(home);
  const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/code/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${discovery.controlToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(5_000),
  });
  return response.json();
}
