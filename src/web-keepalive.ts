import { ownUsageDiagnostics, readSessionDiagnostics, type SessionDiagnostics, type UsageDiagnostic } from "./diagnostics.js";
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
  /** 首次读不到 fork 自有 usage 时的轮询总时长（毫秒），默认 8000。 */
  usageFlushWaitMs?: number;
}

export interface WebKeepaliveReport {
  status: "ok" | "error";
  forkSessionId: string | null;
  forkPrompt: PromptResult | null;
  diagnostics: SessionDiagnostics | null;
  /** 这次保活自身的用量（已剔除 fork 继承的父会话历史）；缺失时为 null。 */
  ownUsage: UsageDiagnostic | null;
  prefixHashesMatch: boolean | null;
  deletedSessionIds: string[];
  error: string | null;
}

const KEEPALIVE_PROMPT = "不要思考，不要调用工具，只回复“1”。";

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
    ownUsage: null,
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
      endReason: report.forkPrompt.endReason ?? null,
      settledBy: report.forkPrompt.settledBy ?? null,
      unsafeToolActivity: report.forkPrompt.unsafeToolActivity,
      durationMs: Date.now() - promptStartedAt,
    });
    if (report.forkPrompt.unsafeToolActivity) {
      throw new Error("保活 fork 请求了工具调用，已取消");
    }
    // WS 的 reason 可能缺失或与详情不一致；以会话详情的 last_turn_reason 为准，
    // 避免把已经完成的回合记成 cancelled。
    if (report.forkPrompt.stopReason !== "end_turn") {
      const detail = await client.sessionInfo(report.forkSessionId).catch(() => null);
      if (detail && !detail.busy && detail.lastTurnReason === "completed") {
        log("keepalive.prompt-reconciled", {
          forkSessionId: report.forkSessionId,
          wsReason: report.forkPrompt.endReason ?? null,
          settledBy: report.forkPrompt.settledBy ?? null,
          lastTurnReason: detail.lastTurnReason,
        });
        report.forkPrompt.stopReason = "end_turn";
      }
    }
    const [parentDiagnostics, forkDiagnostics] = await readWithFlushPoll(options, report.forkSessionId);
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
    // fork 的 wire 继承了父会话全部历史，累计值等于会话总账；自有记录才是这次保活的真实开销。
    const inheritedUsageRecords = parentDiagnostics.usageRecords.length;
    const ownUsageRecords = forkDiagnostics.usageRecords.slice(inheritedUsageRecords);
    const ownUsage = ownUsageDiagnostics(parentDiagnostics, forkDiagnostics);
    report.ownUsage = ownUsage;
    log("keepalive.usage", {
      forkSessionId: report.forkSessionId,
      wireFound: forkDiagnostics.wireFound,
      inputOther: forkDiagnostics.usage.inputOther,
      inputCacheRead: forkDiagnostics.usage.inputCacheRead,
      inputCacheCreation: forkDiagnostics.usage.inputCacheCreation,
      output: forkDiagnostics.usage.output,
      cacheHitRatio: forkDiagnostics.usage.cacheHitRatio,
      usageRecords: forkDiagnostics.usageRecords.length,
      inheritedUsageRecords,
      ownUsageRecords: ownUsageRecords.length,
      ownInputOther: ownUsage.inputOther,
      ownInputCacheRead: ownUsage.inputCacheRead,
      ownOutput: ownUsage.output,
      ownCacheHitRatio: ownUsage.cacheHitRatio,
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

/**
 * usage.record 由 CLI 在回合结束后异步落盘，早于它写完就删 fork 会永久丢掉这次用量。
 * 因此删除前在窗口内轮询 fork 的 wire，读到自有记录即停。
 */
async function readWithFlushPoll(
  options: WebKeepaliveOptions,
  forkSessionId: string,
): Promise<[SessionDiagnostics, SessionDiagnostics]> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.usageFlushWaitMs ?? 8_000);
  let pair = await readBothDiagnostics(options, forkSessionId);
  let attempts = 1;
  while (pair[1].usageRecords.length <= pair[0].usageRecords.length && Date.now() < deadline) {
    await delay(500, options.signal);
    if (options.signal?.aborted) break;
    attempts += 1;
    try {
      const next = await readBothDiagnostics(options, forkSessionId);
      if (next[1].usageRecords.length >= pair[1].usageRecords.length) pair = next;
    } catch {
      // 索引或 wire 可能正在写入，本轮读失败不影响继续轮询
    }
  }
  // 轮询过、或最终仍没有自有记录时都要留痕：后者是"这轮可能空转"的唯一证据
  const missing = pair[1].usageRecords.length <= pair[0].usageRecords.length;
  if (attempts > 1 || missing) {
    (options.log ?? (() => {}))("keepalive.usage-poll", {
      forkSessionId,
      attempts,
      waitedMs: Date.now() - startedAt,
      parentRecords: pair[0].usageRecords.length,
      forkRecords: pair[1].usageRecords.length,
    });
  }
  return pair;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
