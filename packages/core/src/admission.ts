import Redis from 'ioredis';
import { randomUUID } from 'crypto';

export class AdmissionController {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  }

  /**
   * Attempts to enter the platform queue.
   * Uses a Redis Sorted Set (ZSET) to track active leases by expiration timestamp.
   * This is self-healing if a worker crashes.
   */
  public async admit(platform: string, limit: number, timeoutMs: number = 60000): Promise<string | null> {
    const key = `admission_limit:${platform}`;
    const token = randomUUID();
    const now = Date.now();
    const expireTime = now + timeoutMs;

    // Atomic Lua Script: ZREMRANGEBYSCORE, then ZCARD, then ZADD if space
    const script = `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
      local current = redis.call('ZCARD', KEYS[1])
      if current >= tonumber(ARGV[2]) then
        return nil
      end
      redis.call('ZADD', KEYS[1], ARGV[3], ARGV[4])
      return ARGV[4]
    `;

    const result = await this.redis.eval(
      script,
      1,
      key,
      now.toString(),
      limit.toString(),
      expireTime.toString(),
      token
    );

    return result ? result as string : null;
  }

  public async release(platform: string, token: string): Promise<void> {
    const key = `admission_limit:${platform}`;
    await this.redis.zrem(key, token);
  }
}
