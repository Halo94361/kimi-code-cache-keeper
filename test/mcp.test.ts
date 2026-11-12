import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startController } from "../src/controller.js";
import { handleMcp } from "../src/mcp.js";

test("MCP 初始化并暴露五个控制工具", async () => {
  const init = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "/unused");
  assert.equal(init?.["result"] !== undefined, true);
  const list = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "/unused");
  const result = list?.["result"] as { tools: { name: string }[] };
  assert.deepEqual(result.tools.map((tool) => tool.name), ["on", "off", "status", "now", "stop"]);
});

test("MCP 工具调用复用同一控制器接口", async () => {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-mcp-"));
  let probes = 0;
  const controller = await startController({
    home,
    intervalMs: 10_000,
    probe: async () => {
      probes += 1;
      return { hitRatio: 0.9 };
    },
  });
  try {
    const call = (id: number, name: string, args: Record<string, unknown>) => handleMcp({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }, home);
    await call(1, "on", { sessionId: "a", cwd: "/workspace" });
    await call(2, "now", { sessionId: "a", cwd: "/workspace" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await call(3, "status", {});
    const statusValue = status?.["result"] as { structuredContent: { sessions: { sessionId: string; hitRatio: number }[] } };
    assert.equal(statusValue.structuredContent.sessions[0]?.sessionId, "a");
    assert.equal(statusValue.structuredContent.sessions[0]?.hitRatio, 0.9);
    assert.equal(probes, 1);
    await call(4, "off", { sessionId: "a" });
    const stopped = await call(5, "stop", {});
    assert.equal(stopped?.["result"] !== undefined, true);
  } finally {
    await controller.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP 未知方法返回 JSON-RPC 错误", async () => {
  const response = await handleMcp({ jsonrpc: "2.0", id: 9, method: "unknown" }, "/unused");
  assert.equal((response?.["error"] as { code: number }).code, -32601);
});
