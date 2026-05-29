#!/usr/bin/env node
/**
 * Mini Agent CLI
 *
 * 交互设计:
 * - 线性滚动输出，不保留固定底部区域
 * - 输入提示始终跟随在最后一条消息之后
 * - 历史区仅保留用户/模型/工具事件，不保留输入框装饰
 * 
 * 本文件为项目入口：
 * 从 package.json 中可以看出：
"bin": {
  "openclaw-mini": "dist/src/cli.js"    // CLI 命令入口
},
"scripts": {
  "dev": "tsx src/cli.ts",              // 开发运行
  "start": "node dist/src/cli.js",     // 生产运行
}
另外 cli.ts:1 的 shebang 行 #!/usr/bin/env node 也表明它是一个可直接执行的入口文件。
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { Agent } from "./index.js";
import { resolveSessionKey } from "./session-key.js";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import { MyOpenAIStreamProvider } from "./provider/my-openai-stream.js";
import type { ApprovalConfig, ApprovalDecision, ApprovalRequest } from "./tool-approval.js";

// ============== .env 加载 ==============

/**
 * 加载工作目录下的 .env 文件到 process.env
 *
 * 输入示例: loadEnvFile("/home/user/project")
 * 效果: 读取 /home/user/project/.env，将 KEY=VALUE 行设置到环境变量
 *
 * 注意: 不会覆盖已存在的环境变量（只设置新的）
 */
function loadEnvFile(dir: string = process.cwd()): void {
  const envPath = path.join(dir, ".env");
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    // 从=号后的内容视为 value，但会去除首尾的引号
    // 去除开头或结尾的单/双引号
    // 如果没有 /g，replace 只会替换第一个匹配（比如只去掉开头引号，结尾的留着）。加了 /g 后开头和结尾的引号都会被去掉。
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

// ============== 样式 ==============

const styles = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",

  black: "\x1b[30m",
  white: "\x1b[37m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",

  bgWhite: "\x1b[47m",
  bgYellow: "\x1b[43m",
  bgGreen: "\x1b[42m",
  bgCyan: "\x1b[46m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
} as const;

const badgeStyles = {
  system: `${styles.black}${styles.bgWhite}`,
  input: `${styles.black}${styles.bgYellow}`,
  user: `${styles.black}${styles.bgGreen}`,
  model: `${styles.black}${styles.bgCyan}`,
  tool: `${styles.white}${styles.bgBlue}`,
  think: `${styles.white}${styles.bgMagenta}`,
  approve: `${styles.black}${styles.bgYellow}`,
} as const;

/**
 * 为文本添加 ANSI 颜色代码
 *
 * 输入示例: color("hello", "green")
 * 输出示例: "\x1b[32mhello\x1b[0m"
 */
function color(text: string, c: keyof typeof styles): string {
  return `${styles[c]}${text}${styles.reset}`;
}

/**
 * 生成带背景色的徽章文本（如 " MODEL " " TOOL " 等标签）
 *
 * 输入示例: badge("SYS", badgeStyles.system)
 * 输出示例: "\x1b[30m\x1b[47m SYS \x1b[0m"
 */
function badge(text: string, style: string): string {
  return `${style} ${text} ${styles.reset}`;
}

// ============== 输出状态 ==============

let unsubscribe: (() => void) | null = null;
let outputMode: "idle" | "thinking" | "assistant" = "idle";
type BlockKind = "system" | "user" | "tool" | "thinking" | "assistant" | "meta";
let lastBlockKind: BlockKind | null = null;

// 工具调用参数缓存（start 有 args，end 有 result，需关联）
const pendingToolArgs = new Map<string, unknown>();

/** 恢复终端光标可见性（程序退出前调用，避免光标消失） */
function resetTerminal(): void {
  process.stdout.write("\x1b[?25h");
}

/** 关闭当前输出行（若正在输出流式内容则换行，将状态重置为 idle） */
function closeOutputLine(): void {
  if (outputMode !== "idle") {
    process.stdout.write("\n");
    outputMode = "idle";
  }
}

