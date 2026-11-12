import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

export function assertIsolatedHome(input: string | undefined): string {
  if (!input) {
    throw new Error("真实 ACP 测试必须显式指定隔离的 --home <KIMI_CODE_HOME>");
  }
  const home = resolve(input);
  const defaultHome = resolve(homedir(), ".kimi-code");
  if (home === parse(home).root) {
    throw new Error("--home 不能是文件系统根目录");
  }
  if (home === defaultHome) {
    throw new Error("禁止使用默认 ~/.kimi-code；请使用独立的测试数据目录");
  }
  return home;
}

export function assertSessionLifecycleCapabilities(init: acp.InitializeResponse): void {
  const capabilities = init.agentCapabilities?.sessionCapabilities;
  if (capabilities?.fork == null || capabilities.delete == null) {
    throw new Error("当前 Kimi ACP 未同时声明 session/fork 与 session/delete 能力");
  }
}

export function chooseSafeModeId(modes: acp.SessionModeState | null | undefined): string {
  const available = modes?.availableModes ?? [];
  const byId = (id: string) => available.find((mode) => mode.id.toLowerCase() === id);
  const preferredIds = ["default", "manual", "ask", "always-ask", "always_ask", "alwaysask", "read-only", "readonly", "plan"];
  for (const id of preferredIds) {
    const mode = byId(id);
    if (mode) return mode.id;
  }
  const byName = available.find((mode) => /always\s*ask|manual|read[ -]?only|plan/i.test(mode.name));
  if (byName) return byName.id;
  const ids = available.map((mode) => mode.id).join(", ") || "无";
  throw new Error(`无法确认保活安全模式，ACP 可用模式：${ids}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
