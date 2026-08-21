import { db, credentials } from '@media-downloader/db';
import { eq, and, or, lt, sql, asc } from 'drizzle-orm';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { createLogger } from '@media-downloader/logger';

const logger = createLogger('credential-pool');

export interface CredentialConfig {
  redisUrl: string;
}

export type AcquireResult = {
  id: string;
  encryptedData: string;
  leaseId: string;
} | null;

export class CredentialPool {
  private redis: Redis;

  // 1 block = 24h, 2 = 48h, 3 = 7d
  private readonly QUARANTINE_SCHEDULE_MS = [
    24 * 60 * 60 * 1000,
    48 * 60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000
  ];

  constructor(config: CredentialConfig) {
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  }

  /**
   * Pushes healthy credentials into Redis (Hint Engine)
   */
  public async syncToRedis(platform: string): Promise<void> {
    const available = await db.query.credentials.findMany({
      where: and(
        eq(credentials.platform, platform),
        eq(credentials.status, 'AVAILABLE')
      ),
      orderBy: [asc(credentials.updatedAt)] // For fairness
    });

    const listKey = `credential_pool:${platform}:list`;
    
    // Clear list to rebuild
    await this.redis.del(listKey);
    
    if (available.length > 0) {
      await this.redis.rpush(listKey, ...available.map(c => c.id));
      logger.info({ platform, count: available.length }, 'Synced AVAILABLE credentials to Redis hint engine');
    }
  }

  /**
   * Attempts to acquire a credential lease atomically.
   * Enforces D8 DB-authoritative invariant.
   */
  public async acquire(platform: string, leaseDurationMs: number = 300000): Promise<AcquireResult> {
    const listKey = `credential_pool:${platform}:list`;
    const now = new Date();
    
    // Try up to 3 times to account for DB races
    for (let i = 0; i < 3; i++) {
      const candidateId = await this.redis.lpop(listKey);
      if (!candidateId) return null; // No hints in Redis

      const leaseId = randomUUID();
      const leaseUntil = new Date(now.getTime() + leaseDurationMs);

      // Atomic Conditional DB Update (DB > Redis invariant)
      const updated = await db.update(credentials)
        .set({
          status: 'IN_USE',
          leaseId,
          leaseUntil,
          lastUsedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(credentials.id, candidateId),
            or(
              eq(credentials.status, 'AVAILABLE'),
              // Or if it was IN_USE but lease expired (fast-path recovery)
              and(eq(credentials.status, 'IN_USE'), lt(credentials.leaseUntil, now))
            )
          )
        )
        .returning();

      if (updated.length > 0) {
        // Success! We hold the lease.
        const cred = updated[0];
        return {
          id: cred.id,
          encryptedData: cred.encryptedData,
          leaseId: cred.leaseId as string
        };
      } else {
        // Race condition / Stale Redis hint
        logger.warn({ candidateId }, 'Redis hint rejected by DB (stale). Trying next.');
        // We do NOT put it back in Redis. It's properly handled elsewhere.
      }
    }
    return null; // All candidates rejected
  }

