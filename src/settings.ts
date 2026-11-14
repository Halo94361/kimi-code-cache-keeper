import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** `<KIMI_CODE_HOME>/cache-keeper/settings.json` 的可选覆盖项，缺省走内置默认值。 */
export interface KeeperSettings {
  intervalMs?: number;
  maxIdleMs?: number;
  /** 每个会话最多连续保活多少次；未设置表示不限。 */
  maxProbes?: number;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * 读取控制器设置。设置文件只是覆盖默认值，读不到或不合法时静默退回默认，
 * 避免因为一个手写坏的 JSON 让保活整体停摆。
 */
export async function loadSettings(home: string): Promise<KeeperSettings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(home, "cache-keeper", "settings.json"), "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const settings: KeeperSettings = {};
  const intervalMs = positiveInt(record["intervalMs"]);
  const maxIdleMs = positiveInt(record["maxIdleMs"]);
  const maxProbes = positiveInt(record["maxProbes"]);
  if (intervalMs !== undefined) settings.intervalMs = intervalMs;
  if (maxIdleMs !== undefined) settings.maxIdleMs = maxIdleMs;
  if (maxProbes !== undefined) settings.maxProbes = maxProbes;
  return settings;
}
