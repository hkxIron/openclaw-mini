/**
 * 对话历史自适应压缩 (Compaction)
 *
 * 本文件实现上下文窗口超限时的对话历史压缩逻辑：
 * 1. 检测 — 判断当前消息 token 总量是否超过 contextWindow - reserveTokens
 * 2. 分块 — 将被裁剪的消息按 token 预算切分为多个 chunk
 * 3. 摘要 — 通过 LLM 对每个 chunk 生成结构化摘要
 * 4. 合并 — 多段摘要合并为最终的上下文检查点
 * 5. 追加文件操作记录 — 从被裁剪消息中提取 read/write/edit 操作并附加到摘要
 *
 * 对应 OpenClaw: src/agents/pi-extensions/context-pruning/compaction.ts
 */

import { createCompactionSummaryMessage, type Message } from "../session.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  CHARS_PER_TOKEN_ESTIMATE,
} from "./tokens.js";
import {
  pruneContextMessages,
  type ContextPruningSettings,
  type PruneResult,
} from "./pruning.js";

export const BASE_CHUNK_RATIO = 0.4;
export const MIN_CHUNK_RATIO = 0.15;
export const SAFETY_MARGIN = 1.2;

/**
 * Compaction 设置
 *
 * 对应 OpenClaw:
 * - pi-settings.ts → DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000
 * - config/types.agent-defaults.ts → AgentCompactionConfig
 */
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 20_000,
  keepRecentTokens: 20_000,
};

export const DEFAULT_SUMMARY_MAX_TOKENS = 900;
const DEFAULT_SUMMARY_FALLBACK = "No prior history.";
const DEFAULT_PARTS = 2;
const MERGE_SUMMARIES_INSTRUCTIONS =
  "将这些分段摘要合并为一个连贯的摘要。保留关键决策、TODO、未解决问题与约束条件。";

const SUMMARIZATION_SYSTEM_PROMPT = `你是上下文摘要助手。你的任务是阅读用户与 AI 编程助手的对话，然后按照指定格式输出结构化摘要。

不要继续对话。不要回答对话中的问题。只输出结构化摘要。`;

const SUMMARIZATION_PROMPT = `以上消息是一段对话，请生成结构化的上下文检查点摘要，供后续模型继续工作使用。

请严格使用以下格式：

## 目标
[用户想要完成什么？如果会话涉及多个任务，可列出多个目标]

## 约束与偏好
- [用户提到的任何约束、偏好或要求]
- [若无则写“(无)”]

## 进展
### 已完成
- [x] [已完成的任务/改动]

### 进行中
- [ ] [当前进行的工作]

### 阻塞
- [若有阻塞问题，写在这里]

## 关键决策
- **[决策]**: [简要原因]

## 下一步
1. [按顺序列出下一步应该做什么]

## 关键信息
- [继续工作所需的任何数据、示例或引用]
- [若不适用则写“(无)”]

每个部分保持简洁。保留精确的文件路径、函数名与错误信息。`;

const UPDATE_SUMMARIZATION_PROMPT = `以上消息是需要纳入已有摘要的新对话内容。已有摘要位于 <previous-summary> 标签中。

请在保留已有摘要信息的前提下进行更新。规则：
- 保留已有摘要中的所有重要信息
- 追加新进展、决策和上下文
- 更新“进展”：已完成的事项从“进行中”移动到“已完成”
- 根据新进展更新“下一步”
- 保留精确的文件路径、函数名与错误信息
- 若某些信息不再 relevant，可移除

请严格使用以下格式：

## 目标
[保留已有目标，必要时补充新的目标]

## 约束与偏好
- [保留已有内容，新增发现的内容]

## 进展
### 已完成
- [x] [包含之前已完成事项 + 新完成事项]

### 进行中
- [ ] [当前进行的工作]

### 阻塞
- [当前阻塞问题，若已解决可移除]

## 关键决策
- **[决策]**: [简要原因]（保留已有并补充新的）

## 下一步
1. [根据当前状态更新下一步]

## 关键信息
- [保留重要上下文，必要时补充新信息]

每个部分保持简洁。保留精确的文件路径、函数名与错误信息。`;

