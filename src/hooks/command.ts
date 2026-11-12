import { parseKeeperCommand } from "../commands.js";
import { controllerCommand, controllerStatus } from "./control.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input) as {
  session_id?: string;
  session_title?: string;
  cwd?: string;
  prompt?: string;
};
const action = parseKeeperCommand(payload.prompt ?? "");
if (!action) process.exit(0);

const home = process.env.KIMI_CODE_HOME;
const sessionId = payload.session_id;
const cwd = payload.cwd;
if (!home || !sessionId || !cwd) {
  console.log(JSON.stringify({ status: "error", error: "hook 缺少 KIMI_CODE_HOME、session_id 或 cwd" }));
  process.exit(0);
}

try {
  const result = action === "status"
    ? await controllerStatus(home)
    : await controllerCommand(home, action, sessionId, cwd, payload.session_title ?? null);
  console.log(JSON.stringify(result));
} catch (error) {
  console.log(JSON.stringify({
    status: "error",
    action,
    sessionId,
    error: error instanceof Error ? error.message : String(error),
  }));
}
