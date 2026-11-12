import assert from "node:assert/strict";
import test from "node:test";
import { parseWireDiagnostics } from "../src/diagnostics.js";

test("wire 诊断只保留请求 hash 与用量数字", () => {
  const result = parseWireDiagnostics([
    JSON.stringify({
      type: "llm.request",
      provider: "managed:kimi-code",
      model: "k3",
      systemPromptHash: "system-hash",
      toolsHash: "tools-hash",
      messageCount: 8,
    }),
    JSON.stringify({
      type: "usage.record",
      usage: { inputOther: 100, inputCacheRead: 700, inputCacheCreation: 200, output: 12 },
    }),
    JSON.stringify({ type: "context.append_message", content: "不应进入诊断" }),
    "not-json",
  ].join("\n"));
  assert.equal(result.wireFound, true);
  assert.deepEqual(result.requests, [{
    provider: "managed:kimi-code",
    model: "k3",
    systemPromptHash: "system-hash",
    toolsHash: "tools-hash",
    messageCount: 8,
  }]);
  assert.deepEqual(result.usage, {
    inputOther: 100,
    inputCacheRead: 700,
    inputCacheCreation: 200,
    output: 12,
    cacheHitRatio: 0.7,
  });
  assert.equal(JSON.stringify(result).includes("不应进入诊断"), false);
});

test("空 wire 不产生虚假的命中率", () => {
  const result = parseWireDiagnostics("");
  assert.deepEqual(result.requests, []);
  assert.equal(result.usage.cacheHitRatio, null);
});
