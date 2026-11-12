import assert from "node:assert/strict";
import test from "node:test";
import { SessionRegistry, type KeeperSession } from "../src/session-registry.js";

function harness() {
  let time = 0;
  const timers = new Map<number, { callback: () => void; dueAt: number }>();
  let sequence = 0;
  let probes = 0;
  const registry = new SessionRegistry({
    intervalMs: 100,
    maxIdleMs: 250,
    now: () => time,
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
