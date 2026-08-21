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
  CredentialPool,
  S3Storage
} from '@media-downloader/core';
import Redis from 'ioredis';

import { PlatformAdapter } from './platforms/adapter';

const adapters: Partial<Record<Platform, PlatformAdapter>> = {
  [Platform.INSTAGRAM]: new InstagramAdapter(),
  [Platform.TWITTER]: new TwitterAdapter(),
  [Platform.TIKTOK]: new TikTokAdapter(),
  [Platform.REDDIT]: new RedditAdapter(),
};

const fallback = new CobaltFallback();
const s3 = new S3Storage(); // Default mock bucket

const distributedBreakers: Partial<Record<Platform, DistributedCircuitBreaker>> = {
  [Platform.INSTAGRAM]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'instagram', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.TWITTER]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'twitter', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.TIKTOK]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'tiktok', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.REDDIT]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'reddit', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
};

export const identityPool = new CredentialPool({ redisUrl: config.REDIS_URL });
const redisClient = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

export async function processDownload(job: DownloadJobData, logger: Logger): Promise<DownloadResult> {
  await redisClient.incr('metric:platform_acquisitions');
  const outputDir = path.join(config.TEMP_DIR, `job_${job.jobId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const platform = (job.platform.toLowerCase()) as Platform;

  if (platform === Platform.UNKNOWN) {
    throw new PermanentError(`Unsupported platform: ${platform}`);
  }

  // CHECKPOINT RESILIENCE: Check if S3 artifact already exists
  const objectKey = `jobs/${job.jobId}/raw/video.mp4`; // Assuming mp4 for simplicity
  const bucket = 'media-dl-prod';
  
  if (await s3.artifactExists(bucket, objectKey)) {
    logger.info('S3 checkpoint found, skipping download and reusing artifact');
    const metadata = await s3.getArtifactMetadata(bucket, objectKey);
    return {
      filePath: 'S3_CHECKPOINT',
      info: { url: job.url, platform, ext: 'mp4' },
      sourceLayer: 's3_checkpoint',
      downloadTimeMs: 0,
      s3Artifact: {
        bucket,
        objectKey,
        sizeBytes: metadata.sizeBytes,
        contentType: 'video/mp4',
        contentHash: metadata.contentHash
      }
    };
  }

  const adapter = adapters[platform];
  const breaker = distributedBreakers[platform];

  if (!adapter || !breaker) {
    throw new PermanentError(`Unsupported platform: ${platform}`);
  }

  let lastError: Error | null = null;
  let result: DownloadResult | null = null;

  for (let attempt = 0; attempt < config.MAX_RETRIES; attempt++) {
    let leaseId: string | undefined;
    let identityId: string | undefined;

    try {
      const acq = await identityPool.acquire(platform);
      if (!acq) {
        throw new IdentitiesExhaustedError(`All identities in pool for platform [${platform}] are currently BLOCKED or EXHAUSTED`, platform);
      }
      
      identityId = acq.id;
      leaseId = acq.leaseId;

      logger.info({ attempt, identityId, platform }, 'Attempting primary adapter download');

      result = await breaker.execute(() => adapter.download(job.url, outputDir, acq.encryptedData));
      
      // Release lease on success
      await identityPool.release(identityId, leaseId, platform, 'SUCCESS');
      break;

    } catch (error: any) {
      lastError = error;
      logger.warn({ err: error, attempt, identityId }, 'Primary adapter download attempt failed');

      if (identityId && leaseId) {
        let action = error.credentialAction || 'UNKNOWN_ERROR';
        if (action === 'BLOCK') action = '403';
        else if (action === 'COOLDOWN') action = '429';

        logger.warn({ identityId, action }, `Releasing credential with action ${action}`);
        await identityPool.release(identityId, leaseId, platform, action);

        if (error instanceof RateLimitError) {
          throw error; // Bubble up to let BullMQ handle the job-level retry/delay
        }

        if (error instanceof IdentityBlockedError) {
          continue; // Instantly retry with a new identity
        }
      }

      if (!error.isRetryable || error instanceof IdentitiesExhaustedError) {
        throw error; // Immediately bubble up permanent errors or capacity exhaustion
      }

      throw error; // Default: bubble up any other transient error to BullMQ
    }
  }

  if (!result && lastError && lastError instanceof TransientError && !(lastError instanceof IdentitiesExhaustedError)) {
    try {
      logger.info({ lastError: lastError.message }, 'Primary adapter exhausted or identities blocked. Attempting Cobalt fallback.');
      result = await fallback.download(job.url, outputDir);
    } catch (fallbackError: any) {
      logger.error({ err: fallbackError }, 'Cobalt fallback also failed');
      throw new TransientError(`All primary and fallback download methods failed. Last error: ${lastError.message}`);
    }
  }

  if (!result) {
    throw lastError || new PermanentError('Unknown download failure');
  }

  // Upload to S3
  logger.info({ filePath: result.filePath }, 'Uploading artifact to S3');
  const artifactRef = await s3.putArtifact(bucket, objectKey, result.filePath);
  
  result.s3Artifact = artifactRef;
  
  // Cleanup local /tmp file!
  try {
    fs.unlinkSync(result.filePath);
    logger.info('Cleaned up local /tmp artifact');
  } catch (e) {
    logger.error('Failed to cleanup local file');
  }

  return result;
}
