/**
 * 命令队列
 *
 * 对应 OpenClaw: src/process/command-queue.ts
 *
 * 两层 lane 设计:
 * - Session Lane (外层, maxConcurrent=1): 保证同一会话的请求串行，不交错
 * - Global Lane  (内层, 可配置并发): 控制跨 session 的总并发，防止 API 过载
 *
 * 嵌套顺序: enqueueSession(() => enqueueGlobal(() => { ... }))
 * - Session Lane 保证同一 session 不并发
 * - Global Lane 控制不同 session 之间的并行度
 * - 两层协作: session A 和 B 各自串行, 但可同时运行（取决于 global 并发数）
 */

type QueueEntry<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  warnAfterMs: number;
};

type LaneState = {
  lane: string;
  active: number;
  queue: Array<QueueEntry<unknown>>;
  maxConcurrent: number;
};

const lanes = new Map<string, LaneState>();

/**
 * 获取或创建 lane 状态
 *
 * 输入示例: "session:agent:main:session-1"
 * 输出示例: { lane: "session:agent:main:session-1", active: 0, queue: [], maxConcurrent: 1 }
 *
 * 若 lane 不存在则创建默认状态（maxConcurrent=1，即串行执行）
 */
function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    active: 0,
    queue: [],
    maxConcurrent: 1,
  };
  lanes.set(lane, created);
  return created;
}

/**
 * 排空 lane 队列，按并发上限启动等待中的任务
 *
 * 排空循环逻辑:
 * 1. 若 lane 空闲且无排队任务（session lane）→ 从 Map 中删除以释放内存
 * 2. 否则循环: 当活跃数 < maxConcurrent 且队列非空时，弹出队首任务并异步执行
 * 3. 每个任务完成（成功或失败）后递减 active 并递归调用 drainLane，驱动后续任务
 */
function drainLane(lane: string) {
  const state = getLaneState(lane);

  // Mini 改进: 空闲时自动清理 session lane，防止内存泄漏
  // 注意: OpenClaw 生产版未做此清理（lane 在 Map 中累积），此处为 mini 的增强
  if (state.active === 0 && state.queue.length === 0 && lane.startsWith("session:")) {
    lanes.delete(lane);
    return;
  }

  while (state.active < state.maxConcurrent && state.queue.length > 0) {
    const entry = state.queue.shift() as QueueEntry<unknown>;
    state.active += 1;

    // 检测排队等待是否超阈值，触发 onWait 回调通知调用方
    const waitMs = Date.now() - entry.enqueuedAt;
    if (waitMs > entry.warnAfterMs && entry.onWait) {
      entry.onWait(waitMs, state.queue.length);
    }

    void (async () => {
      try {
        const result = await entry.task();
        state.active -= 1;
        drainLane(lane); // 递归驱动下一个等待任务
        entry.resolve(result);
      } catch (err) {
        state.active -= 1;
        drainLane(lane); // 失败也要继续排空后续任务
        entry.reject(err);
      }
    })();
  }
}

/**
 * 设置 lane 的最大并发数
 *
 * 输入示例: setLaneConcurrency("global:main", 5)
 * 输出示例: 无返回值，内部将 lane 的 maxConcurrent 设为 5 并立即尝试排空队列
 *
 * maxConcurrent 最小值为 1（向下取整后不低于 1）
 */
export function setLaneConcurrency(lane: string, maxConcurrent: number) {
  const state = getLaneState(lane);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(lane);
}

export interface EnqueueOpts {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
}

/**
 * 将任务入队到指定 lane，返回 Promise 等待执行结果
 *
 * 输入示例: enqueueInLane("session:tg:123", () => callLLM(prompt), { warnAfterMs: 5000 })
 * 输出示例: Promise<LLMResponse>（在 lane 并发许可下执行后 resolve）
 *
 * 任务入队后立即调用 drainLane 尝试启动执行
 */
export function enqueueInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: EnqueueOpts,
): Promise<T> {
  const state = getLaneState(lane);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: opts?.warnAfterMs ?? 2_000,
      onWait: opts?.onWait,
    });
    drainLane(lane);
  });
}

/**
 * 将 sessionKey 解析为 session lane 名称
 *
 * 输入示例: "agent:main:session-1"
 * 输出示例: "session:agent:main:session-1"
 *
 * 输入示例: "session:tg:123"  (已有前缀)
 * 输出示例: "session:tg:123"  (原样返回)
 *
 * 输入示例: "" (空字符串)
 * 输出示例: "session:main" (fallback 到 "main")
 */
export function resolveSessionLane(sessionKey: string): string {
  const cleaned = sessionKey.trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

/**
 * 清理指定 lane（队列为空且无活跃任务时从 Map 移除）
 *
 * 典型调用时机:
 * - session 结束后清理 session lane
 * - Agent 销毁前清理 global lane
 */
export function deleteLane(lane: string): boolean {
  const state = lanes.get(lane);
  if (!state) return false;
  if (state.active > 0 || state.queue.length > 0) return false;
  return lanes.delete(lane);
}

/**
 * 解析 global lane 名称
 *
 * 输入示例: "high-priority"
 * 输出示例: "high-priority"
 *
 * 输入示例: undefined 或 ""
 * 输出示例: "main" (默认 global lane)
 */
export function resolveGlobalLane(lane?: string): string {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : "main";
}
