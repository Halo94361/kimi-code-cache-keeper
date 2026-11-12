import type * as acp from "@agentclientprotocol/sdk";

export interface UsageSummary {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  cacheHitRatio: number | null;
}

export function summarizeUsage(usage: acp.Usage | null | undefined): UsageSummary | null {
  if (!usage) return null;
  const cachedReadTokens = usage.cachedReadTokens ?? 0;
  const cacheHitRatio = usage.inputTokens > 0
    ? Math.min(1, cachedReadTokens / usage.inputTokens)
    : null;
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedReadTokens,
    cachedWriteTokens: usage.cachedWriteTokens ?? 0,
    cacheHitRatio,
  };
}
