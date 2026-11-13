import type { ProbeLogger } from "./probe-log.js";

export type KeeperSessionStatus = "waiting" | "probing" | "paused" | "disabled" | "expired";

export interface KeeperSession {
  sessionId: string;
  title: string | null;
  cwd: string;
  enabled: boolean;
  busy: boolean;
  state: KeeperSessionStatus;
  nextProbeAt: number | null;
  lastProbeAt: number | null;
  lastRealActivityAt: number;
  /** 最后一轮对话结束时间；控制器重启后据此恢复空闲计时。旧状态文件可能缺失。 */
  lastTurnEndAt?: number | null;
  hitRatio: number | null;
  error: string | null;
}

export interface ProbeResult {
  hitRatio: number | null;
}

export interface RegistryOptions {
  intervalMs: number;
  maxIdleMs: number;
  now?: () => number;
  probe: (session: KeeperSession, signal: AbortSignal) => Promise<ProbeResult>;
  onChange?: () => void;
  /** 调度与探测生命周期的诊断日志；缺省时静默。 */
  log?: ProbeLogger;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

interface MutableSession extends KeeperSession {
  probing: boolean;
  timer: NodeJS.Timeout | null;
  /** 正在执行的探测；真实回合、停止或重新开启时据此取消，避免与父会话并发。 */
  abort: AbortController | null;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, MutableSession>();
  private readonly intervalMs: number;
  private readonly maxIdleMs: number;
  private readonly now: () => number;
  private readonly probe: RegistryOptions["probe"];
  private readonly onChange: () => void;
  private readonly log: ProbeLogger;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(options: RegistryOptions) {
    this.intervalMs = options.intervalMs;
    this.maxIdleMs = options.maxIdleMs;
    this.now = options.now ?? Date.now;
    this.probe = options.probe;
    this.onChange = options.onChange ?? (() => {});
    this.log = options.log ?? (() => {});
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  enable(sessionId: string, cwd: string, title: string | null = null): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.clear(existing);
      existing.abort?.abort();
      existing.enabled = true;
      existing.busy = false;
      existing.cwd = cwd;
      existing.title = title ?? existing.title;
      existing.lastRealActivityAt = this.now();
      existing.error = null;
      existing.state = "waiting";
      this.schedule(existing);
    } else {
      const session: MutableSession = {
        sessionId,
        title,
        cwd,
        enabled: true,
        busy: false,
        state: "waiting",
        nextProbeAt: null,
        lastProbeAt: null,
        lastRealActivityAt: this.now(),
        lastTurnEndAt: null,
        hitRatio: null,
        error: null,
        probing: false,
        timer: null,
        abort: null,
      };
      this.sessions.set(sessionId, session);
      this.schedule(session);
    }
    this.onChange();
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.clear(session);
    session.abort?.abort();
    session.enabled = false;
    session.busy = false;
    session.state = "disabled";
    session.nextProbeAt = null;
    this.onChange();
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      this.clear(session);
      session.abort?.abort();
      session.enabled = false;
      session.busy = false;
      session.state = "disabled";
      session.nextProbeAt = null;
    }
    this.onChange();
  }

  turnStarted(sessionId: string, title: string | null = null): void {
    const session = this.sessions.get(sessionId);
    if (!session?.enabled) return;
    this.clear(session);
    // 真实回合开始时取消在飞探测，避免父会话与保活 fork 同时请求。
    session.abort?.abort();
    session.busy = true;
    if (title) session.title = title;
    session.lastRealActivityAt = this.now();
    session.error = null;
    this.onChange();
  }

  turnEnded(sessionId: string, title: string | null = null): void {
    const session = this.sessions.get(sessionId);
    if (!session?.enabled) return;
    session.busy = false;
    if (title) session.title = title;
    // 保活失败的 paused 会被这里清掉；不记一笔就无法区分"探测成功"和"失败后重启计时"。
    if (session.error !== null) {
      this.log("probe.paused-cleared", { sessionId, error: session.error });
    }
    session.error = null;
    session.lastTurnEndAt = this.now();
    if (!session.probing) this.schedule(session);
    this.onChange();
  }

  /** 短码 on 与 hook 都可能拿不到标题；用 Web 会话信息补齐，供面板展示。 */
  setTitle(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.title === title) return;
    session.title = title;
    this.onChange();
  }

  snapshot(): KeeperSession[] {
    return [...this.sessions.values()].map(({ timer: _timer, probing: _probing, abort: _abort, ...session }) => ({ ...session }));
  }

  restore(sessions: KeeperSession[]): void {
    const due: MutableSession[] = [];
    for (const session of sessions) {
      this.sessions.set(session.sessionId, {
        ...session,
        busy: false,
        probing: false,
        timer: null,
        abort: null,
      });
      if (!session.enabled) continue;
      const restored = this.sessions.get(session.sessionId)!;
      restored.state = "waiting";
      const deadline = this.restoreDeadline(restored, session.busy);
      if (deadline === null) {
        this.schedule(restored);
      } else if (deadline <= this.now()) {
        due.push(restored);
      } else {
        this.schedule(restored, deadline);
      }
    }
    for (const session of due) void this.runProbe(session);
    this.onChange();
  }

  /**
   * 恢复后的下次探测时间。优先沿用持久化的 nextProbeAt；该字段在探测或回合开始
   * 时会被清空，此时若控制器退出前已结束回合，按最后一轮结束时间加间隔推算；
   * 崩溃时正在回合中则无法确定空闲起点，保守地从恢复时刻重新计时。
   */
  private restoreDeadline(session: MutableSession, wasBusy: boolean): number | null {
    if (typeof session.nextProbeAt === "number" && Number.isFinite(session.nextProbeAt)) {
      return session.nextProbeAt;
    }
    if (!wasBusy && typeof session.lastTurnEndAt === "number" && Number.isFinite(session.lastTurnEndAt)) {
      return session.lastTurnEndAt + this.intervalMs;
    }
    return null;
  }

  private schedule(session: MutableSession, deadline = this.now() + this.intervalMs): void {
    this.clear(session);
    if (!session.enabled || session.busy || session.probing) return;
    session.nextProbeAt = deadline;
    session.state = "waiting";
    session.timer = this.setTimer(() => this.runProbe(session), Math.max(0, deadline - this.now()));
    session.timer.unref();
  }

  private clear(session: MutableSession): void {
    if (session.timer) this.clearTimer(session.timer);
    session.timer = null;
    session.nextProbeAt = null;
  }

  private async runProbe(session: MutableSession): Promise<void> {
    this.clear(session);
    if (!session.enabled || session.busy || session.probing) return;
    const idleMs = this.now() - session.lastRealActivityAt;
    if (idleMs >= this.maxIdleMs) {
      session.enabled = false;
      session.state = "expired";
      this.log("probe.expired", { sessionId: session.sessionId, idleMs, maxIdleMs: this.maxIdleMs });
      this.onChange();
      return;
    }
    session.probing = true;
    session.state = "probing";
    const controller = new AbortController();
    session.abort = controller;
    const startedAt = this.now();
    this.log("probe.start", { sessionId: session.sessionId, idleMs, intervalMs: this.intervalMs });
    this.onChange();
    try {
      const result = await this.probe(session, controller.signal);
      if (controller.signal.aborted) {
        this.log("probe.aborted", { sessionId: session.sessionId, durationMs: this.now() - startedAt });
        return;
      }
      session.lastProbeAt = this.now();
      session.hitRatio = result.hitRatio;
      session.error = null;
      this.log("probe.ok", {
        sessionId: session.sessionId,
        durationMs: session.lastProbeAt - startedAt,
        hitRatio: result.hitRatio,
      });
    } catch (error) {
      // 主动取消（真实回合开始、off、stop）不算保活失败。
      if (!controller.signal.aborted) {
        session.error = error instanceof Error ? error.message : String(error);
        this.log("probe.error", {
          sessionId: session.sessionId,
          durationMs: this.now() - startedAt,
          error: session.error,
        });
      } else {
        this.log("probe.aborted", { sessionId: session.sessionId, durationMs: this.now() - startedAt });
      }
    } finally {
      session.probing = false;
      session.abort = null;
      if (!session.enabled) {
        session.state = "disabled";
      } else if (session.error) {
        session.state = "paused";
      } else if (!session.busy) {
        this.schedule(session);
      } else {
        session.state = "waiting";
      }
      // 结算后的调度点是排查"下一次保活为何提前/推迟"的唯一线索。
      this.log("probe.settled", {
        sessionId: session.sessionId,
        state: session.state,
        nextProbeAt: session.nextProbeAt,
        busy: session.busy,
      });
      this.onChange();
    }
  }
}