/** 确保不同类型输出块之间有空行分隔（同类型连续输出不加空行） */
function ensureBlockSpacing(kind: BlockKind): void {
  if (lastBlockKind && lastBlockKind !== kind) {
    process.stdout.write("\n");
  }
  lastBlockKind = kind;
}

/** 开始 thinking 输出行（打印 THINK 徽章，切换模式为 thinking） */
function beginThinkingLine(): void {
  if (outputMode !== "thinking") {
    closeOutputLine();
    ensureBlockSpacing("thinking");
    process.stdout.write(`${badge("THINK", badgeStyles.think)} `);
    outputMode = "thinking";
  }
}

/** 开始 assistant 输出行（打印 MODEL 徽章，切换模式为 assistant） */
function beginAssistantLine(): void {
  if (outputMode !== "assistant") {
    closeOutputLine();
    ensureBlockSpacing("assistant");
    process.stdout.write(`${badge("MODEL", badgeStyles.model)} `);
    outputMode = "assistant";
  }
}

function printSystemLine(text: string, tone: "info" | "warn" | "error" = "info"): void {
  closeOutputLine();
  ensureBlockSpacing("system");
  let body = text;
  if (tone === "warn") body = color(text, "yellow");
  if (tone === "error") body = color(text, "yellow");
  console.log(`${badge("SYS", badgeStyles.system)} ${body}`);
}

function printUserLine(text: string): void {
  closeOutputLine();
  ensureBlockSpacing("user");
  console.log(`${badge("USER", badgeStyles.user)} ${text}`);
}

function printToolLine(text: string, isError = false): void {
  closeOutputLine();
  ensureBlockSpacing("tool");
  const body = isError ? color(text, "yellow") : color(text, "dim");
  console.log(`${badge("TOOL", badgeStyles.tool)} ${body}`);
}

function printMetaLine(text: string): void {
  closeOutputLine();
  ensureBlockSpacing("meta");
  console.log(`${color("↳", "dim")} ${text}`);
}

function clearPromptEchoLine(): void {
  // 删除 readline 刚回显的 "INPUT ❯ xxx" 行，避免历史污染
  process.stdout.write("\x1b[1A\x1b[2K\r");
}

// ============== 主函数 ==============

