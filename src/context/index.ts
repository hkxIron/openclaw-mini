/**
 * Context 模块统一导出
 *
 * 本模块负责 Agent 上下文管理的三大核心功能:
 * 1. Bootstrap — 工作区文件加载 (AGENTS.md, SOUL.md, TOOLS.md 等)
 * 2. Pruning — 上下文修剪 (三层递进: soft trim → hard clear → message drop)
 * 3. Compaction — 历史摘要压缩 (超出上下文窗口时自动生成结构化摘要)
 * 4. Tokens — token 估算 (基于字符数的快速近似)
 *
 * 对应 OpenClaw: src/agents/pi-extensions/context-pruning/ + src/agents/compaction.ts
 */

export { ContextLoader, type ContextFile } from "./loader.js";
export {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  buildBootstrapContextFiles,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  resolveBootstrapMaxChars,
  type BootstrapFile,
  type BootstrapFileName,
} from "./bootstrap.js";
export {
  DEFAULT_CONTEXT_PRUNING_SETTINGS,
  pruneContextMessages,
  resolvePruningSettings,
  type ContextPruningSettings,
  type ContextPruningToolMatch,
  type PruneResult,
} from "./pruning.js";
export {
  buildCompactionSummary,
  compactHistoryIfNeeded,
  computeAdaptiveChunkRatio,
  shouldTriggerCompaction,
  type CompactionSettings,
  type SummarizeFn,
  DEFAULT_COMPACTION_SETTINGS,
  DEFAULT_SUMMARY_MAX_TOKENS,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from "./compaction.js";
export {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateMessageChars,
  estimateMessageTokens,
  estimateMessagesChars,
  estimateMessagesTokens,
} from "./tokens.js";
