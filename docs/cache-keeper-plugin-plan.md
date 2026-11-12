# Kimi Code 会话缓存保活插件方案

状态：早期设计记录
日期：2026-11-12

> 当前实现以 `docs/cache-keeper-short-code-plan.md` 和代码为准：MCP/commands 已移除 `now`，单会话停止接口为 `/v1/sessions/{id}/off`，控制器保留 `/v1/status` 与 `/v1/stop` 供桌面壳使用。

## 背景与目标

Kimi Code 的 prompt cache 会在会话空闲后失效，下一次真实请求需要重新处理较长的输入前缀。插件的目标是在用户显式开启后，对空闲会话进行有限次数的缓存保活，同时满足：

- 不修改 Kimi CLI 源码，不引入中间模型代理，不改变 provider `base_url`。
- 复用现有 OAuth 登录，不读取或持久化 provider token。
- 保活消息不进入主会话，不污染主上下文和 Web 对话记录。
- 不使用 `CronCreate`、`WaitFor` 或主会话心跳回复。
- 支持 `kimi web`，首版以 Windows 为开发验证环境。
- 默认有限时间、有限次数保活，失败时停止，不无限消耗配额。
- 为 `tauri_kimi` 壳提供稳定的本地发现、状态查询和停止接口，支持顶栏状态展示与控制。

## 方案选择

采用 **ACP 或同实例 Web REST + 一次性 fork 会话**。

纯 CLI 且父会话未被占用时，控制器作为 ACP client，通过 `kimi acp` fork 和删除保活 fork。正在运行 `kimi web` 时，控制器只读发现 `server.token` 和实例地址，通过同一个 Web 实例的 REST `:fork`、`prompts` 和 `:delete` 操作，避免跨进程 session lock。主会话 A 的保活 prompt 与回复只写入 fork 会话 B，A 恢复活动后永久删除 B。

不采用以下路线：

- **主会话定时回复**：实现简单，但心跳消息会污染主上下文。
- **provider 请求直接重放**：请求不进入任何会话，但公开插件接口无法捕获完整 provider 请求；使用本地代理会引入 base URL、OAuth 凭据槽和额外安全问题。
- **读取 `wire.jsonl` 重建请求**：`llm.request` 只有模型、hash、消息数量等元数据，没有完整消息体，不能保证精确重放。

## 总体架构

```text
Kimi 插件 commands / hooks
        │ session_id、命令、回合活动
        ▼
本地保活控制器（独立 Node.js 进程）
        │ ACP（纯 CLI）或同实例 Web REST（kimi web）
        ▼
kimi acp / kimi web
        │
        ├─ session/fork   ：主会话 A → 保活会话 B
        ├─ session/prompt  ：B 只回复“1”
        ├─ session/cancel  ：A 恢复活动时中断 B
        └─ session/delete  ：永久删除 B

tauri_kimi
        │ discovery / status / stop（仅 loopback）
        └──────────────────────┘
```

控制器独立于 `kimi web` 会话生命周期运行，避免 Web 默认 30 分钟空闲卸载影响计时。每个 `KIMI_CODE_HOME` 只运行一个控制器实例。

hooks、壳与控制器之间使用仅监听 loopback 的本地控制接口，带随机控制凭据。控制凭据只用于本地插件控制，不是 provider token，不写入日志，不提交到仓库。

## 会话生命周期

```text
主会话 A 正常结束一轮
  → Stop hook 通知控制器
  → 启动默认 20 分钟的空闲计时

A 持续空闲满 20 分钟
  → 从 A 创建 B
  → B 收到最小保活 prompt，只回复“1”
  → 记录 B 的缓存 usage，继续下一次空闲计时

A 收到新的真实用户消息或开始新回合
  → 取消 B 正在运行的 turn（如有）
  → 删除 B 并使旧计时器失效
  → A 正常继续，结束后重新计时

达到最大空闲时长或连续异常阈值
  → 删除 B，停止保活
  → 等 A 的下一次真实用户活动后再重新评估
```

初版只在需要第一次保活时创建 fork，避免用户很快返回时产生无意义的会话。后续心跳复用同一个 B；B 中心跳历史的增长不会影响 A。

默认参数：

- 保活间隔：20 分钟，不把 25 或 30 分钟当作安全 TTL。
- 最大连续空闲保活时长：4 小时，可配置或关闭。
- 连续缓存 miss、网络错误、401/403：暂停并报告，等待下一次真实活动。
- 同一主会话最多一个保活 fork、一个有效计时器。

“恢复主会话”首先定义为收到新消息或开始新回合。仅打开 Web 页面但不发消息是否能被可靠观察，留作验证项。

## 插件命令

```text
/cache-keeper:on       为当前主会话开启保活
/cache-keeper:off      关闭并清理当前主会话的保活 fork
/cache-keeper:status   查看开关、下次触发时间、次数和最近缓存命中情况
```

`UserPromptSubmit` hook 将命令文本和 `session_id` 同步给控制器；命令对应的 Agent 回复只用于展示用户主动请求的状态。需要首先验证插件 slash command 与该 hook 的执行顺序。

