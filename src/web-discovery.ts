import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

interface WebEndpoint {
  baseUrl: string;
  token: string;
}

interface InstanceRecord {
  host?: string;
  port?: number;
  heartbeat_at?: number;
}

async function tokenFromLog(home: string): Promise<string | null> {
  try {
    const text = await readFile(join(home, "logs", "kimi-code.log"), "utf8");
    const matches = [...text.matchAll(/#token=([^\s"']+)/g)];
    return matches.at(-1)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function loadToken(home: string): Promise<string | null> {
  try {
    const token = (await readFile(join(home, "server.token"), "utf8")).trim();
    if (token) return token;
  } catch {
    // server.token 不存在时回退到启动日志
  }
  return tokenFromLog(home);
}

export async function discoverWebRuntime(home: string): Promise<WebEndpoint> {
  const token = await loadToken(home);
  if (!token) {
    throw new Error("未找到当前 Web 实例的 token；请先启动 kimi web");
  }
  let instances: InstanceRecord[] = [];
  try {
    const files = (await readdir(join(home, "server", "instances"))).filter((file) => file.endsWith(".json"));
    instances = await Promise.all(files.map(async (file) => {
      try {
        return JSON.parse(await readFile(join(home, "server", "instances", file), "utf8")) as InstanceRecord;
      } catch {
        return {} as InstanceRecord;
      }
    }));
  } catch {
    // 没有实例目录时按未发现运行实例处理
  }
  instances.sort((a, b) => (b.heartbeat_at ?? 0) - (a.heartbeat_at ?? 0));
  for (const instance of instances) {
    if (!instance.host || !instance.port) continue;
    const baseUrl = `http://${instance.host}:${instance.port}`;
    try {
      const response = await fetch(`${baseUrl}/api/v1/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return { baseUrl, token };
    } catch {
      // 过期实例记录直接跳过
    }
  }
  throw new Error("没有发现正在运行的 kimi web 实例；请先启动 kimi web");
}
