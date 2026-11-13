import type { PromptResult } from "./probe.js";
import { SessionOwnership } from "./session-ownership.js";

export interface WebClientOptions {
  baseUrl: string;
  token: string;
}

export class WebClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly ownership = new SessionOwnership();

  constructor(options: WebClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
  }

  private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? null : JSON.stringify(body),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const payload = await response.json();
    if (payload.code !== 0) {
      throw new Error(payload.msg ?? `Web API 返回 ${payload.code}`);
    }
    return payload.data;
  }

  async forkSession(parentSessionId: string, title: string): Promise<string> {
    const result = await this.request("POST", `/api/v1/sessions/${parentSessionId}:fork`, {
      title,
      metadata: { cacheKeeper: true },
    });
    this.ownership.trackCreatedFork(parentSessionId, result.id);
    return result.id;
  }

  /** 读取会话真实忙碌状态与标题；标题用于面板展示，忙碌状态用于校正漏掉的 TurnStarted/Stop hook。 */
  async sessionInfo(sessionId: string): Promise<{ busy: boolean; title: string | null }> {
    const data = await this.request("GET", `/api/v1/sessions/${sessionId}`);
    return {
      busy: data?.busy === true || data?.main_turn_active === true,
      title: typeof data?.title === "string" && data.title.length > 0 ? data.title : null,
    };
  }

  async sessionBusy(sessionId: string): Promise<boolean> {
    return (await this.sessionInfo(sessionId)).busy;
  }

  /** 端点健康检查；Web 重启后端口会变，据此判断是否应丢弃当前地址并重新发现。 */
  async healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/healthz`, { signal: AbortSignal.timeout(2_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async prompt(sessionId: string, text: string, signal?: AbortSignal): Promise<PromptResult> {
    signal?.throwIfAborted();
    const ws = new WebSocket(`${this.baseUrl.replace(/^http/, "ws")}/api/v1/ws`, [
      `kimi-code.bearer.${this.token}`,
    ]);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      ws.onopen = () => resolveOpen();
      ws.onerror = () => rejectOpen(new Error("WebSocket 连接失败"));
    });
    ws.send(JSON.stringify({
      type: "subscribe_v2",
      id: "1",
      payload: { session_id: sessionId, transcript: { "*": "off" } },
    }));
    let unsafeToolActivity = false;
    let promptId: string | null = null;
    try {
      const accepted = await this.request("POST", `/api/v1/sessions/${sessionId}/prompts`, {
        permission_mode: "manual",
        content: [{ type: "text", text }],
      }, signal);
      promptId = accepted.prompt_id;
      signal?.throwIfAborted();
      const stopReason = await new Promise<PromptResult["stopReason"]>((resolveTurn, rejectTurn) => {
        let timer: NodeJS.Timeout | undefined;
        let settled = false;
        let onAbort: (() => void) | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
        };
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          action();
        };
        onAbort = () => {
          void this.abort(sessionId, promptId).catch(() => undefined);
          settle(() => rejectTurn(new Error("保活已取消")));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => settle(() => rejectTurn(new Error("等待保活 turn 结束超时"))), 120_000);
        ws.onmessage = (event) => {
          const frame = JSON.parse(String(event.data));
          if (frame.type.startsWith("tool.call")) {
            unsafeToolActivity = true;
            void this.abort(sessionId, promptId).catch(() => {});
          }
          if (frame.type === "turn.ended") {
            settle(() => resolveTurn(frame.reason === "completed" ? "end_turn" : "cancelled"));
          }
          if (frame.type === "event.session.work_changed" && frame.payload?.main_turn_active === false) {
            settle(() => resolveTurn(frame.payload.last_turn_reason === "completed" ? "end_turn" : "cancelled"));
          }
        };
      });
      return { stopReason, usage: null, unsafeToolActivity };
    } finally {
      ws.close();
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.ownership.assertCanDelete(sessionId);
    await this.request("POST", `/api/v1/sessions/${sessionId}:delete`, {});
  }

  private async abort(sessionId: string, promptId: string | null): Promise<void> {
    if (!promptId) return;
    await this.request("POST", `/api/v1/sessions/${sessionId}/prompts/${promptId}:abort`, {});
  }
}
