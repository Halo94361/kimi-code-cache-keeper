# Kimi Code Cache Keeper

一个处于设计验证阶段的 Kimi Code 插件：在主会话空闲时，通过 ACP 创建独立的临时 fork 会话进行 prompt-cache 保活，避免保活消息污染主会话上下文。

## 目标

- 使用公开的 ACP 接口，不修改 Kimi CLI 源码。
- 复用现有 Kimi Code 登录，不引入模型代理，不修改 provider `base_url`。
- 保活 prompt 和回复只进入临时 fork，主会话不出现心跳消息。
- 主会话恢复活动后，取消并清理对应的保活 fork。
- 默认有限时间、有限次数保活，异常时停止，不无限消耗配额。
- 同时支持 Kimi Code CLI 与 `kimi web`，首版以 Windows 为开发验证环境。

## 方案概述

```text
主会话 A 一轮结束
  → 控制器启动 20 分钟空闲计时
  → 空闲到点后通过 ACP fork 出会话 B
  → B 只回复“1”，记录缓存 usage
  → A 恢复活动时取消并删除 B
  → A 下一轮结束后重新计时
```

插件计划提供以下命令：

```text
/cache-keeper:on
/cache-keeper:off
/cache-keeper:status
/cache-keeper:now
```

## 技术选型

- TypeScript + Node.js 22+
- `@agentclientprotocol/sdk@1.x`
- `tsc --noEmit` 类型检查
- esbuild 发布打包
- Node.js 内置 `node:test`

首版不使用 Cron、WaitFor、主会话心跳或 MCP 工具，避免增加主会话内容和改变模型请求的工具前缀。

## 当前状态

仓库刚初始化，尚未进入实现。下一步先完成 ACP 可行性验证：确认 fork 与主会话的缓存前缀一致、ACP 能与正在运行的 `kimi web` 会话协作，并验证缓存命中和 fork 清理流程。

## 安全与隐私

本仓库不得提交任何 API key、OAuth token、凭据文件、真实会话导出、`wire.jsonl` 或包含私人对话内容的测试数据。测试夹具必须使用人工构造且经过脱敏的内容。

本项目是社区工具，与 Moonshot AI 官方无关。缓存行为和实际收益以服务端行为及真实用量统计为准。
