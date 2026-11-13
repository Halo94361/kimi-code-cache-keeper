import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { controllerCodeCommand, controllerCodeStatus } from "./hooks/control.js";

/**
 * 版本号由构建脚本从 package.json 注入为 __VERSION__；直接跑 TS 源码
 * （测试、开发）时没有注入，回退到占位值。
 */
const packageVersion = (): string =>
  typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

const CODE_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string", description: "本会话短码，由 cache-keeper 在会话首次提交时注入" },
  },
  required: ["code"],
};

const TOOLS = [
  {
    name: "on",
    description: "开启本会话的缓存保活",
    inputSchema: CODE_SCHEMA,
  },
  {
    name: "off",
    description: "停止本会话的缓存保活并取消后续计时",
    inputSchema: CODE_SCHEMA,
  },
  {
    name: "status",
    description: "查询本会话的保活状态、倒计时和缓存命中率",
    inputSchema: CODE_SCHEMA,
  },
];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcRequest["id"], value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export async function handleMcp(request: JsonRpcRequest, home: string): Promise<Record<string, unknown> | null> {
  const { id, method, params } = request;
  if (method === "initialize") {
    return result(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "cache-keeper", version: packageVersion() },
    });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: TOOLS });
  if (method.startsWith("notifications/")) return null;
  if (method !== "tools/call") return error(id, -32601, `未知方法：${method}`);

  const name = params?.["name"];
  const args = params?.["arguments"] as Record<string, unknown> | undefined;
  if (typeof name !== "string" || !args) return error(id, -32602, "缺少工具名称或参数");
  const code = typeof args["code"] === "string" ? args["code"] : "";
  if (code.trim().length === 0) return error(id, -32602, "缺少会话短码 code");
  try {
    if (name === "status") return result(id, toolResult(await controllerCodeStatus(home, code)));
    if (name !== "on" && name !== "off") {
      return error(id, -32602, `未知工具：${name}`);
    }
    const value = await controllerCodeCommand(home, name, code);
    return result(id, toolResult(value));
  } catch (cause) {
    return result(id, {
      content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
      isError: true,
    });
  }
}

async function main(): Promise<void> {
  const home = process.env.KIMI_CODE_HOME;
  if (!home) throw new Error("MCP 缺少 KIMI_CODE_HOME");
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const request = JSON.parse(line) as JsonRpcRequest;
      const response = await handleMcp(request, home);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
