/**
 * Telegram 频道适配器
 *
 * 对齐 OpenClaw:
 * - src/telegram/bot.ts → grammy Bot 初始化
 * - src/telegram/bot-handlers.ts → 消息处理
 * - src/telegram/bot-message-dispatch.ts → 调用 Agent
 * - src/telegram/bot/delivery.ts → 回复发送
 *
 * 与 openclaw 的区别:
 * - openclaw 的频道直接调用内嵌 Agent（不经过 Gateway）
 * - mini 版采用 Gateway 客户端模式（所有入口统一走 RPC）
 *
 * 架构:
 *   Telegram ──► Bot(grammy) ──► GatewayClient ──► Gateway ──► Agent
 *     ◄──── bot.api.sendMessage ◄──── onEvent("chat") ◄────
 */

import { Bot } from "grammy";
import { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol.js";

// ============== 类型 ==============

export type TelegramChannelOptions = {
  botToken: string;
  gatewayUrl?: string;
  gatewayToken?: string;
};

// ============== 常量 ==============

const TG_MAX_LENGTH = 4096;
const TYPING_INTERVAL_MS = 5000;

// ============== 启动 ==============

/**
 * 启动 Telegram 频道适配器
 *
 * 初始化 grammy Bot 实例并连接 Gateway 客户端，建立双向通信:
 * - Telegram 消息 → Gateway RPC (chat.send) → Agent 处理
 * - Gateway 事件 (chat/final) → Bot API (sendMessage) → 用户收到回复
 *
 * 返回 { close } 对象，用于优雅关闭 Bot 和 Gateway 连接。
 */
export async function startTelegramChannel(opts: TelegramChannelOptions) {
  const bot = new Bot(opts.botToken);

  // sessionKey → chatId 映射（用于从 gateway 事件找到对应的 Telegram 聊天）
  const sessionChats = new Map<string, number>();
  // chatId → typing interval（流式响应期间持续发送 typing 状态）
  const typingTimers = new Map<number, ReturnType<typeof setInterval>>();

  /**
   * 将 Telegram chatId 转换为 Gateway sessionKey
   *
   * 输入示例: sessionKeyFor(123456789)
   * 输出示例: "tg:123456789"
   */
  function sessionKeyFor(chatId: number): string {
    return `tg:${chatId}`;
  }

  // ============== Typing 管理 ==============

  /**
   * 开始向指定聊天发送 "typing..." 状态
   *
   * 立即发送一次 typing 动作，然后每 TYPING_INTERVAL_MS (5秒) 重复发送，
   * 保持用户端持续看到 "正在输入" 提示，直到 stopTyping 被调用。
   */
  function startTyping(chatId: number): void {
    stopTyping(chatId);
    bot.api.sendChatAction(chatId, "typing").catch(() => {});
    typingTimers.set(chatId, setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, TYPING_INTERVAL_MS));
  }

  /**
   * 停止向指定聊天发送 "typing..." 状态
   *
   * 清除定时器并从 typingTimers 中移除。重复调用安全（幂等）。
   */
  function stopTyping(chatId: number): void {
    const timer = typingTimers.get(chatId);
    if (timer) {
      clearInterval(timer);
      typingTimers.delete(chatId);
    }
  }

  // ============== 长消息分片发送 ==============

  /**
   * 分片发送长消息
   *
   * Telegram 单条消息最大长度为 TG_MAX_LENGTH (4096字符)。
   * 超长文本按 4096 字符切片，依次发送多条消息。
   * 空文本直接跳过不发送。
   */
  async function sendLongMessage(chatId: number, text: string): Promise<void> {
    if (!text) return;
    let remaining = text;
    while (remaining.length > 0) {
      const chunk = remaining.slice(0, TG_MAX_LENGTH);
      remaining = remaining.slice(TG_MAX_LENGTH);
      await bot.api.sendMessage(chatId, chunk);
    }
  }

  // ============== Gateway 客户端 ==============

  const client = new GatewayClient({
    url: opts.gatewayUrl ?? "ws://localhost:18789",
    token: opts.gatewayToken,
    onEvent: (evt: EventFrame) => {
      if (evt.event !== "chat") return;
      const p = evt.payload as {
        sessionKey?: string;
        state?: string;
        text?: string;
        error?: string;
      };
      // 仅处理 Telegram 会话的事件
      if (!p.sessionKey?.startsWith("tg:")) return;

      const chatId = sessionChats.get(p.sessionKey);
      if (!chatId) return;

      if (p.state === "final") {
        stopTyping(chatId);
        if (p.text) sendLongMessage(chatId, p.text).catch(console.error);
      } else if (p.state === "error") {
        stopTyping(chatId);
        bot.api.sendMessage(chatId, `Error: ${p.error ?? "unknown"}`).catch(console.error);
      }
      // delta 事件忽略（Telegram 不做流式编辑，等 final 一次性发送）
    },
    onConnect: (hello) => {
      console.log(`\x1b[2m  gateway reconnected (v${hello.protocol})\x1b[0m`);
    },
  });

  const hello = await client.connect();

  // 预先获取 bot 信息并缓存（避免每条群组消息都调用 API）
  await bot.init();
  const botInfo = bot.botInfo;

  // 全局错误处理
  bot.catch((err) => {
    console.error(`\x1b[33m  bot error: ${err.message}\x1b[0m`);
  });

  // ============== Bot 命令 ==============

  bot.command("start", (ctx) =>
    ctx.reply("Hi! Send me a message and I'll reply via the AI agent."),
  );

  bot.command("reset", async (ctx) => {
    const sessionKey = sessionKeyFor(ctx.chat.id);
    try {
      await client.request("sessions.reset", { sessionKey });
      await ctx.reply("Session reset.");
    } catch (err) {
      await ctx.reply(`Reset failed: ${(err as Error).message}`);
    }
  });

  bot.command("health", async (ctx) => {
    try {
      const h = await client.request<{ uptimeMs: number; clients: number }>("health");
      await ctx.reply(`Gateway uptime: ${Math.round(h.uptimeMs / 1000)}s, clients: ${h.clients}`);
    } catch (err) {
      await ctx.reply(`Health check failed: ${(err as Error).message}`);
    }
  });

  // ============== 消息处理 ==============

  bot.on("message:text", async (ctx) => {
    // 群组中仅响应 @bot 或回复 bot 的消息
    if (ctx.chat.type !== "private") {
      const mentioned = ctx.message.text.includes(`@${botInfo.username}`);
      const repliedToMe = ctx.message.reply_to_message?.from?.id === botInfo.id;
      if (!mentioned && !repliedToMe) return;
    }

    const chatId = ctx.chat.id;
    const sessionKey = sessionKeyFor(chatId);
    sessionChats.set(sessionKey, chatId);

    startTyping(chatId);

    try {
      await client.request("chat.send", { sessionKey, message: ctx.message.text });
      // 回复由 onEvent 回调处理
    } catch (err) {
      stopTyping(chatId);
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  });

  // ============== 启动 Bot ==============

  bot.start();

  console.log(`\n\x1b[36m\u25cf\x1b[0m \x1b[1mTelegram Channel\x1b[0m`);
  console.log(`\x1b[2m  gateway: ${opts.gatewayUrl ?? "ws://localhost:18789"} (v${hello.protocol})\x1b[0m`);
  console.log(`\x1b[2m  bot: polling\x1b[0m`);
  console.log(`\x1b[2m  commands: /start /reset /health\x1b[0m`);
  console.log(`\x1b[2m  Ctrl+C to stop\x1b[0m\n`);

  return {
    close: () => {
      for (const timer of typingTimers.values()) clearInterval(timer);
      typingTimers.clear();
      bot.stop();
      client.close();
    },
  };
}
