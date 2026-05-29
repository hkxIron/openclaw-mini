/**
 * 上下文窗口守卫
 *
 * 在 Agent 运行前检查配置的上下文窗口大小是否合理:
 * - 低于 32K tokens 时发出警告（可能导致频繁 compaction）
 * - 低于 16K tokens 时阻止运行（无法保证基本对话质量）
 *
 * 对应 OpenClaw: src/agents/context-window-guard.ts
 */

/** 硬性最低 token 数，低于此值拒绝启动 */
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
/** 警告阈值，低于此值时打印警告日志 */
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export type ContextWindowSource = "agentContextTokens" | "default";

export type ContextWindowInfo = {
  tokens: number;
  source: ContextWindowSource;
};

/**
 * 将输入归一化为正整数，非法值返回 null
 *
 * 输入示例: 200000 → 200000
 * 输入示例: -1 → null
 * 输入示例: "abc" → null
 */
function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

/**
 * 解析上下文窗口信息（来源优先级: agent 配置 > 默认值）
 *
 * 输入示例: { contextTokens: 100000, defaultTokens: 200000 }
 * 输出示例: { tokens: 100000, source: "agentContextTokens" }
 *
 * 输入示例: { contextTokens: undefined, defaultTokens: 200000 }
 * 输出示例: { tokens: 200000, source: "default" }
 */
export function resolveContextWindowInfo(params: {
  contextTokens?: number;
  defaultTokens: number;
}): ContextWindowInfo {
  const fromAgent = normalizePositiveInt(params.contextTokens);
  if (fromAgent) {
    return { tokens: fromAgent, source: "agentContextTokens" };
  }
  return { tokens: Math.floor(params.defaultTokens), source: "default" };
}

export type ContextWindowGuardResult = ContextWindowInfo & {
  shouldWarn: boolean;
  shouldBlock: boolean;
};

/**
 * 评估上下文窗口守卫，决定是否警告或阻止
 *
 * 输入示例: { info: { tokens: 8000, source: "agentContextTokens" }, ... }
 * 输出示例: { tokens: 8000, source: "agentContextTokens", shouldWarn: true, shouldBlock: true }
 *
 * 输入示例: { info: { tokens: 200000, source: "default" }, ... }
 * 输出示例: { tokens: 200000, source: "default", shouldWarn: false, shouldBlock: false }
 */
export function evaluateContextWindowGuard(params: {
  info: ContextWindowInfo;
  warnBelowTokens?: number;
  hardMinTokens?: number;
}): ContextWindowGuardResult {
  const warnBelow = Math.max(1, Math.floor(params.warnBelowTokens ?? CONTEXT_WINDOW_WARN_BELOW_TOKENS));
  const hardMin = Math.max(1, Math.floor(params.hardMinTokens ?? CONTEXT_WINDOW_HARD_MIN_TOKENS));
  const tokens = Math.max(0, Math.floor(params.info.tokens));
  return {
    ...params.info,
    tokens,
    shouldWarn: tokens > 0 && tokens < warnBelow,
    shouldBlock: tokens > 0 && tokens < hardMin,
  };
}