async function main() {
  const args = process.argv.slice(2); // 当前进程的命令行参数
  //console.log(`args:${args} process.env:${JSON.stringify(process.env)}`);
  console.log(`args:${args}`);
  const provider = readFlag(args, "--provider") ?? process.env.OPENCLAW_MINI_PROVIDER ?? "anthropic";
  const model = readFlag(args, "--model") ?? process.env.OPENCLAW_MINI_MODEL;
  const baseUrl = readFlag(args, "--base-url") ?? process.env.OPENCLAW_MINI_BASE_URL;
  const reasoningFlag = readFlag(args, "--reasoning") ?? process.env.OPENCLAW_MINI_REASONING;
  const reasoning = reasoningFlag === "none" ? undefined : (reasoningFlag as any) ?? "medium";
  //const apiKey = readFlag(args, "--api-key") ?? getEnvApiKey(provider);
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.error(`错误: 未找到 ${provider} 的 API Key，请设置对应环境变量或使用 --api-key 参数`);
    process.exit(1);
  }

  const agentId = readFlag(args, "--agent") ??  process.env.OPENCLAW_MINI_AGENT_ID ?? "main";
  const sessionId = resolveSessionIdArg(args) || `session-${Date.now()}`; // Date.now() -> 1780060321434
  const workspaceDir = process.cwd();
  const sessionKey = resolveSessionKey({ agentId, sessionId });

  // --approval 参数解析
  const approvalFlag = readFlag(args, "--approval");
  const approvalEnabled = args.includes("--approval");
  let approval: ApprovalConfig | undefined;
  if (approvalEnabled) {
    /**
     * ask 决定工具审批的询问策略，有两个值：
     * 
      "always" — 每次执行工具都询问用户是否批准
      "on-miss" — 只在工具不在白名单中时才询问
      as const 是 TypeScript 的类型断言，把字符串类型从宽泛的 string 收窄为精确的字面量类型 "always" 或 "on-miss"，以满足后面 ApprovalConfig 的类型约束。

      ask 本身就是一个字符串。但 TypeScript 的类型检查是结构化的（duck typing），不要求显式引用类型名。
      as const 让 ask 的类型从 string 收窄为字面量 "always" | "on-miss"，而 ApprovalAsk 的定义恰好是 "off" | "on-miss" | "always"。
      赋值时 TypeScript 只检查值是否兼容目标类型：

      ask 的类型: "always" | "on-miss"
      approval.ask 期望: "off" | "on-miss" | "always"
      "always" | "on-miss" 是 "off" | "on-miss" | "always" 的子集 → 兼容 ✓

      所以不需要显式写 const ask: ApprovalAsk = ...，
      只要值匹配就能通过类型检查。如果去掉 as const，
      ask 的类型就是宽泛的 string，赋给 ApprovalAsk 类型的字段就会报错。
     */
    const ask = approvalFlag === "always" ? "always" as const : "on-miss" as const;
    approval = {
      ask, // ask 放进去用的是 JavaScript 的对象属性简写语法——当属性名和变量名相同时，{ ask } 等价于 { ask: ask }。
      security: "full",
      tools: { exec: "allowlist", write: "allowlist", edit: "allowlist" },
    };
  }

  // readline（在 agent 之前创建，供审批处理器使用）
  // 自定义输出流: 过滤 ANSI 清屏序列（\x1b[J / \x1b[0J），防止 readline 内部清屏擦掉已有输出
  const rlOutput = new Writable({
    write(chunk, _encoding, callback) {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      process.stdout.write(text.replace(/\x1b\[0?J/g, ""), callback);
    },
  });
  // 创建交互式输入接口: stdin 读取用户输入，
  // output: rlOutput — 输出走自定义流（而非直接 stdout），避免清屏副作用
  // 之后用 readLineIFace.question(...) 向用户提问并等待输入（如工具审批时的 [y/n/a] 提示）
  const readLineIFace = readline.createInterface({
    input: process.stdin,
    output: rlOutput,
  });

  // 审批处理器（对齐 openclaw: CLI 模式下的 approval prompt）
  const onApprovalRequest = approval
    ? async (request: ApprovalRequest): Promise<ApprovalDecision> => {
        closeOutputLine();
        const label = formatToolCompact(request.toolName, request.args);
        return new Promise((resolve) => {
          readLineIFace.question(
            `${badge("?", badgeStyles.approve)} ${color("approve", "yellow")} ${label}? ${color("[y/n/a]", "dim")} `,
            (answer) => {
              const a = answer.trim().toLowerCase();
              if (a === "a" || a === "always") resolve("allow-always");
              else if (a === "n" || a === "no" || a === "d" || a === "deny") resolve("deny");
              else resolve("allow-once");
            },
          );
        });
      }
    : undefined;

  // Banner
  console.log(`${badge("MINI", badgeStyles.system)} ${color("OpenClaw Mini", "bold")}`);
  console.log(color(`  ${provider}${model ? ` · ${model}` : ""}${reasoning ? ` · thinking:${reasoning}` : ""} · ${agentId}`, "dim"));
  console.log(color(`  ${workspaceDir}`, "dim"));
  const hints = ["/help 查看命令"];
  if (approval) hints.push(`approval: ${approval.ask}`);
  hints.push("Ctrl+C 退出");
  console.log(color(`  ${hints.join(" · ")}`, "dim"));
  console.log();

  // 使用自定义 OpenAI 兼容 Provider（绕过 pi-ai 的 provider 注册）
  const myProvider = new MyOpenAIStreamProvider({
    providerId: provider,
  });

  const agent = new Agent({
    apiKey,
    provider,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    agentId,
    workspaceDir,
    reasoning,
    approval,
    onApprovalRequest,
    streamFn: myProvider.stream,
  });

  // 事件订阅（对齐 pi-agent-core: Agent.subscribe → 类型化事件处理）
  unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        printSystemLine(`run ${event.runId.slice(0, 8)} · ${event.model}`);
        break;
      case "agent_end":
        break;
      case "agent_error":
        printSystemLine(`error: ${event.error}`, "error");
        break;

      case "thinking_delta":
        beginThinkingLine();
        process.stdout.write(color(event.delta, "dim"));
        break;

      case "message_delta":
        beginAssistantLine();
        process.stdout.write(event.delta);
        break;
      case "message_end":
        closeOutputLine();
        break;

      case "tool_execution_start": {
        pendingToolArgs.set(event.toolCallId, event.args);
        break;
      }
      case "tool_execution_end": {
        const toolArgs = pendingToolArgs.get(event.toolCallId);
        pendingToolArgs.delete(event.toolCallId);
        const label = formatToolCompact(event.toolName, toolArgs);
        const symbol = event.isError ? "✗" : "•";
        printToolLine(`${symbol} ${label}`, event.isError);
        break;
      }
      case "tool_skipped":
        printToolLine(`⊘ ${event.toolName} (skipped)`);
        break;

      case "tool_approval_resolved":
        if (event.decision === "deny") {
          printToolLine(`✗ ${event.toolName} (denied)`, true);
        } else if (event.decision === "allow-always") {
          printToolLine(`✓ ${event.toolName} (always allowed)`);
        }
        break;

      case "compaction":
        printSystemLine(`compaction: dropped ${event.droppedMessages} messages`);
        break;

      case "subagent_summary": {
        const l = event.label ? ` (${event.label})` : "";
        printSystemLine(`subagent${l}: ${event.summary.slice(0, 120)}`);
        break;
      }
      case "subagent_error":
        printSystemLine(`subagent error: ${event.error}`, "error");
        break;
    }
  });

  const prompt = () => {
    readLineIFace.question(`${badge("INPUT", badgeStyles.input)} ${color("❯", "green")} `, async (input) => {
      clearPromptEchoLine();

      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      // 仅把“真正发送的内容”写入历史显示
      printUserLine(trimmed);

      // 命令处理
      if (trimmed.startsWith("/")) {
        await handleCommand(trimmed, agent, sessionKey);
        console.log();
        prompt();
        return;
      }

      // Agent 执行
      outputMode = "idle";

      try {
        const result = await agent.run(sessionKey, trimmed);

        const parts = [
          `${color(String(result.turns), "cyan")} turns`,
          `${color(String(result.toolCalls), "yellow")} tools`,
          `${color(String(result.memoriesUsed ?? 0), "magenta")} memories`,
          `${color(String(result.text.length), "green")} chars`,
        ];
        printMetaLine(parts.join(color(" · ", "dim")));
      } catch (err) {
        closeOutputLine();
        printSystemLine((err as Error).message, "error");
      }
      prompt();
    });
  };

  prompt();
}

