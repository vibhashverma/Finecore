import type { Redis } from "ioredis";

/** Fixed-window rate limiter. Redis-backed in deployed environments; in-memory only for tests/local dev. */
export interface RateLimiter {
  hit(
    key: string,
    limit: number,
    windowSec: number,
  ): Promise<{ allowed: boolean; retryAfterSec: number }>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSec: number) {
    const k = `rl:${key}`;
    const res = await this.redis.multi().incr(k).expire(k, windowSec, "NX").ttl(k).exec();
    const count = Number(res?.[0]?.[1] ?? 0);
    const ttl = Number(res?.[2]?.[1] ?? windowSec);
    return { allowed: count <= limit, retryAfterSec: Math.max(ttl, 1) };
  }
}

/** In-process limiter: correct for a single instance only (tests / local dev). */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, limit: number, windowSec: number) {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowSec * 1000 };
      this.windows.set(key, w);
    }
    w.count++;
    return { allowed: w.count <= limit, retryAfterSec: Math.ceil((w.resetAt - t) / 1000) };
  }
}
