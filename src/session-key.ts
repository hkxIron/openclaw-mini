/**
 * Session Key 规范（简化版）
 *
 * OpenClaw 的 sessionKey 是路由与隔离的核心。
 * 这里保留最关键的结构：agent:<agentId>:<mainKey>
 *
 * 设计目标:
 * 1. 统一会话命名，避免不同 agent 之间状态混淆
 * 2. 支持显式 sessionKey，也支持 sessionId 自动补全
 * 3. 让 mini 项目具备“系统级”会话域的最小形态
 */

export const DEFAULT_AGENT_ID = "main";
export const DEFAULT_MAIN_KEY = "main";

const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

/**
 * 将 token 值归一化为小写去空格字符串
 *
 * 输入示例: "  Main  " → "main"
 * 输入示例: null → ""
 */
function normalizeToken(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * 归一化 agent ID（转小写，替换非法字符为连字符，限长 64）
 *
 * 输入示例: "My Agent!" → "my-agent"
 * 输入示例: "" → "main"
 * 输入示例: "valid-id" → "valid-id"
 */
export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

/**
 * 归一化主会话 key（转小写，空值回退为 "main"）
 *
 * 输入示例: "Session-1" → "session-1"
 * 输入示例: "" → "main"
 */
export function normalizeMainKey(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.toLowerCase() : DEFAULT_MAIN_KEY;
}

/**
 * 构建标准格式的 agent session key
 *
 * 输入示例: { agentId: "my-bot", mainKey: "chat-1" }
 * 输出示例: "agent:my-bot:chat-1"
 *
 * 输入示例: { agentId: "main" }
 * 输出示例: "agent:main:main"
 */
export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
}

/**
 * 解析 session key，提取 agentId 和剩余部分
 *
 * 输入示例: "agent:my-bot:session-1"
 * 输出示例: { agentId: "my-bot", rest: "session-1" }
 *
 * 输入示例: "invalid-key"
 * 输出示例: null
 */
export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): { agentId: string; rest: string } | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return null;
  }
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0].toLowerCase() !== "agent") {
    return null;
  }
  const agentId = normalizeAgentId(parts[1]);
  const rest = parts.slice(2).join(":").trim();
  if (!rest) {
    return null;
  }
  return { agentId, rest };
}

export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed?.rest) {
    return false;
  }
  return parsed.rest.trim().toLowerCase().startsWith("subagent:");
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}

export function toAgentStoreSessionKey(params: {
  agentId: string;
  requestKey: string | undefined | null;
  mainKey?: string | undefined;
}): string {
  const raw = (params.requestKey ?? "").trim();
  if (!raw || normalizeToken(raw) === DEFAULT_MAIN_KEY) {
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey: params.mainKey });
  }
  const lowered = raw.toLowerCase();
  if (lowered.startsWith("agent:")) {
    return lowered;
  }
  return `agent:${normalizeAgentId(params.agentId)}:${lowered}`;
}

/**
 * 统一入口：把 sessionId / sessionKey 归一为 sessionKey
 * 
 * export 表示将这个函数导出，让其他文件可以通过 import 使用它。
 * // session-key.ts 中导出
export function resolveSessionKey(params: { ... }) { ... }

// cli.ts 中导入使用
import { resolveSessionKey } from "./session-key.js";
没有 export 的函数只能在当前文件内部使用，外部无法访问
 */
export function resolveSessionKey(params: {
  agentId?: string | undefined;
  sessionId?: string | undefined;
  sessionKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId ?? DEFAULT_AGENT_ID);
  const explicit = params.sessionKey?.trim();
  if (explicit) {
    return toAgentStoreSessionKey({ agentId, requestKey: explicit });
  }
  const sessionId = params.sessionId?.trim();
  if (sessionId) {
    return toAgentStoreSessionKey({ agentId, requestKey: sessionId });
  }
  return buildAgentMainSessionKey({ agentId, mainKey: DEFAULT_MAIN_KEY });
}
