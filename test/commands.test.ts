import assert from "node:assert/strict";
import test from "node:test";
import { parseKeeperCommand } from "../src/commands.js";

test("识别四个插件命令", () => {
  for (const action of ["on", "off", "status", "now"] as const) {
    assert.equal(parseKeeperCommand(`/cache-keeper:${action}`), action);
  }
});

test("拒绝其他命令和额外参数", () => {
  assert.equal(parseKeeperCommand("/cache-keeper:on now"), null);
  assert.equal(parseKeeperCommand("/cache-keeper:unknown"), null);
  assert.equal(parseKeeperCommand("普通消息"), null);
});
