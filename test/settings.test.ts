import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings.js";

async function homeWith(content: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-settings-"));
  await mkdir(join(home, "cache-keeper"), { recursive: true });
  await writeFile(join(home, "cache-keeper", "settings.json"), content);
  return home;
}

test("读取 intervalMs / maxIdleMs / maxProbes", async () => {
  const home = await homeWith(JSON.stringify({ intervalMs: 600_000, maxIdleMs: 7_200_000, maxProbes: 20 }));
  assert.deepEqual(await loadSettings(home), { intervalMs: 600_000, maxIdleMs: 7_200_000, maxProbes: 20 });
});

test("设置文件缺失或损坏时退回默认", async () => {
  const missing = await mkdtemp(join(tmpdir(), "cache-keeper-settings-"));
  assert.deepEqual(await loadSettings(missing), {});
  assert.deepEqual(await loadSettings(await homeWith("{not json")), {});
  assert.deepEqual(await loadSettings(await homeWith("[]")), {});
});

test("非正数或非数字字段被忽略，不影响其它字段", async () => {
  const home = await homeWith(JSON.stringify({ intervalMs: 0, maxIdleMs: -5, maxProbes: "20" }));
  assert.deepEqual(await loadSettings(home), {});
  const partial = await homeWith(JSON.stringify({ intervalMs: 600_000, maxProbes: 3.9 }));
  assert.deepEqual(await loadSettings(partial), { intervalMs: 600_000, maxProbes: 3 });
});
