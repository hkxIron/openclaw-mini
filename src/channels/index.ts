/**
 * Channel（频道适配器）模块导出
 *
 * Channel 是 Agent 与外部消息平台之间的桥接层。
 * 每个 Channel 负责:
 * 1. 接收平台消息（如 Telegram 文本消息）
 * 2. 通过 GatewayClient 转发到 Agent
 * 3. 接收 Agent 回复并发送回平台
 *
 * 当前支持: Telegram（通过 grammy Bot 框架 + long polling）
 * 扩展方式: 新增 Channel 文件，实现相同的 GatewayClient 集成模式
 */

export { startTelegramChannel, type TelegramChannelOptions } from "./telegram.js";
