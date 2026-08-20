import { Logger } from 'pino';
import { DownloadJobData, DownloadResult, Platform } from '@media-downloader/types';
import { InstagramAdapter } from './platforms/instagram';
import { TwitterAdapter } from './platforms/twitter';
import { TikTokAdapter } from './platforms/tiktok';
import { RedditAdapter } from './platforms/reddit';
import { CobaltFallback } from './fallback';
import { config } from '@media-downloader/config';
import fs from 'fs';
import path from 'path';
import { calculateBackoffDelay, TransientError, PermanentError, RateLimitError, CircuitBreaker } from '@media-downloader/core';

const adapters = {
  [Platform.INSTAGRAM]: new InstagramAdapter(),
  [Platform.TWITTER]: new TwitterAdapter(),
  [Platform.TIKTOK]: new TikTokAdapter(),
  [Platform.REDDIT]: new RedditAdapter(),
};

const fallback = new CobaltFallback();

const breakers = {
  [Platform.INSTAGRAM]: new CircuitBreaker('instagram', config.CB_FAILURE_THRESHOLD, config.CB_RESET_TIMEOUT_MS),
  [Platform.TWITTER]: new CircuitBreaker('twitter', config.CB_FAILURE_THRESHOLD, config.CB_RESET_TIMEOUT_MS),
  [Platform.TIKTOK]: new CircuitBreaker('tiktok', config.CB_FAILURE_THRESHOLD, config.CB_RESET_TIMEOUT_MS),
  [Platform.REDDIT]: new CircuitBreaker('reddit', config.CB_FAILURE_THRESHOLD, config.CB_RESET_TIMEOUT_MS),
};

export async function processDownload(job: DownloadJobData, logger: Logger): Promise<DownloadResult> {
  const outputDir = path.join(config.TEMP_DIR, `job_${job.jobId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const platform = job.platform as Platform;

  if (platform === Platform.UNKNOWN) {
    throw new PermanentError(`Unsupported platform: ${platform}`);
  }

  const adapter = adapters[platform];
  const breaker = breakers[platform];

  if (!adapter || !breaker) {
    throw new PermanentError(`Unsupported platform: ${platform}`);
  }

  // Basic Retry Engine implementation at the engine level for yt-dlp specifics
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < config.MAX_RETRIES; attempt++) {
    try {
      logger.info({ attempt }, 'Attempting primary adapter download');
      const result = await breaker.execute(() => adapter.download(job.url, outputDir));
      return result;
    } catch (error: any) {
      lastError = error;
      logger.warn({ err: error, attempt }, 'Primary adapter download failed');
      
      if (error instanceof RateLimitError) {
        // Specifically wait for rate limits
        logger.info(`Rate limited. Waiting ${error.retryAfterMs}ms before next attempt`);
        await new Promise(r => setTimeout(r, error.retryAfterMs));
        continue;
      }
      
      if (!error.isRetryable) {
        break; // Stop retrying if it's a permanent error (e.g. 404)
      }

      // Exponential backoff with jitter
      const delay = calculateBackoffDelay(attempt, config.RETRY_BASE_DELAY_MS);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // If primary adapter fails after all retries, try Layer 3: Cobalt fallback
  if (lastError && lastError instanceof TransientError) {
    try {
      logger.info('Primary adapter exhausted. Attempting Cobalt fallback.');
      const result = await fallback.download(job.url, outputDir);
      return result;
    } catch (fallbackError: any) {
      logger.error({ err: fallbackError }, 'Cobalt fallback also failed');
      throw new TransientError(`All download methods failed. Last error: ${lastError.message}`);
    }
  }
  
  throw lastError || new PermanentError('Unknown download failure');
}
