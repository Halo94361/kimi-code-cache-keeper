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
  probe: (session: KeeperSession) => Promise<ProbeResult>;
  onChange?: () => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

interface MutableSession extends KeeperSession {
  probing: boolean;
  pendingNow: boolean;
  timer: NodeJS.Timeout | null;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, MutableSession>();
  private readonly intervalMs: number;
  private readonly maxIdleMs: number;
  private readonly now: () => number;
  private readonly probe: RegistryOptions["probe"];
  private readonly onChange: () => void;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(options: RegistryOptions) {
    this.intervalMs = options.intervalMs;
    this.maxIdleMs = options.maxIdleMs;
    this.now = options.now ?? Date.now;
    this.probe = options.probe;
    this.onChange = options.onChange ?? (() => {});
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  enable(sessionId: string, cwd: string, title: string | null = null): void {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.clear(existing);
      existing.enabled = true;
      existing.busy = false;
      existing.pendingNow = false;
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
        hitRatio: null,
        error: null,
        probing: false,
        pendingNow: false,
        timer: null,
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
    session.enabled = false;
    session.busy = false;
    session.pendingNow = false;
    session.state = "disabled";
    session.nextProbeAt = null;
    this.onChange();
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      this.clear(session);
      session.enabled = false;
      session.busy = false;
      session.pendingNow = false;
      session.state = "disabled";
      session.nextProbeAt = null;
    }
    this.onChange();
  }

  turnStarted(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.enabled) return;
    this.clear(session);
    session.busy = true;
    session.lastRealActivityAt = this.now();
    session.error = null;
    this.onChange();
  }

  turnEnded(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.enabled) return;
    session.busy = false;
    session.error = null;
    if (session.pendingNow && !session.probing) {
      session.pendingNow = false;
      void this.runProbe(session);
    } else if (!session.probing) {
      this.schedule(session);
    }
    this.onChange();
  }

  probeNow(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.enabled || session.probing) return;
    if (session.busy) {
      session.pendingNow = true;
      this.onChange();
      return;
    }
    void this.runProbe(session);
  }

  snapshot(): KeeperSession[] {
    return [...this.sessions.values()].map(({ timer: _timer, probing: _probing, pendingNow: _pendingNow, ...session }) => ({ ...session }));
  }

  restore(sessions: KeeperSession[]): void {
    for (const session of sessions) {
      this.sessions.set(session.sessionId, {
        ...session,
        busy: false,
        probing: false,
        pendingNow: false,
        timer: null,
      });
      if (session.enabled) {
        const restored = this.sessions.get(session.sessionId)!;
        restored.state = "waiting";
        restored.nextProbeAt = null;
        this.schedule(restored);
      }
    }
    this.onChange();
  }

  private schedule(session: MutableSession): void {
    this.clear(session);
    if (!session.enabled || session.busy || session.probing) return;
    session.nextProbeAt = this.now() + this.intervalMs;
    session.state = "waiting";
    session.timer = this.setTimer(() => this.runProbe(session), this.intervalMs);
    session.timer.unref();
  }

  private clear(session: MutableSession): void {
    if (session.timer) this.clearTimer(session.timer);
    session.timer = null;
    session.nextProbeAt = null;
  }

  private async runProbe(session: MutableSession): Promise<void> {
    this.clear(session);
    session.pendingNow = false;
    if (!session.enabled || session.busy || session.probing) return;
    if (this.now() - session.lastRealActivityAt >= this.maxIdleMs) {
      session.enabled = false;
      session.state = "expired";
      this.onChange();
      return;
    }
    session.probing = true;
    session.state = "probing";
    this.onChange();
    try {
      const result = await this.probe(session);
      session.lastProbeAt = this.now();
      session.hitRatio = result.hitRatio;
      session.error = null;
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
    } finally {
      session.probing = false;
      if (!session.enabled) {
        session.state = "disabled";
      } else if (session.error) {
        session.state = "paused";
      } else if (!session.busy) {
        this.schedule(session);
      }
      this.onChange();
    }
  }
}
