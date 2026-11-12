import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForkMap } from "../src/fork-map.js";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-fork-map-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function readMap(home: string): Promise<{ version: number; forks: Record<string, string> }> {
  return JSON.parse(await readFile(join(home, "cache-keeper", "fork-map.json"), "utf8"));
}

test("登记与清除保活 fork 映射", async () => {
  await withHome(async (home) => {
    const map = new ForkMap(home);
    await map.record("fork-1", "parent-1");
    await map.record("fork-2", "parent-2");
    assert.deepEqual((await readMap(home)).forks, { "fork-1": "parent-1", "fork-2": "parent-2" });
    await map.forget("fork-1");
    assert.deepEqual((await readMap(home)).forks, { "fork-2": "parent-2" });
  });
});

test("并发登记不会丢失条目", async () => {
  await withHome(async (home) => {
    const map = new ForkMap(home);
    await Promise.all([
      map.record("fork-a", "parent-a"),
      map.record("fork-b", "parent-b"),
      map.record("fork-c", "parent-c"),
    ]);
    assert.deepEqual((await readMap(home)).forks, {
      "fork-a": "parent-a",
      "fork-b": "parent-b",
      "fork-c": "parent-c",
    });
  });
});

test("启动清空残留映射", async () => {
  await withHome(async (home) => {
    const map = new ForkMap(home);
    await map.record("fork-old", "parent-old");
    await map.clear();
    assert.deepEqual((await readMap(home)).forks, {});
  });
});

test("损坏的映射文件按空表处理并可恢复写入", async () => {
  await withHome(async (home) => {
    const path = join(home, "cache-keeper", "fork-map.json");
    await mkdir(join(home, "cache-keeper"), { recursive: true });
    await writeFile(path, "{ not json", "utf8");
    const map = new ForkMap(home);
    await map.record("fork-1", "parent-1");
    assert.deepEqual((await readMap(home)).forks, { "fork-1": "parent-1" });
  });
});
