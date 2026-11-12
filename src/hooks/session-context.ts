let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input) as {
  session_id?: string;
  session_title?: string;
  cwd?: string;
};
if (payload.session_id && payload.cwd) {
  console.log(JSON.stringify({
    cacheKeeper: {
      sessionId: payload.session_id,
      cwd: payload.cwd,
      title: payload.session_title ?? null,
      note: "调用缓存保活 MCP 工具时使用此 sessionId 和 cwd",
    },
  }));
}
