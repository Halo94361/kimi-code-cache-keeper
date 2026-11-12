import assert from "node:assert/strict";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { runKeepaliveOnce } from "../src/keepalive.js";
import type { ProbeDriver, PromptResult, SessionDescriptor } from "../src/probe.js";

const INIT: acp.InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: { sessionCapabilities: { fork: {}, delete: {} } },
};
const MODES: acp.SessionModeState = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default" }],
};

class Driver implements ProbeDriver {
  parentDeleted = false;
  forkDeleted = false;
  unsafe = false;

  async initialize(): Promise<acp.InitializeResponse> { return INIT; }
  async authenticate(): Promise<void> {}
  async createSession(): Promise<SessionDescriptor> { throw new Error("不应创建父会话"); }
  async resumeSession(sessionId: string): Promise<SessionDescriptor> {
    if (sessionId === "parent-existing") throw new Error("保活不应恢复被占用的父会话");
    return { sessionId, modes: MODES };
  }
  async forkSession(): Promise<SessionDescriptor> {
    return { sessionId: "fork-created", modes: MODES };
  }
  async setManualMode(): Promise<void> {}
  async prompt(): Promise<PromptResult> {
    return { stopReason: this.unsafe ? "cancelled" : "end_turn", usage: null, unsafeToolActivity: this.unsafe };
  }
  async deleteSession(sessionId: string): Promise<void> {
    if (sessionId === "parent-existing") this.parentDeleted = true;
    if (sessionId === "fork-created") this.forkDeleted = true;
  }
}

test("保活只提示 fork 并只清理 fork", async () => {
  const driver = new Driver();
  const report = await runKeepaliveOnce(driver, {
    parentSessionId: "parent-existing",
    cwd: "/isolated/workspace",
  });
  assert.equal(report.status, "ok");
  assert.equal(driver.parentDeleted, false);
  assert.equal(driver.forkDeleted, true);
  assert.deepEqual(report.deletedSessionIds, ["fork-created"]);
});

test("保活工具活动失败但不删除父会话", async () => {
  const driver = new Driver();
  driver.unsafe = true;
  const report = await runKeepaliveOnce(driver, {
    parentSessionId: "parent-existing",
    cwd: "/isolated/workspace",
  });
  assert.equal(report.status, "error");
  assert.equal(driver.parentDeleted, false);
  assert.equal(driver.forkDeleted, true);
});
