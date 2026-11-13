# AGENTS.md - Kimi Code Cache Keeper 开发指南

## 项目目标

本仓库实现一个 Kimi Code 缓存保活插件。主会话空闲达到阈值后，通过 ACP 创建独立的临时 fork，在 fork 内执行最小模型请求，以维持主会话共享的 prompt-cache 前缀；主会话恢复活动后清理 fork。

短码与会话隔离的完整设计见 `docs/cache-keeper-short-code-plan.md`；实现以该文档为准，不按 cwd/busy 推断会话身份。

## 架构约束

- 使用 **ACP（Agent Client Protocol）**，核心调用为 `session/fork`、`session/prompt`、`session/cancel`、`session/delete`。
- 保活消息只能进入临时 fork，禁止在主会话中发送心跳。
- 不修改 Kimi CLI 源码，不引入模型代理，不修改 provider `base_url`。
- 不使用 `CronCreate`、`WaitFor` 或主会话定时回复。
- 通过 MCP 提供 `on` / `off` / `status` 薄封装，全部以本会话 9 位短码 `code` 为唯一定位参数；不向模型暴露 `now` / `stop`，也不接受 `sessionId` 或按 cwd/busy 推断。slash commands 直接指示模型调用对应工具，控制 token 不得暴露给模型。
- `UserPromptSubmit` 只在会话首次激活、`SessionStart` 恢复或 `PreCompact`/`PostCompact` 后补发时注入短码；其余提交输出空字符串。短码文件是会话身份的唯一映射，控制器只按码精确解析，禁止跨会话猜测。会话结束不删除短码，压缩/重载/恢复后仍是同一码，回收只靠 30 天 TTL。
- 控制器是独立的 Node.js 进程，每个 `KIMI_CODE_HOME` 最多一个实例，不依赖 Web 会话常驻内存。
- 控制器每 30 秒通过同实例 Web 的 session busy 状态校正 `TurnStarted`/`Stop` 漏送；Web 晚于控制器启动或重启换端口时重新发现端点；纯 CLI 无 Web 时仅依赖活动 hook。
- 插件 commands 和 hooks 保持薄入口，会话状态机、ACP 通信和安全策略放在可测试的核心模块中。

## 技术栈与结构

- TypeScript + Node.js 22+
- `@agentclientprotocol/sdk@1.x`
- `tsc --noEmit` 类型检查
- esbuild 将 TypeScript 与生产依赖打包为普通 JS，用户无需执行 npm install
- Node.js 内置 `node:test`

规划结构：

```text
kimi.plugin.json
commands/             # on / off / status / now
src/
  acp-client.ts
  controller.ts
  fork-map.ts
  probe-log.ts
  session-codes.ts
  session-registry.ts
  scheduler.ts
  safety.ts
  hooks/
test/
dist/                 # 构建产物，不直接提交
```

依赖必须显式写入 `package.json` 和 lockfile，不假设全局 npm 包存在。新代码优先使用 Node.js 内置能力，避免不必要依赖。

## 安全红线

- 禁止提交或打印 API key、OAuth token、cookie、凭据文件、SSH 私钥和 `.env` 内容。
- 不读取 `~/.kimi-code/credentials/` 或其他凭据存储；ACP 复用 CLI 自身登录状态。仅允许为同实例 Web REST 只读发现 `server.token`、`server/instances/` 元数据和启动日志中的地址与 token，禁止输出、复制、持久化或上传这些凭据。
- 不把真实会话导出、`wire.jsonl`、私人对话或项目代码提交为测试夹具。夹具必须人工构造并脱敏。
- 日志与持久化状态不得包含 token、请求正文、回复正文或完整会话内容，只保存开关、session ID、计时和匿名 usage 统计。诊断日志统一走 `probe-log.ts` 落 `cache-keeper/probe-log.jsonl`，写入前对 Bearer、`sk-` 密钥和长 hex 做脱敏，并对字段截断。
- 只能取消或删除控制器自己创建且归属明确的保活 fork；无法确认归属时保留并报告，禁止误删。
- ACP driver 必须使用创建时登记、删除时校验的所有权白名单：生产保活路径禁止删除原始 session 和未知 session；fork 返回值与父会话相同时立即失败。阶段 0 自建测试父会话的清理也必须单独显式开启，不得默认可用。
- 真实 ACP 验证使用独立测试会话和隔离的 `KIMI_CODE_HOME`，不得操作用户现有正式会话。
- 保活 fork 使用需要审批的权限模式，拒绝所有权限请求；出现 tool-call 事件时立即取消并暂停该会话保活。

## 开发约定

- 面向用户的说明使用中文，代码、标识符、命令和协议字段保持英文。
- 做最小、聚焦的修改，不引入过早抽象，不顺手修改无关文件。
- 注释使用中文，描述设计意图、协议约束和安全边界，不写一次性排障记录。
- 新增功能或修复时同步更新测试和文档；测试失败或真实场景未验证时不得宣称完成。
- 默认保活间隔 20 分钟，最大连续空闲保活时长 4 小时；连续 miss、网络错误或 401/403 必须暂停，不无限重试。控制器重启恢复时必须沿用已持久化的下次探测时间或最后一轮结束时间，已过点立即补探测，不得重置为空闲起点。
- 不通过降低验收标准来绕过 ACP、缓存命中或会话锁问题；受阻时明确记录并报告。

## 阶段 0 验收门槛

在完整插件开发前，必须验证：

1. ACP 能与正在运行的 `kimi web` 会话协作，跨进程 session lock 不阻止预期流程。
2. fork 与主会话的 `systemPromptHash`、`toolsHash`、model 和协议一致。
3. fork 的保活请求能读取主会话留下的缓存前缀，超过原缓存期限后主会话仍能命中。
4. 主会话 `wire.jsonl` 不包含保活消息，删除 fork 不影响主会话。
5. `UserPromptSubmit` 能在会话首次激活时注入 9 位短码，后续提交静默；短码可精确映射到单个会话，不依赖 cwd/busy 推断。
6. 保活 fork 的工具调用会被拒绝，清理逻辑不会触及非本插件创建的会话。

如果 ACP 与 Web 生成的前缀不一致，先暂停完整实现，评估同一 `kimi web` 进程的公开 REST `:fork` + `prompts`，不要退回模型代理或主会话心跳。

## 参考资料

- [Kimi Code ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [Kimi Code Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
- [Kimi Code Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
- [Kimi Code Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
