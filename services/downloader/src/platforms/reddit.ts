import { PlatformAdapter } from './adapter';
import { Platform } from '@media-downloader/types';
import {
  TransientError,
  PermanentError,
  GeoBlockedError,
  DatacenterBlockedError,
  AuthRequiredError,
  AccessBlockedError,
  ContentNotFoundError
} from '@media-downloader/core';
import { CobaltAdapter } from './cobalt';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { createLogger } from '@media-downloader/logger';

const execAsync = util.promisify(exec);
const logger = createLogger('RedditAdapter');

/**
 * Platform capability flags for the extraction router.
 */
export const REDDIT_CAPABILITIES = {
  supportsAuthenticatedExtraction: true,  // Reddit supports cookie-based auth
  supportsEgressFallback: true,
};

export class RedditAdapter extends PlatformAdapter {
  platform = Platform.REDDIT;

  canHandle(url: string): boolean {
    const domains = ['reddit.com', 'old.reddit.com', 'v.redd.it', 'i.redd.it'];
    return domains.some(d => url.includes(d));
  }

  /**
   * Direct extraction — Tier 1 (Cobalt) then Tier 2 (yt-dlp).
   * Throws typed errors for the extraction router to handle tier transitions.
   */
  async extract(url: string, outputDir: string, identityId?: string): Promise<import("@media-downloader/types").ExtractionResult> {
    let cobaltError: Error | null = null;
    let ytdlpError: Error | null = null;

    // Tier 1: Try Cobalt first (fast, no credentials needed)
    try {
      return await this.tryCobalt(url, outputDir);
    } catch (err: any) {
      cobaltError = err;
      logger.warn({
        url,
        errorType: err.constructor.name,
        message: err.message?.substring(0, 200),
      }, 'Cobalt extraction failed, falling back to yt-dlp');
    }

    // Tier 2: Fall back to yt-dlp direct (no proxy, no cookies)
    try {
      return await this.tryYtDlp(url, outputDir);
    } catch (err: any) {
      ytdlpError = err;
      logger.warn({
        url,
        errorType: err.constructor.name,
        message: err.message?.substring(0, 200),
      }, 'yt-dlp extraction also failed');
    }

    // Both tiers failed — propagate the most specific error for the router.
    const bestError = this.pickMostSpecificError(cobaltError!, ytdlpError!);
    throw bestError;
  }

  /**
   * Egress-routed extraction — Tier 3. Called by the engine with a proxy URL.
   */
  async extractWithProxy(url: string, outputDir: string, proxyUrl: string): Promise<import("@media-downloader/types").ExtractionResult> {
    logger.info({ url, proxy: '***' }, 'Tier 3: Attempting yt-dlp extraction with egress proxy');
    return this.tryYtDlp(url, outputDir, { proxy: proxyUrl });
  }

  /**
   * Authenticated extraction — Tier 4. Called by the engine with a cookies file.
   */
  async extractWithCookies(url: string, outputDir: string, cookiesPath: string): Promise<import("@media-downloader/types").ExtractionResult> {
    logger.info({ url }, 'Tier 4: Attempting yt-dlp extraction with authenticated session');
    return this.tryYtDlp(url, outputDir, { cookies: cookiesPath });
  }

  private async tryCobalt(url: string, outputDir: string): Promise<import("@media-downloader/types").ExtractionResult> {
    logger.info({ url }, 'Tier 1: Attempting Cobalt extraction');
    const cobalt = new CobaltAdapter();
    cobalt.platform = this.platform;
    const result = await cobalt.extract(url, outputDir);

    if (result.status === 'success') {
      logger.info({ url, source: 'cobalt' }, 'Cobalt extraction succeeded');
      return result;
    }

    throw new PermanentError(`Cobalt returned non-success status: ${result.status}`);
  }

  private async tryYtDlp(
    url: string,
    outputDir: string,
    options?: { proxy?: string; cookies?: string }
  ): Promise<import("@media-downloader/types").ExtractionResult> {
    logger.info({ url, hasProxy: !!options?.proxy, hasCookies: !!options?.cookies }, 'Attempting yt-dlp extraction');
    const startTime = Date.now();
    const opts = this.getBaseYtDlpOpts(outputDir);

    if (options?.proxy) {
      opts.push('--proxy', `'${options.proxy}'`);
    }
    if (options?.cookies) {
      opts.push('--cookies', `'${options.cookies}'`);
    }

    const command = `yt-dlp ${opts.join(' ')} --dump-json "${url}"`;

    try {
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
      throw this.classifyYtDlpError(stderr, url);
    }
  }

  private resolveFile(outputDir: string): string {
    const files = fs.readdirSync(outputDir);
    const downloaded = files.find(f => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.json') && !f.endsWith('.txt'));

    if (downloaded) return path.join(outputDir, downloaded);
    throw new PermanentError(`File not found in output directory ${outputDir}`);
  }

  /**
   * Classifies yt-dlp stderr output into typed errors using Reddit-specific markers.
   * Reddit-specific: "Account authentication is required" = AuthRequired (not PermanentError).
   */
  private classifyYtDlpError(stderr: string, url: string): Error {
    const lower = stderr.toLowerCase();

    // Reddit auth block — the canonical datacenter/unauthenticated block signal.
    // "Account authentication is required. Use --cookies-from-browser or --cookies"
    if (lower.includes('account authentication is required') ||
        lower.includes('use --cookies-from-browser') ||
        lower.includes('use --cookies for the authentication')) {
      return new AuthRequiredError(
        `Reddit requires authentication: ${stderr.substring(0, 200)}`,
        'reddit'
      );
    }

    // Rate limiting
    if (lower.includes('http error 429') || lower.includes('too many requests')) {
      return new TransientError(`Reddit rate limited: ${stderr.substring(0, 200)}`);
    }

    // Content not found
    if (lower.includes('http error 404') || lower.includes('unable to extract') || lower.includes('page not found')) {
      return new ContentNotFoundError(`Reddit content not found: ${stderr.substring(0, 200)}`, 'reddit');
    }

    // Unsupported
    if (lower.includes('unsupported url')) {
      return new PermanentError(`Reddit unsupported URL: ${stderr.substring(0, 200)}`);
    }

    // Timeout
    if (lower.includes('timeout') || lower.includes('timed out')) {
      return new TransientError(`Reddit timeout: ${stderr.substring(0, 200)}`);
    }

    // Forbidden — could be datacenter block
    if (lower.includes('http error 403') || lower.includes('forbidden')) {
      return new DatacenterBlockedError(`Reddit 403 (likely datacenter block): ${stderr.substring(0, 200)}`, 'reddit');
    }

    // Default: treat as transient to allow BullMQ retry
    return new TransientError(`Reddit yt-dlp unknown error: ${stderr.substring(0, 200)}`);
  }

  /**
   * Given errors from Cobalt and yt-dlp, pick the most actionable one for the router.
   * AccessBlockedError > PermanentError > TransientError
   */
  private pickMostSpecificError(cobaltErr: Error, ytdlpErr: Error): Error {
    // If either is an AccessBlockedError, prefer it — it drives tier transitions
    if (ytdlpErr instanceof AccessBlockedError) return ytdlpErr;
    if (cobaltErr instanceof AccessBlockedError) return cobaltErr;

    // If either is permanent, prefer it
    if (ytdlpErr instanceof PermanentError) return ytdlpErr;
    if (cobaltErr instanceof PermanentError) return cobaltErr;

    // Default to yt-dlp error (last attempted)
    return ytdlpErr;
  }
}
