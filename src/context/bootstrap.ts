/**
 * Bootstrap 文件发现、加载、过滤与截断
 *
 * 本文件负责工作区 Bootstrap 文件 (AGENTS.md, SOUL.md, TOOLS.md 等) 的完整生命周期：
 * 1. 发现 — 在指定目录中查找所有约定的 Bootstrap 文件
 * 2. 加载 — 读取文件内容
 * 3. 过滤 — 对子代理 (subagent) 会话仅保留白名单中的文件
 * 4. 截断 — 超长文件按 head(70%) + tail(20%) 截断并插入标记
 *
 * 对应 OpenClaw: src/agents/context-loader.ts 中的 bootstrap 部分
 */

import fs from "node:fs/promises";
import path from "node:path";
import { isSubagentSessionKey } from "../session-key.js";

export const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
export const DEFAULT_SOUL_FILENAME = "SOUL.md";
export const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
export const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
export const DEFAULT_USER_FILENAME = "USER.md";
export const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
export const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
export const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
export const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";

export type BootstrapFileName =
  | typeof DEFAULT_AGENTS_FILENAME
  | typeof DEFAULT_SOUL_FILENAME
  | typeof DEFAULT_TOOLS_FILENAME
  | typeof DEFAULT_IDENTITY_FILENAME
  | typeof DEFAULT_USER_FILENAME
  | typeof DEFAULT_HEARTBEAT_FILENAME
  | typeof DEFAULT_BOOTSTRAP_FILENAME
  | typeof DEFAULT_MEMORY_FILENAME
  | typeof DEFAULT_MEMORY_ALT_FILENAME;

export type BootstrapFile = {
  name: BootstrapFileName;
  path: string;
  content?: string;
  missing: boolean;
};

export type ContextFile = {
  path: string;
  content: string;
};

const SUBAGENT_BOOTSTRAP_ALLOWLIST = new Set([DEFAULT_AGENTS_FILENAME, DEFAULT_TOOLS_FILENAME]);

export const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;
const BOOTSTRAP_HEAD_RATIO = 0.7;
const BOOTSTRAP_TAIL_RATIO = 0.2;

type TrimBootstrapResult = {
  content: string;
  truncated: boolean;
  maxChars: number;
  originalLength: number;
  headChars: number;
  tailChars: number;
};

/**
 * 将任意值规范化为正整数，无效值返回 null
 *
 * 输入示例: 3.7
 * 输出示例: 3
 *
 * 输入示例: -1
 * 输出示例: null
 *
 * 输入示例: "abc"
 * 输出示例: null
 */
function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int > 0 ? int : null;
}

/**
 * 解析 Bootstrap 文件的最大字符数限制
 *
 * 若传入有效正整数则使用该值，否则回退到默认值 (20000)。
 *
 * 输入示例: 5000
 * 输出示例: 5000
 *
 * 输入示例: undefined
 * 输出示例: 20000 (DEFAULT_BOOTSTRAP_MAX_CHARS)
 */
export function resolveBootstrapMaxChars(maxChars?: number): number {
  const parsed = normalizePositiveInt(maxChars);
  return parsed ?? DEFAULT_BOOTSTRAP_MAX_CHARS;
}

/**
 * 截断超长 Bootstrap 文件内容
 *
 * 策略：保留文件头部 70% + 尾部 20%，中间插入截断标记。
 * 若内容未超过 maxChars 则原样返回。
 *
 * 输入示例: content="...30000字符...", fileName="AGENTS.md", maxChars=20000
 * 输出示例: { content: "头部14000字符\n[截断标记]\n尾部4000字符", truncated: true, ... }
 *
 * 输入示例: content="短内容", fileName="SOUL.md", maxChars=20000
 * 输出示例: { content: "短内容", truncated: false, ... }
 */
function trimBootstrapContent(
  content: string,
  fileName: string,
  maxChars: number,
): TrimBootstrapResult {
  const trimmed = content.trimEnd();
  if (trimmed.length <= maxChars) {
    return {
      content: trimmed,
      truncated: false,
      maxChars,
      originalLength: trimmed.length,
      headChars: trimmed.length,
      tailChars: 0,
    };
  }

  // 按比例计算头部和尾部保留的字符数
  const headChars = Math.floor(maxChars * BOOTSTRAP_HEAD_RATIO);
  const tailChars = Math.floor(maxChars * BOOTSTRAP_TAIL_RATIO);
  const head = trimmed.slice(0, headChars);
  const tail = trimmed.slice(-tailChars);

  const marker = [
    "",
    `[...truncated, read ${fileName} for full content...]`,
    `…(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})…`,
    "",
  ].join("\n");
  const contentWithMarker = [head, marker, tail].join("\n");
  return {
    content: contentWithMarker,
    truncated: true,
    maxChars,
    originalLength: trimmed.length,
    headChars,
    tailChars,
  };
}

/**
 * 解析 MEMORY.md / memory.md 的候选文件条目
 *
 * 同时检查两种命名 (MEMORY.md 和 memory.md)，若存在则加入结果。
 * 当两者指向同一物理文件（如符号链接）时进行去重，避免重复加载。
 *
 * 输入示例: resolvedDir="/project"
 *   - /project/MEMORY.md 存在
 *   - /project/memory.md 不存在
 * 输出示例: [{ name: "MEMORY.md", filePath: "/project/MEMORY.md" }]
 */
