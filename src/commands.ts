export const KEEPER_ACTIONS = ["on", "off", "status", "now"] as const;
export type KeeperAction = typeof KEEPER_ACTIONS[number];

export function parseKeeperCommand(prompt: unknown): KeeperAction | null {
  if (typeof prompt !== "string") return null;
  const match = /^\/cache-keeper:(on|off|status|now)$/.exec(prompt.trim());
  return match ? match[1] as KeeperAction : null;
}
