import { readSessionDiagnostics, type SessionDiagnostics } from "./diagnostics.js";
import type { ForkMap } from "./fork-map.js";
import type { ProbeDriver, PromptResult } from "./probe.js";
import { assertSessionLifecycleCapabilities, errorMessage } from "./safety.js";

export interface KeepaliveOptions {
  parentSessionId: string;
  cwd: string;
  diagnosticsHome?: string;
  forkMap?: ForkMap;
  /** 真实回合开始、off/stop 时取消在飞保活。 */
  signal?: AbortSignal;
}

export interface KeepaliveReport {
  status: "ok" | "error";
  parentSessionId: string;
  forkSessionId: string | null;
  forkPrompt: PromptResult | null;
  diagnostics: SessionDiagnostics | null;
  prefixHashesMatch: boolean | null;
  deletedSessionIds: string[];
  error: string | null;
}

const KEEPALIVE_PROMPT = "这是一次缓存保活请求。请只回复“1”，不要调用任何工具。";

export async function runKeepaliveOnce(
  driver: ProbeDriver,
  options: KeepaliveOptions,
): Promise<KeepaliveReport> {
  const report: KeepaliveReport = {
    status: "error",
    parentSessionId: options.parentSessionId,
    forkSessionId: null,
    forkPrompt: null,
    diagnostics: null,
    prefixHashesMatch: null,
    deletedSessionIds: [],
    error: null,
  };

  let onAbort: (() => void) | undefined;
  try {
    options.signal?.throwIfAborted();
    const init = await driver.initialize();
    assertSessionLifecycleCapabilities(init);
    await driver.authenticate();
    options.signal?.throwIfAborted();

    const fork = await driver.forkSession(options.parentSessionId, options.cwd);
    report.forkSessionId = fork.sessionId;
    await options.forkMap?.record(fork.sessionId, options.parentSessionId);
    onAbort = () => {
      void driver.cancelPrompt(fork.sessionId).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    options.signal?.throwIfAborted();
    const resumedFork = await driver.resumeSession(fork.sessionId, options.cwd);
    await driver.setManualMode(fork.sessionId, resumedFork.modes ?? fork.modes);
    report.forkPrompt = await driver.prompt(fork.sessionId, KEEPALIVE_PROMPT);
    if (report.forkPrompt.unsafeToolActivity) {
      throw new Error("保活 fork 请求了工具调用或权限，已取消");
    }

    if (options.diagnosticsHome) {
      const [parentDiagnostics, forkDiagnostics] = await Promise.all([
        readSessionDiagnostics(options.diagnosticsHome, options.parentSessionId),
        readSessionDiagnostics(options.diagnosticsHome, fork.sessionId),
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
    }
    report.status = "ok";
  } catch (error) {
    if (process.env.CACHE_KEEPER_ACP_DEBUG === "1") console.error(error);
    report.error = errorMessage(error);
  } finally {
    if (onAbort !== undefined) options.signal?.removeEventListener("abort", onAbort);
    if (report.forkSessionId) {
      try {
        await driver.deleteSession(report.forkSessionId);
        report.deletedSessionIds.push(report.forkSessionId);
        await options.forkMap?.forget(report.forkSessionId);
      } catch (error) {
        report.deletedSessionIds = [];
        report.error = `清理保活 fork 失败：${errorMessage(error)}`;
      }
    }
  }
  if (report.error !== null) report.status = "error";
  return report;
}
