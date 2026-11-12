import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startController } from "../src/controller.js";

test("本地控制接口支持开关、活动、状态和发现文件", async () => {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-controller-"));
  let probes = 0;
  const controller = await startController({
    home,
    intervalMs: 10_000,
    probe: async () => {
      probes += 1;
      return { hitRatio: 0.95 };
    },
  });
  const discoveryPath = join(home, "cache-keeper", "controller.json");
  try {
    const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
    const base = `http://127.0.0.1:${controller.port}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${discovery.controlToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
      return response.json();
    };
    await call("POST", "/v1/sessions/session-a/on", { cwd: "/workspace", title: "测试" });
    await call("POST", "/v1/sessions/session-a/now", {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    let status = await call("GET", "/v1/status");
    assert.equal(probes, 1);
    assert.equal(status.enabled, true);
    assert.equal(status.sessions[0].sessionId, "session-a");
    assert.equal(status.sessions[0].hitRatio, 0.95);

    await call("POST", "/v1/sessions/session-a/activity", { event: "TurnStarted" });
    status = await call("GET", "/v1/status");
    assert.equal(status.sessions[0].busy, true);
    assert.equal(status.sessions[0].nextProbeAt, null);
    await call("POST", "/v1/sessions/session-a/activity", { event: "Stop" });
    status = await call("GET", "/v1/status");
    assert.equal(status.sessions[0].busy, false);
    assert.notEqual(status.sessions[0].nextProbeAt, null);

    await call("POST", "/v1/sessions/session-a/off", {});
    status = await call("GET", "/v1/status");
    assert.equal(status.enabled, false);

    const unauthorized = await fetch(`${base}/v1/status`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await controller.close();
    await rm(home, { recursive: true, force: true });
  }
});
