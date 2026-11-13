---
name: on
description: 开启本会话的缓存保活（调用 cache-keeper keeper MCP 的 on 工具）
---

调用 cache-keeper 插件 `keeper` MCP server 的 `on` 工具，`code` 使用本会话注入的 9 位短码（即 UserPromptSubmit hook 注入的「cache-keeper 会话码」）。简短报告工具返回的会话和 on 操作结果。

若短码缺失，请用户提供，不要猜测；若工具报错，直接说明失败原因。不要使用其它会话的短码，不要调用其它工具，也不要执行项目任务。
