/**
 * 上下文加载器 (ContextLoader)
 *
 * 负责加载工作区中的 Bootstrap 文件 (AGENTS.md / SOUL.md / TOOLS.md 等),
 * 并构建系统提示的"项目上下文"部分。
 *
 * 对应 OpenClaw: src/agents/context-loader.ts
 * - 加载 → 过滤(子代理白名单) → 截断(超长文件) → 拼接为 prompt 片段
 */

import {
  buildBootstrapContextFiles,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_SOUL_FILENAME,
  type BootstrapFile,
  type ContextFile,
} from "./bootstrap.js";

export class ContextLoader {
  private workspaceDir: string;
  private maxChars?: number;
  private warn?: (message: string) => void;

  constructor(
    workspaceDir: string,
    opts?: {
      maxChars?: number;
      warn?: (message: string) => void;
    },
  ) {
    this.workspaceDir = workspaceDir;
    this.maxChars = opts?.maxChars;
    this.warn = opts?.warn;
  }

  /**
   * 加载并过滤 Bootstrap 文件
   */
  async loadBootstrapFiles(params?: {
    sessionKey?: string;
  }): Promise<BootstrapFile[]> {
    const files = await loadWorkspaceBootstrapFiles(this.workspaceDir);
    return filterBootstrapFilesForSession(files, params?.sessionKey);
  }

  /**
   * 构建系统提示的上下文部分（Project Context）
   */
  async buildContextPrompt(params?: { sessionKey?: string }): Promise<string> {
    const files = await this.loadBootstrapFiles(params);
    const contextFiles = buildBootstrapContextFiles(files, {
      maxChars: this.maxChars,
      warn: this.warn,
    });
    if (contextFiles.length === 0) return "";

    const hasSoulFile = contextFiles.some((file) => {
      const normalized = file.path.trim().replace(/\\/g, "/");
      const baseName = normalized.split("/").pop() ?? normalized;
      return baseName.toLowerCase() === DEFAULT_SOUL_FILENAME.toLowerCase();
    });

    const lines: string[] = [
      "",
      "## 工作区文件 (已注入)",
      "以下文件为可编辑上下文，已注入到 Project Context：",
      "",
      "# Project Context",
      "",
      "以下项目上下文文件已加载：",
    ];
    if (hasSoulFile) {
      lines.push(
        "若存在 SOUL.md，请遵循其人格与语气指引，避免机械化回复（除非更高优先级指令覆盖）。",
      );
    }
    lines.push("");

    for (const file of contextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }

    return lines.join("\n");
  }

  /**
   * 检查 HEARTBEAT.md 是否有待办任务
   */
  async hasHeartbeatTasks(): Promise<boolean> {
    const files = await loadWorkspaceBootstrapFiles(this.workspaceDir);
    const heartbeat = files.find((f) => f.name === DEFAULT_HEARTBEAT_FILENAME);
    if (!heartbeat?.content) return false;

    // 检查是否有非空内容 (排除标题和空行)
    const lines = heartbeat.content.split("\n");
    return lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed &&
        !/^#+(\s|$)/.test(trimmed) &&
        !/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)
      );
    });
  }
}

export type { ContextFile };
