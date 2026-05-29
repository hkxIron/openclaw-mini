/**
 * Gateway（网关）模块导出
 *
 * Gateway 是 Agent 的网络服务层，提供 WebSocket RPC 接口:
 * - 服务端 (server.ts): 启动 WS 服务，处理 RPC 方法路由，广播 Agent 事件
 * - 客户端 (client.ts): 连接 Gateway，发送 RPC 请求，接收事件推送
 * - 协议 (protocol.ts): 帧类型定义（req/res/event）+ 验证 + 常量
 * - 处理器 (handlers.ts): 具体 RPC 方法实现（connect/chat.send/health 等）
 *
 * 架构: Channel → GatewayClient → WebSocket → GatewayServer → Agent
 */

export { startGatewayServer, type GatewayServer, type GatewayServerOptions } from "./server.js";
export { GatewayClient, type GatewayClientOptions } from "./client.js";
export {
  type RequestFrame, type ResponseFrame, type EventFrame, type HelloOk,
  type ErrorShape, type GatewayFrame,
  ErrorCodes, errorShape,
  PROTOCOL_VERSION, GATEWAY_METHODS, GATEWAY_EVENTS,
} from "./protocol.js";
export { handlers, type Handler, type HandlerContext } from "./handlers.js";