  /**
   * Releases a credential based on its outcome.
   * Respects idempotency: only the lease holder can transition it.
   */
  public async release(
    id: string, 
    leaseId: string, 
    platform: string,
    outcome: 'SUCCESS' | 'KEEP' | '429' | '403' | 'UNKNOWN_ERROR' | 'DISABLE'
  ): Promise<void> {
    const listKey = `credential_pool:${platform}:list`;
    const now = new Date();

    // Verify lease ownership atomically during update
    const currentCred = await db.query.credentials.findFirst({
      where: and(eq(credentials.id, id), eq(credentials.leaseId, leaseId))
    });

    if (!currentCred) {
      logger.warn({ id, leaseId }, 'Release failed: Invalid lease ownership or already released');
      return;
    }

    if (outcome === 'SUCCESS' || outcome === 'KEEP') {
      const resetFails = outcome === 'SUCCESS' ? 0 : currentCred.consecutiveFailures;
      await db.update(credentials)
        .set({
          status: 'AVAILABLE',
          leaseId: null,
          leaseUntil: null,
          consecutiveFailures: resetFails,
          updatedAt: now
        })
        .where(and(eq(credentials.id, id), eq(credentials.leaseId, leaseId)));

      // Healthy Round-Robin: RPUSH to tail
      await this.redis.rpush(listKey, id);
    } 
    else if (outcome === '429') {
      const nextFailures = currentCred.consecutiveFailures + 1;
      const backoffMs = Math.pow(2, nextFailures) * 10000; // 20s, 40s, 80s...
      const cooldownUntil = new Date(now.getTime() + backoffMs);

      await db.update(credentials)
        .set({
          status: 'COOLDOWN',
          leaseId: null,
          leaseUntil: null,
          consecutiveFailures: nextFailures,
          cooldownUntil,
          updatedAt: now
        })
        .where(and(eq(credentials.id, id), eq(credentials.leaseId, leaseId)));
      
      // Do NOT push to Redis. It's in cooldown.
    } 
    else if (outcome === 'UNKNOWN_ERROR') {
      const nextFailures = currentCred.consecutiveFailures + 1;
      const cooldownMs = process.env.TEST_COOLDOWN_MS ? parseInt(process.env.TEST_COOLDOWN_MS) : 5 * 60 * 1000;
      const cooldownUntil = new Date(now.getTime() + cooldownMs);

      await db.update(credentials)
        .set({
          status: 'COOLDOWN',
          leaseId: null,
          leaseUntil: null,
          consecutiveFailures: nextFailures,
          cooldownUntil,
          updatedAt: now
        })
        .where(and(eq(credentials.id, id), eq(credentials.leaseId, leaseId)));
    }
    else if (outcome === '403') {
      const nextBlockCount = currentCred.blockCount + 1;
      let newStatus = 'BLOCKED';
      let cooldownUntil = null;

      if (nextBlockCount > this.QUARANTINE_SCHEDULE_MS.length) {
        newStatus = 'DISABLED'; // Burned completely
      } else {
        const quarantineMs = this.QUARANTINE_SCHEDULE_MS[nextBlockCount - 1];
        cooldownUntil = new Date(now.getTime() + quarantineMs);
      }

      await db.update(credentials)
        .set({
          status: newStatus,
          leaseId: null,
          leaseUntil: null,
          blockCount: nextBlockCount,
          cooldownUntil,
          updatedAt: now
        })
        .where(and(eq(credentials.id, id), eq(credentials.leaseId, leaseId)));
      
      // Do NOT push to Redis.
    }
    else if (outcome === 'DISABLE') {
      await db.update(credentials)
        .set({
          status: 'DISABLED',
          leaseId: null,
          leaseUntil: null,
          updatedAt: now
        })
        .where(and(eq(credentials.id, id), eq(credentials.leaseId, leaseId)));
      
      // Do NOT push to Redis.
    }
  }

  /**
   * Sweeps the DB for expired states and restores them to AVAILABLE
   */
  public async sweep(platform: string): Promise<number> {
    const now = new Date();
    
    const recovered = await db.update(credentials)
      .set({
        status: 'AVAILABLE',
        leaseId: null,
        leaseUntil: null,
        cooldownUntil: null,
        updatedAt: now
      })
      .where(
        and(
          eq(credentials.platform, platform),
          or(
            // Recover crashed IN_USE leases
            and(eq(credentials.status, 'IN_USE'), lt(credentials.leaseUntil, now)),
            // Recover expired COOLDOWN
            and(eq(credentials.status, 'COOLDOWN'), lt(credentials.cooldownUntil, now)),
            // Recover expired BLOCKED quarantine
            and(eq(credentials.status, 'BLOCKED'), lt(credentials.cooldownUntil, now))
          )
        )
      )
      .returning({ id: credentials.id });

    if (recovered.length > 0) {
      const listKey = `credential_pool:${platform}:list`;
      await this.redis.rpush(listKey, ...recovered.map(r => r.id));
      logger.info({ platform, recoveredCount: recovered.length }, 'Sweeper recovered credentials');
    }
    
    return recovered.length;
  }

  public async close() {
    await this.redis.quit();
  }
}
