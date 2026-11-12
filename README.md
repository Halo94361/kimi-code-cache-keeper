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
- Per-session on/off, probe now, status, stop all
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
/plugins install https://github.com/Halo94361/kimi-code-cache-keeper/releases/download/v0.1.4/cache-keeper-0.1.4.zip
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
| `/cache-keeper:now` | probe once after the current turn |

MCP tools: `on`, `off`, `status`, `now`, `stop`. The `UserPromptSubmit` hook
only injects the current `sessionId` and `cwd`; the control token never
reaches the model.

## Compatibility and limits

- Verified on Kimi Code CLI 2.5.3, Windows. Linux code paths exist but are
  less tested.
- The REST path uses kimi web's internal endpoints; CLI upgrades may change
  them. Failures surface as `error` / `paused` instead of silently skipping.
- The OpenCode Go `x-opencode-session` fix needs `opencode-session-proxy`
  shipped with `tauri_kimi` 0.7.7+. A plain CLI install gets the fork
  keep-alive only, not that header repair.
- Oversized or unparsable requests may fall back to a process-wide session ID.
- State lives in `<KIMI_CODE_HOME>/cache-keeper/state.json`; it contains no
  message content, tokens or API keys.

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
- 单会话开关、立即保活、状态查询、全部停止
- 同时提供 slash commands 与 MCP 工具
- fork 所有权白名单，只能删除本插件创建的临时会话
- 写入 `fork-map.json`，供本机代理复用父会话的 OpenCode Go 缓存亲和

### 安装

```text
/plugins install https://github.com/Halo94361/kimi-code-cache-keeper/releases/download/v0.1.4/cache-keeper-0.1.4.zip
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
| `/cache-keeper:now` | 当前回合结束后立即探测一次 |

MCP 提供 `on`、`off`、`status`、`now`、`stop` 五个工具。`UserPromptSubmit`
hook 只向模型提供当前 `sessionId` 与 `cwd`，控制 token 不进入上下文。

### 兼容性与限制

- 在 Kimi Code CLI 2.5.3（Windows）验证；Linux 代码路径可用但测试较少
- Web 模式使用 kimi web 内部 REST 端点，CLI 升级可能变化；失败会标记为
  `error` / `paused`，不会静默跳过
- OpenCode Go 的 `x-opencode-session` 修复需要 `tauri_kimi` 0.7.7+ 附带的
  `opencode-session-proxy`；纯 CLI 安装只获得 fork 保活
- 超过请求体上限或无法解析时退回进程级会话 ID
- 状态保存在 `<KIMI_CODE_HOME>/cache-keeper/state.json`，不含消息正文、
  token 或 API key

### 开发

```bash
npm ci
npm run check                 # 类型检查 + 测试 + 构建
npm run probe -- handshake --home .probe-home
```

E2E 脚本使用隔离的 `.probe-home`；完整 probe 会产生真实模型请求。

### 许可证

MIT。社区项目，与 Moonshot AI 官方无关。
