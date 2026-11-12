let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input) as {
  session_id?: string;
  session_title?: string;
  cwd?: string;
};
if (payload.session_id && payload.cwd) {
  // 使用纯文本输出，确保 CLI 将会话信息注入模型上下文。
  const title = payload.session_title ? `（${payload.session_title}）` : "";
  console.log(
    `cache-keeper 会话信息：session_id=${payload.session_id}${title}，cwd=${payload.cwd}。`
    + "调用缓存保活 MCP 工具时使用此 session_id 和 cwd。",
  );
}
