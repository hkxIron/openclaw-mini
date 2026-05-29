#!/usr/bin/env node
/**
 * Channel CLI 入口
 *
 * 用法:
 *   tsx src/channels/channel-cli.ts telegram [--gateway-url ws://...] [--gateway-token xxx]
 */

import fs from "node:fs";
import path from "node:path";
import { startTelegramChannel } from "./telegram.js";

// ============== .env ==============

/**
 * 加载 .env 文件到 process.env
 *
 * 从当前工作目录读取 .env 文件，解析 KEY=VALUE 格式的环境变量。
 * 仅在 process.env 中不存在该 key 时才设置（不覆盖已有环境变量）。
 * 文件不存在时静默跳过。
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
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile();

// ============== 参数解析 ==============

/**
 * 从命令行参数数组中提取指定 flag 的值
 *
 * 输入示例: flag(["--bot-token", "abc123", "--gateway-url", "ws://..."], "--bot-token")
 * 输出示例: "abc123"
 *
 * 输入示例: flag(["--gateway-url", "ws://..."], "--bot-token")
 * 输出示例: undefined (flag 不存在)
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const channel = args[0] ?? "telegram";

// ============== telegram ==============

/**
 * 启动 Telegram 频道
 *
 * 解析 bot token 和 gateway 连接参数（优先 CLI flag，回退到环境变量），
 * 然后调用 startTelegramChannel 建立 Bot 实例并连接 Gateway。
 * 注册 SIGINT 处理器以支持 Ctrl+C 优雅退出。
 */
async function telegram() {
  const botToken = flag(args, "--bot-token") ?? process.env.TELEGRAM_BOT_TOKEN;
  const gatewayUrl = flag(args, "--gateway-url") ?? process.env.OPENCLAW_MINI_GW_URL ?? "ws://localhost:18789";
  const gatewayToken = flag(args, "--gateway-token") ?? process.env.OPENCLAW_MINI_GW_TOKEN;

  if (!botToken) {
    console.error("Error: Telegram bot token not found.");
    console.error("Set TELEGRAM_BOT_TOKEN in .env or pass --bot-token <token>");
    process.exit(1);
  }

  const ch = await startTelegramChannel({ botToken, gatewayUrl, gatewayToken });
  process.on("SIGINT", () => { ch.close(); console.log("\nBye!"); process.exit(0); });
}

// ============== 入口 ==============

if (channel === "telegram") {
  telegram();
} else {
  console.error(`Unknown channel: ${channel}`);
  console.error("Available channels: telegram");
  process.exit(1);
}
