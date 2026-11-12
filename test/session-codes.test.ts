import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionCodes,
  SessionCodeError,
  isValidCode,
  makeCode,
  normalizeCode,
} from "../src/session-codes.js";

const DATE = new Date(2026, 10, 12, 10, 0, 0);
const CODE = "111213757";

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "cache-keeper-codes-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function daysLater(days: number): Date {
  return new Date(DATE.getTime() + days * 24 * 60 * 60_000);
}

test("短码为 MMDD + 4 位随机 + Luhn 校验", () => {
  assert.equal(makeCode(DATE, () => 1375), CODE);
  assert.equal(isValidCode(CODE), true);
  assert.equal(normalizeCode(" 1112-1375-7 "), CODE);
});

test("Luhn 拒绝所有单字符错误", () => {
  for (let index = 0; index < CODE.length; index += 1) {
    const digit = (Number(CODE[index]) + 1) % 10;
    const wrong = `${CODE.slice(0, index)}${digit}${CODE.slice(index + 1)}`;
    assert.equal(isValidCode(wrong), false, `第 ${index} 位改错后仍通过校验`);
  }
});

test("首次提交注入，后续静默；补发时使用同一短码", async () => {
  await withHome(async (home) => {
    const codes = new SessionCodes(home, { random: () => 1375 });
    assert.equal(await codes.injectOnPrompt("session-a", "/workspace", DATE), CODE);
    assert.equal(await codes.injectOnPrompt("session-a", "/workspace", daysLater(0)), null);

    await codes.markNeedsInjection("session-a", DATE);
    assert.equal(await codes.injectOnPrompt("session-a", "/workspace", DATE), CODE);
    assert.equal((await codes.read("session-a"))?.needsInjection, false);
  });
});

test("生成时查重：随机数冲突则重抽", async () => {
  await withHome(async (home) => {
    const values = [1375, 1375, 9024];
    const codes = new SessionCodes(home, { random: () => values.shift()! });
    assert.equal(await codes.injectOnPrompt("session-a", "/workspace", DATE), CODE);
    const second = await codes.injectOnPrompt("session-b", "/workspace", DATE);
    assert.notEqual(second, CODE);
    assert.equal(second, makeCode(DATE, () => 9024));
  });
});

test("按短码精确解析会话，不使用其它字段推断", async () => {
  await withHome(async (home) => {
    const codes = new SessionCodes(home, { random: () => 1375 });
    await codes.injectOnPrompt("session-a", "/workspace", DATE);
    assert.deepEqual(await codes.resolve(CODE, DATE), {
      code: CODE,
      sessionId: "session-a",
      cwd: "/workspace",
    });
  });
});

test("校验位错误、未知码和过期码都不会解析", async () => {
  await withHome(async (home) => {
    const codes = new SessionCodes(home, { random: () => 1375 });
    await codes.injectOnPrompt("session-a", "/workspace", DATE);

    const wrongCheck = `${CODE.slice(0, 8)}8`;
    await assert.rejects(
      codes.resolve(wrongCheck, DATE),
      (error: unknown) => error instanceof SessionCodeError && error.kind === "invalid",
    );
    const unknown = makeCode(DATE, () => 1111);
    await assert.rejects(
      codes.resolve(unknown, DATE),
      (error: unknown) => error instanceof SessionCodeError && error.kind === "unknown",
    );
    await assert.rejects(
      codes.resolve(CODE, daysLater(31)),
      (error: unknown) => error instanceof SessionCodeError && error.kind === "unknown",
    );
  });
});

test("重复短码报冲突，不猜测归属", async () => {
  await withHome(async (home) => {
    const dir = join(home, "cache-keeper", "sessions");
    await mkdir(dir, { recursive: true });
    for (const sessionId of ["session-a", "session-b"]) {
      await writeFile(join(dir, `${sessionId}.json`), JSON.stringify({
        version: 1,
        code: CODE,
        sessionId,
        cwd: "/workspace",
        createdAt: DATE.toISOString(),
        updatedAt: DATE.toISOString(),
        needsInjection: false,
      }));
    }
    const codes = new SessionCodes(home);
    await assert.rejects(
      codes.resolve(CODE, DATE),
      (error: unknown) => error instanceof SessionCodeError && error.kind === "conflict",
    );
  });
});

test("prune 清理过期文件，保留活跃文件", async () => {
  await withHome(async (home) => {
    const codes = new SessionCodes(home, { random: () => 1375 });
    await codes.injectOnPrompt("session-old", "/workspace", DATE);
    await codes.injectOnPrompt("session-new", "/workspace", daysLater(40));
    await codes.prune(daysLater(41));
    assert.deepEqual(await readdir(join(home, "cache-keeper", "sessions")), ["session-new.json"]);
  });
});

test("非法会话 ID 不写文件", async () => {
  await withHome(async (home) => {
    const codes = new SessionCodes(home);
    await assert.rejects(
      codes.injectOnPrompt("../escape", "/workspace", DATE),
      (error: unknown) => error instanceof SessionCodeError && error.kind === "invalid",
    );
  });
});

test("会话结束后短码保留，恢复会话复用同一短码", async () => {
  await withHome(async (home) => {
    const codes = new SessionCodes(home, { random: () => 1375 });
    assert.equal(await codes.injectOnPrompt("session-a", "/workspace", DATE), CODE);
    // SessionStart 恢复会话：只置补发标志，不会重新生成短码
    await codes.markNeedsInjection("session-a", daysLater(1));
    assert.equal(await codes.injectOnPrompt("session-a", "/workspace", daysLater(1)), CODE);
    assert.equal((await codes.resolve(CODE, daysLater(1))).sessionId, "session-a");
    // 清理只由 TTL 负责
    await codes.prune(daysLater(32));
    await assert.rejects(readFile(join(home, "cache-keeper", "sessions", "session-a.json"), "utf8"));
  });
});
