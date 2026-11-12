import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface RequestDiagnostic {
  provider: string;
  model: string;
  systemPromptHash: string;
  toolsHash: string;
  messageCount: number;
}

export interface UsageDiagnostic {
  inputOther: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  output: number;
  cacheHitRatio: number | null;
}

export interface SessionDiagnostics {
  wireFound: boolean;
  requests: RequestDiagnostic[];
  usage: UsageDiagnostic;
  usageRecords: UsageDiagnostic[];
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function usageDiagnostic(inputOther: number, inputCacheRead: number, inputCacheCreation: number, output: number): UsageDiagnostic {
  const inputTotal = inputOther + inputCacheRead + inputCacheCreation;
  return {
    inputOther,
    inputCacheRead,
    inputCacheCreation,
    output,
    cacheHitRatio: inputTotal > 0 ? inputCacheRead / inputTotal : null,
  };
}

export function parseWireDiagnostics(text: string): SessionDiagnostics {
  const requests: RequestDiagnostic[] = [];
  const usageRecords: UsageDiagnostic[] = [];
  let inputOther = 0;
  let inputCacheRead = 0;
  let inputCacheCreation = 0;
  let output = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const value = record as Record<string, unknown>;
    if (value["type"] === "llm.request") {
      requests.push({
        provider: stringField(value["provider"]),
        model: stringField(value["model"]),
        systemPromptHash: stringField(value["systemPromptHash"]),
        toolsHash: stringField(value["toolsHash"]),
        messageCount: numberField(value["messageCount"]),
      });
      continue;
    }
    if (value["type"] !== "usage.record" || typeof value["usage"] !== "object" || value["usage"] === null) {
      continue;
    }
    const recordUsage = value["usage"] as Record<string, unknown>;
    const other = numberField(recordUsage["inputOther"]);
    const cacheRead = numberField(recordUsage["inputCacheRead"]);
    const cacheCreation = numberField(recordUsage["inputCacheCreation"]);
    const recordOutput = numberField(recordUsage["output"]);
    inputOther += other;
    inputCacheRead += cacheRead;
    inputCacheCreation += cacheCreation;
    output += recordOutput;
    usageRecords.push(usageDiagnostic(other, cacheRead, cacheCreation, recordOutput));
  }
  return {
    wireFound: true,
    requests,
    usage: usageDiagnostic(inputOther, inputCacheRead, inputCacheCreation, output),
    usageRecords,
  };
}

function sessionDirFromIndex(indexText: string, sessionId: string): string | null {
  let found: string | null = null;
  for (const line of indexText.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record["sessionId"] === sessionId && typeof record["sessionDir"] === "string") {
        found = record["sessionDir"];
      }
    } catch {
      // 索引末尾可能留有未写完的行，之前完整记录仍可使用
    }
  }
  return found;
}

export async function readSessionDiagnostics(home: string, sessionId: string): Promise<SessionDiagnostics> {
  const root = resolve(home);
  const indexText = await readFile(resolve(root, "session_index.jsonl"), "utf8");
  const indexedDir = sessionDirFromIndex(indexText, sessionId);
  if (!indexedDir) throw new Error(`隔离 home 中找不到 session 索引：${sessionId}`);
  const sessionDir = resolve(indexedDir);
  const outside = relative(root, sessionDir);
  if (outside.startsWith("..") || isAbsolute(outside)) {
    throw new Error("session 索引指向隔离 home 之外，已拒绝读取");
  }
  try {
    const wire = await readFile(resolve(sessionDir, "agents", "main", "wire.jsonl"), "utf8");
    return parseWireDiagnostics(wire);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        wireFound: false,
        requests: [],
        usage: usageDiagnostic(0, 0, 0, 0),
        usageRecords: [],
      };
    }
    throw error;
  }
}
