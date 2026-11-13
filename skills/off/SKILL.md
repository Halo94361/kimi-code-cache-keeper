---
name: off
description: 关闭本会话的缓存保活并清理临时 fork（调用 keeper MCP 的 off 工具）
---

调用 cache-keeper 插件 `keeper` MCP server 的 `off` 工具，`code` 使用本会话注入的 9 位短码（即 UserPromptSubmit hook 注入的「cache-keeper 会话码」）。简短报告工具返回的会话和 off 操作结果。

若短码缺失（例如上下文压缩后没看到注入行），先请用户执行 `/reload`（TUI 与 kimi web 均支持），然后随便发一条消息，短码会在下一次提交时自动重新注入；仍拿不到时再请用户提供，不要猜测。若工具报错，直接说明失败原因。不要使用其它会话的短码，不要调用其它工具，也不要执行项目任务。
