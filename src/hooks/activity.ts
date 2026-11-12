import { homedir } from "node:os";
import { join } from "node:path";
import { controllerActivity } from "./control.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input) as {
  hook_event_name?: string;
  session_id?: string;
  session_title?: string;
  cwd?: string;
};
const home = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
const sessionId = payload.session_id;
const cwd = payload.cwd;
if (!sessionId || !cwd || !payload.hook_event_name) process.exit(0);

try {
  await controllerActivity(
    home,
    payload.hook_event_name,
    sessionId,
    cwd,
    payload.session_title ?? null,
  );
} catch {
  // 控制器暂不可用时让当前对话继续，后续真实请求会重试连接
}
