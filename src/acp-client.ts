import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { ProbeDriver, PromptResult, SessionDescriptor } from "./probe.js";
import { chooseSafeModeId } from "./safety.js";
import { SessionOwnership } from "./session-ownership.js";
import { summarizeUsage } from "./usage.js";

const REQUEST_TIMEOUT_MS = 120_000;

function requestOptions(): acp.SendRequestOptions {
  return { cancellationSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
}

class KimiAcpDriver implements ProbeDriver {
  private activeSessionId: string | null = null;
  private unsafeToolActivity = false;
  private cancelSent = false;
  private readonly ownership = new SessionOwnership();

  constructor(
    private readonly ctx: acp.ClientContext,
    private readonly allowCreatedParentCleanup: boolean,
  ) {}

  initialize(): Promise<acp.InitializeResponse> {
    return this.ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    }, requestOptions());
  }

  async authenticate(): Promise<void> {
    await this.ctx.request(acp.methods.agent.authenticate, { methodId: "login" }, requestOptions());
  }

  async createSession(cwd: string): Promise<SessionDescriptor> {
    const result = await this.ctx.request(acp.methods.agent.session.new, {
      cwd,
      mcpServers: [],
    }, requestOptions());
    this.ownership.trackCreatedParent(result.sessionId);
    return result;
  }

  async resumeSession(sessionId: string, cwd: string): Promise<SessionDescriptor> {
    const result = await this.ctx.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd,
    }, requestOptions());
    return { ...result, sessionId };
  }

  async forkSession(sessionId: string, cwd: string): Promise<SessionDescriptor> {
    const result = await this.ctx.request(acp.methods.agent.session.fork, {
      sessionId,
      cwd,
    }, requestOptions());
    this.ownership.trackCreatedFork(sessionId, result.sessionId);
    return result;
  }

  async setManualMode(
    sessionId: string,
    modes: acp.SessionModeState | null | undefined,
  ): Promise<void> {
    const modeId = chooseSafeModeId(modes);
    if (modes?.currentModeId === modeId) return;
    await this.ctx.request(acp.methods.agent.session.setMode, {
      sessionId,
      modeId,
    }, requestOptions());
  }

  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    this.activeSessionId = sessionId;
    this.unsafeToolActivity = false;
    this.cancelSent = false;
    try {
      const result = await this.ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      }, requestOptions());
      return {
        stopReason: result.stopReason,
        usage: summarizeUsage(result.usage),
        unsafeToolActivity: this.unsafeToolActivity,
      };
    } finally {
      this.activeSessionId = null;
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.ownership.assertCanDelete(sessionId, this.allowCreatedParentCleanup);
    await this.ctx.request(acp.methods.agent.session.delete, { sessionId }, requestOptions());
  }

  handleUpdate(params: acp.SessionNotification): void {
    if (params.sessionId !== this.activeSessionId) return;
    if (params.update.sessionUpdate !== "tool_call" && params.update.sessionUpdate !== "tool_call_update") {
      return;
    }
    this.unsafeToolActivity = true;
    this.cancelActiveTurn();
  }

  denyPermission(): acp.RequestPermissionResponse {
    this.unsafeToolActivity = true;
    this.cancelActiveTurn();
    return { outcome: { outcome: "cancelled" } };
  }

  private cancelActiveTurn(): void {
    const sessionId = this.activeSessionId;
    if (!sessionId || this.cancelSent) return;
    this.cancelSent = true;
    void this.ctx.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
  }
}

export interface KimiAcpOptions {
  home: string;
  kimiPath?: string;
  allowCreatedParentCleanup?: boolean;
  readOnlyParent?: boolean;
}

export async function withKimiAcp<T>(
  options: KimiAcpOptions,
  operation: (driver: ProbeDriver) => Promise<T>,
): Promise<T> {
  const child = spawn(options.kimiPath ?? "kimi", ["acp"], {
    env: {
      ...process.env,
      KIMI_CODE_HOME: options.home,
      ...(options.readOnlyParent === true ? { KIMI_CODE_SESSION_LOCK: "0" } : {}),
    },
    stdio: ["pipe", "pipe", process.env.CACHE_KEEPER_ACP_DEBUG === "1" ? "inherit" : "ignore"],
    windowsHide: true,
  });
  child.on("error", () => {});

  const input = Writable.toWeb(child.stdin!);
  const output = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  let driver: KimiAcpDriver | undefined;

  try {
    return await acp.client({ name: "kimi-code-cache-keeper-probe" })
      .onRequest(acp.methods.client.session.requestPermission, () => driver?.denyPermission() ?? {
        outcome: { outcome: "cancelled" },
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        driver?.handleUpdate(ctx.params);
      })
      .connectWith(acp.ndJsonStream(input, output), async (ctx) => {
        driver = new KimiAcpDriver(ctx, options.allowCreatedParentCleanup === true);
        return operation(driver);
      });
  } finally {
    child.stdin.end();
    if (!child.killed) child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}
