/**
 * Session Tool Result Guard
 *
 * 对应 OpenClaw: src/agents/session-tool-result-guard.ts
 *               + src/agents/session-tool-result-guard-wrapper.ts
 *               + src/agents/session-transcript-repair.ts (makeMissingToolResult)
 *
 * 追踪 assistant 消息中的 tool_use 调用，确保每个都有对应的 tool_result。
 * 当新消息到达但存在未匹配的 tool_use 时，自动合成错误结果（synthetic error results）。
 *
 * 作用:
 * - 防止 LLM API 拒绝不完整的 tool_use/tool_result 配对
 * - 处理 agent 中途崩溃/中断导致的结果缺失
 *
 * 架构对齐:
 * - openclaw 中 toolResult 是独立消息（role: "toolResult"）
 * - mini 中 tool_result 是 user 消息内的 ContentBlock
 * - 核心逻辑相同: 追踪 pending → 匹配清除 → flush 合成
 */

import type { SessionManager, Message, ContentBlock } from "./session.js";

type ToolCall = { id: string; name?: string };

/**
 * 从 assistant 消息中提取 tool_use 调用
 *
 * 对应 OpenClaw: session-tool-result-guard.ts → extractAssistantToolCalls()
 * - openclaw 支持 type: "toolCall" | "toolUse" | "functionCall"
 * - mini 统一为 type: "tool_use"（Anthropic API 格式）
 *
 * 输入示例:
 *   { role: "assistant", content: [
 *     { type: "text", text: "Let me read the file." },
 *     { type: "tool_use", id: "toolu_01abc", name: "read", input: { path: "/tmp/a.ts" } }
 *   ] }
 * 输出示例: [{ id: "toolu_01abc", name: "read" }]
 *
 * 输入示例: { role: "user", content: "hello" }
 * 输出示例: [] (非 assistant 消息直接返回空数组)
 */
function extractToolUsesFromAssistant(msg: Message): ToolCall[] {
  if (msg.role !== "assistant" || typeof msg.content === "string") return [];
  const calls: ToolCall[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_use" && block.id) {
      calls.push({ id: block.id, name: block.name });
    }
  }
  return calls;
}

/**
 * 从 user 消息中提取 tool_result 的 tool_use_id
 *
 * 对应 OpenClaw: session-tool-result-guard.ts → extractToolResultId()
 * - openclaw 中 toolResult 是独立消息，检查 toolCallId / toolUseId
 * - mini 中 tool_result 是 ContentBlock，检查 tool_use_id
 *
 * 输入示例:
 *   { role: "user", content: [
 *     { type: "tool_result", tool_use_id: "toolu_01abc", content: "file content..." }
 *   ] }
 * 输出示例: ["toolu_01abc"]
 *
 * 输入示例: { role: "assistant", content: [...] }
 * 输出示例: [] (非 user 消息直接返回空数组)
 */
function extractToolResultIds(msg: Message): string[] {
  if (msg.role !== "user" || typeof msg.content === "string") return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (block.type === "tool_result" && block.tool_use_id) {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

/**
 * 生成缺失工具结果的合成占位
 *
 * 对应 OpenClaw: session-transcript-repair.ts → makeMissingToolResult()
 * - isError: true 语义（openclaw 原始字段，mini 通过内容文本表达）
 * - 消息文本与 openclaw 保持一致风格
 *
 * 输入示例: makeMissingToolResult("toolu_01abc", "read")
 * 输出示例: {
 *   type: "tool_result",
 *   tool_use_id: "toolu_01abc",
 *   name: "read",
 *   content: "[openclaw-mini] missing tool result in session history; inserted synthetic error result for transcript repair."
 * }
 */
function makeMissingToolResult(toolCallId: string, toolName?: string): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: toolCallId,
    name: toolName,
    content:
      "[openclaw-mini] missing tool result in session history; inserted synthetic error result for transcript repair.",
  };
}

export { makeMissingToolResult };

