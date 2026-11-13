import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startController } from "../src/controller.js";
import { SessionCodes, makeCode } from "../src/session-codes.js";

test("本地控制接口支持开关、活动、状态和发现文件", async () => {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-controller-"));
  const controller = await startController({
    home,
    intervalMs: 10_000,
    probe: async () => ({ hitRatio: 0.95 }),
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
    let status = await call("GET", "/v1/status");
    assert.equal(status.enabled, true);
    assert.equal(status.sessions[0].sessionId, "session-a");
    assert.equal(status.sessions[0].hitRatio, null);

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

test("Web 状态校正补上漏掉的 Stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-reconcile-"));
  const webServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(JSON.stringify({
      code: 0,
      msg: "success",
      data: { busy: false, main_turn_active: false },
    }));
  });
  await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
  const address = webServer.address();
  if (address === null || typeof address === "string") throw new Error("mock web 监听失败");
  const controller = await startController({
    home,
    intervalMs: 10_000,
    reconcileMs: 10,
    web: { baseUrl: `http://127.0.0.1:${address.port}`, token: "test" },
    probe: async () => ({ hitRatio: 0.9 }),
  });
  try {
    const discovery = JSON.parse(await readFile(join(home, "cache-keeper", "controller.json"), "utf8"));
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
    await call("POST", "/v1/sessions/session-r/on", { cwd: "/workspace" });
    await call("POST", "/v1/sessions/session-r/activity", { event: "TurnStarted", cwd: "/workspace" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const status = await call("GET", "/v1/status");
    assert.equal(status.sessions[0]?.busy, false);
    assert.notEqual(status.sessions[0]?.nextProbeAt, null);
  } finally {
    await controller.close();
    webServer.closeAllConnections();
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("短码接口精确开启并查询单个会话", async () => {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-code-controller-"));
  let probes = 0;
  const controller = await startController({
    home,
    intervalMs: 10_000,
    probe: async () => {
      probes += 1;
      return { hitRatio: 0.9 };
    },
  });
  try {
    const code = await new SessionCodes(home, { random: () => 1375 })
      .injectOnPrompt("session-code", "/workspace", new Date(2026, 10, 12));
    assert.equal(code, "111213757");
    const discovery = JSON.parse(await readFile(join(home, "cache-keeper", "controller.json"), "utf8"));
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

    const on = await call("POST", "/v1/code/on", { code });
    assert.equal(on.sessionId, "session-code");
    let status = await call("GET", "/v1/status");
    assert.equal(status.sessions[0]?.sessionId, "session-code");
    assert.equal(status.sessions[0]?.enabled, true);

    const codeStatus = await call("GET", `/v1/code/${code}`);
    assert.equal(codeStatus.session.sessionId, "session-code");
    assert.equal(codeStatus.session.enabled, true);

    const invalid = await call("POST", "/v1/code/on", { code: "111213758" });
    assert.equal(invalid.status, "error");
    const unknown = await call("POST", "/v1/code/on", { code: makeCode(new Date(2026, 10, 12), () => 1111) });
    assert.equal(unknown.status, "error");

    await call("POST", "/v1/code/off", { code });
    status = await call("GET", "/v1/status");
    assert.equal(status.enabled, false);
    assert.equal(probes, 0);
  } finally {
    await controller.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("reconcile 用 Web 会话标题补齐面板显示", async () => {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-title-"));
  const webServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(JSON.stringify({
      code: 0,
      msg: "success",
      data: { busy: false, main_turn_active: false, title: "重构保活插件" },
    }));
  });
  await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
  const address = webServer.address();
  if (address === null || typeof address === "string") throw new Error("mock web 监听失败");
  const controller = await startController({
    home,
    intervalMs: 10_000,
    reconcileMs: 10,
    web: { baseUrl: `http://127.0.0.1:${address.port}`, token: "test" },
    probe: async () => ({ hitRatio: 0.9 }),
  });
  try {
    const discovery = JSON.parse(await readFile(join(home, "cache-keeper", "controller.json"), "utf8"));
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
    // 模拟短码 on：不带标题
    await call("POST", "/v1/sessions/session-r/on", { cwd: "/workspace" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const status = await call("GET", "/v1/status");
    assert.equal(status.sessions[0]?.title, "重构保活插件");
    // hook 自带的标题也会更新
    await call("POST", "/v1/sessions/session-r/activity", { event: "Stop", cwd: "/workspace", title: "hook 标题" });
    const after = await call("GET", "/v1/status");
    assert.equal(after.sessions[0]?.title, "hook 标题");
  } finally {
    await controller.close();
    webServer.closeAllConnections();
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("Web 晚于控制器启动时 reconcile 重新发现端点并补上漏掉的 Stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-late-web-"));
  const webServer = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    if (request.url?.endsWith("/healthz")) {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.end(JSON.stringify({
      code: 0,
      msg: "success",
      data: { busy: false, main_turn_active: false },
    }));
  });
  await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
  const address = webServer.address();
  if (address === null || typeof address === "string") throw new Error("mock web 监听失败");
  let webReady = false;
  const controller = await startController({
    home,
    intervalMs: 10_000,
    reconcileMs: 10,
    discoverWeb: async () => (webReady
      ? { baseUrl: `http://127.0.0.1:${address.port}`, token: "test" }
      : null),
    probe: async () => ({ hitRatio: 0.9 }),
  });
  try {
    const discovery = JSON.parse(await readFile(join(home, "cache-keeper", "controller.json"), "utf8"));
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

    await call("POST", "/v1/sessions/session-late/on", { cwd: "/workspace" });
    await call("POST", "/v1/sessions/session-late/activity", { event: "TurnStarted", cwd: "/workspace" });
    const before = await call("GET", "/v1/status");
    assert.equal(before.sessions[0]?.busy, true);
    assert.equal(before.sessions[0]?.nextProbeAt, null);

    webReady = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const after = await call("GET", "/v1/status");
    assert.equal(after.sessions[0]?.busy, false);
    assert.notEqual(after.sessions[0]?.nextProbeAt, null);
  } finally {
    await controller.close();
    webServer.closeAllConnections();
    await new Promise<void>((resolve) => webServer.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("Web 重启换端口后 reconcile 丢弃失效端点并重新发现", async () => {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-restart-web-"));
  const deadServer = createServer();
  await new Promise<void>((resolve) => deadServer.listen(0, "127.0.0.1", resolve));
  const deadAddress = deadServer.address();
  if (deadAddress === null || typeof deadAddress === "string") throw new Error("端口分配失败");
  await new Promise<void>((resolve) => deadServer.close(() => resolve()));

  const liveServer = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    if (request.url?.endsWith("/healthz")) {
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.end(JSON.stringify({
      code: 0,
      msg: "success",
      data: { busy: false, main_turn_active: false },
    }));
  });
  await new Promise<void>((resolve) => liveServer.listen(0, "127.0.0.1", resolve));
  const liveAddress = liveServer.address();
  if (liveAddress === null || typeof liveAddress === "string") throw new Error("mock web 监听失败");

  let discoveries = 0;
  const controller = await startController({
    home,
    intervalMs: 10_000,
    reconcileMs: 10,
    discoverWeb: async () => {
      discoveries += 1;
      return discoveries === 1
        ? { baseUrl: `http://127.0.0.1:${deadAddress.port}`, token: "test" }
        : { baseUrl: `http://127.0.0.1:${liveAddress.port}`, token: "test" };
    },
    probe: async () => ({ hitRatio: 0.9 }),
  });
  try {
    const discovery = JSON.parse(await readFile(join(home, "cache-keeper", "controller.json"), "utf8"));
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

    await call("POST", "/v1/sessions/session-restart/on", { cwd: "/workspace" });
    await call("POST", "/v1/sessions/session-restart/activity", { event: "TurnStarted", cwd: "/workspace" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const status = await call("GET", "/v1/status");
    assert.equal(discoveries > 1, true);
    assert.equal(status.sessions[0]?.busy, false);
    assert.notEqual(status.sessions[0]?.nextProbeAt, null);
  } finally {
    await controller.close();
    liveServer.closeAllConnections();
    await new Promise<void>((resolve) => liveServer.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
