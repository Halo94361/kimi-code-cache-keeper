import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startController } from "../dist/controller.js";

const home = resolve(".probe-home");
const parent = {
  sessionId: process.env.CACHE_KEEPER_E2E_PARENT ?? "session_210beecc-2fe9-422f-977a-e520c643012d",
  workDir: resolve(home, "workspace"),
};

const controller = await startController({ home });
const discovery = JSON.parse(await readFile(resolve(home, "cache-keeper", "controller.json"), "utf8"));

async function call(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${discovery.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${discovery.controlToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.status === "error") throw new Error(payload.error ?? "控制器调用失败");
  return payload;
}

try {
  await call("POST", `/v1/sessions/${parent.sessionId}/on`, { cwd: parent.workDir, title: "CLI-only 验收" });
  await call("POST", `/v1/sessions/${parent.sessionId}/now`, {});
  let kept;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await call("GET", "/v1/status");
    kept = status.sessions.find((session) => session.sessionId === parent.sessionId);
    if (kept?.lastProbeAt) break;
    if (kept?.state === "paused") throw new Error(kept.error ?? "CLI-only 保活失败");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!kept?.lastProbeAt) throw new Error("CLI-only 保活超时");
  if (kept.hitRatio < 0.8) throw new Error(`CLI-only 缓存命中率异常：${kept.hitRatio}`);
  await call("POST", `/v1/sessions/${parent.sessionId}/off`, {});
  console.log(JSON.stringify({
    status: "ok",
    sessionId: parent.sessionId,
    hitRatio: kept.hitRatio,
    mode: "acp-cli-only",
  }, null, 2));
} finally {
  await controller.close();
}
