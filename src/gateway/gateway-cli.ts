#!/usr/bin/env node
/**
 * Gateway CLI 入口
 *
 * 对齐 OpenClaw:
 * - cli/gateway-cli.ts → gateway run / gateway status
 * - 两种模式: serve（启动服务）/ connect（连接客户端）
 *
 * 用法:
 *   tsx src/gateway/gateway-cli.ts serve [--port 18789] [--token xxx]
 *   tsx src/gateway/gateway-cli.ts connect [--url ws://...] [--token xxx]
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Agent } from "../agent.js";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import { startGatewayServer } from "./server.js";
import { GatewayClient } from "./client.js";
import type { EventFrame } from "./protocol.js";

// ============== .env ==============

/**
 * 加载当前目录下的 .env 文件到 process.env
 *
 * 规则:
 * - 跳过空行和 # 开头的注释行
 * - 不覆盖已存在的环境变量（process.env 优先）
 * - 自动去除值两端的引号（单引号/双引号）
 * - .env 文件不存在时静默忽略
 *
 * 输入示例: .env 文件内容 "API_KEY='sk-abc123'"
 * 输出示例: process.env.API_KEY === "sk-abc123"
 */
function loadEnvFile(): void {
  const envPath = path.join(process.cwd(), ".env");
  let content: string;
  try { content = fs.readFileSync(envPath, "utf-8"); } catch { return; }
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    // 去除值两端的引号（支持 KEY="value" 和 KEY='value' 格式）
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

// ============== 参数解析 ==============

/**
 * 从命令行参数数组中提取指定标志的值
 *
 * 输入示例: (["serve", "--port", "3000", "--token", "abc"], "--port")
 * 输出示例: "3000"
 *
 * 输入示例: (["serve", "--port", "3000"], "--token")
 * 输出示例: undefined
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const mode = args[0] ?? "serve";

// ============== serve 模式 ==============

/**
 * serve 模式 — 启动 Gateway 服务端
 *
 * 从命令行参数和环境变量中读取配置，创建 Agent 实例并启动 WebSocket 服务。
 * 支持的参数: --port, --token, --provider, --model, --base-url, --api-key
 * 环境变量回退: OPENCLAW_MINI_GW_TOKEN, OPENCLAW_MINI_PROVIDER, OPENCLAW_MINI_MODEL, OPENCLAW_MINI_BASE_URL
 */
async function serve() {
  const port = Number(flag(args, "--port") ?? 18789);
  const token = flag(args, "--token") ?? process.env.OPENCLAW_MINI_GW_TOKEN;
  const provider = flag(args, "--provider") ?? process.env.OPENCLAW_MINI_PROVIDER ?? "anthropic";
  const model = flag(args, "--model") ?? process.env.OPENCLAW_MINI_MODEL;
  const baseUrl = flag(args, "--base-url") ?? process.env.OPENCLAW_MINI_BASE_URL;
  const apiKey = flag(args, "--api-key") ?? getEnvApiKey(provider);

  if (!apiKey) { console.error("Error: API key not found"); process.exit(1); }

  const agent = new Agent({ apiKey, provider, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}) });
  const gw = await startGatewayServer({ port, token, agent });

  console.log(`\n\x1b[36m\u25cf\x1b[0m \x1b[1mMini Gateway\x1b[0m`);
  console.log(`\x1b[2m  ws://localhost:${gw.port}\x1b[0m`);
  console.log(`\x1b[2m  ${provider}${model ? ` · ${model}` : ""}\x1b[0m`);
  console.log(`\x1b[2m  token: ${token ? "***" : "(none)"}\x1b[0m`);
  console.log(`\x1b[2m  Ctrl+C to stop\x1b[0m\n`);

  process.on("SIGINT", () => { gw.close(); console.log("\nBye!"); process.exit(0); });
}

// ============== connect 模式 ==============

/**
 * connect 模式 — 启动交互式 Gateway 客户端
 *
 * 连接到已运行的 Gateway 服务，提供 REPL 交互界面。
 * 支持的参数: --url, --token, --session
 * 内置命令: /quit (退出), /health (健康状态), /sessions (会话列表)
 *
 * 事件处理:
 * - chat.delta → 实时流式输出文本
 * - chat.final → 输出完成，重新显示输入提示符
 * - chat.error → 显示错误信息
 * - agent (tool_execution_end) → 显示工具执行状态
 */
async function connect() {
  const url = flag(args, "--url") ?? "ws://localhost:18789";
  const token = flag(args, "--token") ?? process.env.OPENCLAW_MINI_GW_TOKEN;
  const sessionKey = flag(args, "--session") ?? "main";

  // 事件驱动 prompt：chat.final / chat.error 后重新显示输入提示
  let showPrompt: (() => void) | null = null;

  const client = new GatewayClient({
    url,
    token,
    autoReconnect: false, // CLI 模式不自动重连，手动控制
    onEvent: (evt: EventFrame) => {
      if (evt.event === "chat") {
        const p = evt.payload as { state?: string; text?: string; error?: string };
        if (p.state === "delta") {
          process.stdout.write(p.text ?? "");
        } else if (p.state === "final") {
          process.stdout.write("\n");
          showPrompt?.();
        } else if (p.state === "error") {
          console.error(`\x1b[33m  error: ${p.error}\x1b[0m`);
          showPrompt?.();
        }
      } else if (evt.event === "agent") {
        const p = evt.payload as { type?: string; toolName?: string };
        if (p.type === "tool_execution_end") {
          console.log(`\x1b[2m  \u25cf ${p.toolName}\x1b[0m`);
        }
      } else if (evt.event === "tick") {
        // 心跳，静默
      } else if (evt.event === "shutdown") {
        const p = evt.payload as { reason?: string; restartExpectedMs?: number | null };
        const hint = p.restartExpectedMs ? ` (restart in ~${Math.round(p.restartExpectedMs / 1000)}s)` : "";
        console.log(`\x1b[2m  server shutting down${hint}\x1b[0m`);
      }
    },
    onClose: (_code, _reason) => {
      console.log("\x1b[2m  disconnected\x1b[0m");
      process.exit(0);
    },
  });

  try {
    const hello = await client.connect();
    console.log(`\n\x1b[36m\u25cf\x1b[0m \x1b[1mConnected\x1b[0m`);
    console.log(`\x1b[2m  protocol: v${hello.protocol}\x1b[0m`);
    console.log(`\x1b[2m  methods: ${hello.methods.join(", ")}\x1b[0m`);
    console.log(`\x1b[2m  session: ${sessionKey}\x1b[0m\n`);
  } catch (err) {
    console.error(`Connection failed: ${(err as Error).message}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const prompt = () => {
    rl.question("\x1b[32m\u276f\x1b[0m ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) { prompt(); return; }
      if (trimmed === "/quit") { client.close(); return; }
      if (trimmed === "/health") {
        const h = await client.request("health");
        console.log(h);
        prompt();
        return;
      }
      if (trimmed === "/sessions") {
        const s = await client.request("sessions.list");
        console.log(s);
        prompt();
        return;
      }

      try {
        await client.request("chat.send", { sessionKey, message: trimmed });
      } catch (err) {
        console.error(`\x1b[33m  ${(err as Error).message}\x1b[0m`);
        prompt();
      }
      // prompt 由 onEvent chat.final/error 回调触发
    });
  };

  showPrompt = prompt;
  prompt();
  process.on("SIGINT", () => { client.close(); process.exit(0); });
}

// ============== 入口 ==============

if (mode === "connect") {
  connect();
} else {
  serve();
}
