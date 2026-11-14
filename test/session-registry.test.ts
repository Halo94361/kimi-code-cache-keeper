import assert from "node:assert/strict";
import test from "node:test";
import { SessionRegistry, type KeeperSession } from "../src/session-registry.js";

interface LogEntry {
  event: string;
  fields: Record<string, unknown>;
}

function harness(logs?: LogEntry[]) {
  let time = 0;
  const timers = new Map<number, { callback: () => void; dueAt: number }>();
  let sequence = 0;
  let probes = 0;
  const registry = new SessionRegistry({
    intervalMs: 100,
    maxIdleMs: 250,
    now: () => time,
    ...(logs === undefined ? {} : {
      log: (event: string, fields?: Record<string, unknown>) => {
        logs.push({ event, fields: fields ?? {} });
      },
    }),
    setTimer: ((callback: () => void, delay: number) => {
      const id = ++sequence;
      timers.set(id, { callback, dueAt: time + delay });
      return { id, unref() {} } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimer: ((timer: NodeJS.Timeout) => {
      timers.delete((timer as unknown as { id: number }).id);
    }) as typeof clearTimeout,
    probe: async () => {
      probes += 1;
      return { hitRatio: 0.9 };
    },
  });
  const advance = async (ms: number) => {
    time += ms;
    const pending = [...timers.entries()].filter(([, timer]) => timer.dueAt <= time);
    for (const [id] of pending) timers.delete(id);
    for (const [, timer] of pending) timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { registry, advance, probes: () => probes, pending: () => timers.size };
}

test("开启后倒计时保活，停止后不再触发", async () => {
  const { registry, advance, probes } = harness();
  registry.enable("a", "/workspace");
  await advance(100);
  assert.equal(probes(), 1);
  registry.stop("a");
  await advance(100);
  assert.equal(probes(), 1);
});

test("真实回合取消旧倒计时，结束后重新计算", async () => {
  const { registry, advance, probes, pending } = harness();
  registry.enable("a", "/workspace");
  await advance(50);
  registry.turnStarted("a");
  assert.equal(pending(), 0);
  await advance(100);
  assert.equal(probes(), 0);
  registry.turnEnded("a");
  await advance(99);
  assert.equal(probes(), 0);
  await advance(1);
  assert.equal(probes(), 1);
});

test("超过最大空闲时间自动退休", async () => {
  const { registry, advance, probes } = harness();
  registry.enable("a", "/workspace");
  await advance(250);
  assert.equal(probes(), 0);
  assert.equal(registry.snapshot()[0]?.state, "expired");
});

test("保活异常进入暂停，真实活动后可恢复", async () => {
  let time = 0;
  let shouldFail = true;
  const registry = new SessionRegistry({
    intervalMs: 1,
    maxIdleMs: 100,
    now: () => time,
    probe: async (_session: KeeperSession) => {
      if (shouldFail) throw new Error("mock failure");
      return { hitRatio: 0.8 };
    },
  });
  registry.enable("a", "/workspace");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(registry.snapshot()[0]?.state, "paused");
  shouldFail = false;
  registry.turnStarted("a");
  registry.turnEnded("a");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(registry.snapshot()[0]?.state, "waiting");
});

test("真实回合开始会取消在飞探测", async () => {
  let probeSignal: AbortSignal = new AbortController().signal;
  let resolveProbe: (() => void) | undefined;
  const registry = new SessionRegistry({
    intervalMs: 1,
    maxIdleMs: 1_000,
    probe: async (_session, signal) => {
      probeSignal = signal;
      await new Promise<void>((resolve) => {
        resolveProbe = resolve;
      });
      return { hitRatio: 0.9 };
    },
  });
  registry.enable("a", "/workspace");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(probeSignal.aborted, false);

  registry.turnStarted("a");
  assert.equal(probeSignal.aborted, true);
  resolveProbe?.();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const session = registry.snapshot()[0];
  assert.equal(session?.busy, true);
  assert.equal(session?.state, "waiting");
  assert.equal(session?.error, null);
  registry.stop("a");
});

function stored(overrides: Partial<KeeperSession> = {}): KeeperSession {
  return {
    sessionId: "a",
    title: null,
    cwd: "/workspace",
    enabled: true,
    busy: false,
    state: "waiting",
    nextProbeAt: null,
    lastProbeAt: null,
    lastRealActivityAt: 0,
    hitRatio: null,
    error: null,
    ...overrides,
  };
}

test("回合结束记录时间戳供重启恢复", async () => {
  const { registry, advance } = harness();
  registry.enable("a", "/workspace");
  await advance(30);
  registry.turnStarted("a");
  await advance(10);
  registry.turnEnded("a");
  assert.equal(registry.snapshot()[0]?.lastTurnEndAt, 40);
});

test("重启后沿用持久化的下次探测时间", async () => {
  const { registry, advance, probes } = harness();
  registry.restore([stored({ nextProbeAt: 60 })]);
  assert.equal(registry.snapshot()[0]?.nextProbeAt, 60);
  await advance(59);
  assert.equal(probes(), 0);
  await advance(1);
  assert.equal(probes(), 1);
});

test("重启时已过探测时间立即补一次", async () => {
  const { registry, advance, probes } = harness();
  registry.restore([stored({ nextProbeAt: -10 })]);
  await advance(0);
  assert.equal(probes(), 1);
});

test("缺探测点时按最后一轮结束时间恢复", async () => {
  const { registry, advance, probes } = harness();
  registry.restore([stored({ lastTurnEndAt: 20 })]);
  await advance(99);
  assert.equal(probes(), 0);
  await advance(21);
  assert.equal(probes(), 1);
});

test("最后回合已超出一个间隔时立即补一次", async () => {
  const { registry, advance, probes } = harness();
  registry.restore([stored({ lastTurnEndAt: -150 })]);
  await advance(0);
  assert.equal(probes(), 1);
});

test("旧状态缺少时间字段时从恢复时刻重新计时", async () => {
  const { registry, advance, probes } = harness();
  registry.restore([stored()]);
  await advance(99);
  assert.equal(probes(), 0);
  await advance(1);
  assert.equal(probes(), 1);
});

test("崩溃时正在回合中则从恢复时刻重新计时", async () => {
  const { registry, advance, probes } = harness();
  registry.restore([stored({ busy: true, lastTurnEndAt: -150 })]);
  await advance(99);
  assert.equal(probes(), 0);
  await advance(1);
  assert.equal(probes(), 1);
});

test("hook 与 reconcile 补齐会话标题供面板展示", async () => {
  const { registry } = harness();
  registry.enable("a", "/workspace");
  assert.equal(registry.snapshot()[0]?.title, null);
  registry.turnStarted("a", "写代码");
  assert.equal(registry.snapshot()[0]?.title, "写代码");
  registry.turnEnded("a");
  assert.equal(registry.snapshot()[0]?.title, "写代码");
  // 短码 on 不带标题时保留已有标题
  registry.enable("a", "/workspace");
  assert.equal(registry.snapshot()[0]?.title, "写代码");
  registry.setTitle("a", "改名为重构");
  assert.equal(registry.snapshot()[0]?.title, "改名为重构");
  // 未知会话静默忽略
  registry.setTitle("missing", "x");
});

test("探测成功记录开始、结果与调度点", async () => {
  const logs: LogEntry[] = [];
  const { registry, advance } = harness(logs);
  registry.enable("a", "/workspace");
  await advance(100);

  assert.deepEqual(logs.map((entry) => entry.event), ["probe.start", "probe.ok", "probe.settled"]);
  assert.equal(logs[0]?.fields.sessionId, "a");
  assert.equal(logs[0]?.fields.idleMs, 100);
  assert.equal(logs[1]?.fields.hitRatio, 0.9);
  assert.equal(typeof logs[1]?.fields.durationMs, "number");
  // 结算点携带下一次调度，用于解释保活间隔为何被推迟
  assert.equal(logs[2]?.fields.state, "waiting");
  assert.equal(logs[2]?.fields.nextProbeAt, 200);
});

test("探测失败与被清除的暂停状态都留痕", async () => {
  const logs: LogEntry[] = [];
  const registry = new SessionRegistry({
    intervalMs: 1,
    maxIdleMs: 1_000,
    log: (event: string, fields?: Record<string, unknown>) => {
      logs.push({ event, fields: fields ?? {} });
    },
    probe: async () => {
      throw new Error("保活失败：mock");
    },
  });
  registry.enable("a", "/workspace");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(registry.snapshot()[0]?.state, "paused");
  assert.equal(logs.find((entry) => entry.event === "probe.error")?.fields.error, "保活失败：mock");
  const settled = logs.find((entry) => entry.event === "probe.settled");
  assert.equal(settled?.fields.state, "paused");
  assert.equal(settled?.fields.nextProbeAt, null);

  registry.turnEnded("a");
  assert.equal(registry.snapshot()[0]?.error, null);
  assert.equal(logs.find((entry) => entry.event === "probe.paused-cleared")?.fields.error, "保活失败：mock");
});

test("超过最大空闲时间退休时记录原因", async () => {
  const logs: LogEntry[] = [];
  const { registry, advance } = harness(logs);
  registry.enable("a", "/workspace");
  await advance(100);
  await advance(100);
  await advance(100);

  const expired = logs.find((entry) => entry.event === "probe.expired");
  assert.equal(expired?.fields.sessionId, "a");
  assert.equal(expired?.fields.maxIdleMs, 250);
  assert.equal(registry.snapshot()[0]?.state, "expired");
});

test("保活次数用满后自动停止，重新开启重新计数", async () => {
  const logs: LogEntry[] = [];
  let probes = 0;
  const registry = new SessionRegistry({
    intervalMs: 1,
    maxIdleMs: 10_000,
    maxProbes: 2,
    log: (event: string, fields?: Record<string, unknown>) => {
      logs.push({ event, fields: fields ?? {} });
    },
    probe: async () => {
      probes += 1;
      return { hitRatio: 0.9 };
    },
  });
  registry.enable("a", "/workspace");
  await new Promise((resolve) => setTimeout(resolve, 40));

  const session = registry.snapshot()[0];
  assert.equal(probes, 2);
  assert.equal(session?.enabled, false);
  assert.equal(session?.state, "disabled");
  assert.equal(session?.probeCount, 2);
  assert.equal(session?.nextProbeAt, null);
  const exhausted = logs.filter((entry) => entry.event === "probe.budget-exhausted");
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0]?.fields.maxProbes, 2);

  registry.enable("a", "/workspace");
  assert.equal(registry.snapshot()[0]?.probeCount, 0);
  registry.stop("a");
});

test("重启后沿用已用的保活次数", () => {
  const registry = new SessionRegistry({
    intervalMs: 100,
    maxIdleMs: 1_000,
    maxProbes: 3,
    probe: async () => ({ hitRatio: 1 }),
  });
  registry.restore([stored({ probeCount: 2 })]);
  assert.equal(registry.snapshot()[0]?.probeCount, 2);
  registry.stop("a");
});
