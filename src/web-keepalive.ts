import { readSessionDiagnostics, type SessionDiagnostics } from "./diagnostics.js";
import type { PromptResult } from "./probe.js";
import { errorMessage } from "./safety.js";
import type { WebClient } from "./web-client.js";

export interface WebKeepaliveOptions {
  parentSessionId: string;
  diagnosticsHome: string;
}

export interface WebKeepaliveReport {
  status: "ok" | "error";
  forkSessionId: string | null;
  forkPrompt: PromptResult | null;
  diagnostics: SessionDiagnostics | null;
  prefixHashesMatch: boolean | null;
  deletedSessionIds: string[];
  error: string | null;
}

const KEEPALIVE_PROMPT = "这是一次缓存保活请求。请只回复“1”，不要调用任何工具。";

export async function runWebKeepaliveOnce(
  client: WebClient,
  options: WebKeepaliveOptions,
): Promise<WebKeepaliveReport> {
  const report: WebKeepaliveReport = {
    status: "error",
    forkSessionId: null,
    forkPrompt: null,
    diagnostics: null,
    prefixHashesMatch: null,
    deletedSessionIds: [],
    error: null,
  };
  try {
    report.forkSessionId = await client.forkSession(options.parentSessionId, "Cache Keeper");
    report.forkPrompt = await client.prompt(report.forkSessionId, KEEPALIVE_PROMPT);
    if (report.forkPrompt.unsafeToolActivity) {
      throw new Error("保活 fork 请求了工具调用，已取消");
    }
    const [parentDiagnostics, forkDiagnostics] = await Promise.all([
      readSessionDiagnostics(options.diagnosticsHome, options.parentSessionId),
      readSessionDiagnostics(options.diagnosticsHome, report.forkSessionId),
    ]);
    report.diagnostics = forkDiagnostics;
    const parentRequest = parentDiagnostics.requests.at(-1);
    const forkRequest = forkDiagnostics.requests.at(-1);
    if (parentRequest && forkRequest) {
      report.prefixHashesMatch =
        parentRequest.provider === forkRequest.provider &&
        parentRequest.model === forkRequest.model &&
        parentRequest.systemPromptHash === forkRequest.systemPromptHash &&
        parentRequest.toolsHash === forkRequest.toolsHash;
    }
    report.status = "ok";
  } catch (error) {
    report.error = errorMessage(error);
  } finally {
    if (report.forkSessionId) {
      try {
        await client.deleteSession(report.forkSessionId);
        report.deletedSessionIds.push(report.forkSessionId);
      } catch (error) {
        report.error = `删除保活 fork 失败：${errorMessage(error)}`;
      }
    }
  }
  if (report.error !== null) report.status = "error";
  return report;
}