type FileOps = {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
};

/**
 * 创建空的文件操作记录容器
 *
 * 输出示例: { read: Set{}, written: Set{}, edited: Set{} }
 */
function createFileOps(): FileOps {
  return {
    read: new Set<string>(),
    written: new Set<string>(),
    edited: new Set<string>(),
  };
}

/**
 * 从单条 assistant 消息中提取文件操作记录
 *
 * 遍历消息中的 tool_use 块，根据工具名称 (read/write/edit) 将文件路径
 * 分类记录到 fileOps 中。非 assistant 消息或非 tool_use 块会被跳过。
 *
 * 输入示例: message={ role:"assistant", content:[{ type:"tool_use", name:"read", input:{ path:"src/a.ts" } }] }
 * 副作用: fileOps.read 中新增 "src/a.ts"
 */
function extractFileOpsFromMessage(message: Message, fileOps: FileOps): void {
  if (message.role !== "assistant") {
    return;
  }
  if (!Array.isArray(message.content)) {
    return;
  }
  for (const block of message.content) {
    if (block.type !== "tool_use") {
      continue;
    }
    const args = block.input;
    if (!args || typeof args !== "object") {
      continue;
    }
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) {
      continue;
    }
    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

/**
 * 从文件操作记录中计算"只读文件"和"已修改文件"两个列表
 *
 * 规则：被 write 或 edit 过的文件归为 modified；仅被 read 过（且未修改）的归为 readOnly。
 * 两个列表均按字母序排序。
 *
 * 输入示例: fileOps={ read: Set{"a.ts","b.ts"}, written: Set{"b.ts"}, edited: Set{"c.ts"} }
 * 输出示例: { readFiles: ["a.ts"], modifiedFiles: ["b.ts","c.ts"] }
 */
function computeFileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
  // 排除已修改的文件，剩余为纯读取文件
  const readOnly = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles: readOnly, modifiedFiles };
}

/**
 * 将文件操作列表格式化为 XML 标签包裹的文本，用于附加到摘要末尾
 *
 * 输入示例: readFiles=["a.ts"], modifiedFiles=["b.ts","c.ts"]
 * 输出示例: "\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\nc.ts\n</modified-files>"
 *
 * 输入示例: readFiles=[], modifiedFiles=[]
 * 输出示例: ""
 */
function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * 摘要生成函数签名
 *
 * 解耦 compaction 与具体 LLM SDK:
 * - 调用方通过 pi-ai 的 completeSimple 或任意 provider 实现
 */
export type SummarizeFn = (params: {
  system: string;
  userPrompt: string;
  maxTokens: number;
}) => Promise<string>;

/**
 * 规范化分片数量，确保在 [1, messageCount] 范围内
 *
 * 输入示例: parts=3, messageCount=10
 * 输出示例: 3
 *
 * 输入示例: parts=5, messageCount=2
 * 输出示例: 2 (不超过消息总数)
 *
 * 输入示例: parts=0, messageCount=10
 * 输出示例: 1 (无效值回退为 1)
 */
function normalizeParts(parts: number, messageCount: number): number {
  if (!Number.isFinite(parts) || parts <= 1) {
    return 1;
  }
  return Math.min(Math.max(1, Math.floor(parts)), Math.max(1, messageCount));
}

