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
  async sessionInfo(sessionId: string): Promise<{ busy: boolean; title: string | null; lastTurnReason: string | null }> {
    const data = await this.request("GET", `/api/v1/sessions/${sessionId}`);
    return {
      busy: data?.busy === true || data?.main_turn_active === true,
      title: typeof data?.title === "string" && data.title.length > 0 ? data.title : null,
      // 回合结束的真实原因：WS 事件可能缺失或字段不同，用会话详情交叉校验 cancelled
      lastTurnReason: typeof data?.last_turn_reason === "string" ? data.last_turn_reason : null,
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
    // 新版 Kimi Web 用 subscribe（session_id + agent_ids）投递 turn/item 事件，
    // 旧版用 subscribe_v2。服务端会忽略不认识的消息类型，两种都发以兼容两个版本。
    ws.send(JSON.stringify({
      type: "subscribe",
      request_id: "1",
      session_id: sessionId,
      agent_ids: ["main"],
    }));
    ws.send(JSON.stringify({
      type: "subscribe_v2",
      id: "1",
      payload: { session_id: sessionId, transcript: { "*": "off" } },
    }));
    let unsafeToolActivity = false;
    let promptId: string | null = null;
    let endReason: string | null = null;
    let settledBy: PromptResult["settledBy"] = null;
    try {
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
        // 先挂监听再发 prompt，避免 turn 结束过快时事件在 POST 返回前丢失。
        ws.onmessage = (event) => {
          let frame: Record<string, any>;
          try {
            frame = JSON.parse(String(event.data)) as Record<string, any>;
          } catch {
            return;
          }
          const payload = frame["payload"] as Record<string, any> | undefined;
          const frameSession = frame["session_id"] ?? payload?.["session_id"];
          if (typeof frameSession === "string" && frameSession !== sessionId) return;
          const type = typeof frame["type"] === "string" ? frame["type"] : "";
          // 新版协议用 item.started/ended 的 toolUse 项表示工具调用，
          // 权限请求体现在 pending_interaction；命中任一情况都取消保活。
          const item = frame["item"] as Record<string, any> | undefined;
          const pending = payload?.["pending_interaction"];
          if (
            type.startsWith("tool.call") ||
            (item !== undefined && (item["type"] === "toolUse" || item["type"] === "tool_call")) ||
            (typeof pending === "string" && pending !== "none")
          ) {
            unsafeToolActivity = true;
            void this.abort(sessionId, promptId).catch(() => {});
          }
          if (type === "turn.ended") {
            const reason = frame["reason"]
              ?? (frame["turn"] as Record<string, any> | undefined)?.["reason"]
              ?? payload?.["reason"];
            settle(() => {
              endReason = typeof reason === "string" ? reason : null;
              settledBy = "turn.ended";
              resolveTurn(reason === "completed" ? "end_turn" : "cancelled");
            });
          }
          if (type === "event.session.work_changed" && payload?.["main_turn_active"] === false) {
            const reason = payload["last_turn_reason"];
            settle(() => {
              endReason = typeof reason === "string" ? reason : null;
              settledBy = "work_changed";
              resolveTurn(reason === "completed" ? "end_turn" : "cancelled");
            });
          }
        };
        void this.request("POST", `/api/v1/sessions/${sessionId}/prompts`, {
          permission_mode: "manual",
          content: [{ type: "text", text }],
        }, signal).then((accepted) => {
          promptId = accepted.prompt_id;
          if (signal?.aborted) void this.abort(sessionId, promptId).catch(() => undefined);
        }).catch((error: unknown) => {
          settle(() => rejectTurn(error instanceof Error ? error : new Error(String(error))));
        });
      });
      return { stopReason, usage: null, unsafeToolActivity, endReason, settledBy };
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
