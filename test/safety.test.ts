import assert from "node:assert/strict";
import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import test from "node:test";
import type * as acp from "@agentclientprotocol/sdk";
import { assertIsolatedHome, assertSessionLifecycleCapabilities, chooseSafeModeId } from "../src/safety.js";

test("必须显式指定非默认的隔离 home", () => {
  assert.throws(() => assertIsolatedHome(undefined), /--home/);
  assert.throws(() => assertIsolatedHome(resolve(homedir(), ".kimi-code")), /默认/);
  assert.throws(() => assertIsolatedHome(parse(resolve(homedir())).root), /根目录/);
  assert.equal(
    assertIsolatedHome(resolve(homedir(), "cache-keeper-test-home")),
    resolve(homedir(), "cache-keeper-test-home"),
  );
});

test("fork 与 delete 能力缺一不可", () => {
  const withCapabilities = (fork: boolean, del: boolean): acp.InitializeResponse => ({
    protocolVersion: 1,
    agentCapabilities: {
      sessionCapabilities: {
        ...(fork ? { fork: {} } : {}),
        ...(del ? { delete: {} } : {}),
      },
    },
  });
  assert.doesNotThrow(() => assertSessionLifecycleCapabilities(withCapabilities(true, true)));
  assert.throws(() => assertSessionLifecycleCapabilities(withCapabilities(true, false)), /delete/);
  assert.throws(() => assertSessionLifecycleCapabilities(withCapabilities(false, true)), /fork/);
});

test("Kimi default 手动审批模式优先于 plan", () => {
  const mode = chooseSafeModeId({
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
      { id: "auto", name: "Auto" },
    ],
  });
  assert.equal(mode, "default");
});

test("无法识别安全模式时明确失败", () => {
  assert.throws(() => chooseSafeModeId({
    currentModeId: "auto",
    availableModes: [{ id: "auto", name: "Auto" }],
  }), /无法确认保活安全模式/);
});
