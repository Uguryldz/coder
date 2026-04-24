import { createLogger, loadConfig } from "@orkestra/config";
import Redis from "ioredis";

const log = createLogger("rate-limit");

/**
 * Redis-backed token + request rate limiter for Anthropic API.
 * Sliding window per minute. Works across worker replicas.
 */
export class RateLimiter {
  private redis: Redis;
  private rpmLimit: number;
  private tpmInLimit: number;

  constructor(redis: Redis, rpmLimit: number, tpmInLimit: number) {
    this.redis = redis;
    this.rpmLimit = rpmLimit;
    this.tpmInLimit = tpmInLimit;
  }

  /**
   * Reserve capacity for a call. Blocks (polls) until available or rejects after timeoutMs.
   * Returns a release function to be called after the request completes.
   */
  async acquire(estimatedTokens: number, timeoutMs = 120_000): Promise<() => Promise<void>> {
    const deadline = Date.now() + timeoutMs;
    const bucketMinute = Math.floor(Date.now() / 60_000);
    const reqKey = `rl:req:${bucketMinute}`;
    const tokKey = `rl:tok:${bucketMinute}`;

    while (Date.now() < deadline) {
      const [req, tok] = await Promise.all([
        this.redis.get(reqKey).then((v) => Number(v ?? 0)),
        this.redis.get(tokKey).then((v) => Number(v ?? 0)),
      ]);
      if (req < this.rpmLimit && tok + estimatedTokens < this.tpmInLimit) {
        await this.redis
          .multi()
          .incr(reqKey)
          .expire(reqKey, 70)
          .incrby(tokKey, estimatedTokens)
          .expire(tokKey, 70)
          .exec();
        return async () => {}; // noop release for minute-bucket model
      }
      const wait = Math.min(2000, Math.max(500, deadline - Date.now()));
      log.debug({ req, tok, estimatedTokens }, "rate limit full, waiting");
      await new Promise((r) => setTimeout(r, wait));
    }
    throw new Error("rate limit acquire timed out");
  }
}

let _instance: RateLimiter | undefined;

export function getRateLimiter(): RateLimiter {
  if (!_instance) {
    const cfg = loadConfig();
    const redis = new Redis(cfg.REDIS_URL);
    _instance = new RateLimiter(redis, cfg.ANTHROPIC_RPM_LIMIT, cfg.ANTHROPIC_TPM_INPUT_LIMIT);
  }
  return _instance;
}
