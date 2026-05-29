/**
 * 工具策略
 *
 * 对应 OpenClaw: src/agents/pi-tools.policy.ts + src/agents/sandbox/tool-policy.ts
 *
 * 三级 CompiledPattern 设计:
 * - "all"   → "*" 匹配一切，短路返回
 * - "exact" → 无通配符，直接字符串比较，零 RegExp 开销
 * - "regex" → 含 * 通配符，编译为安全的 RegExp
 *
 * 转义链（仅 regex 分支）:
 *   1. 先把所有正则特殊字符转义: "exec*" → "exec\*"
 *   2. 再把 "\*"（被转义的通配符）替换为 ".*": "exec\*" → "exec.*"
 *   3. 加首尾锚点: "^exec.*$"
 *   效果: 用户输入的 . ( ) 等被当作字面量，只有 * 作为通配符
 */

import type { Tool } from "./tools/types.js";

export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

// ============== 三级编译模式（对齐 OpenClaw） ==============

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

/**
 * 工具名归一化
 *
 * 对应 OpenClaw: normalizeToolName()
 *
 * 输入示例: "bash"         → 输出: "exec"
 * 输入示例: "apply-patch"  → 输出: "apply_patch"
 * 输入示例: "Read"         → 输出: "read"
 * 输入示例: "  Exec  "     → 输出: "exec"
 */
function normalizeToolName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  // 对齐 openclaw 别名映射
  if (trimmed === "apply-patch") return "apply_patch";
  if (trimmed === "bash") return "exec";
  return trimmed;
}

/**
 * 编译 pattern 为三级类型
 *
 * 对应 OpenClaw: pi-tools.policy.ts:11-32 → compilePattern()
 *
 * 输入示例: "*"          → 输出: { kind: "all" }
 * 输入示例: "exec"       → 输出: { kind: "exact", value: "exec" }
 * 输入示例: "mcp__*"     → 输出: { kind: "regex", value: /^mcp__.*$/ }
 * 输入示例: "bash"       → 输出: { kind: "exact", value: "exec" } (经过归一化)
 */
function compilePattern(pattern: string): CompiledPattern {
  const normalized = normalizeToolName(pattern);
  if (!normalized) {
    return { kind: "exact", value: "" };
  }
  // "*" → 匹配一切
  if (normalized === "*") {
    return { kind: "all" };
  }
  // 无通配符 → 精确匹配，不构造 RegExp
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized };
  }
  // 含通配符 → 安全编译为 RegExp
  // 步骤 1: 转义所有正则特殊字符（包括 *）
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 步骤 2: 把被转义的 \* 还原为 .* (通配符语义)
  const regex = `^${escaped.replaceAll("\\*", ".*")}$`;
  return { kind: "regex", value: new RegExp(regex) };
}

function compilePatterns(patterns: string[]): CompiledPattern[] {
  return patterns.map(compilePattern);
}

/**
 * 匹配已编译的 pattern 列表
 *
 * 对应 OpenClaw: pi-tools.policy.ts → matchesAny()
 *
 * 遍历 patterns，任一匹配即返回 true；全部不匹配返回 false。
 * 短路优化: "all" 类型直接返回 true，无需遍历后续 pattern。
 */
function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") return true;
    if (pattern.kind === "exact" && name === pattern.value) return true;
    if (pattern.kind === "regex" && pattern.value.test(name)) return true;
  }
  return false;
}

// ============== 公共 API ==============

/**
 * 判断工具是否被策略允许
 *
 * 对应 OpenClaw: makeToolPolicyMatcher() 的判定顺序:
 * 1. deny 优先 — 匹配 deny 则拒绝
 * 2. allow 为空 — 允许一切
 * 3. allow 匹配 — 明确允许
 * 4. apply_patch 继承 exec 权限（openclaw 特殊规则）
 * 5. 默认拒绝
 *
 * 输入示例: isToolAllowed("bash", { allow: ["exec", "read"], deny: [] })
 * 输出示例: true  ("bash" 归一化为 "exec"，在 allow 列表中)
 *
 * 输入示例: isToolAllowed("write", { allow: ["exec"], deny: ["write"] })
 * 输出示例: false  (匹配 deny 列表)
 */
export function isToolAllowed(name: string, policy?: ToolPolicy): boolean {
  if (!policy) return true;

  const normalized = normalizeToolName(name);
  const deny = compilePatterns(policy.deny ?? []);
  const allow = compilePatterns(policy.allow ?? []);

  if (matchesAny(normalized, deny)) return false;
  if (allow.length === 0) return true;
  if (matchesAny(normalized, allow)) return true;
  // 对应 OpenClaw: apply_patch 继承 exec 的权限
  if (normalized === "apply_patch" && matchesAny("exec", allow)) return true;
  return false;
}

/**
 * 按策略过滤工具列表，返回允许使用的工具子集
 *
 * 输入示例: filterToolsByPolicy(
 *   [{ name: "exec", ... }, { name: "write", ... }, { name: "read", ... }],
 *   { allow: ["exec", "read"], deny: [] }
 * )
 * 输出示例: [{ name: "exec", ... }, { name: "read", ... }]
 */
export function filterToolsByPolicy(tools: Tool[], policy?: ToolPolicy): Tool[] {
  if (!policy) return tools;
  // 预编译一次，避免 N 个工具重复编译 N 次
  const deny = compilePatterns(policy.deny ?? []);
  const allow = compilePatterns(policy.allow ?? []);
  return tools.filter((tool) => {
    const normalized = normalizeToolName(tool.name);
    if (matchesAny(normalized, deny)) return false;
    if (allow.length === 0) return true;
    if (matchesAny(normalized, allow)) return true;
    // 对应 OpenClaw: apply_patch 继承 exec 权限
    if (normalized === "apply_patch" && matchesAny("exec", allow)) return true;
    return false;
  });
}