/**
 * 计算自适应分块比率
 *
 * 根据消息平均 token 数与上下文窗口的比值动态调整 chunk 占比：
 * - 消息普遍较大时（avgRatio > 10%），降低 chunk 比率以避免单 chunk 过大
 * - 消息较小时，使用基础比率 (0.4)
 *
 * 输入示例: messages=[10条消息共约40000 tokens], contextWindow=200000
 * 输出示例: 0.4 (BASE_CHUNK_RATIO，因为 avgRatio = 4800/200000 ≈ 2.4% < 10%)
 *
 * 输入示例: messages=[5条消息共约120000 tokens], contextWindow=200000
 * 输出示例: 约 0.16 (降低后的比率，因为 avgRatio ≈ 14.4% > 10%)
 */
export function computeAdaptiveChunkRatio(messages: Message[], contextWindow: number): number {
  if (messages.length === 0) {
    return BASE_CHUNK_RATIO;
  }
  const totalTokens = estimateMessagesTokens(messages);
  const avgTokens = totalTokens / messages.length;
  const safeAvgTokens = avgTokens * SAFETY_MARGIN;
  const avgRatio = safeAvgTokens / contextWindow;

  // 当单条消息平均占比超过 10% 时，缩小 chunk 比率以适应大消息
  if (avgRatio > 0.1) {
    const reduction = Math.min(avgRatio * 2, BASE_CHUNK_RATIO - MIN_CHUNK_RATIO);
    return Math.max(MIN_CHUNK_RATIO, BASE_CHUNK_RATIO - reduction);
  }
  return BASE_CHUNK_RATIO;
}

/**
 * 按 token 均分策略将消息拆分为指定数量的分片
 *
 * 计算每片的目标 token 数 = 总 tokens / parts，然后顺序遍历消息，
 * 当当前分片累计 token 超过目标值时切分。保证最后一片包含剩余所有消息。
 *
 * 输入示例: messages=[6条消息], parts=2
 * 输出示例: [[前3条(约一半tokens)], [后3条(约一半tokens)]]
 *
 * 输入示例: messages=[], parts=2
 * 输出示例: []
 */
