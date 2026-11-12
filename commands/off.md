---
description: 关闭当前会话的缓存保活并清理临时 fork
---

调用 cache-keeper 插件 keeper MCP server 的 `off` 工具，使用 `UserPromptSubmit` hook 注入的 `session_id` 作为 `sessionId`。简短报告工具返回的 off 操作结果。不要调用其他工具，不要执行项目任务。若工具不可用或缺少会话信息，直接报告失败原因，不要猜测成功。
