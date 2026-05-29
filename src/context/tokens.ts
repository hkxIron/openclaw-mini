/**
 * Token 估算工具
 *
 * 本文件提供基于字符数的 token 估算函数，用于上下文窗口管理。
 * 采用 1 token ≈ 4 字符的简化比例（业界通用近似值），
 * 为 pruning 和 compaction 提供快速的 token 预算计算。
 *
 * 对应 OpenClaw: src/agents/pi-extensions/context-pruning/tokens.ts
 */

import type { ContentBlock, Message } from "../session.js";

/** 每个 token 大约对应的字符数（英文约 4 字符/token，中文约 2 字符/token，取折中值） */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * 估算单个内容块的字符数
 *
 * 输入示例: { type: "text", text: "hello world" }
 * 输出示例: 11
 *
 * 输入示例: { type: "tool_use", name: "read", input: { file_path: "src/index.ts" } }
 * 输出示例: 4 + 32 + 16 = 52 (name长度 + JSON序列化参数长度 + 固定开销)
 *
 * 输入示例: { type: "tool_result", content: "文件内容..." }
 * 输出示例: 6 (content字符数)
 */
function estimateBlockChars(block: ContentBlock): number {
  if (block.type === "text") {
    return block.text?.length ?? 0;
  }
  if (block.type === "tool_use") {
    const base = block.name?.length ?? 0;
    try {
      const input = block.input ? JSON.stringify(block.input) : "";
      return base + input.length + 16;
    } catch {
      return base + 128;
    }
  }
  if (block.type === "tool_result") {
    return block.content?.length ?? 0;
  }
  return 0;
}

/**
 * 估算单条消息的字符数
 *
 * 输入示例: { role: "user", content: "你好", timestamp: 123 }
 * 输出示例: 2
 *
 * 输入示例: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 123 }
 * 输出示例: 2
 */
export function estimateMessageChars(message: Message): number {
  if (typeof message.content === "string") {
    return message.content.length;
  }
  let total = 0;
  for (const block of message.content) {
    total += estimateBlockChars(block);
  }
  return total;
}

/**
 * 估算消息数组的总字符数
 *
 * 输入示例: [{ role: "user", content: "hi", timestamp: 1 }, { role: "assistant", content: "hello", timestamp: 2 }]
 * 输出示例: 7 (2 + 5)
 */
export function estimateMessagesChars(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageChars(msg), 0);
}

/**
 * 估算单条消息的 token 数（字符数 / 4，最少 1）
 *
 * 输入示例: { role: "user", content: "hello world!!", timestamp: 1 }
 * 输出示例: 4 (13 chars / 4 = 3.25 → ceil = 4)
 */
export function estimateMessageTokens(message: Message): number {
  const chars = estimateMessageChars(message);
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE));
}

/**
 * 估算消息数组的总 token 数
 *
 * 输入示例: 包含 3 条消息，各自 100/200/300 字符
 * 输出示例: 25 + 50 + 75 = 150
 */
export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}