/**
 * 安装 tool result guard
 *
 * 对应 OpenClaw:
 * - session-tool-result-guard.ts → installSessionToolResultGuard()
 * - session-tool-result-guard-wrapper.ts → guardSessionManager()
 *
 * Monkey-patch SessionManager.append()，拦截消息追加:
 * 1. assistant 消息 → 追踪 pending tool_use IDs
 * 2. user 消息（含 tool_result）→ 清除匹配的 pending IDs
 * 3. 其他消息到达时 pending 非空 → 自动 flush 合成结果
 *
 * 幂等: 多次调用不会重复安装（对应 OpenClaw: guardSessionManager 的 idempotent check）
 */
export function installSessionToolResultGuard(sessionManager: SessionManager): {
  flushPendingToolResults: (sessionKey: string) => Promise<void>;
  getPendingIds: (sessionKey: string) => string[];
} {
  // 幂等检查
  const sm = sessionManager as SessionManager & {
    __toolResultGuardInstalled?: boolean;
    __toolResultGuard?: ReturnType<typeof installSessionToolResultGuard>;
  };
  if (sm.__toolResultGuardInstalled && sm.__toolResultGuard) {
    return sm.__toolResultGuard;
  }

  const originalAppend = sessionManager.append.bind(sessionManager);

  // Per-session pending 追踪（mini 中一个 SessionManager 管多个 session）
  const pendingBySession = new Map<string, Map<string, string | undefined>>();

  function getPending(sessionKey: string): Map<string, string | undefined> {
    let m = pendingBySession.get(sessionKey);
    if (!m) {
      m = new Map();
      pendingBySession.set(sessionKey, m);
    }
    return m;
  }

  /**
   * Flush 所有 pending tool results（对应 OpenClaw: flushPendingToolResults）
   *
   * 为每个未匹配的 tool_use 生成 synthetic error result，
   * 打包为一条 user 消息追加到 session
   */
  const flushPendingToolResults = async (sessionKey: string): Promise<void> => {
    const pending = pendingBySession.get(sessionKey);
    if (!pending || pending.size === 0) return;
    const results: ContentBlock[] = [];
    for (const [id, name] of pending.entries()) {
      results.push(makeMissingToolResult(id, name));
    }
    pending.clear();
    await originalAppend(sessionKey, {
      role: "user",
      content: results,
      timestamp: Date.now(),
    });
  };

  /**
   * Monkey-patch append（对应 OpenClaw: guardedAppend）
   *
   * 判定顺序:
   * 1. user 消息含 tool_result → 清除匹配的 pending IDs，直接追加
   * 2. pending 非空且非 tool_result 消息 → 先 flush，再追加
   * 3. pending 非空且新 assistant 带 tool_use → 先 flush 旧的，再追加
   * 4. assistant 消息带 tool_use → 追加后记录 pending
   */
  sessionManager.append = async (sessionKey: string, message: Message): Promise<void> => {
    const pending = getPending(sessionKey);

    // user 消息含 tool_result → 清除匹配的 pending
    const resultIds = extractToolResultIds(message);
    if (resultIds.length > 0) {
      for (const id of resultIds) {
        pending.delete(id);
      }
      return originalAppend(sessionKey, message);
    }

    const toolCalls = extractToolUsesFromAssistant(message);

    // 对应 OpenClaw: 非 toolResult 消息到达但有 pending → flush
    if (pending.size > 0 && toolCalls.length === 0) {
      await flushPendingToolResults(sessionKey);
    }
    // 对应 OpenClaw: 新 assistant 带 tool_use 但旧的 pending 还在 → flush 旧的
    if (pending.size > 0 && toolCalls.length > 0) {
      await flushPendingToolResults(sessionKey);
    }

    await originalAppend(sessionKey, message);

    // 追踪新的 tool_use
    for (const call of toolCalls) {
      pending.set(call.id, call.name);
    }
  };

  const guard = {
    flushPendingToolResults,
    getPendingIds: (sessionKey: string): string[] => {
      const pending = pendingBySession.get(sessionKey);
      return pending ? Array.from(pending.keys()) : [];
    },
  };

  sm.__toolResultGuardInstalled = true;
  sm.__toolResultGuard = guard;
  return guard;
}