通过 MCP 提供 `on` / `off` / `status` 薄封装，供 LLM 调用同一控制器接口；控制 token 不暴露给模型。会话身份以短码传递，详细设计见短码方案文档。MCP 只负责控制，实际保活由独立控制器执行。

## 本地控制与壳集成接口

控制器在 `$KIMI_CODE_HOME/cache-keeper/controller.json` 写发现信息：

```json
{
  "apiVersion": 1,
  "pid": 12345,
  "port": 58921,
  "controlToken": "随机本地控制凭据",
  "updatedAt": "..."
}
```

首版控制接口：

```text
GET  /v1/status
POST /v1/sessions/{session_id}/stop
POST /v1/stop
```

`GET /v1/status` 至少返回：

```json
{
  "enabled": true,
  "sessions": [
    {
      "sessionId": "session_...",
      "title": "当前项目对话",
      "state": "waiting",
      "nextProbeAt": "...",
      "lastProbeAt": "...",
      "hitRatio": 0.98
    }
  ]
}
```

接口只暴露开关、会话标识、标题、计时、运行状态和匿名 usage 统计，不暴露对话正文、请求正文或 provider token。壳通过控制器在线状态和协议版本识别插件，不依赖 Web DOM，也不需要解析 Kimi 插件安装记录。

## tauri_kimi 顶栏集成计划

壳检测到兼容控制器后，在顶栏 stats 浮窗左侧自动显示保活组件；控制器不存在或协议不兼容时隐藏。

紧凑状态示例：

```text
[本地] [远端] [设置]   [保活 2 个会话 · 17:42 ▾] [■]     [stats...]
```

功能包括：

- 显示启用保活的会话数量和最近一次保活倒计时。
- 区分等待、正在保活、已暂停和控制器离线等状态。
- 点击展开会话明细，展示标题、状态、各会话倒计时和最近缓存命中率。
- 支持停止单个会话与全部停止；停止后以控制器确认的实际状态为准，不在 UI 中提前宣称成功。
- 壳每 5～10 秒拉取一次状态，前端每秒根据 `nextProbeAt` 本地计算倒计时，避免高频请求控制器。
- 仅对运行在本机的 `kimi web` 会话生效，不把远端托管会话混入控制列表。

顶栏 chip 放在壳现有的 `tabs.html` 中。由于顶栏 WebView 只有 36px 高，会话明细使用独立的 `cache_keeper` 子 WebView，从顶栏下方展开，不在 chip 内强行绘制超出边界的下拉框。stats 保持右侧吸附，保活组件在其左侧预留空间。

壳侧后续改动范围：

- 新增 `cache_keeper.rs`，负责发现、轮询、停止和状态事件。
- 新增 `cache_keeper_status`、`cache_keeper_stop`、`cache_keeper_stop_all` commands，并同步 Tauri ACL。
- 新增 `cache-keeper-status` 事件和独立明细页面。
- 新中文文案重新生成壳的字体子集，并按壳仓库约定更新其 AGENTS.md 与版本号。

这些壳侧修改属于后续集成阶段，不在插件阶段 0 中进行。

## 安全约束

- 控制器只删除自己创建并记录的 fork，禁止按标题模糊删除其他会话。
- ACP driver 在 `session/delete` 入口执行所有权白名单：只能删除本次调用登记的 fork，生产路径不得删除原始 session 或未知 session；fork 与父会话 ID 相同直接失败。阶段 0 测试父会话清理单独显式授权。
- 保活会话切换到需要审批的模式，ACP client 拒绝所有权限请求。
- 保活会话一旦出现 tool-call 事件，立即取消 turn、记录异常并暂停该会话的保活。
- 不执行保活模型返回的任何工具调用，不读取其正文用于后续自动化。
- 不持久化对话正文、请求正文或 OAuth token；持久化内容仅限开关、session ID、计时和匿名 usage 统计。
- 控制器与 ACP 进程失败时停止保活，不在主会话中降级发送心跳。
- 对孤儿 fork 的清理必须能可靠识别归属；无法确认归属时保留并报告，不误删。
- 本地控制接口仅监听 loopback，发现文件权限遵循当前用户私有原则；控制凭据不进入日志、状态响应或仓库。

## 技术选型

- **TypeScript + Node.js 22+**：控制器、hooks、ACP client 和测试共用一套类型。
- **`@agentclientprotocol/sdk@1.x`**：使用官方 ACP SDK，不手写 JSON-RPC 帧和会话协议。
- **TypeScript 编译与 esbuild 打包**：开发期用 `tsc --noEmit` 做类型检查，发布期将 TS 和 ACP SDK 打包为普通 JS；用户无需安装 TS 或执行 npm install。
- **Node 内置 `node:test`**：首版测试不引入额外测试框架。
- **Markdown plugin commands + 编译后的 JS hooks**：插件入口保持很薄，核心逻辑位于可测试的控制器模块。

建议结构：

