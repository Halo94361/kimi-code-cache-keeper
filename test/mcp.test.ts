import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startController } from "../src/controller.js";
import { handleMcp } from "../src/mcp.js";
import { SessionCodes } from "../src/session-codes.js";

test("MCP 初始化并暴露三个短码控制工具", async () => {
  const init = await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, "/unused");
  assert.equal(init?.["result"] !== undefined, true);
  const list = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "/unused");
  const result = list?.["result"] as { tools: { name: string }[] };
  assert.deepEqual(result.tools.map((tool) => tool.name), ["on", "off", "status"]);
});

test("MCP 工具使用会话短码，缺少短码直接拒绝", async () => {
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
    const code = await new SessionCodes(home, { random: () => 1375 })
      .injectOnPrompt("a", "/workspace", new Date());
    assert.equal(code, "111213757");
    const call = (id: number, name: string, args: Record<string, unknown>) => handleMcp({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }, home);
    await call(1, "on", { code });
    const status = await call(2, "status", { code });
    const value = status?.["result"] as {
      structuredContent: { session: { sessionId: string; hitRatio: number | null } };
    };
    assert.equal(value.structuredContent.session.sessionId, "a");
    assert.equal(value.structuredContent.session.hitRatio, null);
    assert.equal(probes, 0);
    await call(3, "off", { code });

    const missing = await call(4, "on", {});
    assert.equal((missing?.["error"] as { code: number }).code, -32602);
  } finally {
    await controller.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP 未知方法返回 JSON-RPC 错误", async () => {
  const response = await handleMcp({ jsonrpc: "2.0", id: 9, method: "unknown" }, "/unused");
  assert.equal((response?.["error"] as { code: number }).code, -32601);
});
