---
description: 开启当前会话的缓存保活
---

调用 cache-keeper 插件 keeper MCP server 的 `on` 工具，使用 `UserPromptSubmit` hook 注入的 `session_id` 作为 `sessionId`、`cwd` 作为 `cwd`，有会话标题时作为 `title`。简短报告工具返回的 on 操作结果。不要调用其他工具，不要执行项目任务。若工具不可用或缺少会话信息，直接报告失败原因，不要猜测成功。
