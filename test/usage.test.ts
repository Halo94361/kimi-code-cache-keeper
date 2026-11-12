import assert from "node:assert/strict";
import test from "node:test";
import { summarizeUsage } from "../src/usage.js";

test("汇总缓存 token 并计算命中率", () => {
  const summary = summarizeUsage({
    totalTokens: 1_100,
    inputTokens: 1_000,
    outputTokens: 100,
    cachedReadTokens: 800,
    cachedWriteTokens: 100,
  });
  assert.deepEqual(summary, {
    totalTokens: 1_100,
    inputTokens: 1_000,
    outputTokens: 100,
    cachedReadTokens: 800,
    cachedWriteTokens: 100,
    cacheHitRatio: 0.8,
  });
});

test("缺失缓存字段按零处理，零输入不计算命中率", () => {
  const summary = summarizeUsage({ totalTokens: 0, inputTokens: 0, outputTokens: 0 });
  assert.equal(summary?.cachedReadTokens, 0);
  assert.equal(summary?.cachedWriteTokens, 0);
  assert.equal(summary?.cacheHitRatio, null);
});

test("没有 usage 时返回 null", () => {
  assert.equal(summarizeUsage(undefined), null);
  assert.equal(summarizeUsage(null), null);
});
