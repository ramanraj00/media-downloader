import { Logger } from 'pino';
import { DownloadJobData, DownloadResult, Platform } from '@media-downloader/types';
import { InstagramAdapter } from './platforms/instagram';
import { TwitterAdapter } from './platforms/twitter';
import { TikTokAdapter, TIKTOK_CAPABILITIES } from './platforms/tiktok';
import { RedditAdapter, REDDIT_CAPABILITIES } from './platforms/reddit';
import { CobaltAdapter } from './platforms/cobalt';
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
  S3Storage,
  AccessBlockedError,
  GeoBlockedError,
  DatacenterBlockedError,
  AuthRequiredError,
} from '@media-downloader/core';
import Redis from 'ioredis';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

import { PlatformAdapter } from './platforms/adapter';

// ─── Adapter Registry ────────────────────────────────────────────────────────

const adapters: Partial<Record<string, PlatformAdapter>> = {
  [Platform.INSTAGRAM]: new InstagramAdapter(),
  [Platform.TWITTER]: new TwitterAdapter(),
  [Platform.TIKTOK]: new TikTokAdapter(),
  [Platform.REDDIT]: new RedditAdapter(),
};

/**
 * Platform capability flags — determines what tier transitions are valid.
 * If a platform doesn't support authenticated extraction, AuthRequiredError
 * should NOT route to Tier 4; it should be treated as a terminal state.
 */
const platformCapabilities: Partial<Record<string, {
  supportsAuthenticatedExtraction: boolean;
  supportsEgressFallback: boolean;
}>> = {
  [Platform.TIKTOK]: TIKTOK_CAPABILITIES,
  [Platform.REDDIT]: REDDIT_CAPABILITIES,
  [Platform.INSTAGRAM]: { supportsAuthenticatedExtraction: true, supportsEgressFallback: false },
  [Platform.TWITTER]: { supportsAuthenticatedExtraction: true, supportsEgressFallback: false },
};

// ─── Retry Budgets ───────────────────────────────────────────────────────────

const TIER3_MAX_EGRESS_ATTEMPTS = 2;   // Max proxy identities to try
const TIER4_MAX_AUTH_ATTEMPTS = 1;      // Max cookie credentials to try

// ─── Infrastructure ──────────────────────────────────────────────────────────

const s3 = new S3Storage();

const distributedBreakers: Partial<Record<string, DistributedCircuitBreaker>> = {
  [Platform.INSTAGRAM]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'instagram', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.TWITTER]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'twitter', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.TIKTOK]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'tiktok', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
  [Platform.REDDIT]: new DistributedCircuitBreaker({ redisUrl: config.REDIS_URL, name: 'reddit', failureThreshold: config.CB_FAILURE_THRESHOLD, resetTimeoutMs: config.CB_RESET_TIMEOUT_MS }),
};

export const identityPool = new CredentialPool({ redisUrl: config.REDIS_URL });
const redisClient = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const secretsManager = new SecretsManagerClient({ region: 'ap-south-1' });

// ─── Extraction State Machine ────────────────────────────────────────────────

type ExtractionTier = 'DIRECT' | 'EGRESS' | 'AUTHENTICATED' | 'EXHAUSTED';

interface TierTransition {
  nextTier: ExtractionTier;
  reason: string;
}

/**
 * Reason-driven extraction router.
 * 
 * Flow:
 *   Tier 1+2 (DIRECT) → adapter.extract() [Cobalt → yt-dlp]
 *     ├── SUCCESS → S3
 *     ├── GeoBlocked / DatacenterBlocked → Tier 3 (EGRESS)
 *     ├── AuthRequired → Tier 4 (AUTHENTICATED) if platform supports it
 *     ├── Retryable (429/5xx/timeout) → throw to BullMQ for backoff
 *     └── Permanent (ContentNotFound/Unsupported) → failed_permanently
 * 
 *   Tier 3 (EGRESS) → adapter.extractWithProxy() [yt-dlp + proxy]
 *     ├── SUCCESS → S3
 *     ├── Budget exhausted (2 attempts) → failed_permanently
 *     └── Retryable → throw to BullMQ
 * 
 *   Tier 4 (AUTHENTICATED) → adapter.extractWithCookies() [yt-dlp + cookies]
 *     ├── SUCCESS → S3
 *     ├── Budget exhausted (1 attempt) → failed_permanently
 *     └── Retryable → throw to BullMQ
 */
