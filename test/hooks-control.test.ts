import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveControllerScript } from "../src/hooks/control.js";

async function withLayout(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-ctrlpath-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function touch(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "");
}

test("mcp.js 布局：控制器与自身同目录", async () => {
  await withLayout(async (home) => {
    const dist = join(home, "dist");
    await touch(join(dist, "mcp.js"));
    await touch(join(dist, "controller.js"));
    const resolved = resolveControllerScript(pathToFileURL(join(dist, "mcp.js")).href);
    assert.equal(resolved, join(dist, "controller.js"));
  });
});

test("hooks 布局：控制器在上一级目录", async () => {
  await withLayout(async (home) => {
    const hooks = join(home, "dist", "hooks");
    await touch(join(hooks, "activity.js"));
    await touch(join(home, "dist", "controller.js"));
    const resolved = resolveControllerScript(pathToFileURL(join(hooks, "activity.js")).href);
    assert.equal(resolved, join(home, "dist", "controller.js"));
  });
});

test("两种布局都不存在时回退上一级候选，保持旧行为", async () => {
  await withLayout(async (home) => {
    const hooks = join(home, "dist", "hooks");
    await touch(join(hooks, "control.js"));
    const resolved = resolveControllerScript(pathToFileURL(join(hooks, "control.js")).href);
    assert.equal(resolved, join(home, "dist", "controller.js"));
  });
});
