import Redis from 'ioredis';
import { IdentitiesExhaustedError } from './errors';

export enum IdentityStatus {
  ACTIVE = 'ACTIVE',
  COOLDOWN = 'COOLDOWN',
  BLOCKED = 'BLOCKED',
}

export interface IdentityPoolConfig {
  redisUrl: string;
  defaultCooldownMs?: number;
  defaultBlockMs?: number;
}

export class RedisIdentityPool {
  private redis: Redis;

  constructor(config: IdentityPoolConfig) {
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  }

  public async registerIdentities(platform: string, identityIds: string[]): Promise<void> {
    const listKey = `identity_pool:${platform}:list`;
    const pipeline = this.redis.pipeline();
    pipeline.del(listKey);
    for (const id of identityIds) {
      pipeline.rpush(listKey, id);
      const statusKey = `identity:${platform}:${id}:status`;
      pipeline.setnx(statusKey, IdentityStatus.ACTIVE);
    }
    await pipeline.exec();
  }

  public async getHealthyIdentity(platform: string): Promise<string> {
    const listKey = `identity_pool:${platform}:list`;
    const identities = await this.redis.lrange(listKey, 0, -1);

    if (!identities || identities.length === 0) {
      return 'anonymous'; // Default fallback if no identity pool configured
    }

    const now = Date.now();
    for (const id of identities) {
      const statusKey = `identity:${platform}:${id}:status`;
      const cooldownKey = `identity:${platform}:${id}:cooldown_until`;

      const status = await this.redis.get(statusKey);
      const cooldownUntilRaw = await this.redis.get(cooldownKey);
      const cooldownUntil = cooldownUntilRaw ? parseInt(cooldownUntilRaw, 10) : 0;

      if (status === IdentityStatus.BLOCKED) {
        continue; // Blocked identity skipped
      }

      if (status === IdentityStatus.COOLDOWN && now < cooldownUntil) {
        continue; // Still in cooldown
      }

      // If cooldown expired, revert to active
      if (status === IdentityStatus.COOLDOWN && now >= cooldownUntil) {
        await this.redis.set(statusKey, IdentityStatus.ACTIVE);
        await this.redis.del(cooldownKey);
      }

      return id; // Healthy active identity found!
    }

    throw new IdentitiesExhaustedError(`All identities in pool for platform [${platform}] are currently BLOCKED or EXHAUSTED`, platform);
  }

  public async markIdentityBlocked(platform: string, identityId: string, durationMs: number = 300000): Promise<void> {
    const statusKey = `identity:${platform}:${identityId}:status`;
    const cooldownKey = `identity:${platform}:${identityId}:cooldown_until`;
    const expireSec = Math.ceil(durationMs / 1000);

    await this.redis.set(statusKey, IdentityStatus.BLOCKED, 'EX', expireSec);
    await this.redis.set(cooldownKey, (Date.now() + durationMs).toString(), 'EX', expireSec);
  }

  public async markIdentityCooldown(platform: string, identityId: string, durationMs: number = 30000): Promise<void> {
    const statusKey = `identity:${platform}:${identityId}:status`;
    const cooldownKey = `identity:${platform}:${identityId}:cooldown_until`;
    const expireSec = Math.ceil(durationMs / 1000);

    await this.redis.set(statusKey, IdentityStatus.COOLDOWN, 'EX', expireSec);
    await this.redis.set(cooldownKey, (Date.now() + durationMs).toString(), 'EX', expireSec);
  }

  public async getIdentityState(platform: string, identityId: string) {
    const statusKey = `identity:${platform}:${identityId}:status`;
    const cooldownKey = `identity:${platform}:${identityId}:cooldown_until`;

    const status = (await this.redis.get(statusKey)) || IdentityStatus.ACTIVE;
    const cooldownUntil = await this.redis.get(cooldownKey);

    return {
      identityId,
      status,
      cooldownUntil: cooldownUntil ? parseInt(cooldownUntil, 10) : 0,
    };
  }

  public async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
