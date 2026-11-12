import { homedir } from "node:os";
import { join } from "node:path";
import { SessionCodes } from "../session-codes.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;

interface Payload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
}

let payload: Payload;
try {
  payload = JSON.parse(input) as Payload;
} catch {
  process.exit(0);
}

const home = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
const sessionId = payload.session_id;
const event = payload.hook_event_name;
if (!sessionId || !event) process.exit(0);

const codes = new SessionCodes(home);
try {
  if (event === "UserPromptSubmit") {
    const code = await codes.injectOnPrompt(sessionId, payload.cwd ?? "");
    if (code !== null) {
      console.log(
        `cache-keeper 会话码：${code}。调用缓存保活 MCP 工具时传 code=${code}；仅本会话有效。`,
      );
    }
  } else if (event === "SessionStart" || event === "PreCompact" || event === "PostCompact") {
    await codes.markNeedsInjection(sessionId);
  }
} catch {
  // 短码失败不阻塞对话；下一次提交或控制器会重试
}
