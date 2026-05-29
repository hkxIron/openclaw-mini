/**
 * MyOpenAI Stream Provider
 *
 * 使用 OpenAI Chat Completions 兼容格式请求自定义 LLM 服务端。
 * 满足 pi-ai 的 StreamFunction 签名，可直接作为 Agent 的 streamFn 使用。
 *
 * 支持: SSE 流式、tool calling、extended thinking (reasoning_content)
 */

import type {
  Model,
  Context,
  SimpleStreamOptions,
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
  StopReason,
  Tool as PiTool,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

// ============== 配置 ==============

export interface MyOpenAIConfig {
  /** 默认 base URL（可被 model.baseUrl 覆盖） */
  baseUrl?: string;
  /** 默认额外 headers */
  headers?: Record<string, string>;
  /** X-Model-Provider-Id（每次请求携带） */
  providerId?: string;
  /** top_p 参数，默认 0.95 */
  topP?: number;
}

// ============== OpenAI 请求/响应类型 ==============

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIStreamChoice {
  index: number;
  delta: OpenAIStreamDelta;
  finish_reason: string | null;
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  choices: OpenAIStreamChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ============== 实现 ==============

export class MyOpenAIStreamProvider {
  private config: MyOpenAIConfig;

  constructor(config?: MyOpenAIConfig) {
    this.config = config ?? {};
  }

  /**
   * 满足 StreamFunction 签名的流式调用方法。
   * 用法: new MyOpenAIStreamProvider().stream 作为 Agent 的 streamFn
   */
  stream = (
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => {
    const eventStream = createAssistantMessageEventStream();

    this._run_query(model, context, options, eventStream).catch((err) => {
      const errorMessage: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: EMPTY_USAGE,
        stopReason: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      eventStream.push({ type: "error", reason: "error", error: errorMessage });
    });

    return eventStream;
  };

  private async _run_query(
    model: Model<any>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    eventStream: ReturnType<typeof createAssistantMessageEventStream>,
  ) {
    const baseUrl = model.baseUrl || this.config.baseUrl || "";
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const apiKey = options?.apiKey ?? "";
    const requestId = crypto.randomUUID();

    // 构造 headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Model-Request-Id": requestId,
      ...(this.config.providerId ? { "X-Model-Provider-Id": this.config.providerId } : {}),
      ...this.config.headers,
      ...options?.headers,
    };

    // 构造 messages
    const messages = this._buildMessages(context);

    // 构造 tools
    const tools = context.tools?.length ? this._buildTools(context.tools) : undefined;

    // 构造请求体
    const body: Record<string, unknown> = {
      model: model.id,
      messages,
      stream: true,
      ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(this.config.topP !== undefined ? { top_p: this.config.topP } : {}),
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    };

    // reasoning 支持（部分服务如 DeepSeek 通过 enable_thinking 或 reasoning_effort）
    if (options?.reasoning) {
      body.stream_options = { include_usage: true };
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    // 解析 SSE 流
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: "stop",
      timestamp: Date.now(),
    };

    eventStream.push({ type: "start", partial });

    // 状态追踪
    let textContent = "";
    let textStarted = false;
    let thinkingContent = "";
    let thinkingStarted = false;
    const toolCallAccumulators: Map<number, { id: string; name: string; args: string }> = new Map();
    let contentIndex = 0;
    let finishReason: string | null = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (options?.signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          const json = trimmed.slice(6);
          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(json);
          } catch {
            continue;
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          finishReason = choice.finish_reason;

          // Thinking / Reasoning content
          if (delta.reasoning_content) {
            if (!thinkingStarted) {
              thinkingStarted = true;
              eventStream.push({ type: "thinking_start", contentIndex, partial });
            }
            thinkingContent += delta.reasoning_content;
            eventStream.push({ type: "thinking_delta", contentIndex, delta: delta.reasoning_content, partial });
          }

          // Text content
          if (delta.content) {
            if (thinkingStarted && !textStarted) {
              // thinking 结束，text 开始
              const thinkingBlock: ThinkingContent = { type: "thinking", thinking: thinkingContent };
              partial.content.push(thinkingBlock);
              eventStream.push({ type: "thinking_end", contentIndex, content: thinkingContent, partial });
              contentIndex++;
              thinkingStarted = false;
            }
            if (!textStarted) {
              textStarted = true;
              eventStream.push({ type: "text_start", contentIndex, partial });
            }
            textContent += delta.content;
            eventStream.push({ type: "text_delta", contentIndex, delta: delta.content, partial });
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              let acc = toolCallAccumulators.get(tc.index);
              if (!acc) {
                acc = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
                toolCallAccumulators.set(tc.index, acc);

                // 关闭前面的 text（如有）
                if (textStarted) {
                  const textBlock: TextContent = { type: "text", text: textContent };
                  partial.content.push(textBlock);
                  eventStream.push({ type: "text_end", contentIndex, content: textContent, partial });
                  contentIndex++;
                  textStarted = false;
                  textContent = "";
                }

                eventStream.push({ type: "toolcall_start", contentIndex, partial });
              }
              if (tc.function?.name) {
                acc.name = tc.function.name;
              }
              if (tc.function?.arguments) {
                acc.args += tc.function.arguments;
                eventStream.push({ type: "toolcall_delta", contentIndex, delta: tc.function.arguments, partial });
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 关闭未结束的 thinking
    if (thinkingStarted) {
      const thinkingBlock: ThinkingContent = { type: "thinking", thinking: thinkingContent };
      partial.content.push(thinkingBlock);
      eventStream.push({ type: "thinking_end", contentIndex, content: thinkingContent, partial });
      contentIndex++;
    }

    // 关闭未结束的 text
    if (textStarted) {
      const textBlock: TextContent = { type: "text", text: textContent };
      partial.content.push(textBlock);
      eventStream.push({ type: "text_end", contentIndex, content: textContent, partial });
      contentIndex++;
    }

    // 关闭所有 tool calls
    for (const [, acc] of toolCallAccumulators) {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(acc.args);
      } catch { /* empty */ }

      const toolCall: ToolCall = {
        type: "toolCall",
        id: acc.id,
        name: acc.name,
        arguments: args,
      };
      partial.content.push(toolCall);
      eventStream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
      contentIndex++;
    }

    // 确定 stopReason
    let stopReason: StopReason = "stop";
    if (finishReason === "tool_calls" || toolCallAccumulators.size > 0) {
      stopReason = "toolUse";
    } else if (finishReason === "length") {
      stopReason = "length";
    }

    partial.stopReason = stopReason;
    partial.timestamp = Date.now();

    // 发射 done 事件
    const doneReason = stopReason === "toolUse" ? "toolUse" : stopReason === "length" ? "length" : "stop";
    eventStream.push({ type: "done", reason: doneReason, message: partial });
  }

  // ============== 内部转换 ==============

  private _buildMessages(context: Context): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    if (context.systemPrompt) {
      result.push({ role: "system", content: context.systemPrompt });
    }

    for (const msg of context.messages) {
      if (msg.role === "user") {
        const content = typeof msg.content === "string"
          ? msg.content
          : (msg.content as Array<{ type: string; text?: string }>)
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("");
        result.push({ role: "user", content });
      } else if (msg.role === "assistant") {
        const assistantMsg = msg as AssistantMessage;
        const textParts = assistantMsg.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("");

        const toolCalls = assistantMsg.content
          .filter((b): b is ToolCall => b.type === "toolCall")
          .map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));

        const openaiMsg: OpenAIMessage = { role: "assistant", content: textParts || null };
        if (toolCalls.length > 0) {
          openaiMsg.tool_calls = toolCalls;
        }
        result.push(openaiMsg);
      } else if (msg.role === "toolResult") {
        result.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: (msg.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join(""),
        });
      }
    }

    return result;
  }

  private _buildTools(tools: PiTool[]): OpenAITool[] {
    return tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

// ============== 常量 ==============

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
