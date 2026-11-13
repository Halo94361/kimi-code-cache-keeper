# Kimi Code Cache Keeper

Keeps the provider-side prompt cache warm for idle Kimi Code sessions.

**Keep-alive messages never enter your main conversation.** Each probe runs
in a temporary ACP or `kimi web` fork, unlike skill-based approaches that
inject messages into the session. The main conversation keeps no trace of
the request or the reply.

[中文说明](#中文说明)

## Features

- **No keep-alive prompt or reply in the main session**
- Default: one probe 20 minutes after the last turn; stops after 4 hours idle
- Controller restarts keep the planned probe time; overdue probes run immediately
- Per-session 9-digit short code; on/off/status act only on the calling session
- Global stop all remains on the controller API for the desktop shell
- Slash commands and MCP tools
- Fork ownership allowlist: only forks created by this plugin can be deleted
- Writes `fork-map.json` so a local proxy can reuse the parent session's
  OpenCode Go cache affinity

## Requirements

- Node.js 22+
- Kimi Code CLI with `session/fork` and `session/delete` (verified on 2.5.3)
- A running `kimi web` for the REST path; otherwise ACP is used

## Install

```text
/plugins install https://github.com/Halo94361/kimi-code-cache-keeper/releases/download/v0.2.10/cache-keeper-0.2.10.zip
/plugins reload
```

From a local checkout: `npm ci && npm run build`, then
`/plugins install <path-to-repo>` and `/plugins reload`.

## Usage

| Command | Action |
| --- | --- |
| `/cache-keeper:on` | enable keep-alive for the current session |
| `/cache-keeper:off` | disable it |
| `/cache-keeper:status` | countdown, last hit ratio, state |

The same actions are also shipped as Skills, which is the only way to reach
them from the web UI (`/` there lists built-in commands and Skills, not plugin
commands): `/skill:cache-keeper:on`, `/skill:cache-keeper:off`,
`/skill:cache-keeper:status`. Both routes call the same MCP tools.


MCP tools: `on`, `off`, `status`. Every tool takes the session's 9-digit
short code, injected once when the session becomes active. The code
maps to exactly one session; there is no cwd/busy inference. The control
token never reaches the model.

## Compatibility and limits

- Verified on Kimi Code CLI 2.5.3, Windows. Linux code paths exist but are
  less tested.
- The REST path uses kimi web's internal endpoints; CLI upgrades may change
  them. Failures surface as `error` / `paused` instead of silently skipping.
- The OpenCode Go `x-opencode-session` fix needs `opencode-session-proxy`
  shipped with `tauri_kimi` 0.7.7+. A plain CLI install gets the fork
  keep-alive only, not that header repair.
- The controller reconciles the real session busy state through `kimi web`
  every 30 seconds; a missed Stop hook still starts the idle timer.
- Oversized or unparsable requests may fall back to a process-wide session ID.
- State lives in `<KIMI_CODE_HOME>/cache-keeper/state.json`; it contains no
  message content, tokens or API keys.
- Session short codes live in `<KIMI_CODE_HOME>/cache-keeper/sessions/`
  (one file per session, 30-day TTL); they contain only the code, session ID,
  cwd and timestamps.
- Each probe appends one JSONL line per step to
  `<KIMI_CODE_HOME>/cache-keeper/probe-log.jsonl` (512 KiB, one rotated
  generation): scheduling points, fork ids, stop reason, token counts and the
  error summary. Bearer tokens, `sk-…` keys and long hex strings are masked,
  and only ids, numbers and short summaries are written — never prompts,
  replies or credentials.

## Development

```bash
npm ci
npm run check                 # typecheck + tests + build
npm run probe -- handshake --home .probe-home
```

E2E scripts (`e2e-controller.mjs`, `e2e-cli-only.mjs`, `e2e-plugin.mjs`) use
an isolated `.probe-home`; full probes make real model requests.

## License

MIT. Community project, not affiliated with Moonshot AI.

---

## 中文说明

**保活消息不进入主会话，这是它与 Skill 方案最大的区别。** 主会话空闲时，
在临时 ACP / `kimi web` fork 中执行一次最小请求维持缓存前缀，prompt 与
回复都不会写入你的对话记录。

### 特性

- 主会话零污染，不产生保活消息或回复
- 默认最后一轮结束 20 分钟后保活，连续空闲 4 小时后自动停止
- 控制器重启沿用原定探测时间，已过点立即补一次
- 会话首次提交时注入 9 位短码，MCP 工具只作用于该短码对应的会话
- 全局停止保留在控制器接口，仅供桌面壳使用
- 同时提供 slash commands 与 MCP 工具
- fork 所有权白名单，只能删除本插件创建的临时会话
- 写入 `fork-map.json`，供本机代理复用父会话的 OpenCode Go 缓存亲和

### 安装

```text
/plugins install https://github.com/Halo94361/kimi-code-cache-keeper/releases/download/v0.2.10/cache-keeper-0.2.10.zip
/plugins reload
```

本地目录：先 `npm ci && npm run build`，再 `/plugins install <仓库路径>` 并
`/plugins reload`。

### 使用

| 命令 | 作用 |
| --- | --- |
| `/cache-keeper:on` | 开启当前会话保活 |
| `/cache-keeper:off` | 关闭 |
| `/cache-keeper:status` | 查看倒计时、命中率与状态 |

同名的 Skill 提供 web 端入口（web UI 的 `/` 菜单只列内置命令与 Skill，
不列插件命令）：`/skill:cache-keeper:on`、`/skill:cache-keeper:off`、
`/skill:cache-keeper:status`。两者调用同一批 MCP 工具，效果一致。


MCP 提供 `on`、`off`、`status` 三个工具，均接收本会话的 9 位短码。
短码在会话激活后首次提交时注入一次，精确映射到单个会话；不再按
`cwd`/忙碌状态推断，也不接受其他会话的 `sessionId`。控制 token 不进入上下文。

### 兼容性与限制

- 在 Kimi Code CLI 2.5.3（Windows）验证；Linux 代码路径可用但测试较少
- Web 模式使用 kimi web 内部 REST 端点，CLI 升级可能变化；失败会标记为
  `error` / `paused`，不会静默跳过
- OpenCode Go 的 `x-opencode-session` 修复需要 `tauri_kimi` 0.7.7+ 附带的
  `opencode-session-proxy`；纯 CLI 安装只获得 fork 保活
- 控制器每 30 秒通过 `kimi web` 的真实忙碌状态校正计时；漏掉 Stop hook 仍会开始空闲倒计时
- 超过请求体上限或无法解析时退回进程级会话 ID
- 状态保存在 `<KIMI_CODE_HOME>/cache-keeper/state.json`，不含消息正文、
  token 或 API key
- 会话短码保存在 `<KIMI_CODE_HOME>/cache-keeper/sessions/`（每会话一个文件，
  30 天 TTL），只含短码、session ID、cwd 和时间戳
- 每次保活按步骤追加一行 JSONL 到
  `<KIMI_CODE_HOME>/cache-keeper/probe-log.jsonl`（512 KiB，轮转一代）：调度
  时间点、fork id、stop reason、token 计数和错误摘要。Bearer token、`sk-…`
  密钥和长 hex 串会被脱敏，只写 id、数字和短摘要，不写请求/回复正文与凭据

### 开发

```bash
npm ci
npm run check                 # 类型检查 + 测试 + 构建
npm run probe -- handshake --home .probe-home
```

E2E 脚本使用隔离的 `.probe-home`；完整 probe 会产生真实模型请求。

### 许可证

MIT。社区项目，与 Moonshot AI 官方无关。
