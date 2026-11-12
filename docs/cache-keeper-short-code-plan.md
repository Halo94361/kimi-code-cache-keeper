# 会话短码与按会话隔离方案

状态：已实现（v0.2.2）
日期：2026-11-12
关联：`docs/cache-keeper-plugin-plan.md`

## 1. 背景

当前实现依赖 `UserPromptSubmit` hook 在**每一轮**注入会话信息：

```xml
<hook_result hook_event="UserPromptSubmit">
cache-keeper 会话信息：session_id=session_...，cwd=...
</hook_result>
```

它同时带来三个问题：

- 每轮都在对话里显示一个 hook 块。
- 每轮都向模型上下文重复注入同样内容，长会话累积 N 份。
- 完整 `session_id` 很长，模型调用 MCP 工具时手动传参有抄错风险。

不能退回到“按 cwd + busy 推断当前会话”：

- 同一工作目录可以同时运行多个对话，推断必然歧义。
- MCP 工具调用不携带 Kimi 的 session id（`tools/call` 参数和 MCP 进程环境都只有 `KIMI_CODE_HOME` / `KIMI_PLUGIN_ROOT`），没有可靠的调用者身份。
- 任何按 cwd 猜测“所有权”的实现都会允许会话 A 操作会话 B。

## 2. 目标

- 每个会话有自己的短码，MCP 工具只接受短码，精确映射到该会话。
- 短码只在**每个会话激活后第一次提交**时注入一次；其余提交完全静默。
- 多会话并发、同 cwd 并发时互不干扰。
- 不改变 OpenCode Go 请求代理的协议、路径和时序。
- 短码可清理，不永久堆积；清理不能误伤活跃会话。

非目标：

- 不提供“操作其它会话”的通用入口。MCP 不接受 `sessionId`，也不做推断。
- 不把短码当作安全边界。它用于避免误指和抄错，不用于对抗同用户本地进程。
- 不修改 Kimi CLI 源码，不引入模型代理。

## 3. 短码规格

格式：`MMDD + RRRR + C`，共 9 位数字。

- `MMDD`：生成时的本地日期，例如 11 月 12 日 → `1112`。
- `RRRR`：4 位随机数字，`crypto.randomInt(0, 10000)` 补零。
- `C`：Luhn 校验位，对前 8 位计算。

示例：`1112` + `1375` + `7` → **`111213757`**。

规则：

- 生成后校验完整 9 位的 Luhn；必须通过。
- 查重范围：`sessions/` 下所有现存活短码。整个 9 位重复则重新抽 4 位随机数，最多重试若干次。
- 控制器解析时先验 Luhn，再查表；校验失败直接拒绝，不进入会话映射。
- 短码不是 secret，不写入日志；日志只记录会话 id 和匹配结果。
- 日期前缀只用于可读性和排障，不承担唯一性。

## 4. 会话码文件与生命周期

每个会话一个文件，避免多会话并发写同一个大文件：

```text
<KIMI_CODE_HOME>/cache-keeper/sessions/<sessionId>.json
```

```json
{
  "version": 1,
  "code": "111213757",
  "sessionId": "session_...",
  "cwd": "/workspace",
  "createdAt": "2026-11-12T10:00:00.000Z",
  "updatedAt": "2026-11-12T10:00:00.000Z",
  "needsInjection": false
}
```

