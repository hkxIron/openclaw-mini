/**
 * 工具审批系统
 *
 * 对应 OpenClaw: src/infra/exec-approvals.ts + src/gateway/exec-approval-manager.ts
 *
 * 两层安全设计:
 *   Layer 1: tool-policy.ts (静态) — Agent 启动前过滤工具列表 (allow/deny)
 *   Layer 2: tool-approval.ts (运行时) — 工具执行前拦截，等待用户审批
 *
 * 三级安全 (ApprovalSecurity):
 *   deny      → 拒绝执行（该工具被完全禁止）
 *   allowlist  → 仅已批准的工具可直接执行，否则需审批
 *   full       → 允许执行，无需审批
 *
 * 三种提示 (ApprovalAsk):
 *   off        → 不提示，直接按 security 级别决定
 *   on-miss    → 仅当 security 策略会拒绝时提示（allowlist 模式下工具不在列表中）
 *   always     → 每次执行都提示
 *
 * 三种决定 (ApprovalDecision):
 *   allow-once   → 本次允许执行
 *   allow-always → 允许执行并加入 allowlist（后续不再提示）
 *   deny         → 拒绝执行
 *
 * 决策真值表（对齐 openclaw requiresExecApproval）:
 * | ask      | security  | inAllowlist | → requires approval |
 * |----------|-----------|-------------|---------------------|
 * | off      | *         | *           | false               |
 * | always   | *         | *           | true                |
 * | on-miss  | full      | *           | false               |
 * | on-miss  | deny      | *           | false (直接拒绝)    |
 * | on-miss  | allowlist | true        | false               |
 * | on-miss  | allowlist | false       | true                |
 */

// ============== 类型 ==============

/** 安全级别（对齐 openclaw ExecSecurity） */
export type ApprovalSecurity = "deny" | "allowlist" | "full";

/** 提示模式（对齐 openclaw ExecAsk） */
export type ApprovalAsk = "off" | "on-miss" | "always";

/** 审批决定（对齐 openclaw ExecApprovalDecision） */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

/** 审批请求 */
export type ApprovalRequest = {
  toolCallId: string;
  toolName: string;
  args: unknown;
};

/** 审批配置 */
export type ApprovalConfig = {
  /** 默认安全级别（默认 "full"，无需审批） */
  security?: ApprovalSecurity;
  /** 提示模式（默认 "off"，不提示） */
  ask?: ApprovalAsk;
  /** 每工具安全级别覆盖（工具名 → 安全级别） */
  tools?: Record<string, ApprovalSecurity>;
};

/** 审批处理器（由外部提供，如 CLI readline、Gateway 广播） */
export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** Allowlist 条目 */
export type AllowlistEntry = {
  toolName: string;
  addedAt: number;
};

// ============== 核心决策 ==============

/**
 * 判断工具是否需要审批
 *
 * 对齐 openclaw: exec-approvals.ts → requiresExecApproval()
 *
 * 输入示例:
 *   requiresApproval({
 *     toolName: "exec",
 *     config: { ask: "on-miss", security: "allowlist", tools: {} },
 *     allowlist: [{ toolName: "read", addedAt: 1700000000000 }]
 *   })
 * 输出示例: true  (ask="on-miss" + security="allowlist" + "exec" 不在 allowlist 中 → 需要审批)
 *
 * 输入示例:
 *   requiresApproval({
 *     toolName: "read",
 *     config: { ask: "on-miss", security: "allowlist" },
 *     allowlist: [{ toolName: "read", addedAt: 1700000000000 }]
 *   })
 * 输出示例: false  ("read" 已在 allowlist 中 → 无需审批)
 */
export function requiresApproval(params: {
  toolName: string;
  config: ApprovalConfig;
  allowlist: AllowlistEntry[];
}): boolean {
  const { toolName, config, allowlist } = params;
  const ask = config.ask ?? "off";
  const security = config.tools?.[toolName] ?? config.security ?? "full";

  if (ask === "off") return false;
  if (ask === "always") return true;

  // on-miss: 仅当 security 策略会拒绝时提示
  if (ask === "on-miss") {
    if (security === "full") return false;
    // deny 级别不在此处提示（由 checkToolApproval 直接拒绝，对齐 openclaw 真值表）
    if (security === "deny") return false;
    // allowlist 模式: 检查是否已在列表中
    return !allowlist.some((e) => e.toolName === toolName);
  }

  return false;
}

// ============== Allowlist 管理 ==============

/**
 * 内存 Allowlist 管理器
 *
 * 对齐 openclaw: exec-approvals.ts → AllowlistEntry[] + matchAllowlist()
 * - openclaw 持久化到 ~/.openclaw/exec-approvals.json
 * - mini 版简化为内存管理（进程生命周期内有效）
 */
export class AllowlistManager {
  private entries: AllowlistEntry[] = [];

  has(toolName: string): boolean {
    return this.entries.some((e) => e.toolName === toolName);
  }

  add(toolName: string): void {
    if (!this.has(toolName)) {
      this.entries.push({ toolName, addedAt: Date.now() });
    }
  }

  getAll(): AllowlistEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}
