import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 诊断日志字段：只收 id、数字、布尔和短字符串，避免正文与凭据落盘。 */
export type ProbeLogFields = Record<string, string | number | boolean | null>;

export type ProbeLogger = (event: string, fields?: ProbeLogFields) => void;

export interface ProbeLogOptions {
  /** 单文件上限；写满后轮转为 `.1`，只保留一代。 */
  maxBytes?: number;
  /** 单个字符串字段的长度上限，超出截断。 */
  maxFieldChars?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_FIELD_CHARS = 240;
const PATTERNS: Array<[RegExp, string]> = [
  [/(bearer\s+)[^\s"']+/gi, "$1***"],
  [/\bsk-[A-Za-z0-9_-]{8,}/gi, "sk-***"],
  [/\b[0-9a-f]{32,}\b/gi, "***"],
];

function sanitize(value: string, maxChars: number): string {
  let clean = value;
  for (const [pattern, replacement] of PATTERNS) clean = clean.replace(pattern, replacement);
  clean = clean.replace(/[\r\n\t]+/g, " ");
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}…` : clean;
}

/**
 * 保活诊断日志（`<KIMI_CODE_HOME>/cache-keeper/probe-log.jsonl`）。
 * 控制器是脱离终端的后台进程，stdout 不可见；出现"请求确实发出去了、账面却为空"
 * 这类问题时只能靠这份追加日志核对每次探测的步骤、用量和失败原因。
 * 写入串行、尽力而为：日志故障绝不影响保活本身。
 */
export class ProbeLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFieldChars: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(home: string, options: ProbeLogOptions = {}) {
    this.path = join(home, "cache-keeper", "probe-log.jsonl");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFieldChars = options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS;
  }

  readonly record: ProbeLogger = (event, fields = {}) => {
    const entry: Record<string, unknown> = { ts: new Date().toISOString(), event };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = typeof value === "string" ? sanitize(value, this.maxFieldChars) : value;
    }
    const line = JSON.stringify(entry);
    this.queue = this.queue.then(() => this.append(line)).catch(() => {});
  };

  private async append(line: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const size = await stat(this.path).then((stats) => stats.size).catch(() => 0);
    if (size + line.length + 1 > this.maxBytes) {
      await rename(this.path, `${this.path}.1`).catch(() => {});
    }
    await appendFile(this.path, `${line}\n`, { mode: 0o600 });
  }
}