// ============== 工具函数 ==============

/**
 * 从命令行参数数组中读取标志值
 *
 * 输入示例: readFlag(["--model", "gpt-4", "--port", "3000"], "--model")
 * 输出示例: "gpt-4"
 *
 * 输入示例: readFlag(["--model", "gpt-4"], "--port")
 * 输出示例: undefined
 */
function readFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((arg) => arg === name);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next.trim() || undefined;
}

const FLAGS_WITH_VALUE = new Set(["--agent", "--model", "--provider", "--api-key", "--base-url", "--reasoning"]);

/**
 * 从命令行参数中解析 sessionId（跳过 "chat" 子命令和已知标志）
 *
 * 输入示例: resolveSessionIdArg(["chat", "--model", "gpt-4", "my-session"])
 * 输出示例: "my-session"
 *
 * 输入示例: resolveSessionIdArg(["--model", "gpt-4"])
 * 输出示例: undefined
 */
function resolveSessionIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "chat") continue;
    if (FLAGS_WITH_VALUE.has(arg)) { i += 1; continue; }
    if (arg.startsWith("--")) continue;
    return arg.trim() || undefined;
  }
  return undefined;
}

/** 提取工具调用的关键参数，生成紧凑摘要 */
function formatToolCompact(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, string>;
  switch (name) {
    case "read": return `read(${shortPath(a.file_path)})`;
    case "write": return `write(${shortPath(a.file_path)})`;
    case "edit": return `edit(${shortPath(a.file_path)})`;
    case "list": return `list(${a.path || "."})`;
    case "exec": return `exec(\`${String(a.command || "").slice(0, 50)}\`)`;
    case "grep": return `grep("${a.pattern || ""}"${a.path ? `, ${a.path}` : ""})`;
    case "memory_search": return `memory_search("${(a.query || "").slice(0, 30)}")`;
    case "memory_get": return `memory_get(${a.id || ""})`;
    case "memory_save": return `memory_save(${(a.content || "").slice(0, 30)}...)`;
    case "subagent": return `subagent("${(a.task || "").slice(0, 40)}")`;
    default: return name;
  }
}

