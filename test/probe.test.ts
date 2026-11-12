import assert from "node:assert/strict";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { runProbe, type ProbeDriver, type PromptResult, type SessionDescriptor } from "../src/probe.js";

const INIT: acp.InitializeResponse = {
  protocolVersion: 1,
  agentInfo: { name: "mock-kimi", version: "1.0.0" },
  agentCapabilities: { sessionCapabilities: { fork: {}, delete: {} } },
};

const MODES: acp.SessionModeState = {
  currentModeId: "ask",
  availableModes: [{ id: "ask", name: "Always Ask" }],
};

class MockDriver implements ProbeDriver {
  deleted: string[] = [];
  failPromptSessionId: string | null = null;
  unsafePromptSessionId: string | null = null;
  failDelete = false;

  async initialize(): Promise<acp.InitializeResponse> { return INIT; }
  async authenticate(): Promise<void> {}
  async createSession(): Promise<SessionDescriptor> {
    return { sessionId: "parent-created", modes: MODES };
  }
  async resumeSession(sessionId: string): Promise<SessionDescriptor> {
    return { sessionId, modes: MODES };
  }
  async forkSession(): Promise<SessionDescriptor> {
    return { sessionId: "fork-created", modes: MODES };
  }
  async setManualMode(): Promise<void> {}
  async prompt(sessionId: string): Promise<PromptResult> {
    if (this.failPromptSessionId === sessionId) throw new Error("mock prompt failed");
    const unsafe = this.unsafePromptSessionId === sessionId;
    return {
      stopReason: unsafe ? "cancelled" : "end_turn",
      usage: null,
      unsafeToolActivity: unsafe,
    };
  }
  async deleteSession(sessionId: string): Promise<void> {
    if (this.failDelete) throw new Error("mock delete failed");
    this.deleted.push(sessionId);
  }
}

test("完整流程只清理自建 fork 与父会话，fork 先删除", async () => {
  const driver = new MockDriver();
  const report = await runProbe(driver, { cwd: "/isolated/workspace" });
  assert.equal(report.status, "ok");
  assert.equal(report.parentSessionId, "parent-created");
  assert.equal(report.forkSessionId, "fork-created");
  assert.deepEqual(driver.deleted, ["fork-created", "parent-created"]);
});

test("使用已有测试父会话时只删除 fork", async () => {
  const driver = new MockDriver();
  const report = await runProbe(driver, {
    cwd: "/isolated/workspace",
    parentSessionId: "parent-existing",
  });
  assert.equal(report.status, "ok");
  assert.deepEqual(driver.deleted, ["fork-created"]);
});

test("父会话出现工具活动时取消验证并清理父会话", async () => {
  const driver = new MockDriver();
  driver.unsafePromptSessionId = "parent-created";
  const report = await runProbe(driver, { cwd: "/isolated/workspace" });
  assert.equal(report.status, "error");
  assert.match(report.error ?? "", /工具调用或权限/);
  assert.deepEqual(driver.deleted, ["parent-created"]);
});

test("fork 出现工具活动时同时清理 fork 与自建父会话", async () => {
  const driver = new MockDriver();
  driver.unsafePromptSessionId = "fork-created";
  const report = await runProbe(driver, { cwd: "/isolated/workspace" });
  assert.equal(report.status, "error");
  assert.match(report.error ?? "", /工具调用或权限/);
  assert.deepEqual(driver.deleted, ["fork-created", "parent-created"]);
});

test("prompt 失败后仍执行清理", async () => {
  const driver = new MockDriver();
  driver.failPromptSessionId = "parent-created";
  const report = await runProbe(driver, { cwd: "/isolated/workspace" });
  assert.equal(report.status, "error");
  assert.match(report.error ?? "", /mock prompt failed/);
  assert.deepEqual(driver.deleted, ["parent-created"]);
});

test("清理失败会明确报告，不伪装成功", async () => {
  const driver = new MockDriver();
  driver.failDelete = true;
  const report = await runProbe(driver, { cwd: "/isolated/workspace" });
  assert.equal(report.status, "error");
  assert.equal(report.error, "清理测试会话时发生错误");
  assert.equal(report.cleanupErrors.length, 2);
});

test("等待后可恢复父会话并再次验证", async () => {
  const driver = new MockDriver();
  const report = await runProbe(driver, {
    cwd: "/isolated/workspace",
    resumeDelaySeconds: 0,
  });
  assert.equal(report.status, "ok");
  assert.equal(report.parentResumePrompt?.stopReason, "end_turn");
  assert.deepEqual(driver.deleted, ["fork-created", "parent-created"]);
});