async function resolveMemoryBootstrapEntries(
  resolvedDir: string,
): Promise<Array<{ name: BootstrapFileName; filePath: string }>> {
  const candidates: BootstrapFileName[] = [
    DEFAULT_MEMORY_FILENAME,
    DEFAULT_MEMORY_ALT_FILENAME,
  ];
  const entries: Array<{ name: BootstrapFileName; filePath: string }> = [];
  for (const name of candidates) {
    const filePath = path.join(resolvedDir, name);
    try {
      await fs.access(filePath);
      entries.push({ name, filePath });
    } catch {
      // optional — 文件不存在则跳过
    }
  }
  if (entries.length <= 1) {
    return entries;
  }

  // 通过 realpath 去重：避免 MEMORY.md 和 memory.md 是同一文件的符号链接时重复加载
  const seen = new Set<string>();
  const deduped: Array<{ name: BootstrapFileName; filePath: string }> = [];
  for (const entry of entries) {
    let key = entry.filePath;
    try {
      key = await fs.realpath(entry.filePath);
    } catch {}
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

/**
 * 加载工作区目录下的所有 Bootstrap 文件
 *
 * 按照固定顺序扫描文件 (AGENTS → SOUL → TOOLS → IDENTITY → USER → HEARTBEAT → BOOTSTRAP → MEMORY)，
 * 无论文件是否存在都会包含在结果中（missing 字段标记缺失状态）。
 *
 * 输入示例: dir="./my-project"
 * 输出示例: [
 *   { name: "AGENTS.md", path: "/abs/my-project/AGENTS.md", content: "...", missing: false },
 *   { name: "SOUL.md", path: "/abs/my-project/SOUL.md", missing: true },
 *   ...
 * ]
 */
export async function loadWorkspaceBootstrapFiles(dir: string): Promise<BootstrapFile[]> {
  const resolvedDir = path.resolve(dir);
  const entries: Array<{
    name: BootstrapFileName;
    filePath: string;
  }> = [
    {
      name: DEFAULT_AGENTS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_AGENTS_FILENAME),
    },
    {
      name: DEFAULT_SOUL_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_SOUL_FILENAME),
    },
    {
      name: DEFAULT_TOOLS_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_TOOLS_FILENAME),
    },
    {
      name: DEFAULT_IDENTITY_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_IDENTITY_FILENAME),
    },
    {
      name: DEFAULT_USER_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_USER_FILENAME),
    },
    {
      name: DEFAULT_HEARTBEAT_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_HEARTBEAT_FILENAME),
    },
    {
      name: DEFAULT_BOOTSTRAP_FILENAME,
      filePath: path.join(resolvedDir, DEFAULT_BOOTSTRAP_FILENAME),
    },
  ];

  entries.push(...(await resolveMemoryBootstrapEntries(resolvedDir)));

  const result: BootstrapFile[] = [];
  for (const entry of entries) {
    try {
      const content = await fs.readFile(entry.filePath, "utf-8");
      result.push({
        name: entry.name,
        path: entry.filePath,
        content,
        missing: false,
      });
    } catch {
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    }
  }
  return result;
}

/**
 * 根据会话类型过滤 Bootstrap 文件
 *
 * 主会话返回全部文件；子代理 (subagent) 会话仅保留白名单中的文件
 * (AGENTS.md 和 TOOLS.md)，以减少子代理的上下文噪声。
 *
 * 输入示例: files=[所有Bootstrap文件], sessionKey="subagent:task-123"
 * 输出示例: 仅包含 AGENTS.md 和 TOOLS.md 的子集
 *
 * 输入示例: files=[所有Bootstrap文件], sessionKey=undefined
 * 输出示例: 原样返回全部文件
 */
export function filterBootstrapFilesForSession(
  files: BootstrapFile[],
  sessionKey?: string,
): BootstrapFile[] {
  if (!sessionKey || !isSubagentSessionKey(sessionKey)) {
    return files;
  }
  return files.filter((file) => SUBAGENT_BOOTSTRAP_ALLOWLIST.has(file.name));
}

/**
 * 将 Bootstrap 文件构建为可注入上下文的最终内容列表
 *
 * 对每个文件执行：
 * - 缺失文件 → 生成 [MISSING] 占位内容
 * - 正常文件 → 截断处理（若超长则触发警告）
 * - 空内容文件 → 跳过不包含在结果中
 *
 * 输入示例: files=[{ name:"AGENTS.md", content:"...", missing:false }], opts={ maxChars:20000 }
 * 输出示例: [{ path:"AGENTS.md", content:"..." }]
 */
export function buildBootstrapContextFiles(
  files: BootstrapFile[],
  opts?: { warn?: (message: string) => void; maxChars?: number },
): ContextFile[] {
  const maxChars = resolveBootstrapMaxChars(opts?.maxChars);
  const result: ContextFile[] = [];
  for (const file of files) {
    if (file.missing) {
      result.push({
        path: file.name,
        content: `[MISSING] Expected at: ${file.path}`,
      });
      continue;
    }
    const trimmed = trimBootstrapContent(file.content ?? "", file.name, maxChars);
    if (!trimmed.content) {
      continue;
    }
    if (trimmed.truncated) {
      opts?.warn?.(
        `workspace bootstrap file ${file.name} is ${trimmed.originalLength} chars ` +
          `(limit ${trimmed.maxChars}); truncating in injected context`,
      );
    }
    result.push({
      path: file.name,
      content: trimmed.content,
    });
  }
  return result;
}
