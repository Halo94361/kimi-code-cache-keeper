import assert from "node:assert/strict";
import test from "node:test";
import { SessionOwnership } from "../src/session-ownership.js";

test("只允许删除本次创建的 fork", () => {
  const ownership = new SessionOwnership();
  ownership.trackCreatedParent("parent");
  ownership.trackCreatedFork("parent", "fork");
  assert.doesNotThrow(() => ownership.assertCanDelete("fork"));
  assert.throws(() => ownership.assertCanDelete("fork"), /未知 session/);
});

test("生产保活路径永远不能删除原始 session", () => {
  const ownership = new SessionOwnership();
  ownership.trackCreatedParent("parent");
  assert.throws(() => ownership.assertCanDelete("parent"), /原始 session/);
  assert.throws(() => ownership.assertCanDelete("unknown"), /未知 session/);
});

test("仅阶段 0 显式允许时才可清理自建测试父会话", () => {
  const ownership = new SessionOwnership();
  ownership.trackCreatedParent("parent");
  assert.throws(() => ownership.assertCanDelete("parent"), /原始 session/);
  assert.doesNotThrow(() => ownership.assertCanDelete("parent", true));
});

test("fork 与父会话同 ID 或复用父 ID 时立即失败", () => {
  const ownership = new SessionOwnership();
  ownership.trackCreatedParent("parent");
  assert.throws(() => ownership.trackCreatedFork("parent", "parent"), /无效的保活 fork ID/);
});