/**
 * 缩短路径显示（保留最后两段）
 *
 * 输入示例: "/home/user/project/src/utils/helper.ts"
 * 输出示例: ".../utils/helper.ts"
 */
function shortPath(p: string | undefined): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : p;
}

/**
 * 处理斜杠命令
 *
 * 输入示例: handleCommand("/help", agent, "agent:main:main")
 * 效果: 打印帮助信息
 *
 * 输入示例: handleCommand("/reset", agent, "agent:main:session-123")
 * 效果: 清空指定会话历史
 */
async function handleCommand(cmd: string, agent: Agent, sessionKey: string) {
  const [command] = cmd.slice(1).split(" ");

  switch (command) {
    case "help":
      console.log(`命令:\n  /help     显示帮助\n  /reset    重置当前会话\n  /history  显示会话历史\n  /sessions 列出所有会话\n  /quit     退出\n\n启动参数:\n  --provider <name>   指定 provider (anthropic/openai/google/groq/...)\n  --model <id>        指定模型 ID\n  --base-url <url>    自定义 API 端点 (代理/自部署)\n  --api-key <key>     API Key\n  --reasoning <level> 思考级别 (minimal/low/medium/high/xhigh/none)\n  --approval          启用工具审批 (on-miss 模式)\n  --approval always   每次工具调用都需审批`);
      break;

    case "reset":
      await agent.reset(sessionKey);
      console.log(color("会话已重置", "green"));
      break;

    case "history": {
      const history = agent.getHistory(sessionKey);
      if (history.length === 0) {
        console.log(color("暂无历史", "dim"));
      } else {
        for (const msg of history) {
          const role = msg.role === "user" ? "你" : "Agent";
          const content =
            typeof msg.content === "string"
              ? msg.content
              : msg.content.map((c) => c.text || `[${c.type}]`).join(" ");
          console.log(`${color(role + ":", role === "你" ? "green" : "blue")} ${content.slice(0, 100)}...`);
        }
      }
      break;
    }

    case "sessions": {
      const sessions = await agent.listSessions();
      if (sessions.length === 0) {
        console.log(color("暂无会话", "dim"));
      } else {
        console.log("会话列表:");
        for (const s of sessions) {
          console.log(`  - ${s}${s === sessionKey ? color(" (当前)", "cyan") : ""}`);
        }
      }
      break;
    }

    case "quit":
    case "exit":
      resetTerminal();
      process.exit(0);

    default:
      console.log(color(`未知命令: ${command}`, "yellow"));
  }
}

/**
 * process 是 Node.js 的全局对象，代表当前运行的进程。
在这个文件中用到的主要属性：
process.argv — 命令行参数数组，如 ["node", "cli.ts", "--provider", "openai"]
process.env — 环境变量对象，如 process.env.OPENAI_API_KEY
process.cwd() — 当前工作目录路径
process.stdout — 标准输出流（用于打印内容）
process.stdin — 标准输入流（用于读取用户输入）
process.exit(1) — 退出进程（1 表示异常退出）
不需要 import，Node.js 中任何地方都可以直接使用。
 * 
 */
// 处理 Ctrl+C
process.on("SIGINT", () => {
  closeOutputLine();
  resetTerminal();
  console.log(color("\nBye!", "dim"));
  unsubscribe?.();
  process.exit(0);
});

main().catch((err) => {
  closeOutputLine();
  resetTerminal();
  console.error("启动失败:", err);
  process.exit(1);
});
