import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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

async function ensureController(home: string): Promise<Discovery> {
  let discovery = await readDiscovery(home);
  if (discovery && await reachable(discovery)) return discovery;

  const controllerPath = fileURLToPath(new URL("../controller.js", import.meta.url));
  spawn(process.execPath, [controllerPath, "--home", home], {
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

export async function controllerCommand(
  home: string,
  action: "on" | "off" | "now",
  sessionId: string,
  cwd: string,
  title: string | null,
): Promise<unknown> {
  const discovery = await ensureController(home);
  const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${discovery.controlToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cwd, title }),
    signal: AbortSignal.timeout(5_000),
  });
  return response.json();
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

export async function controllerStatus(home: string): Promise<unknown> {
  const discovery = await ensureController(home);
  const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/status`, {
    headers: { Authorization: `Bearer ${discovery.controlToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  return response.json();
}

export async function controllerStopAll(home: string): Promise<unknown> {
  const discovery = await ensureController(home);
  const response = await fetch(`http://127.0.0.1:${discovery.port}/v1/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${discovery.controlToken}` },
    signal: AbortSignal.timeout(5_000),
  });
  return response.json();
}
