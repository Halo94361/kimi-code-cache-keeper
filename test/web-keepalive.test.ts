import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptResult } from "../src/probe.js";
import type { WebClient } from "../src/web-client.js";
import { runWebKeepaliveOnce } from "../src/web-keepalive.js";

interface LogEntry {
  event: string;
  fields: Record<string, unknown>;
}

const FORK_ID = "session_fork";

class FakeClient {
  readonly deleted: string[] = [];
  unsafe = false;

  async forkSession(): Promise<string> {
    return FORK_ID;
  }

  async prompt(): Promise<PromptResult> {
    return { stopReason: "end_turn", usage: null, unsafeToolActivity: this.unsafe };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }
}

function collected(logs: LogEntry[]) {
  return (event: string, fields?: Record<string, unknown>) => {
    logs.push({ event, fields: fields ?? {} });
  };
}

/** 构造隔离 home：session_index.jsonl + 两个会话的 wire.jsonl。 */
async function isolatedHome(wire: { parent: boolean; fork: boolean }): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-web-keepalive-"));
  const parentDir = join(home, "sessions", "parent");
  const forkDir = join(home, "sessions", FORK_ID);
  const index = [
    { sessionId: "session_parent", sessionDir: parentDir },
    { sessionId: FORK_ID, sessionDir: forkDir },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(join(home, "session_index.jsonl"), `${index}\n`);

  const request = (cacheRead: number, inputOther: number) => [
    JSON.stringify({
      type: "llm.request",
      provider: "opencode",
      model: "deepseek-v4.1-flash",
      systemPromptHash: "sp",
      toolsHash: "th",
      messageCount: 42,
    }),
    JSON.stringify({
      type: "usage.record",
      usage: { inputOther, inputCacheRead: cacheRead, inputCacheCreation: 0, output: 3 },
    }),
  ].join("\n");

  if (wire.parent) {
    await mkdir(join(parentDir, "agents", "main"), { recursive: true });
    await writeFile(join(parentDir, "agents", "main", "wire.jsonl"), `${request(192_000, 900)}\n`);
  }
  if (wire.fork) {
    await mkdir(join(forkDir, "agents", "main"), { recursive: true });
    await writeFile(join(forkDir, "agents", "main", "wire.jsonl"), `${request(124_288, 69_212)}\n`);
  }
  return home;
}

test("保活各步骤与用量写入诊断日志", async () => {
  const logs: LogEntry[] = [];
  const client = new FakeClient();
  const report = await runWebKeepaliveOnce(client as unknown as WebClient, {
    parentSessionId: "session_parent",
    diagnosticsHome: await isolatedHome({ parent: true, fork: true }),
    log: collected(logs),
  });

  assert.equal(report.status, "ok");
  assert.equal(report.prefixHashesMatch, true);
  assert.deepEqual(client.deleted, [FORK_ID]);
  assert.deepEqual(logs.map((entry) => entry.event), [
    "keepalive.fork.created",
    "keepalive.prompt",
    "keepalive.usage",
    "keepalive.fork.deleted",
  ]);
  assert.equal(logs[0]?.fields.parentSessionId, "session_parent");
  assert.equal(logs[1]?.fields.stopReason, "end_turn");
  assert.equal(logs[2]?.fields.inputOther, 69_212);
  assert.equal(logs[2]?.fields.inputCacheRead, 124_288);
  assert.equal(logs[2]?.fields.cacheHitRatio, 124_288 / (124_288 + 69_212));
  assert.equal(logs[2]?.fields.wireFound, true);
});

test("fork 工具活动失败但日志保留原因且仍清理 fork", async () => {
  const logs: LogEntry[] = [];
  const client = new FakeClient();
  client.unsafe = true;
  const report = await runWebKeepaliveOnce(client as unknown as WebClient, {
    parentSessionId: "session_parent",
    diagnosticsHome: await isolatedHome({ parent: true, fork: false }),
    log: collected(logs),
  });

  assert.equal(report.status, "error");
  assert.deepEqual(client.deleted, [FORK_ID]);
  assert.equal(logs.find((entry) => entry.event === "keepalive.error")?.fields.error, "保活 fork 请求了工具调用，已取消");
  assert.equal(logs.at(-1)?.event, "keepalive.fork.deleted");
});

test("fork 缺少 wire 时用量为空但不判失败", async () => {
  const logs: LogEntry[] = [];
  const client = new FakeClient();
  const report = await runWebKeepaliveOnce(client as unknown as WebClient, {
    parentSessionId: "session_parent",
    diagnosticsHome: await isolatedHome({ parent: true, fork: false }),
    log: collected(logs),
  });

  assert.equal(report.status, "ok");
  const usage = logs.find((entry) => entry.event === "keepalive.usage");
  assert.equal(usage?.fields.wireFound, false);
  assert.equal(usage?.fields.cacheHitRatio, null);
  assert.equal(usage?.fields.inputCacheRead, 0);
});