- 目录 `700`，文件 `600`（Windows 忽略 POSIX mode，依赖用户目录 ACL）。
- 文件名使用原始 `sessionId`；写文件前做路径字符校验，禁止 `/`、`\`、`..`。
- 原子写：临时文件 + rename。
- 不存标题、消息正文、token、provider key。

生命周期：

| 事件 | 行为 |
| --- | --- |
| 首次 `UserPromptSubmit`（无文件） | 生成短码、写文件、注入一次 |
| 后续 `UserPromptSubmit` | 不输出，静默 |
| `SessionStart`（含恢复会话） | 文件存在则置 `needsInjection=true`；不删除，不使旧码失效 |
| `PreCompact` | 置 `needsInjection=true`，下次提交补发同一个短码；该 hook 被 Kimi `await`，不依赖时序运气 |
| `PostCompact` | 幂等兜底，同样置标志；Kimi 对它 `fireAndForget`，不作为唯一依赖 |
| `SessionEnd` | 不删除该会话文件；短码保留给恢复会话复用，回收交给 TTL |
| 控制器启动 / 定期 | 清理 `updatedAt` 超过 30 天的文件 |
| 每次注入或活动 | 刷新 `updatedAt`，避免活跃长会话被 TTL 误删 |

设计理由：

- `SessionStart` 只置标志、不删除，避免“恢复会话后旧码立即失效”，也兼容没有新用户消息的自动续跑。
- `PreCompact` 置标志，解决上下文压缩把短码摘要掉的问题；下次用户提交时补发。该事件被 Kimi `await`，`PostCompact` 是 `fireAndForget`，因此以 `PreCompact` 为主、`PostCompact` 仅做幂等兜底，避免“压缩后用户立刻提交”时标志还没落盘。
- `SessionEnd` 不删除文件：压缩、插件重载或恢复会话都会走会话重建，删除会让短码漂移；短码必须在一个会话的整个生命周期内稳定。回收只由 30 天 TTL 负责（控制器每小时扫描一次）。
- 保活 fork 的 `SessionStart` 被 Kimi 跳过（source=`fork`），不会生成短码文件。

## 5. 注入行为

`UserPromptSubmit` hook 每次都会执行（Kimi 不支持按会话动态注销 hook），但只在以下情况输出：

- 没有会话文件；
- 或 `needsInjection=true`。

输出内容（单行）：

```text
cache-keeper 会话码：111213757。调用缓存保活 MCP 工具时传 code=111213757；仅本会话有效。
```

其他提交输出空字符串。依据 Kimi 的 `userPromptHookMessage()` 与 `renderUserPromptHookResult()`：

- 空/纯空白 stdout 返回 `undefined`；消息列表为空时不会 push `hookParts`，也不会派发 `HookResult` 事件。
- 因此没有 hook 卡片、没有上下文注入；只有正常的 hook 进程启动开销（约几十毫秒）。

首次注入会显示一次 hook 块并进入上下文一次，这是本方案接受的唯一可见成本。

## 6. MCP 与控制接口

MCP 工具（全部要求 `code`，不再接受 `sessionId` / `cwd` 作为定位依据）：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `on` | `code` | 开启该会话保活 |
| `off` | `code` | 停止该会话保活 |
| `status` | `code` | 只返回该会话状态 |

- 移除 MCP 的 `stop`（停止全部），避免跨会话操作。全局停止保留在控制器接口，供桌面壳使用。
- 短码缺失、Luhn 失败、未找到 → 返回明确错误；不回退到 cwd/busy 推断。
- 不提供 `now`：手动触发会与当前回合并发，且“继续对话”本身就是最真实的缓存刷新。
- 真实回合开始、`off`、`stop` 时取消在飞探测：Web 路径 abort prompt 并删除 fork，ACP 路径发送 `session/cancel`，避免父会话和保活 fork 同时请求。
- 控制器每 30 秒通过同实例 Web 的 `/api/v1/sessions/{id}` 校正真实 `busy` 状态：漏送 `TurnStarted`/`Stop` 时自动补上，避免 `busy` 卡死导致永不计时；纯 CLI 无 Web 时仍只依赖活动 hook。

控制器接口：

```text
POST /v1/code/on      { "code": "111213757" }
POST /v1/code/off     { "code": "111213757" }
GET  /v1/code/111213757
GET  /v1/status                     # 全局视图，仅桌面壳使用
POST /v1/sessions/{id}/...          # 既有管理接口，保留给桌面壳
```

控制器新增 `session-codes` 模块，负责：

- 读取/扫描 `sessions/`，建立 code → { sessionId, cwd } 映射；
- Luhn 校验；
- TTL 清理；
- 重复短码检测（若两个文件同码，报错，不猜测）。

## 7. 撤销/回退语义

结论：**撤销本轮对话不会停止保活。**

- 保活状态属于控制器，持久化在 `<KIMI_CODE_HOME>/cache-keeper/state.json`，并由独立进程/计时器维护。Kimi 的撤销只修改会话历史，不通知插件，也不改外部状态。
- 已经创建或正在创建的保活 fork 由控制器管理；撤销不会删除它。正在执行的探针会正常完成并清理 fork。
- `UserPromptSubmit` 的短码注入是**用户消息的一部分**（`hookParts`），撤销该轮会连同用户消息一起移除。
- `origin.kind="injection"` 的系统提醒不会被撤销；但本方案的短码不走这条通道。

由此产生一个已知边界：

- 如果被撤销的那一轮恰好是“本会话第一次提交”（或唯一一次短码补发），模型上下文里的短码会一起消失；会话文件仍在且 `needsInjection=false`，下一条普通消息不会自动补发。此时模型无法再凭短码控制该会话。
- 如果短码是在更早的轮次注入的（常见情况），撤销当前“开启保活”的指令不会影响它。
- 恢复手段：重启或恢复会话（`SessionStart` 置 `needsInjection`，下一条消息补发同一短码）；使用 `tauri_kimi` 的保活面板或控制器接口查看/停止；最迟 4 小时最大空闲后保活自动失效。
- 不引入撤销同步：Kimi 没有 undo hook，监听 wire/history 推断撤销脆弱且违背“控制器为唯一事实来源”的既有约束。

可选的额外缓解（默认不启用）：`on` 成功后由控制器把 `needsInjection` 置为 true，使下一次提交再补发一次短码。它能让“开启后撤销”场景自愈，但会给每个 `on` 增加一次可见提示，暂不纳入默认行为。

## 8. OpenCode Go 请求代理兼容性

本方案只改变“从哪个父会话开启保活”，不改变任何下游请求链路。

保持不变：

- 短码只解析出 `sessionId`；控制器继续以该 `sessionId` 作为 `parentSessionId`。
- `ForkMap` 路径不变：`<KIMI_CODE_HOME>/cache-keeper/fork-map.json`。
- 文件格式不变：`{ "version": 1, "forks": { "<forkId>": "<parentId>" } }`。
- 写入时序不变：fork 创建成功 → `forkMap.record(forkId, parentId)` → 发送保活 prompt。
- 清理时序不变：删除 fork → `forkMap.forget(forkId)`。
- `opencode-session-proxy` 仍逐请求读取 fork-map，把 `x-opencode-session` 从 fork id 映射为父会话 id。
- Linux systemd unit 不设置 `OCSP_FORK_MAP` 时使用默认路径；Windows 壳显式设置 `OCSP_FORK_MAP`，两者都指向同一文件。

不在本方案内：

- 不修改代理源码、不要求重新编译代理、不改变端口/上游/unit。
- 不改变请求体 `prompt_cache_key` / `metadata.user_id` 的取值逻辑。

兼容性验收：

1. Go 单测 `forkParent` / `inject` 全通过。
2. 用短码开启保活，等待自动探测（测试时用短 interval），确认 `fork-map.json` 出现 fork → 父会话映射。
3. 代理 debug 模式下日志出现 `source=fork-map`，注入值为父会话 id。
4. 父会话恢复正常请求时，短码层不参与，代理按 `prompt_cache_key` 正常注入。

## 9. 安全与隐私

- 短码不是安全边界：模型有文件系统权限，理论上可读取其它会话文件。它的目标是防误指、防长 ID 抄错。
- 所有状态仅包含 session id、cwd、短码、时间和匿名 usage；不存消息正文、标题、token。
- 文件权限 600/目录 700；日志不输出短码全文（可输出会话 id 和匹配结果）。
- 控制器接口只监听 loopback，沿用现有随机控制 token。
- 删除短码文件不影响保活状态文件；`off` 仍通过码精确作用到单个会话。

## 10. 测试计划

单元：

- Luhn：合法/非法校验位；单字符错误全部拒绝。
- 生成：格式、4 位补零、查重重试、同日多会话。
- 文件：原子写、权限、路径字符拒绝、TTL 清理。
- 注入判定：无文件注入；有文件且 `needsInjection=false` 静默；`needsInjection=true` 补发同一码。

控制器：

- `/v1/code/on|off|now` 精确映射；未知码/校验失败返回错误；不访问其它会话。
- 全局 `/v1/status` 仍可用；`/v1/sessions/{id}` 管理接口不受影响。

MCP：

- 工具列表为 `on/off/status`，全部要求 `code`。
- 缺失 `code` 返回参数错误；错误码不触发任何保活变更。

端到端：

- 临时 `KIMI_CODE_HOME` + 临时 `kimi web`：首条消息注入一次，第二条消息无 hook 块。
- 两个并发会话：短码不同，各自 `on/off` 互不影响。
- `SessionStart` 后下一条消息补发；`PreCompact`/`PostCompact` 后下一条消息补发，且补发的仍是同一短码；`SessionEnd` 不删除文件，恢复会话后同一短码继续可用。
- 保活 + 代理：自动探测后 fork-map 正确，代理日志 `source=fork-map`。

## 11. 实施步骤

1. 新增 `src/session-codes.ts`：短码生成、Luhn、文件读写、扫描、TTL。
2. 新增 `src/hooks/session-code.ts`：处理 `UserPromptSubmit` / `SessionStart` / `PreCompact` / `PostCompact`；短码文件在会话结束后保留，不在 `SessionEnd` 删除，避免压缩或重载后短码漂移。
3. 更新 `kimi.plugin.json` 与 `scripts/build.mjs`；版本升至 `0.2.0`。
4. 控制器增加 `/v1/code/*`，接入 `session-codes`；移除 `current`/推断路径（若存在）。
5. MCP 工具契约改为 `code`；移除 `stop`。
6. 更新 `commands/*.md` 文案，不再提 `sessionId`/`cwd` 注入。
7. 更新测试与 `scripts/e2e-plugin.mjs` 的 hook/命令计数断言。
8. 更新 README / AGENTS.md 中关于 `UserPromptSubmit` 注入和工具列表的描述。
9. 构建、全量测试、安装到 `~/.kimi-code/plugins/managed/cache-keeper`，用临时 Web 实例验证。
10. 按第 8 节做一次代理兼容性验收。

## 12. 决策记录

- **不采用**按 cwd + busy 推断：并发会话不可靠，且会允许跨会话操作。
- **不采用** `.env` + 短码但无注入：模型不会自动读取文件，短码无法送达。
- **不采用** `SessionStart` 外部 hook 输出短码：Kimi 只 await hook 结果，不注入、不显示。
- **不采用** `sessionStart.skill` 注入完整 session id：隐藏但需要模型抄长 ID；本方案用首轮 hook + 短码替代。
- **采用** 首轮 `UserPromptSubmit` 注入短码 + 每会话文件 + 控制器精确映射。
- **接受** 每个会话激活后第一次提交显示一次短码提示；其余提交静默。
- **撤销不同步**：控制器是保活状态的唯一事实来源；撤销只影响对话历史。

## 13. 实现与验证结果（2026-11-12，v0.2.2）

- `npm run check`：类型检查、55 个测试、构建全部通过。
- 0.2.1 移除手动 `now`；真实回合开始、`off`、`stop` 会取消在飞探测（Web abort prompt + 删除 fork，ACP 发送 `session/cancel`）。
- 0.2.2 增加 Web 会话状态 reconcile：实测发现 Stop hook 可能漏送，`busy` 卡在 true 导致不进入 20 分钟计时；现在控制器每 30 秒按真实 `busy` 校正。
- 直接执行 hook：首条提交注入；第二条空输出；SessionStart / PreCompact / PostCompact 后补发同一短码。
- 临时 Kimi Web 实例加载插件：version 0.2.0，state ok，4 commands / 9 hooks / 1 MCP。
- 打包后的 controller：`/v1/code/on|off` 正常，非法校验位返回 400；`/v1/code/:code` 返回单会话状态。
- 代理兼容：`fork-map.ts`、`keepalive.ts`、`web-keepalive.ts`、`session-ownership.ts` 均未改动；`opencode-session-proxy` 的 Go 测试通过。
- 旧控制器已停止；下一个 MCP 调用会从新 dist 启动控制器。