export function splitMessagesByTokenShare(messages: Message[], parts = DEFAULT_PARTS): Message[][] {
  if (messages.length === 0) {
    return [];
  }
  const normalizedParts = normalizeParts(parts, messages.length);
  if (normalizedParts <= 1) {
    return [messages];
  }

  const totalTokens = estimateMessagesTokens(messages);
  const targetTokens = totalTokens / normalizedParts;
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    // 当还有剩余分片需要切分，且当前分片已超出目标 token 数时，执行切分
    if (
      chunks.length < normalizedParts - 1 &&
      current.length > 0 &&
      currentTokens + messageTokens > targetTokens
    ) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * 按最大 token 数限制将消息切分为多个 chunk
 *
 * 与 splitMessagesByTokenShare 不同，本函数以绝对 token 上限切分，
 * 不预设分片数。若单条消息超过 maxTokens，则该消息独占一个 chunk。
 *
 * 输入示例: messages=[10条消息], maxTokens=5000
 * 输出示例: [[前几条共约5000tokens], [中间几条], ...]
 */
export function chunkMessagesByMaxTokens(messages: Message[], maxTokens: number): Message[][] {
  if (messages.length === 0) {
    return [];
  }
  const chunks: Message[][] = [];
  let current: Message[] = [];
  let currentTokens = 0;

  for (const message of messages) {
    const messageTokens = estimateMessageTokens(message);
    if (current.length > 0 && currentTokens + messageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += messageTokens;

    // 单条消息超过 maxTokens 时强制独占一个 chunk，避免后续消息被合入
    if (messageTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * 判断单条消息是否过大以至于无法安全地送入 LLM 进行摘要
 *
 * 阈值：消息 token 数 * 安全系数 > 上下文窗口的 50%
 *
 * 输入示例: msg(约60000 tokens), contextWindow=200000
 * 输出示例: false (60000*1.2=72000 < 100000)
 *
 * 输入示例: msg(约90000 tokens), contextWindow=200000
 * 输出示例: true (90000*1.2=108000 > 100000)
 */
function isOversizedForSummary(msg: Message, contextWindow: number): boolean {
  const tokens = estimateMessageTokens(msg) * SAFETY_MARGIN;
  return tokens > contextWindow * 0.5;
}

/**
 * 从消息 content 中提取纯文本内容
 *
 * 若 content 为字符串则直接返回；若为块数组则仅拼接 text 类型块的文本。
 *
 * 输入示例: "hello"
 * 输出示例: "hello"
 *
 * 输入示例: [{ type:"text", text:"hi" }, { type:"tool_result", content:"..." }]
 * 输出示例: "hi"
 */
function extractUserText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * 将消息数组序列化为人类可读的对话文本，用于作为 LLM 摘要的输入
 *
 * 格式示例:
 *   [User]: 用户消息
 *   [Tool result]: 工具返回内容
 *   [Assistant]: 助手回复
 *   [Assistant tool calls]: read(path="src/a.ts"); write(path="b.ts", content="...")
 *
 * 输入示例: [{ role:"user", content:"你好" }, { role:"assistant", content:"Hi!" }]
 * 输出示例: "[User]: 你好\n\n[Assistant]: Hi!"
 */
function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractUserText(msg.content);
      if (text) {
        parts.push(`[User]: ${text}`);
      }
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content
          .filter((block) => block.type === "tool_result")
          .map((block) => block.content ?? "")
          .filter(Boolean);
        for (const result of toolResults) {
          parts.push(`[Tool result]: ${result}`);
        }
      }
      continue;
    }

    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      if (typeof msg.content === "string") {
        textParts.push(msg.content);
      } else {
        for (const block of msg.content) {
          if (block.type === "text") {
            if (block.text) {
              textParts.push(block.text);
            }
            continue;
          }
          if (block.type === "tool_use") {
            const args = block.input ?? {};
            const argsStr = Object.entries(args)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join(", ");
            toolCalls.push(`${block.name ?? "tool"}(${argsStr})`);
          }
        }
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
    }
  }
  return parts.join("\n\n");
}

/**
 * 生成单次摘要：将消息序列化后调用 LLM 生成结构化摘要
 *
 * 根据是否有 previousSummary 决定使用"新建摘要"还是"增量更新"的 prompt 模板。
 * 支持通过 customInstructions 追加额外关注点。
 */
async function generateSummary(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  // 根据是否存在已有摘要选择不同的 prompt 策略
  let basePrompt = params.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (params.customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${params.customInstructions}`;
  }
  const conversationText = serializeConversation(params.messages);
  let prompt = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (params.previousSummary) {
    prompt += `<previous-summary>\n${params.previousSummary}\n</previous-summary>\n\n`;
  }
  prompt += basePrompt;

  return params.summarize({
    system: SUMMARIZATION_SYSTEM_PROMPT,
    userPrompt: prompt,
    maxTokens: params.maxTokens,
  });
}

/**
 * 分块逐步摘要：将消息按 maxChunkTokens 切分后，依次生成摘要
 *
 * 采用滚动摘要策略：每次将上一个 chunk 的摘要作为 previousSummary 传入下一次调用，
 * 实现增量式信息累积。
 */
async function summarizeChunks(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }
  const chunks = chunkMessagesByMaxTokens(params.messages, params.maxChunkTokens);
  // 滚动摘要：每个 chunk 的输出作为下一个 chunk 的 previousSummary
  let summary = params.previousSummary;
  for (const chunk of chunks) {
    summary = await generateSummary({
      messages: chunk,
      summarize: params.summarize,
      maxTokens: params.maxTokens,
      customInstructions: params.customInstructions,
      previousSummary: summary,
    });
  }
  return summary ?? DEFAULT_SUMMARY_FALLBACK;
}

/**
 * 带降级回退的摘要生成
 *
 * 处理流程：
 * 1. 首先尝试直接对所有消息分块摘要
 * 2. 若失败（如超长导致 API 报错），则过滤掉超大消息后重试
 * 3. 若仍失败，返回兜底描述文本
 *
 * 这确保即使存在异常大的消息也不会导致整个 compaction 失败。
 */
async function summarizeWithFallback(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  // 第一次尝试：直接对全部消息分块摘要
  try {
    return await summarizeChunks(params);
  } catch {
    // fallback — 可能因为消息过大导致 LLM 调用失败
  }

  // 第二次尝试：过滤掉超大消息，仅对可处理的消息生成摘要
  const smallMessages: Message[] = [];
  const oversizedNotes: string[] = [];
  for (const msg of params.messages) {
    if (isOversizedForSummary(msg, params.contextWindow)) {
      const tokens = estimateMessageTokens(msg);
      oversizedNotes.push(`[Large ${msg.role} (~${Math.round(tokens / 1000)}K tokens) omitted]`);
    } else {
      smallMessages.push(msg);
    }
  }

  if (smallMessages.length > 0) {
    try {
      const partial = await summarizeChunks({
        ...params,
        messages: smallMessages,
      });
      const notes = oversizedNotes.length > 0 ? `\n\n${oversizedNotes.join("\n")}` : "";
      return partial + notes;
    } catch {
      // fall through — 即使过滤后仍失败，使用兜底文本
    }
  }

  return `Context contained ${params.messages.length} messages. Summary unavailable due to size limits.`;
}

/**
 * 分阶段摘要：先并行摘要各分片，再合并为最终摘要
 *
 * 适用于大量消息的场景。流程：
 * 1. 判断是否需要分片（消息数 >= minMessagesForSplit 且总 token > maxChunkTokens）
 * 2. 若不需要分片，直接走 summarizeWithFallback
 * 3. 若需要分片，按 token 均分为 parts 个分片，各自独立摘要
 * 4. 将各分片摘要作为新"消息"再次调用摘要函数进行合并
 *
 * 这种两层结构能处理超长对话历史，同时保证最终摘要的质量。
 */
export async function summarizeInStages(params: {
  messages: Message[];
  summarize: SummarizeFn;
  maxTokens: number;
  maxChunkTokens: number;
  contextWindow: number;
  customInstructions?: string;
  previousSummary?: string;
  parts?: number;
  minMessagesForSplit?: number;
}): Promise<string> {
  const { messages } = params;
  if (messages.length === 0) {
    return params.previousSummary ?? DEFAULT_SUMMARY_FALLBACK;
  }

  const minMessagesForSplit = Math.max(2, params.minMessagesForSplit ?? 4);
  const parts = normalizeParts(params.parts ?? DEFAULT_PARTS, messages.length);
  const totalTokens = estimateMessagesTokens(messages);

  // 若消息量不足或总 token 在单 chunk 范围内，无需分阶段处理
  if (parts <= 1 || messages.length < minMessagesForSplit || totalTokens <= params.maxChunkTokens) {
    return summarizeWithFallback(params);
  }

  // 第一阶段：将消息按 token 均分为多个分片，各自独立生成摘要
  const splits = splitMessagesByTokenShare(messages, parts).filter((chunk) => chunk.length > 0);
  if (splits.length <= 1) {
    return summarizeWithFallback(params);
  }

  const partialSummaries: string[] = [];
  for (const chunk of splits) {
    partialSummaries.push(
      await summarizeWithFallback({
        ...params,
        messages: chunk,
        previousSummary: undefined,
      }),
    );
  }

  if (partialSummaries.length === 1) {
    return partialSummaries[0];
  }

  // 第二阶段：将各分片摘要作为消息输入，合并为最终统一摘要
  const summaryMessages: Message[] = partialSummaries.map((summary) => ({
    role: "user",
    content: summary,
    timestamp: Date.now(),
  }));

  const mergeInstructions = params.customInstructions
    ? `${MERGE_SUMMARIES_INSTRUCTIONS}\n\nAdditional focus:\n${params.customInstructions}`
    : MERGE_SUMMARIES_INSTRUCTIONS;

  return summarizeWithFallback({
    ...params,
    messages: summaryMessages,
    customInstructions: mergeInstructions,
  });
}

/**
 * 是否应该触发 compaction
 *
 * 对应 OpenClaw: pi-coding-agent → shouldCompact(contextTokens, contextWindow, settings)
 * 触发条件: contextTokens > contextWindow - reserveTokens
 * （reserve-based，不是 ratio-based）
 */
export function shouldTriggerCompaction(params: {
  messages: Message[];
  contextWindowTokens: number;
  settings?: Partial<CompactionSettings>;
}): boolean {
  const settings = {
    ...DEFAULT_COMPACTION_SETTINGS,
    ...params.settings,
  };
  if (!settings.enabled) return false;
  const totalTokens = estimateMessagesTokens(params.messages);
  return totalTokens > params.contextWindowTokens - settings.reserveTokens;
}

/**
 * 生成 compaction 摘要
 *
 * 对应 OpenClaw: pi-coding-agent → generateSummary()
 * maxTokens = floor(0.8 × reserveTokens)
 */
export async function buildCompactionSummary(params: {
  summarize: SummarizeFn;
  messages: Message[];
  contextWindowTokens: number;
  maxTokens?: number;
  reserveTokens?: number;
  customInstructions?: string;
}): Promise<string> {
  if (params.messages.length === 0) {
    return DEFAULT_SUMMARY_FALLBACK;
  }
  const adaptiveRatio = computeAdaptiveChunkRatio(params.messages, params.contextWindowTokens);
  const maxChunkTokens = Math.max(1, Math.floor(params.contextWindowTokens * adaptiveRatio));
  // 对应 OpenClaw: maxTokens = Math.floor(0.8 * reserveTokens)
  const reserveTokens = params.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
  const maxTokens = Math.max(64, Math.floor(params.maxTokens ?? (0.8 * reserveTokens)));

  return summarizeInStages({
    messages: params.messages,
    summarize: params.summarize,
    maxTokens,
    maxChunkTokens,
    contextWindow: params.contextWindowTokens,
    customInstructions: params.customInstructions,
  });
}

export async function compactHistoryIfNeeded(params: {
  summarize: SummarizeFn;
  messages: Message[];
  contextWindowTokens: number;
  pruningSettings?: Partial<ContextPruningSettings>;
  compactionSettings?: Partial<CompactionSettings>;
  maxTokens?: number;
}): Promise<{
  summary?: string;
  summaryMessage?: Message;
  pruneResult: PruneResult;
}> {
  const pruneResult = pruneContextMessages({
    messages: params.messages,
    contextWindowTokens: params.contextWindowTokens,
    settings: params.pruningSettings,
  });

  const shouldCompact = shouldTriggerCompaction({
    messages: params.messages,
    contextWindowTokens: params.contextWindowTokens,
    settings: params.compactionSettings,
  });

  if (!shouldCompact || pruneResult.droppedMessages.length === 0) {
    return { pruneResult };
  }

  const resolvedSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...params.compactionSettings };
  let summary = await buildCompactionSummary({
    summarize: params.summarize,
    messages: pruneResult.droppedMessages,
    contextWindowTokens: params.contextWindowTokens,
    maxTokens: params.maxTokens,
    reserveTokens: resolvedSettings.reserveTokens,
  });
  const fileOps = createFileOps();
  for (const message of pruneResult.droppedMessages) {
    extractFileOpsFromMessage(message, fileOps);
  }
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);

  const summaryMessage: Message = createCompactionSummaryMessage(summary, Date.now());

  return {
    summary,
    summaryMessage,
    pruneResult,
  };
}

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
export const DEFAULT_HISTORY_SHARE = 0.5;
export const DEFAULT_CONTEXT_WINDOW_CHARS =
  DEFAULT_CONTEXT_WINDOW_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
