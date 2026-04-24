import { createLogger, loadConfig } from "@orkestra/config";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import os from "node:os";

const log = createLogger("sandbox.capacity-pool");

const KEY = "orkestra:sandbox:capacity";
const ENTRY_TTL_SEC = 60 * 65; // match container max TTL (60m) + small margin
const POLL_INTERVAL_MS = 250;

export interface CapacityPoolOptions {
  max?: number;
  redisUrl?: string;
  keyPrefix?: string;
}

export type ReleaseFn = () => Promise<void>;

/**
 * Redis-backed distributed semaphore for bounding concurrent sandboxes
 * across the fleet. Entries are stored in a sorted set with score = expiry
 * epoch ms, so stale entries (e.g. crashed worker) are reaped automatically.
 */
export class CapacityPool {
  readonly max: number;
  private readonly redis: Redis;
  private readonly key: string;
  private readonly owned: Redis;

  constructor(opts: CapacityPoolOptions = {}) {
    const cfg = loadConfig();
    this.max =
      opts.max ?? cfg.SANDBOX_MAX_CONCURRENT ?? Math.max(1, Math.floor(os.cpus().length / 4));
    this.key = opts.keyPrefix ? `${opts.keyPrefix}:${KEY}` : KEY;
    this.redis = new Redis(opts.redisUrl ?? cfg.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
    this.owned = this.redis;
    log.info({ max: this.max, key: this.key }, "capacity pool ready");
  }

  /**
   * Attempt to acquire a slot, blocking up to timeoutMs. Returns a
   * release function the caller MUST invoke in a finally.
   */
  async acquire(timeoutMs = 10 * 60 * 1000): Promise<ReleaseFn> {
    const id = randomUUID();
    const deadline = Date.now() + timeoutMs;
    const l = log.child({ sandboxId: id });

    while (Date.now() < deadline) {
      const now = Date.now();
      // Drop expired entries before counting.
      await this.redis.zremrangebyscore(this.key, 0, now);
      const size = await this.redis.zcard(this.key);

      if (size < this.max) {
        const expiry = now + ENTRY_TTL_SEC * 1000;
        const added = await this.redis.zadd(this.key, "NX", expiry, id);
        if (added === 1) {
          await this.redis.expire(this.key, ENTRY_TTL_SEC);
          l.info({ size: size + 1, max: this.max }, "slot acquired");
          return async () => this.release(id);
        }
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    l.error({ timeoutMs }, "capacity acquire timed out");
    throw new Error(`CapacityPool: timed out after ${timeoutMs}ms waiting for a slot`);
  }

  private async release(id: string): Promise<void> {
    try {
      await this.redis.zrem(this.key, id);
      log.info({ sandboxId: id }, "slot released");
    } catch (e) {
      log.error({ err: e, sandboxId: id }, "release failed (slot will TTL-expire)");
    }
  }

  async currentUsage(): Promise<number> {
    await this.redis.zremrangebyscore(this.key, 0, Date.now());
    return this.redis.zcard(this.key);
  }

  async close(): Promise<void> {
    if (this.owned) await this.redis.quit().catch(() => {});
  }
}
