/**
 * Gateway 客户端
 *
 * 对齐 OpenClaw:
 * - client.ts → GatewayClient 类
 *   - pending Map: id → { resolve, reject } 关联请求与响应
 *   - connect(): 接收 challenge → 发送 connect 请求 → 收到 HelloOk
 *   - request(): 生成 UUID → 存入 pending → ws.send → await Promise
 *   - flushPendingErrors(): 连接断开时拒绝所有待处理请求
 *   - seq 追踪: 检测事件丢失
 *   - scheduleReconnect(): 指数退避自动重连（1s → 2s → ... → 30s）
 *   - startTickWatch(): 心跳监视（2 周期无 tick → 主动断开）
 */

import WebSocket from "ws";
import {
  type RequestFrame, type ResponseFrame, type EventFrame, type HelloOk,
  isResponseFrame, isEventFrame,
  newId, REQUEST_TIMEOUT_MS, TICK_INTERVAL_MS,
} from "./protocol.js";

// ============== 类型 ==============

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type GatewayClientOptions = {
  url: string;
  token?: string;
  onEvent?: (event: EventFrame) => void;
  onClose?: (code: number, reason: string) => void;
  /** 连接成功回调（含重连） */
  onConnect?: (hello: HelloOk) => void;
  /** 事件序列号间隙回调（对齐 openclaw onGap） */
  onGap?: (info: { expected: number; received: number }) => void;
  /** 是否启用自动重连（默认 true） */
  autoReconnect?: boolean;
};

// ============== 客户端 ==============

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private lastSeq: number | null = null;
  private opts: GatewayClientOptions;
  private closed = false;

  // 指数退避（对齐 openclaw client.ts: 1s → 2s → 4s → ... → 30s 上限）
  private backoffMs = 1000;
  private static readonly MAX_BACKOFF_MS = 30_000;

  // Tick 心跳监视（对齐 openclaw client.ts: startTickWatch）
  private tickIntervalMs = TICK_INTERVAL_MS;
  private lastTick: number | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: GatewayClientOptions) {
    this.opts = opts;
  }

  /**
   * 连接 Gateway 并完成握手
   *
   * 对齐 openclaw client.ts: start() → onopen → 等待 challenge → sendConnect()
   */
  async connect(): Promise<HelloOk> {
    this.closed = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      let handshakeResolved = false;

      ws.on("error", (err) => {
        if (!handshakeResolved) {
          handshakeResolved = true;
          reject(new Error(`connection failed: ${err.message}`));
        }
      });

      ws.on("message", (raw) => {
        let parsed: unknown;
        try { parsed = JSON.parse(String(raw)); } catch { return; }

        // 响应帧 → 解决 pending Promise（对齐 openclaw client.ts handleMessage）
        if (isResponseFrame(parsed)) {
          const res = parsed as ResponseFrame;
          const p = this.pending.get(res.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(res.id);
          if (res.ok) {
            p.resolve(res.payload);
          } else {
            p.reject(new Error(res.error?.message ?? "request failed"));
          }
          return;
        }

        // 事件帧
        if (isEventFrame(parsed)) {
          const evt = parsed as EventFrame;

          // seq 追踪 + 间隙检测（对齐 openclaw client.ts: onGap）
          if (typeof evt.seq === "number" && evt.seq > 0) {
            if (this.lastSeq !== null && evt.seq > this.lastSeq + 1) {
              this.opts.onGap?.({ expected: this.lastSeq + 1, received: evt.seq });
            }
            this.lastSeq = evt.seq;
          }

          // Tick 时间戳更新（对齐 openclaw: this.lastTick = Date.now()）
          if (evt.event === "tick") {
            this.lastTick = Date.now();
          }

          // connect.challenge → 自动发送 connect 请求
          if (evt.event === "connect.challenge") {
            const nonce = (evt.payload as { nonce?: string })?.nonce;
            this.request<HelloOk>("connect", { token: this.opts.token, nonce })
              .then((hello) => {
                // 从 HelloOk 获取 tickIntervalMs（对齐 openclaw: 动态调整心跳间隔）
                if (hello.policy?.tickIntervalMs) {
                  this.tickIntervalMs = hello.policy.tickIntervalMs;
                }
                this.backoffMs = 1000; // 成功连接，重置退避
                this.startTickWatch();
                if (!handshakeResolved) {
                  handshakeResolved = true;
                  resolve(hello);
                } else {
                  // 重连成功
                  this.opts.onConnect?.(hello);
                }
              })
              .catch((err) => {
                if (!handshakeResolved) {
                  handshakeResolved = true;
                  reject(err);
                }
              });
            return;
          }

          // 其他事件交给回调
          this.opts.onEvent?.(evt);
        }
      });

      ws.on("close", (code, reason) => {
        this.ws = null;
        this.stopTickWatch();
        this.flushPendingErrors(new Error(`connection closed (${code})`));
        this.opts.onClose?.(code, String(reason));
        // 自动重连（对齐 openclaw client.ts: scheduleReconnect）
        this.scheduleReconnect();
      });
    });
  }

  /**
   * 发送 RPC 请求
   *
   * 对齐 openclaw client.ts request():
   * - 生成 UUID id → 存入 pending Map → ws.send → 超时自动 reject
   */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("not connected");
    }
    const id = newId();
    const frame: RequestFrame = { type: "req", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  /**
   * 关闭连接（禁止自动重连）
   */
  close(): void {
    this.closed = true;
    this.stopTickWatch();
    this.ws?.close();
    this.flushPendingErrors(new Error("client closed"));
  }

  /**
   * 指数退避自动重连（对齐 openclaw client.ts scheduleReconnect）
   *
   * 1s → 2s → 4s → 8s → 16s → 30s（上限），成功后重置为 1s
   */
  private scheduleReconnect(): void {
    if (this.closed || this.opts.autoReconnect === false) return;

    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, GatewayClient.MAX_BACKOFF_MS);
    setTimeout(() => {
      if (this.closed) return;
      this.reconnect();
    }, delay).unref(); // unref: 不阻止进程退出
  }

  /**
   * 重连（复用 connect 逻辑，但不返回 Promise）
   */
  private reconnect(): void {
    this.lastSeq = null;
    this.lastTick = null;
    this.connect().catch(() => {
      // connect 失败会在 ws.on("close") 中触发下一轮重连
    });
  }

  /**
   * 心跳监视（对齐 openclaw client.ts startTickWatch）
   *
   * 每个 tick 周期检查一次，如果 2 周期内没有收到 tick → 主动断开触发重连
   */
  private startTickWatch(): void {
    this.stopTickWatch();
    this.lastTick = Date.now();
    const interval = Math.max(this.tickIntervalMs, 1000);
    this.tickTimer = setInterval(() => {
      if (this.closed || !this.lastTick) return;
      const gap = Date.now() - this.lastTick;
      if (gap > this.tickIntervalMs * 2) {
        // 心跳超时，主动断开（对齐 openclaw: close 4000 "tick timeout"）
        this.ws?.close(4000, "tick timeout");
      }
    }, interval);
  }

  /** 停止心跳监视定时器 */
  private stopTickWatch(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * 刷新所有待处理请求（对齐 openclaw client.ts flushPendingErrors）
   */
  private flushPendingErrors(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
