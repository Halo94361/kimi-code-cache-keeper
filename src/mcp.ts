import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { controllerCommand, controllerStatus } from "./hooks/control.js";

const TOOLS = [
  {
    name: "on",
    description: "开启指定 Kimi Code 会话的缓存保活",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cwd: { type: "string" },
        title: { type: "string" },
      },
      required: ["sessionId", "cwd"],
    },
  },
  {
    name: "off",
    description: "停止指定会话的保活并取消后续计时",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  {
    name: "status",
    description: "查询全部保活会话的状态、倒计时和缓存命中率",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "now",
    description: "立即对指定会话执行一次 fork 保活",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cwd: { type: "string" },
        title: { type: "string" },
      },
      required: ["sessionId", "cwd"],
    },
  },
  {
    name: "stop",
    description: "停止全部会话的缓存保活",
    inputSchema: { type: "object", properties: {} },
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
      serverInfo: { name: "cache-keeper", version: "0.1.0" },
    });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: TOOLS });
  if (method.startsWith("notifications/")) return null;
  if (method !== "tools/call") return error(id, -32601, `未知方法：${method}`);

  const name = params?.["name"];
  const args = params?.["arguments"] as Record<string, unknown> | undefined;
  if (typeof name !== "string" || !args) return error(id, -32602, "缺少工具名称或参数");
  const sessionId = typeof args["sessionId"] === "string" ? args["sessionId"] : "";
  const cwd = typeof args["cwd"] === "string" ? args["cwd"] : "";
  const title = typeof args["title"] === "string" ? args["title"] : null;
  try {
    if (name === "status") return result(id, toolResult(await controllerStatus(home)));
    if (name === "stop") {
      const discovery = await import("./hooks/control.js").then((module) => module.controllerStopAll(home));
      return result(id, toolResult(discovery));
    }
    if (!sessionId || ((name === "on" || name === "now") && !cwd)) {
      return error(id, -32602, "该工具需要有效的 sessionId 和 cwd");
    }
    if (name !== "on" && name !== "off" && name !== "now") {
      return error(id, -32602, `未知工具：${name}`);
    }
    const value = await controllerCommand(home, name, sessionId, cwd, title);
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
