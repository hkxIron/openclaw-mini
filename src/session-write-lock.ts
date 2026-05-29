/**
 * 会话文件写锁
 *
 * 通过文件系统原子操作 (O_EXCL/wx) 实现跨进程互斥锁，
 * 防止多个进程同时写入同一个会话 JSONL 文件导致数据损坏。
 *
 * 对应 OpenClaw: src/agents/session-write-lock.ts
 *
 * 核心机制:
 * - 创建 .lock 文件（O_EXCL 原子操作，同时只有一个进程能成功）
 * - 锁文件内记录 PID 和创建时间
 * - 过期锁检测（30 分钟）和死进程锁清理
 * - 指数退避重试直到获取锁或超时
 */

import fs from "node:fs/promises";
import path from "node:path";

type LockPayload = {
  pid: number;
  createdAt: string;
};

/**
 * 检查指定 PID 的进程是否存活
 *
 * 输入示例: 12345 (存活进程) → true
 * 输入示例: 99999 (不存在进程) → false
 * 输入示例: -1 (非法 PID) → false
 *
 * 原理: process.kill(pid, 0) 不发送信号，仅检查进程是否可达
 */
function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取锁文件内容，解析为 LockPayload
 *
 * 输入示例: "/path/to/session.jsonl.lock" (内容: { "pid": 1234, "createdAt": "2024-01-01T00:00:00Z" })
 * 输出示例: { pid: 1234, createdAt: "2024-01-01T00:00:00Z" }
 *
 * 文件不存在或格式错误时返回 null
 */
async function readLockPayload(lockPath: string): Promise<LockPayload | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== "number") {
      return null;
    }
    if (typeof parsed.createdAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

/**
 * 获取会话文件写锁
 *
 * 输入示例: { sessionFile: "/data/sessions/main.jsonl", timeoutMs: 10000 }
 * 输出示例: { release: async () => void } (调用 release 释放锁)
 *
 * 获取失败时抛出超时错误。内部自动处理:
 * - 过期锁清理（默认 30 分钟）
 * - 死进程锁清理（PID 不存活）
 * - 指数退避重试（50ms → 100ms → ... → 1000ms 上限）
 */
export async function acquireSessionWriteLock(params: {
  sessionFile: string;
  timeoutMs?: number;
  staleMs?: number;
}): Promise<{ release: () => Promise<void> }> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const staleMs = params.staleMs ?? 30 * 60 * 1000;
  const sessionFile = path.resolve(params.sessionFile);
  const lockPath = `${sessionFile}.lock`;
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
      return {
        release: async () => {
          await handle.close();
          await fs.rm(lockPath, { force: true });
        },
      };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code !== "EEXIST") {
        throw err;
      }
      const payload = await readLockPayload(lockPath);
      const createdAt = payload?.createdAt ? Date.parse(payload.createdAt) : NaN;
      const stale = !Number.isFinite(createdAt) || Date.now() - createdAt > staleMs;
      const alive = payload?.pid ? isAlive(payload.pid) : false;
      if (stale || !alive) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      const delay = Math.min(1000, 50 * attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`获取会话写锁超时: ${sessionFile}`);
}
