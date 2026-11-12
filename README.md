# Kimi Code Cache Keeper

Kimi Code 的 prompt-cache 保活插件：主会话空闲时，通过独立临时 fork 执行最小模型请求，维持共享缓存前缀，同时避免保活消息污染主会话。

## 核心特性

- 主会话不出现保活 prompt 或回复。
- 默认空闲 20 分钟后保活，真实回合自动取消并重新计时。
- 最大连续空闲保活 4 小时，异常时暂停，不无限消耗配额。
- 支持单会话开关、立即保活、状态查询和全部停止。
- 同时提供手动 slash commands 和 LLM 可调用的 MCP 工具。
- ACP driver 采用所有权白名单，只能删除本次创建的 fork，生产路径不能删除原始 session。

## 双模式工作方式

### 正在运行 `kimi web`

控制器只读发现 `$KIMI_CODE_HOME/server.token` 和 `server/instances/` 中的地址，经健康检查后，通过同一个 Web 实例的 REST 完成 fork、prompt 和永久删除。不会额外启动 Web 进程，端口变化不影响 token。

### 纯 CLI、没有运行中的 Web 实例

回退到 ACP，通过 `kimi acp` 完成 fork 和永久删除，不需要 Web token。父会话被其他进程占用时不会强行接管。

## 安装

要求：Node.js 22+，以及已安装并可用的 `kimi` 命令。

开发目录中先构建：

```bash
npm ci
npm run build
```

在 Kimi Code 中安装本地插件：

```text
/plugins install D:\My_GitLab\kimi-code-cache-keeper
/plugins reload
```

仓库公开后，也计划支持通过 GitHub release 安装。发布包中的 TypeScript 和 ACP SDK 已打包为普通 JS，不需要执行 `npm install`。

## 使用

手动命令：

```text
/cache-keeper:on       开启当前会话保活
/cache-keeper:off      关闭当前会话保活
/cache-keeper:status   查看倒计时、最近命中率和运行状态
/cache-keeper:now      在当前命令回合结束后立即保活一次
```

也可以直接对 LLM 说“开启当前会话的缓存保活”“查询保活状态”或“停止全部保活”。MCP 提供 `on`、`off`、`status`、`now`、`stop` 五个工具；`UserPromptSubmit` hook 只向模型提供当前 `sessionId` 和 `cwd`，不会暴露控制 token。

## 开发与验证

```bash
npm ci
npm run check
```

独立 ACP 验证：

```bash
# 仅握手，不发起模型请求
npm run probe -- handshake --home .probe-home

# 在隔离 home 中独立登录一次
export KIMI_CODE_HOME="$PWD/.probe-home"
kimi login

# 完整 fork/prompt/usage/delete 验证
npm run probe -- probe --home .probe-home

# fork 保活后等待 20 分钟，再恢复父会话验证
npm run probe -- probe --home .probe-home --wait-seconds 1200
```

同实例 REST 控制器验收：

```bash
node scripts/e2e-controller.mjs
```

CLI-only ACP 回退验收：

```bash
node scripts/e2e-cli-only.mjs
```

插件安装结构验收：

```bash
node scripts/e2e-plugin.mjs
```

测试统一使用隔离的 `.probe-home`，不读取或复制默认 home 中的凭据。完整 probe 会产生真实模型请求；未指定 `--session` 时，阶段 0 测试父会话与 fork 都会清理，指定已有测试父会话时只清理 fork。

## 当前验证结果

- 类型检查、32 个模拟测试和 esbuild 打包通过。
- ACP 即时 fork 验证中，前缀 hash 一致，缓存命中率约 97.8%。
- fork 保活后等待 20 分钟，再恢复父会话，最近一次缓存命中率约 98.1%。
- 同实例 REST 保活验证中，最近一次缓存命中率约 99.48%，保活 fork 已从 children 列表永久删除。
- CLI-only ACP 回退路径也已通过，缓存命中率约 99.48%。
- 插件安装结构验证通过：4 个 commands、7 个 hooks、1 个 MCP server。

## 安全与隐私

不得提交 API key、OAuth token、凭据文件、真实会话导出、`wire.jsonl` 或包含私人对话内容的测试数据。测试夹具必须人工构造并脱敏。

`server.token`、实例元数据和必要的启动日志只用于只读发现同实例 Web REST，禁止输出、复制、持久化或上传这些凭据。持久化状态仅包含开关、session ID、计时和匿名 usage 统计，不包含消息正文。

本项目是社区工具，与 Moonshot AI 官方无关。缓存行为和实际收益以服务端行为及真实用量统计为准。

## 开发计划

完整设计与实施计划见 [docs/cache-keeper-plugin-plan.md](docs/cache-keeper-plugin-plan.md)，包括 ACP 可行性验证、控制器与插件实现、本地控制接口，以及后续 `tauri_kimi` 顶栏状态与停止控制集成。
