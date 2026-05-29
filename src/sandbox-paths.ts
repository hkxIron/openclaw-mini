/**
 * 沙箱路径安全工具
 *
 * 确保工具操作的文件路径不会逃逸出工作区 (workspace) 目录。
 * 防御路径穿越攻击 (如 "../../etc/passwd") 和符号链接逃逸。
 *
 * 对应 OpenClaw: src/agents/sandbox/sandbox-paths.ts
 *
 * 三层防护:
 * 1. 路径解析: ~ 展开 + Unicode 空格归一化 + 相对路径解析
 * 2. 边界检查: relative() 计算后检查是否以 ".." 开头
 * 3. 符号链接检查: 逐段 lstat 检测符号链接
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * 将 Unicode 特殊空格字符归一化为 ASCII 空格
 *
 * 输入示例: "src/file name.ts" (包含不间断空格)
 * 输出示例: "src/file name.ts"
 */
function normalizeUnicodeSpaces(value: string): string {
  return value.replace(UNICODE_SPACES, " ");
}

/**
 * 展开路径中的 ~ 为用户主目录
 *
 * 输入示例: "~/docs/file.md"
 * 输出示例: "/home/user/docs/file.md"
 *
 * 输入示例: "src/index.ts"
 * 输出示例: "src/index.ts" (非 ~ 开头，原样返回)
 */
function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(filePath);
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

/**
 * 将文件路径解析为绝对路径（相对于 cwd）
 *
 * 输入示例: ("src/index.ts", "/home/user/project")
 * 输出示例: "/home/user/project/src/index.ts"
 */
function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

/**
 * 缩短路径显示（将 home 目录替换为 ~）
 *
 * 输入示例: "/home/user/project/src/index.ts"
 * 输出示例: "~/project/src/index.ts"
 */
function shortPath(value: string): string {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}

/**
 * 逐段检查路径中是否存在符号链接
 *
 * 输入示例: ("src/utils/helper.ts", "/home/user/project")
 * 若 /home/user/project/src 是符号链接 → 抛出错误
 * 若路径中某段不存在 (ENOENT) → 提前返回（尚未创建的目录不检查）
 */
async function assertNoSymlink(relative: string, root: string): Promise<void> {
  if (!relative) {
    return;
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Path contains symlink: ${current}`);
      }
    } catch (err) {
      const anyErr = err as { code?: string };
      if (anyErr.code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

/**
 * 解析并验证沙箱路径（同步版，仅做边界检查，不检查符号链接）
 *
 * 输入示例: { filePath: "src/index.ts", cwd: "/project", root: "/project" }
 * 输出示例: { resolved: "/project/src/index.ts", relative: "src/index.ts" }
 *
 * 输入示例: { filePath: "../../etc/passwd", cwd: "/project", root: "/project" }
 * 抛出错误: "Path escapes workspace"
 */
export function resolveSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
}): { resolved: string; relative: string } {
  const resolved = resolveToCwd(params.filePath, params.cwd);
  const rootResolved = path.resolve(params.root);
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative === "") {
    return { resolved, relative: "" };
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace (${shortPath(rootResolved)}): ${params.filePath}`);
  }
  return { resolved, relative };
}

/**
 * 解析、验证并检查符号链接的沙箱路径（异步版，完整安全检查）
 *
 * 输入示例: { filePath: "src/index.ts", cwd: "/project", root: "/project" }
 * 输出示例: { resolved: "/project/src/index.ts", relative: "src/index.ts" }
 *
 * 安全保证: 路径不能逃逸 root，且路径中的每一段都不能是符号链接
 */
export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
}): Promise<{ resolved: string; relative: string }> {
  const resolved = resolveSandboxPath(params);
  await assertNoSymlink(resolved.relative, path.resolve(params.root));
  return resolved;
}
