import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProbeLog } from "../src/probe-log.js";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cache-keeper-probe-log-"));
}

function logPath(home: string): string {
  return join(home, "cache-keeper", "probe-log.jsonl");
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8").catch(() => "");
}

async function waitFor(check: () => Promise<boolean>, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待日志落盘超时");
}

function entries(text: string): Array<Record<string, unknown>> {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("逐行追加事件，保留字段类型", async () => {
  const home = await tempHome();
  const log = new ProbeLog(home);
  log.record("probe.ok", { sessionId: "s1", hitRatio: 0.64, ok: true, missing: null });
  log.record("probe.settled", { sessionId: "s1", nextProbeAt: 1_700_000_000_000 });
  await waitFor(async () => (await readText(logPath(home))).split("\n").filter(Boolean).length === 2);

  const lines = entries(await readText(logPath(home)));
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.event, "probe.ok");
  assert.equal(lines[0]?.sessionId, "s1");
  assert.equal(lines[0]?.hitRatio, 0.64);
  assert.equal(lines[0]?.ok, true);
  assert.equal(lines[0]?.missing, null);
  assert.equal(lines[1]?.nextProbeAt, 1_700_000_000_000);
  assert.match(String(lines[0]?.ts), /^\d{4}-\d{2}-\d{2}T/);
});

test("凭据形态的文本被脱敏，超长字段截断", async () => {
  const home = await tempHome();
  const log = new ProbeLog(home, { maxFieldChars: 40 });
  log.record("probe.error", {
    error: "Authorization: Bearer abc.def-123 失败 sk-875f26a1-ff57-4916 也失败 0123456789abcdef0123456789abcdef0123",
  });
  log.record("probe.ok", { error: "x".repeat(200) });
  await waitFor(async () => (await readText(logPath(home))).split("\n").filter(Boolean).length === 2);

  const [first, second] = entries(await readText(logPath(home)));
  const text = String(first?.error);
  assert.equal(text.includes("abc.def-123"), false);
  assert.equal(text.includes("875f26a1"), false);
  assert.equal(text.includes("0123456789abcdef"), false);
  assert.equal(text.includes("Bearer ***"), true);
  assert.equal(String(second?.error).length, 41);
  assert.equal(String(second?.error).endsWith("…"), true);
});

test("超过上限轮转，只保留一代", async () => {
  const home = await tempHome();
  const log = new ProbeLog(home, { maxBytes: 120 });
  log.record("probe.ok", { sessionId: "first", padding: "a".repeat(40) });
  await waitFor(async () => (await readText(logPath(home))).length > 0);
  log.record("probe.ok", { sessionId: "second", padding: "b".repeat(40) });
  await waitFor(async () => {
    const current = entries(await readText(logPath(home)));
    return current.at(-1)?.sessionId === "second";
  });

  const rotated = entries(await readText(`${logPath(home)}.1`));
  assert.equal(rotated.at(-1)?.sessionId, "first");
  assert.equal(entries(await readText(logPath(home))).at(-1)?.sessionId, "second");
});

test("日志目录不可写时静默失败", async () => {
  const home = await tempHome();
  const blocking = join(home, "not-a-dir");
  await writeFile(blocking, "x");
  const log = new ProbeLog(join(blocking, "nested"));
  log.record("probe.ok", { sessionId: "s1" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const exists = await stat(logPath(join(blocking, "nested"))).then(() => true).catch(() => false);
  assert.equal(exists, false);
});
