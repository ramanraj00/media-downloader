import { PlatformAdapter } from './adapter';
import { Platform } from '@media-downloader/types';
import { TransientError, PermanentError } from '@media-downloader/core';
import { CobaltAdapter } from './cobalt';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { createLogger } from '@media-downloader/logger';

const execAsync = util.promisify(exec);
const logger = createLogger('RedditAdapter');

export class RedditAdapter extends PlatformAdapter {
  platform = Platform.REDDIT;

  canHandle(url: string): boolean {
    const domains = ['reddit.com', 'old.reddit.com', 'v.redd.it', 'i.redd.it'];
    return domains.some(d => url.includes(d));
  }

  async extract(url: string, outputDir: string, identityId?: string): Promise<import("@media-downloader/types").ExtractionResult> {
    // Tier 1: Try Cobalt first (fast, no credentials needed)
    const cobaltResult = await this.tryCobalt(url, outputDir);
    if (cobaltResult) return cobaltResult;

    // Tier 2: Fall back to yt-dlp direct (no proxy, no cookies)
    const ytdlpResult = await this.tryYtDlp(url, outputDir);
    if (ytdlpResult) return ytdlpResult;

    // Both tiers failed
    throw new PermanentError(`Reddit extraction failed for ${url}: Cobalt and yt-dlp both failed`);
  }

  private async tryCobalt(url: string, outputDir: string): Promise<import("@media-downloader/types").ExtractionResult | null> {
    try {
      logger.info({ url }, 'Tier 1: Attempting Cobalt extraction');
      const cobalt = new CobaltAdapter();
      cobalt.platform = this.platform;
      const result = await cobalt.extract(url, outputDir);

      if (result.status === 'success') {
        logger.info({ url, source: 'cobalt' }, 'Cobalt extraction succeeded');
        return result;
      }

      logger.warn({ url, status: result.status }, 'Cobalt returned non-success status');
      return null;
    } catch (err: any) {
      // Distinguish error types for evidence/debugging
      const isAuthError = err.message?.includes('auth');
      const isFetchError = err.message?.includes('fetch');
      const isAdmission = err.message?.includes('admission');

      logger.warn({
        url,
        errorType: isAuthError ? 'cobalt_auth_failure' : isFetchError ? 'cobalt_fetch_failure' : isAdmission ? 'cobalt_admission_full' : 'cobalt_error',
        message: err.message?.substring(0, 200),
      }, 'Cobalt extraction failed, falling back to yt-dlp');

      return null;
    }
  }

  private async tryYtDlp(url: string, outputDir: string): Promise<import("@media-downloader/types").ExtractionResult | null> {
    try {
      logger.info({ url }, 'Tier 2: Attempting yt-dlp extraction');
      const startTime = Date.now();
      const opts = this.getBaseYtDlpOpts(outputDir);

      // yt-dlp with --dump-json downloads AND prints metadata
      const command = `yt-dlp ${opts.join(' ')} --dump-json "${url}"`;
      const { stdout } = await execAsync(command, { timeout: 120000 });

      const info = JSON.parse(stdout);
      const actualPath = this.resolveFile(outputDir);

      logger.info({ url, source: 'ytdlp', downloadTimeMs: Date.now() - startTime }, 'yt-dlp extraction succeeded');

      return {
        status: 'success',
        source: 'ytdlp',
        filePath: actualPath,
        metadata: {
          url,
          platform: this.platform,
          title: info.title,
          duration: info.duration,
          width: info.width,
          height: info.height,
          thumbnailUrl: info.thumbnail,
          fileSize: fs.statSync(actualPath).size,
          ext: actualPath.split('.').pop(),
          hasAudio: info.acodec !== 'none',
          hasVideo: info.vcodec !== 'none',
          vcodec: info.vcodec,
          acodec: info.acodec,
          downloadTimeMs: Date.now() - startTime,
        }
      };
    } catch (error: any) {
      const stderr = error.stderr || error.message || '';
      logger.warn({
        url,
        errorType: this.classifyYtDlpError(stderr),
        message: stderr.substring(0, 200),
      }, 'yt-dlp extraction failed');
      return null;
    }
  }

  private resolveFile(outputDir: string): string {
    const files = fs.readdirSync(outputDir);
    const downloaded = files.find(f => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.json'));

    if (downloaded) return path.join(outputDir, downloaded);
    throw new PermanentError(`File not found in output directory ${outputDir}`);
  }

  private classifyYtDlpError(stderr: string): string {
    const lower = stderr.toLowerCase();
    if (lower.includes('http error 429') || lower.includes('too many requests')) return 'rate_limit';
    if (lower.includes('http error 403') || lower.includes('forbidden')) return 'forbidden';
    if (lower.includes('http error 404') || lower.includes('not found')) return 'not_found';
    if (lower.includes('unsupported url')) return 'unsupported_url';
    if (lower.includes('private') || lower.includes('login')) return 'auth_required';
    if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
    return 'unknown';
  }
}
