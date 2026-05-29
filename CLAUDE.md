# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指导。

## 项目概述

OpenClaw Mini 是 OpenClaw 核心 AI Agent 架构的最小化（约 5,700 行代码）教学级重新实现。它通过一个完整、可运行的 TypeScript 实现来演示系统级 Agent 设计，涵盖双循环 Agent 执行、事件驱动流式处理、JSONL 会话持久化、上下文窗口管理以及基于 WebSocket 的网关 RPC。

## 常用命令

```bash
pnpm install          # 安装依赖（需要 pnpm 10.23+，Node >=20）
pnpm build            # 编译 TypeScript（tsc）
pnpm dev              # 通过 tsx 运行 CLI（开发模式）
pnpm test             # 运行测试（node --test）
pnpm gateway          # 启动 Gateway WebSocket 服务器
pnpm gateway:connect  # 连接 Gateway 客户端
```

运行单个测试文件：
```bash
node --test test/session.test.ts
```

## 架构

四层架构设计，按阅读优先级排列：

```
┌─────────────────────────────────────────────────┐
│ 网关层（Gateway）  — WebSocket RPC、发布/订阅    │
├─────────────────────────────────────────────────┤
│ 工程层（Engineering）— 工具策略、沙箱、锁        │
├─────────────────────────────────────────────────┤
│ 扩展层（Extended） — 记忆、技能、心跳            │
├─────────────────────────────────────────────────┤
│ 核心层（Core）     — Agent 循环、事件、会话      │
└─────────────────────────────────────────────────┘
```

### 核心层（从这里开始阅读）

- **`agent.ts`** — Agent 类：配置、`run()` 入口、订阅者模式
- **`agent-loop.ts`** — 双循环：外层（后续跟进）+ 内层（工具执行 + 转向控制），返回 EventStream
- **`agent-events.ts`** — 18 种类型化事件定义、MiniAgentResult 接口
- **`session.ts`** — JSONL 仅追加持久化；延迟写入（仅在首条 assistant 消息时才持久化）
- **`context/`** — 上下文管理流水线：
  - `loader.ts` — 引导文件加载（AGENTS.md、SOUL.md）
  - `pruning.ts` — 三级裁剪：软裁剪（30%）→ 硬清除（50%）→ 消息丢弃
  - `compaction.ts` — 基于 Token 感知的分块摘要
  - `tokens.ts` — Token 估算（3.3 字符/Token 启发式）
- **`tools/`** — 工具系统：类型定义、10 个内置工具（read/write/edit/exec/list/grep/memory_*）、中止处理

### 扩展层

- **`memory.ts`** — 基于 BM25 风格的关键词搜索，存储于 JSON 文件
- **`skills.ts`** — 通过 frontmatter + 触发词进行技能匹配
- **`heartbeat.ts`** — 基于定时器的主动唤醒，支持合并

### 工程层

- **`tool-policy.ts`** — 三级访问控制（allow/deny/none）
- **`tool-approval.ts`** — 执行审批工作流 + 白名单
- **`session-write-lock.ts`** — 并发写保护
- **`context-window-guard.ts`** — 可配置阈值的溢出检测
- **`sandbox-paths.ts`** — 路径遍历安全校验
- **`command-queue.ts`** — 并发通道（会话串行 + 全局并行）
- **`session-tool-result-guard.ts`** — 自动修补缺失的 tool_result 块

### 网关层（`gateway/`）

- **`protocol.ts`** — 帧类型、错误码
- **`server.ts`** — HTTP+WS 服务器、挑战-响应握手、支持背压的发布/订阅广播器
- **`handlers.ts`** — 6 个 RPC 方法（connect、chat.send、chat.history、sessions.*、health）
- **`client.ts`** — WS 客户端，含 pending-map RPC、指数退避（1s→30s）、30s 心跳

### 渠道层（`channels/`）

- **`telegram.ts`** — 通过 grammy 集成 Telegram Bot

## 核心设计决策

- **LLM 供应商抽象** 通过 `@mariozechner/pi-ai` 实现 — 支持 anthropic、openai、google、groq 等
- **EventStream** 是带类型化推送事件的异步迭代器；订阅者通过 `agent.subscribe()` 接收事件
- **会话键** 遵循 `agent:id:session` 格式，在 `session-key.ts` 中标准化
- **上下文窗口默认值**：200K Token，低于 20K 时警告，硬性最低 5K
- **网关握手流程**：nonce → token 验证 → HelloOk（挑战-响应）

## 配置

环境变量（通过 `.env` 文件配置，在 cli.ts 中加载）：

```
OPENCLAW_MINI_PROVIDER=anthropic|openai|google|groq|...
OPENCLAW_MINI_MODEL=claude-sonnet-4-20250514|gpt-4o|...
OPENCLAW_MINI_BASE_URL=https://proxy.example.com/v1
ANTHROPIC_API_KEY / OPENAI_API_KEY / 等
OPENCLAW_MINI_AGENT_ID=main
```

## 测试

使用 Node.js 内置的 `node:test` 模块。测试文件位于 `/test/` 目录，遵循以下模式：

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";

test("描述", async () => { /* ... */ });
```
