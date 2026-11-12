import { randomInt } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FILE_VERSION = 1;
const CODE_TTL_MS = 30 * 24 * 60 * 60_000;
const TOUCH_INTERVAL_MS = 60 * 60_000;
const MAX_CODE_ATTEMPTS = 100;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export type SessionCodeErrorKind = "invalid" | "unknown" | "conflict";

export interface SessionCodeRecord {
  version: 1;
  code: string;
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  needsInjection: boolean;
}

export interface ResolvedCode {
  code: string;
  sessionId: string;
  cwd: string;
}

export class SessionCodeError extends Error {
  readonly kind: SessionCodeErrorKind;

  constructor(kind: SessionCodeErrorKind, message: string) {
    super(message);
    this.name = "SessionCodeError";
    this.kind = kind;
  }
}

/** Luhn 校验位：对 payload 计算，追加后完整数字应通过 Luhn。 */
export function luhnCheckDigit(payload: string): number {
  let sum = 0;
  let double = true;
  for (let index = payload.length - 1; index >= 0; index -= 1) {
    let digit = Number(payload[index]);
    if (!Number.isInteger(digit)) return -1;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidCode(code: string): boolean {
  if (!/^\d{9}$/.test(code)) return false;
  return luhnCheckDigit(code.slice(0, 8)) === Number(code[8]);
}

/** 接受空白和连字符，返回 9 位短码；无法规范化时返回空串。 */
export function normalizeCode(value: string): string {
  const normalized = value.trim().replace(/[\s-]/g, "");
  return /^\d{9}$/.test(normalized) ? normalized : "";
}

/** MMDD + 4 位随机 + 1 位 Luhn 校验。 */
export function makeCode(date: Date, nextRandom: () => number = () => randomInt(0, 10_000)): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const random = String(Math.abs(Math.trunc(nextRandom())) % 10_000).padStart(4, "0");
  const payload = `${month}${day}${random}`;
  return `${payload}${luhnCheckDigit(payload)}`;
}

function parseRecord(raw: unknown, sessionId: string): SessionCodeRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record["version"] !== FILE_VERSION || record["sessionId"] !== sessionId) return null;
  const code = typeof record["code"] === "string" ? record["code"] : "";
  const cwd = typeof record["cwd"] === "string" ? record["cwd"] : "";
  const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : "";
  const updatedAt = typeof record["updatedAt"] === "string" ? record["updatedAt"] : "";
  if (!isValidCode(code) || createdAt.length === 0 || updatedAt.length === 0) return null;
  return {
    version: 1,
    code,
    sessionId,
    cwd,
    createdAt,
    updatedAt,
    needsInjection: record["needsInjection"] === true,
  };
}

/**
 * 每个会话一个短码文件，供 hook 生成、控制器解析。
 * 文件不存标题、消息正文或凭据。
 */
export class SessionCodes {
  private readonly dir: string;
  private readonly random: () => number;

  constructor(home: string, options: { random?: () => number } = {}) {
    this.dir = join(home, "cache-keeper", "sessions");
    this.random = options.random ?? (() => randomInt(0, 10_000));
  }

  async read(sessionId: string): Promise<SessionCodeRecord | null> {
    try {
      const raw = JSON.parse(await readFile(this.pathFor(sessionId), "utf8")) as unknown;
      return parseRecord(raw, sessionId);
    } catch {
      return null;
    }
  }

  /**
   * 每次提交调用：没有文件时生成并返回要注入的短码；
   * needsInjection 为 true 时返回同一个短码；其余情况静默返回 null。
   */
  async injectOnPrompt(sessionId: string, cwd: string, now = new Date()): Promise<string | null> {
    const existing = await this.read(sessionId);
    if (existing !== null) {
      const regenerate = !isValidCode(existing.code);
      const code = regenerate ? await this.generate(now) : existing.code;
      const inject = existing.needsInjection || regenerate;
      const stale = now.getTime() - Date.parse(existing.updatedAt) > TOUCH_INTERVAL_MS;
      const nextCwd = existing.cwd.length > 0 ? existing.cwd : cwd;
      if (inject || stale || nextCwd !== existing.cwd) {
        await this.write({
          ...existing,
          code,
          cwd: nextCwd,
          updatedAt: now.toISOString(),
          needsInjection: false,
        });
      }
      return inject ? code : null;
    }

    const code = await this.generate(now);
    await this.write({
      version: 1,
      code,
      sessionId,
      cwd,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      needsInjection: false,
    });
    return code;
  }

  /** SessionStart / PreCompact / PostCompact：下次提交补发同一个码。 */
  async markNeedsInjection(sessionId: string, now = new Date()): Promise<void> {
    const existing = await this.read(sessionId);
    if (existing === null) return;
    await this.write({
      ...existing,
      updatedAt: now.toISOString(),
      needsInjection: true,
    });
  }

  /**
   * 短码解析：先验格式与 Luhn，再在未过期文件中查唯一匹配。
   * 重复码或找不到都报错，不做任何猜测。
   */
  async resolve(code: string, now = new Date()): Promise<ResolvedCode> {
    const normalized = normalizeCode(code);
    if (normalized.length === 0 || !isValidCode(normalized)) {
      throw new SessionCodeError("invalid", "短码格式或校验位无效");
    }
    const matches = (await this.list()).filter(
      (record) => record.code === normalized && now.getTime() - Date.parse(record.updatedAt) <= CODE_TTL_MS,
    );
    if (matches.length === 0) {
      throw new SessionCodeError("unknown", "未找到该短码对应的会话，可能已过期；请重启或恢复会话以重新获取");
    }
    if (matches.length > 1) {
      throw new SessionCodeError("conflict", "短码冲突：多个会话使用同一短码，请重启相关会话");
    }
    const record = matches[0]!;
    return { code: normalized, sessionId: record.sessionId, cwd: record.cwd };
  }

  /** 清理过期或损坏的文件；正常由控制器定期调用，hook 生成时也会顺带扫描。 */
  async prune(now = new Date()): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.dir, name);
      const sessionId = name.slice(0, -".json".length);
      let record: SessionCodeRecord | null = null;
      try {
        record = parseRecord(JSON.parse(await readFile(path, "utf8")) as unknown, sessionId);
      } catch {
        record = null;
      }
      if (record === null || now.getTime() - Date.parse(record.updatedAt) > CODE_TTL_MS) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  }

  private async list(): Promise<SessionCodeRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: SessionCodeRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -".json".length);
      try {
        const raw = JSON.parse(await readFile(join(this.dir, name), "utf8")) as unknown;
        const record = parseRecord(raw, sessionId);
        if (record !== null) records.push(record);
      } catch {
        // 损坏文件按不存在处理，prune 会清理
      }
    }
    return records;
  }

  private async generate(now: Date): Promise<string> {
    await this.prune(now);
    const existing = new Set((await this.list()).map((record) => record.code));
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
      const code = makeCode(now, this.random);
      if (!existing.has(code)) return code;
    }
    throw new SessionCodeError("conflict", "无法生成唯一短码，请稍后重试");
  }

  private async write(record: SessionCodeRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = this.pathFor(record.sessionId);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, path);
  }

  private pathFor(sessionId: string): string {
    if (
      sessionId.length === 0
      || sessionId === "."
      || sessionId === ".."
      || !SESSION_ID_PATTERN.test(sessionId)
    ) {
      throw new SessionCodeError("invalid", `非法会话 ID：${sessionId}`);
    }
    return join(this.dir, `${sessionId}.json`);
  }
}
