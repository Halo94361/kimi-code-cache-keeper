import type * as acp from "@agentclientprotocol/sdk";
import { readSessionDiagnostics, type SessionDiagnostics } from "./diagnostics.js";
import { assertSessionLifecycleCapabilities, errorMessage } from "./safety.js";
import { summarizeUsage, type UsageSummary } from "./usage.js";

export interface PromptResult {
  stopReason: acp.StopReason;
  usage: UsageSummary | null;
  unsafeToolActivity: boolean;
}

export interface SessionDescriptor {
  sessionId: string;
  modes?: acp.SessionModeState | null;
}

export interface ProbeDriver {
  initialize(): Promise<acp.InitializeResponse>;
  authenticate(): Promise<void>;
  createSession(cwd: string): Promise<SessionDescriptor>;
  resumeSession(sessionId: string, cwd: string): Promise<SessionDescriptor>;
  forkSession(sessionId: string, cwd: string): Promise<SessionDescriptor>;
  setManualMode(sessionId: string, modes: acp.SessionModeState | null | undefined): Promise<void>;
  prompt(sessionId: string, text: string): Promise<PromptResult>;
  /** 取消当前正在进行的 prompt；用于真实回合开始时停止在飞保活。 */
  cancelPrompt(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface ProbeOptions {
  cwd: string;
  parentSessionId?: string;
  diagnosticsHome?: string;
  resumeDelaySeconds?: number;
}

export interface ProbeReport {
  status: "ok" | "error";
  protocolVersion: number | null;
  agent: string | null;
  parentSessionId: string | null;
  forkSessionId: string | null;
  parentPrompt: PromptResult | null;
  forkPrompt: PromptResult | null;
  parentResumePrompt: PromptResult | null;
  parentDiagnostics: SessionDiagnostics | null;
  forkDiagnostics: SessionDiagnostics | null;
  prefixHashesMatch: boolean | null;
  deletedSessionIds: string[];
  cleanupErrors: string[];
  error: string | null;
}

const TEST_PROMPT = "这是一次隔离的缓存前缀测试。请只回复“1”，不要调用任何工具。";

export async function runProbe(driver: ProbeDriver, options: ProbeOptions): Promise<ProbeReport> {
  const report: ProbeReport = {
    status: "error",
    protocolVersion: null,
    agent: null,
    parentSessionId: options.parentSessionId ?? null,
    forkSessionId: null,
    parentPrompt: null,
    forkPrompt: null,
    parentResumePrompt: null,
    parentDiagnostics: null,
    forkDiagnostics: null,
    prefixHashesMatch: null,
    deletedSessionIds: [],
    cleanupErrors: [],
    error: null,
  };
  let ownsParent = false;

  try {
    const init = await driver.initialize();
    report.protocolVersion = init.protocolVersion;
    report.agent = init.agentInfo
      ? `${init.agentInfo.name}@${init.agentInfo.version}`
      : null;
    assertSessionLifecycleCapabilities(init);
    await driver.authenticate();

    const parent = report.parentSessionId
      ? await driver.resumeSession(report.parentSessionId, options.cwd)
      : await driver.createSession(options.cwd);
    report.parentSessionId = parent.sessionId;
    ownsParent = !options.parentSessionId;
    await driver.setManualMode(parent.sessionId, parent.modes);
    report.parentPrompt = await driver.prompt(parent.sessionId, TEST_PROMPT);
    if (report.parentPrompt.unsafeToolActivity) {
      throw new Error("测试父会话请求了工具调用或权限，已取消");
    }

    const fork = await driver.forkSession(parent.sessionId, options.cwd);
    report.forkSessionId = fork.sessionId;
    const resumedFork = await driver.resumeSession(fork.sessionId, options.cwd);
    await driver.setManualMode(fork.sessionId, resumedFork.modes ?? fork.modes);
    report.forkPrompt = await driver.prompt(fork.sessionId, TEST_PROMPT);
    if (report.forkPrompt.unsafeToolActivity) {
      throw new Error("保活 fork 请求了工具调用或权限，已取消");
    }

    if (options.resumeDelaySeconds !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.resumeDelaySeconds! * 1_000));
      const resumedParent = await driver.resumeSession(parent.sessionId, options.cwd);
      await driver.setManualMode(parent.sessionId, resumedParent.modes);
      report.parentResumePrompt = await driver.prompt(parent.sessionId, TEST_PROMPT);
      if (report.parentResumePrompt.unsafeToolActivity) {
        throw new Error("恢复后的父会话请求了工具调用或权限，已取消");
      }
    }

    if (options.diagnosticsHome) {
      [report.parentDiagnostics, report.forkDiagnostics] = await Promise.all([
        readSessionDiagnostics(options.diagnosticsHome, parent.sessionId),
        readSessionDiagnostics(options.diagnosticsHome, fork.sessionId),
      ]);
      const parentRequest = report.parentDiagnostics.requests.at(-1);
      const forkRequest = report.forkDiagnostics.requests.at(-1);
      if (parentRequest && forkRequest) {
        report.prefixHashesMatch =
          parentRequest.provider === forkRequest.provider &&
          parentRequest.model === forkRequest.model &&
          parentRequest.systemPromptHash === forkRequest.systemPromptHash &&
          parentRequest.toolsHash === forkRequest.toolsHash;
      }
    }
  } catch (error) {
    if (process.env.CACHE_KEEPER_ACP_DEBUG === "1") console.error(error);
    report.error = errorMessage(error);
  } finally {
    const owned = [ownsParent ? report.parentSessionId : null, report.forkSessionId]
      .filter((id): id is string => id !== null)
      .reverse();
    for (const sessionId of owned) {
      try {
        await driver.deleteSession(sessionId);
        report.deletedSessionIds.push(sessionId);
      } catch (error) {
        report.cleanupErrors.push(`${sessionId}: ${errorMessage(error)}`);
      }
    }
  }

  if (report.error === null && report.cleanupErrors.length === 0) {
    report.status = "ok";
  } else if (report.error === null) {
    report.error = "清理测试会话时发生错误";
  }
  return report;
}
