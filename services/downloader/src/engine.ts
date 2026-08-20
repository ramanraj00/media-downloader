import { Logger } from 'pino';
import { DownloadJobData, DownloadResult, Platform } from '@media-downloader/types';
import { InstagramAdapter } from './platforms/instagram';
import { TwitterAdapter } from './platforms/twitter';
import { TikTokAdapter } from './platforms/tiktok';
import { RedditAdapter } from './platforms/reddit';
import { CobaltFallback } from './fallback';
export { CobaltFallback };
import { config } from '@media-downloader/config';
import fs from 'fs';
import path from 'path';
import {
  calculateBackoffDelay,
  TransientError,
  PermanentError,
  RateLimitError,
  IdentityBlockedError,
  IdentitiesExhaustedError,
  DistributedCircuitBreaker,
  RedisIdentityPool
} from '@media-downloader/core';
import Redis from 'ioredis';

const adapters = {
  [Platform.INSTAGRAM]: new InstagramAdapter(),
  [Platform.TWITTER]: new TwitterAdapter(),
  [Platform.TIKTOK]: new TikTokAdapter(),
  [Platform.REDDIT]: new RedditAdapter(),
};

const fallback = new CobaltFallback();

const distributedBreakers = {
  [Platform.INSTAGRAM]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'instagram', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.TWITTER]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'twitter', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.TIKTOK]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'tiktok', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.REDDIT]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'reddit', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
};

export const identityPool = new RedisIdentityPool({ redisUrl: config.REDIS_URL });
const redisClient = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export async function processDownload(job: DownloadJobData, logger: Logger): Promise<DownloadResult> {
  await redisClient.incr('metric:platform_acquisitions');
  const outputDir = path.join(config.TEMP_DIR, `job_${job.jobId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const platform = (job.platform.toLowerCase()) as Platform;

  if (platform === Platform.UNKNOWN) {
    throw new PermanentError(`Unsupported platform: ${platform}`);
  }

  const adapter = adapters[platform];
  const breaker = distributedBreakers[platform];

  if (!adapter || !breaker) {
    throw new PermanentError(`Unsupported platform: ${platform}`);
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < config.MAX_RETRIES; attempt++) {
    let identityId: string | undefined;

    try {
      try {
        identityId = await identityPool.getHealthyIdentity(platform);
      } catch (err: any) {
        if (err instanceof IdentitiesExhaustedError) {
          logger.warn({ platform }, 'All identities in pool are BLOCKED or EXHAUSTED. Failing over to Cobalt layer.');
          lastError = err;
          break; // Break retry loop to trigger Cobalt fallback immediately
        }
        throw err;
      }

      logger.info({ attempt, identityId, platform }, 'Attempting primary adapter download');

      const result = await breaker.execute(() => adapter.download(job.url, outputDir, identityId));
      return result;

    } catch (error: any) {
      lastError = error;
      logger.warn({ err: error, attempt, identityId }, 'Primary adapter download attempt failed');

      if (error instanceof IdentityBlockedError) {
        // Mark identity BLOCKED in Redis and rotate to next healthy identity
        logger.warn({ identityId: error.identityId }, `Identity ${error.identityId} blocked by anti-bot challenge. Marking BLOCKED in Redis.`);
        await identityPool.markIdentityBlocked(platform, error.identityId, 300000);
        continue;
      }

      if (error instanceof RateLimitError) {
        logger.info({ retryAfterMs: error.retryAfterMs }, `Rate limited on platform ${platform}. Applying adaptive backoff.`);
        if (identityId) {
          await identityPool.markIdentityCooldown(platform, identityId, error.retryAfterMs);
        }
        const delay = calculateBackoffDelay(attempt, error.retryAfterMs);
        await new Promise(r => setTimeout(r, Math.min(delay, 2000))); // Non-blocking short backoff in test / worker
        continue;
      }

      if (!error.isRetryable) {
        break; // Stop retrying for permanent errors (e.g. 404)
      }

      const delay = calculateBackoffDelay(attempt, config.RETRY_BASE_DELAY_MS);
      await new Promise(r => setTimeout(r, Math.min(delay, 1000)));
    }
  }

  // Layer 3: Secondary Provider (Cobalt Fallback)
  if (lastError && (lastError instanceof TransientError || lastError instanceof IdentitiesExhaustedError)) {
    try {
      logger.info({ lastError: lastError.message }, 'Primary adapter exhausted or identities blocked. Attempting Cobalt fallback.');
      const result = await fallback.download(job.url, outputDir);
      return result;
    } catch (fallbackError: any) {
      logger.error({ err: fallbackError }, 'Cobalt fallback also failed');
      throw new TransientError(`All primary and fallback download methods failed. Last error: ${lastError.message}`);
    }
  }

  throw lastError || new PermanentError('Unknown download failure');
}