export async function processDownload(job: DownloadJobData, logger: Logger): Promise<DownloadResult> {
  await redisClient.incr('metric:platform_acquisitions');
  const outputDir = path.join(config.TEMP_DIR, `job_${job.jobId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const platform = (job.platform.toLowerCase()) as Platform;

  if (platform === Platform.UNKNOWN) {
    throw new PermanentError(`Unsupported platform: ${platform}`);
  }

  // CHECKPOINT RESILIENCE: Check if S3 artifact already exists
  const objectKey = `jobs/${job.jobId}/raw/video.mp4`;
  const bucket = config.ARTIFACT_BUCKET;
  
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
  const capabilities = platformCapabilities[platform] || {
    supportsAuthenticatedExtraction: false,
    supportsEgressFallback: false,
  };

  if (!adapter || !breaker) {
    throw new PermanentError(`Unsupported platform: ${platform}`);
  }

  // ─── Reason-Driven State Machine ─────────────────────────────────────

  let currentTier: ExtractionTier = 'DIRECT';
  let lastBlockError: AccessBlockedError | null = null;

  while (currentTier !== 'EXHAUSTED') {
    try {
      let result: DownloadResult;

      switch (currentTier) {
        case 'DIRECT':
          result = await executeDirect(adapter, breaker, job, outputDir, platform, logger);
          break;

        case 'EGRESS':
          result = await executeEgress(adapter, job, outputDir, platform, logger);
          break;

        case 'AUTHENTICATED':
          result = await executeAuthenticated(adapter, job, outputDir, platform, logger);
          break;

        default:
          throw new PermanentError(`Unknown tier: ${currentTier}`);
      }

      // SUCCESS — upload to S3 and return
      return await uploadAndCleanup(result, bucket, objectKey, logger);

    } catch (error: any) {
      const transition = classifyErrorForTierTransition(error, currentTier, capabilities, logger);

      if (transition) {
        logger.info({
          fromTier: currentTier,
          toTier: transition.nextTier,
          reason: transition.reason,
          errorType: error.constructor.name,
        }, 'Tier transition: routing to next extraction tier');

        currentTier = transition.nextTier;
        if (error instanceof AccessBlockedError) {
          lastBlockError = error;
        }
        continue;
      }

      // No tier transition — error must be handled by BullMQ or declared permanent.
      // Retryable errors (429, 5xx, timeout) bubble up to BullMQ for backoff.
      // PermanentErrors (ContentNotFound, Unsupported) bubble up as UnrecoverableError.
      throw error;
    }
  }

  // Should never reach here, but safety net
  throw lastBlockError || new PermanentError('All extraction tiers exhausted');
}

// ─── Tier Executors ──────────────────────────────────────────────────────────

/**
 * DIRECT tier: Uses the platform adapter's standard extract() method,
 * which internally tries Cobalt (Tier 1) then yt-dlp (Tier 2).
 */
async function executeDirect(
  adapter: PlatformAdapter,
  breaker: DistributedCircuitBreaker,
  job: DownloadJobData,
  outputDir: string,
  platform: Platform,
  logger: Logger
): Promise<DownloadResult> {
  // For platforms that strictly require credentials upfront
  const requiresIdentity = platform === Platform.INSTAGRAM || platform === Platform.TWITTER;
  
  const acq = await identityPool.acquire(platform);
  
  if (!acq && requiresIdentity) {
    throw new IdentitiesExhaustedError(`All identities for [${platform}] are exhausted`, platform);
  }

  const identityId = acq?.id;
  const leaseId = acq?.leaseId;
  const encryptedData = acq?.encryptedData;

  try {
    logger.info({ tier: 'DIRECT', identityId, platform }, 'Attempting direct extraction (Cobalt → yt-dlp)');

    const extResult = await breaker.execute(() => adapter.extract(job.url, outputDir, encryptedData));
    
    if (extResult.status !== 'success' || !extResult.filePath) {
      throw new PermanentError(`Extraction failed or no filePath: ${extResult.status}`);
    }

    // Release lease on success
    if (identityId && leaseId) {
      await identityPool.release(identityId, leaseId, platform, 'SUCCESS');
    }

    return {
      filePath: extResult.filePath,
      info: extResult.metadata as any,
      sourceLayer: extResult.source,
      downloadTimeMs: extResult.metadata?.downloadTimeMs || 0
    };
  } catch (error: any) {
    // Release lease on failure
    if (identityId && leaseId) {
      const action = error.credentialAction || 'UNKNOWN_ERROR';
      await identityPool.release(identityId, leaseId, platform, action === 'BLOCK' ? '403' : action === 'COOLDOWN' ? '429' : action);
    }
    throw error;
  }
}

/**
 * EGRESS tier: Acquires a proxy identity and routes yt-dlp through it.
 * Budget: max TIER3_MAX_EGRESS_ATTEMPTS proxy identities.
 */
async function executeEgress(
  adapter: PlatformAdapter,
  job: DownloadJobData,
  outputDir: string,
  platform: Platform,
  logger: Logger
): Promise<DownloadResult> {
  // Check if adapter supports proxy extraction
  const adapterWithProxy = adapter as any;
  if (typeof adapterWithProxy.extractWithProxy !== 'function') {
    throw new PermanentError(`Platform ${platform} does not support egress extraction`);
  }

  for (let attempt = 0; attempt < TIER3_MAX_EGRESS_ATTEMPTS; attempt++) {
    // Acquire an egress identity (proxy) from the credential pool
    const egressAcq = await identityPool.acquire('egress' as any);

    if (!egressAcq) {
      logger.warn({ attempt }, 'No egress identities available in pool');
      throw new PermanentError(
        `Egress tier exhausted: no proxy identities available (attempt ${attempt + 1}/${TIER3_MAX_EGRESS_ATTEMPTS})`
      );
    }

    const proxyUrl = egressAcq.encryptedData; // encryptedData stores the proxy URL
    // SECURITY: Never log the actual proxy URL/credentials
    logger.info({
      tier: 'EGRESS',
      attempt: attempt + 1,
      maxAttempts: TIER3_MAX_EGRESS_ATTEMPTS,
      egressId: egressAcq.id,
    }, 'Attempting egress extraction via proxy');

    try {
      const extResult = await adapterWithProxy.extractWithProxy(job.url, outputDir, proxyUrl);

      if (extResult.status !== 'success' || !extResult.filePath) {
        await identityPool.release(egressAcq.id, egressAcq.leaseId, 'egress' as any, 'UNKNOWN_ERROR');
        throw new PermanentError(`Egress extraction failed: ${extResult.status}`);
      }

      // Success — release proxy identity as healthy
      await identityPool.release(egressAcq.id, egressAcq.leaseId, 'egress' as any, 'SUCCESS');

      return {
        filePath: extResult.filePath,
        info: extResult.metadata as any,
        sourceLayer: `egress_${extResult.source}`,
        downloadTimeMs: extResult.metadata?.downloadTimeMs || 0
      };
    } catch (error: any) {
      await identityPool.release(egressAcq.id, egressAcq.leaseId, 'egress' as any, 'UNKNOWN_ERROR');

      // If this is still an AccessBlockedError even with proxy, try next proxy
      if (error instanceof AccessBlockedError && attempt < TIER3_MAX_EGRESS_ATTEMPTS - 1) {
        logger.warn({ attempt, err: error.message }, 'Egress proxy also blocked, trying next proxy');
        continue;
      }

      // If retryable (429/timeout), bubble up to BullMQ
      if (error instanceof TransientError) throw error;

      // Last attempt or permanent error
      if (attempt >= TIER3_MAX_EGRESS_ATTEMPTS - 1) {
        throw new PermanentError(
          `Egress tier exhausted after ${TIER3_MAX_EGRESS_ATTEMPTS} attempts. Last error: ${error.message}`
        );
      }
      throw error;
    }
  }

  throw new PermanentError('Egress tier: unexpected loop exit');
}

/**
 * AUTHENTICATED tier: Acquires cookies from Secrets Manager and routes yt-dlp with --cookies.
 * Budget: max TIER4_MAX_AUTH_ATTEMPTS credential attempts.
 * Security: cookie file is written to a temp path and ALWAYS deleted in finally.
 */
async function executeAuthenticated(
  adapter: PlatformAdapter,
  job: DownloadJobData,
  outputDir: string,
  platform: Platform,
  logger: Logger
): Promise<DownloadResult> {
  const adapterWithCookies = adapter as any;
  if (typeof adapterWithCookies.extractWithCookies !== 'function') {
    throw new PermanentError(`Platform ${platform} does not support authenticated extraction`);
  }

  for (let attempt = 0; attempt < TIER4_MAX_AUTH_ATTEMPTS; attempt++) {
    // Acquire a platform-specific credential (cookie) from the pool
    const authAcq = await identityPool.acquire(platform);

    if (!authAcq) {
      logger.warn({ attempt }, 'No authenticated credentials available for platform');
      throw new PermanentError(
        `Authenticated tier exhausted: no credentials available for ${platform} (attempt ${attempt + 1}/${TIER4_MAX_AUTH_ATTEMPTS})`
      );
    }

    // Write cookie to a job-scoped temporary file
    const cookiePath = path.join(outputDir, `cookies_${job.jobId}_${Date.now()}.txt`);
    
    try {
      let cookieString = authAcq.encryptedData;
      
      // Check if the credential is a Secrets Manager reference
      if (cookieString.startsWith('/media-downloader/') || cookieString.startsWith('arn:aws:secretsmanager')) {
        const command = new GetSecretValueCommand({ SecretId: cookieString });
        const secretResponse = await secretsManager.send(command);
        if (secretResponse.SecretString) {
          cookieString = secretResponse.SecretString;
        }
      }

      fs.writeFileSync(cookiePath, cookieString, { mode: 0o600 });
      logger.info({
        tier: 'AUTHENTICATED',
        attempt: attempt + 1,
        maxAttempts: TIER4_MAX_AUTH_ATTEMPTS,
        credentialId: authAcq.id,
      }, 'Attempting authenticated extraction');

      const extResult = await adapterWithCookies.extractWithCookies(job.url, outputDir, cookiePath);

      if (extResult.status !== 'success' || !extResult.filePath) {
        await identityPool.release(authAcq.id, authAcq.leaseId, platform, 'UNKNOWN_ERROR');
        throw new PermanentError(`Authenticated extraction failed: ${extResult.status}`);
      }

      // Success
      await identityPool.release(authAcq.id, authAcq.leaseId, platform, 'SUCCESS');

      return {
        filePath: extResult.filePath,
        info: extResult.metadata as any,
        sourceLayer: `authenticated_${extResult.source}`,
        downloadTimeMs: extResult.metadata?.downloadTimeMs || 0
      };
    } catch (error: any) {
      await identityPool.release(authAcq.id, authAcq.leaseId, platform, 'UNKNOWN_ERROR');

      if (error instanceof TransientError) throw error;

      if (attempt >= TIER4_MAX_AUTH_ATTEMPTS - 1) {
        throw new PermanentError(
          `Authenticated tier exhausted after ${TIER4_MAX_AUTH_ATTEMPTS} attempts. Last error: ${error.message}`
        );
      }
      throw error;
    } finally {
      // SECURITY: Always delete the cookie file immediately
      try {
        if (fs.existsSync(cookiePath)) {
          fs.unlinkSync(cookiePath);
          logger.info('Deleted temporary cookie file');
        }
      } catch (e) {
        logger.error('Failed to delete temporary cookie file — manual cleanup required');
      }
    }
  }

  throw new PermanentError('Authenticated tier: unexpected loop exit');
}

// ─── Error Classification for Tier Transitions ──────────────────────────────

/**
 * Determines whether an error should trigger a tier transition or be handled
 * by BullMQ (retry/backoff) or declared permanent.
 * 
 * Returns a TierTransition if the error should route to a different tier,
 * or null if the error should be thrown as-is.
 */
function classifyErrorForTierTransition(
  error: Error,
  currentTier: ExtractionTier,
  capabilities: { supportsAuthenticatedExtraction: boolean; supportsEgressFallback: boolean },
  logger: Logger
): TierTransition | null {
  // Only DIRECT tier can trigger transitions to EGRESS or AUTHENTICATED.
  // EGRESS and AUTHENTICATED tiers handle their own retry budgets internally.
  if (currentTier !== 'DIRECT') return null;

  // GeoBlocked or DatacenterBlocked → route to EGRESS tier (if supported)
  if (error instanceof GeoBlockedError || error instanceof DatacenterBlockedError) {
    if (capabilities.supportsEgressFallback) {
      return {
        nextTier: 'EGRESS',
        reason: error instanceof GeoBlockedError ? 'geo_blocked' : 'datacenter_blocked',
      };
    }
    // Platform doesn't support egress fallback — declare permanent
    logger.warn({ platform: (error as any).platform }, 'Access blocked but platform does not support egress fallback');
    return null;
  }

  // AuthRequired → route to AUTHENTICATED tier (if platform supports it)
  if (error instanceof AuthRequiredError) {
    if (capabilities.supportsAuthenticatedExtraction) {
      return {
        nextTier: 'AUTHENTICATED',
        reason: 'auth_required',
      };
    }
    // Platform doesn't support authenticated extraction — declare permanent
    logger.warn({ platform: (error as any).platform }, 'Auth required but platform does not support authenticated extraction');
    return null;
  }

  // IdentitiesExhausted → bubble up directly (special handling in worker.ts)
  if (error instanceof IdentitiesExhaustedError) return null;

  // Retryable errors (429, timeout, 5xx) → bubble up to BullMQ for backoff
  if (error instanceof TransientError) return null;

  // PermanentError (ContentNotFound, Unsupported) → bubble up as terminal
  if (error instanceof PermanentError) return null;

  // Unknown errors → no transition, let BullMQ handle it
  return null;
}

// ─── S3 Upload ───────────────────────────────────────────────────────────────

async function uploadAndCleanup(
  result: DownloadResult,
  bucket: string,
  objectKey: string,
  logger: Logger
): Promise<DownloadResult> {
  logger.info({ filePath: result.filePath, sourceLayer: result.sourceLayer }, 'Uploading artifact to S3');
  const artifactRef = await s3.putArtifact(bucket, objectKey, result.filePath);
  
  result.s3Artifact = artifactRef;
  
  // Cleanup local /tmp file
  try {
    fs.unlinkSync(result.filePath);
    logger.info('Cleaned up local /tmp artifact');
  } catch (e) {
    logger.error('Failed to cleanup local file');
  }

  return result;
}