```text
cache-keeper/
├── kimi.plugin.json
├── commands/
│   ├── on.md
│   ├── off.md
│   ├── status.md
├── src/
│   ├── acp-client.ts
│   ├── controller.ts
│   ├── mcp.ts
│   ├── acp-client.ts
│   ├── web-client.ts
│   ├── web-keepalive.ts
│   ├── web-discovery.ts
│   ├── session-registry.ts
│   ├── scheduler.ts
│   ├── safety.ts
│   └── hooks/
│       ├── activity.ts
│       ├── command.ts
│       └── session-context.ts
├── test/
├── package.json
├── tsconfig.json
└── dist/                 # 发布包内为编译、打包后的 JS
```

运行依赖仅限 Node.js 和现有 `kimi` 命令；ACP SDK 随发布包打包，不依赖全局 npm 包。

## 实施阶段

### 阶段 0：ACP 可行性验证

先写独立验证程序，不制作完整插件，不修改现有 Kimi 配置。

1. 初始化 ACP client，验证与正在运行的 `kimi web` 会话协作及跨进程 session lock。
2. 对测试会话执行 fork → prompt → usage → delete。
3. 比较主会话与 fork 的 `systemPromptHash`、`toolsHash`、model 和协议。
4. 检查 fork 第一次保活的 `cached_tokens` / `inputCacheRead`，再验证超过原缓存期限后主会话仍能命中缓存。
5. 验证删除 fork 不影响主会话，主会话 `wire.jsonl` 不包含保活消息。
6. 验证 Web 空闲卸载、ACP 重启和主会话恢复时的行为。
7. 验证 `UserPromptSubmit` 能同时取得插件命令和正确的 `session_id`。

缓存不命中或前缀 hash 不一致时，先停止完整实现。必要时退回到同一 `kimi web` 进程的公开 REST `:fork` + `prompts`，仍不引入模型代理。

阶段 0 原型验证结果（2026-11-12，Kimi Code CLI 2.5.3）：

- ACP 握手确认 `fork/delete/resume/close` 能力，真实父会话与 fork 均以 `end_turn` 完成 prompt，无工具活动。
- 父会话与 fork 的 `systemPromptHash`、`toolsHash`、provider 和 model 一致，即时 fork 聚合缓存命中率约 97.8%。
- fork 保活后等待 20 分钟，再恢复父会话发起请求，最近一次缓存命中率约 98.1%；fork 与父会话随后均清理成功。
- 当前 Kimi ACP 的 `PromptResponse` 未返回 usage，原型从隔离测试的 `wire.jsonl` 只提取请求 hash 与 token 数字，不输出消息正文。
- `UserPromptSubmit` 与插件 slash command 的执行顺序仍待插件包装阶段验证。

### 阶段 1：控制器 MVP

实现 ACP client、会话注册表、计时器、保活状态机、fork 清理、usage 记录和安全熔断。持久化采用原子写入；控制器重启后只恢复设置与归属明确的记录，捕获不到的实时状态以 ACP 返回为准。

同步实现 discovery/status/stop 本地接口，先用命令行或简单 HTTP client 验证，不依赖壳才能测试控制器。

### 阶段 2：插件包装

添加 manifest、commands、hooks 和安装/卸载说明，完成 on/off/status。卸载插件前提示用户先执行 off，并提供孤儿保活会话检查命令。

### 阶段 3：测试与验收

- 单元测试：计时器、状态迁移、会话归属、错误熔断、usage 解析、原子状态写入。
- ACP 集成测试：fork/prompt/cancel/delete、进程断开、未知 session、并发调用。
- 控制接口验收：发现文件更新、协议版本、单会话停止、全部停止、控制器离线和非法凭据。
- 真实 Web 验收：两个主会话并行、长任务、用户恢复、Web 空闲卸载、主会话压缩、模型切换、off、控制器重启。
- 安全验收：保活会话工具调用被拒绝，日志和状态文件不包含 token 或对话正文。
- 缓存验收：主会话恢复时缓存读取符合预期，且主上下文没有任何保活记录。

### 阶段 4：tauri_kimi 集成

先实现顶栏 chip、倒计时、会话数量和全部停止，再增加独立明细弹层与单会话停止。分别在控制器在线、离线、插件未安装、多个会话和 stats 吸附/悬浮状态下验证布局与行为。

## 后续增强

- 根据连续 hit/miss 自适应调整保活间隔。
- 增加每次保活成本、累计缓存读取和估算节省。
- 如未来出现公开 provider capture/replay API，可评估无 fork 的直接重放实现。

## 参考资料

- [Kimi Code ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html)
- [Kimi Code Server API](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/server-api.html)
- [Kimi Code Plugins](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html)
- [Kimi Code Hooks](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html)
- [Kimi Code Sessions](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html)
- [CLI `profileService.ts`：cacheKey 使用 sessionId](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/agent/profile/profileService.ts)
- [CLI `llmRequestOps.ts`：请求 trace 字段](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/agent/loop/llmRequestOps.ts)
- [社区缓存实测：Pi Kimi provider](https://github.com/Leechael/pi-provider-kimi-code/blob/main/docs/caching.md)
- [直接请求重放参考：pi-kimi-keepalive](https://github.com/realOliverSama/pi-kimi-keepalive)
- [主会话 Cron 保活参考：kimi-cache-keeper](https://github.com/RooKichenn/kimi-cache-keeper)
