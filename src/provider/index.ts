/**
 * Provider 抽象层 — 基于 @mariozechner/pi-ai
 *
 * 设计决策:
 * - LLM SDK 适配（Anthropic/OpenAI/Gemini）交给 pi-ai 处理
 * - Agent 层只依赖 pi-ai 的统一接口: StreamFunction, Model, Context, AssistantMessageEvent
 * - 错误分类与重试是 Agent 层逻辑，保留在 errors.ts
 */

// pi-ai 核心类型
export type {
  Api,
  KnownApi,
  Provider,
  KnownProvider,
  Model,
  StreamFunction,
  StreamOptions,
  SimpleStreamOptions,
  Context,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
  StopReason,
  ThinkingLevel,
  Message as PiMessage,
  UserMessage as PiUserMessage,
  ToolResultMessage as PiToolResultMessage,
  Tool as PiTool,
} from "@mariozechner/pi-ai";

// pi-ai 流式调用
export {
  stream,
  streamSimple,
  complete,
  completeSimple,
} from "@mariozechner/pi-ai";

// pi-ai provider 适配器
export { streamAnthropic, streamSimpleAnthropic } from "@mariozechner/pi-ai";

// pi-ai 模型注册表
export { getModel, getModels, getProviders } from "@mariozechner/pi-ai";

// pi-ai EventStream
export {
  createAssistantMessageEventStream,
  type EventStream,
  AssistantMessageEventStream as AssistantMessageEventStreamClass,
} from "@mariozechner/pi-ai";

// pi-ai context overflow 检测
export { isContextOverflow } from "@mariozechner/pi-ai";

// 自定义 OpenAI 兼容 Provider（支持自建 LLM 服务端）
export { MyOpenAIStreamProvider, type MyOpenAIConfig } from "./my-openai-stream.js";

// Agent 层: 错误分类与重试（pi-ai 不包含）
export {
  FailoverError,
  isFailoverError,
  type FailoverReason,
  type RetryOptions,
  retryAsync,
  isContextOverflowError,
  isRateLimitError,
  isTimeoutError,
  isAuthError,
  classifyFailoverReason,
  describeError,
} from "./errors.js";
