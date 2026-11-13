import { readSessionDiagnostics, type SessionDiagnostics } from "./diagnostics.js";
import type { ForkMap } from "./fork-map.js";
import type { ProbeLogger } from "./probe-log.js";
import type { PromptResult } from "./probe.js";
import { errorMessage } from "./safety.js";
import type { WebClient } from "./web-client.js";

export interface WebKeepaliveOptions {
  parentSessionId: string;
  diagnosticsHome: string;
  forkMap?: ForkMap;
  /** 步骤级诊断日志：记录了用量与失败原因，控制器账面之外唯一的事后依据。 */
  log?: ProbeLogger;
  /** 真实回合开始、off/stop 时取消在飞保活。 */
  signal?: AbortSignal;
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
  const log = options.log ?? (() => {});
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
    options.signal?.throwIfAborted();
    report.forkSessionId = await client.forkSession(options.parentSessionId, "Cache Keeper");
    log("keepalive.fork.created", {
      parentSessionId: options.parentSessionId,
      forkSessionId: report.forkSessionId,
    });
    await options.forkMap?.record(report.forkSessionId, options.parentSessionId);
    options.signal?.throwIfAborted();
    const promptStartedAt = Date.now();
    report.forkPrompt = await client.prompt(report.forkSessionId, KEEPALIVE_PROMPT, options.signal);
    log("keepalive.prompt", {
      forkSessionId: report.forkSessionId,
      stopReason: report.forkPrompt.stopReason,
      unsafeToolActivity: report.forkPrompt.unsafeToolActivity,
      durationMs: Date.now() - promptStartedAt,
    });
    if (report.forkPrompt.unsafeToolActivity) {
      throw new Error("保活 fork 请求了工具调用，已取消");
    }
    const [parentDiagnostics, forkDiagnostics] = await readBothDiagnostics(options, report.forkSessionId);
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
    // 保活是否划算全看这里：cacheHitRatio 低说明空闲期已经把前缀放凉了。
    log("keepalive.usage", {
      forkSessionId: report.forkSessionId,
      wireFound: forkDiagnostics.wireFound,
      inputOther: forkDiagnostics.usage.inputOther,
      inputCacheRead: forkDiagnostics.usage.inputCacheRead,
      inputCacheCreation: forkDiagnostics.usage.inputCacheCreation,
      output: forkDiagnostics.usage.output,
      cacheHitRatio: forkDiagnostics.usage.cacheHitRatio,
      usageRecords: forkDiagnostics.usageRecords.length,
      parentRequests: parentDiagnostics.requests.length,
      forkRequests: forkDiagnostics.requests.length,
      prefixHashesMatch: report.prefixHashesMatch,
    });
    report.status = "ok";
  } catch (error) {
    report.error = errorMessage(error);
    log("keepalive.error", {
      parentSessionId: options.parentSessionId,
      forkSessionId: report.forkSessionId,
      error: report.error,
    });
  } finally {
    if (report.forkSessionId) {
      try {
        await client.deleteSession(report.forkSessionId);
        report.deletedSessionIds.push(report.forkSessionId);
        await options.forkMap?.forget(report.forkSessionId);
        log("keepalive.fork.deleted", { forkSessionId: report.forkSessionId });
      } catch (error) {
        report.error = `删除保活 fork 失败：${errorMessage(error)}`;
        log("keepalive.delete-failed", {
          forkSessionId: report.forkSessionId,
          error: report.error,
        });
      }
    }
  }
  if (report.error !== null) report.status = "error";
  return report;
}

/**
 * 两侧诊断分开取：任一失败都要留下是父会话还是 fork 出的问题，
 * 否则只能看到"保活失败"而不知道丢在哪一步。
 */
async function readBothDiagnostics(
  options: WebKeepaliveOptions,
  forkSessionId: string,
): Promise<[SessionDiagnostics, SessionDiagnostics]> {
  const log = options.log ?? (() => {});
  const read = async (sessionId: string, role: "parent" | "fork"): Promise<SessionDiagnostics> => {
    try {
      return await readSessionDiagnostics(options.diagnosticsHome, sessionId);
    } catch (error) {
      log("keepalive.diagnostics-failed", {
        role,
        sessionId,
        error: errorMessage(error),
      });
      throw error;
    }
  };
  return Promise.all([read(options.parentSessionId, "parent"), read(forkSessionId, "fork")]);
}
