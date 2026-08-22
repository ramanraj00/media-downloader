import { PlatformAdapter } from './adapter';
import { Platform } from '@media-downloader/types';
import { TransientError, PermanentError, ContentNotFoundError, GeoBlockedError, DatacenterBlockedError, AuthRequiredError, AccessBlockedError } from '@media-downloader/core';
import { CobaltAdapter } from './cobalt';
import { execFile } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';
import { createLogger } from '@media-downloader/logger';

const execFileAsync = util.promisify(execFile);
const logger = createLogger('InstagramAdapter');

/**
 * Platform capability flags for the extraction router.
 */
export const INSTAGRAM_CAPABILITIES = {
  supportsAuthenticatedExtraction: true,  // Instagram heavily relies on cookies
  supportsEgressFallback: true,           // Proxy fallback
};

export class InstagramAdapter extends PlatformAdapter {
  platform = Platform.INSTAGRAM;

  canHandle(url: string): boolean {
    return url.includes('instagram.com') || url.includes('instagr.am');
  }

  async extract(url: string, outputDir: string, identityId?: string): Promise<import("@media-downloader/types").ExtractionResult> {
    let cobaltError: Error | null = null;
    let ytdlpError: Error | null = null;

    // Tier 1: Try Cobalt first
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

    // Tier 2: Fall back to yt-dlp direct
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

    const bestError = this.pickMostSpecificError(cobaltError!, ytdlpError!);
    throw bestError;
  }

  async extractWithProxy(url: string, outputDir: string, proxyUrl: string): Promise<import("@media-downloader/types").ExtractionResult> {
    logger.info({ url, proxy: '***' }, 'Tier 3: Attempting yt-dlp extraction with egress proxy');
    return this.tryYtDlp(url, outputDir, { proxy: proxyUrl });
  }

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
      opts.push('--proxy', options.proxy);
    }
    if (options?.cookies) {
      opts.push('--cookies', options.cookies);
    }

    const finalOpts = [...opts, '--dump-json', '--no-simulate', url];

    try {
      const { stdout } = await execFileAsync('yt-dlp', finalOpts, { timeout: 120000 });
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
          title: info.title || 'Instagram Post',
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

  private classifyYtDlpError(stderr: string, url: string): Error {
    const lower = stderr.toLowerCase();

    // Login required / Auth block
    if (lower.includes('login') || lower.includes('password') || lower.includes('account authentication is required')) {
      return new AuthRequiredError(`Instagram auth required: ${stderr.substring(0, 200)}`, 'instagram');
    }

    if (lower.includes('http error 429') || lower.includes('too many requests')) {
      return new TransientError(`Instagram rate limited: ${stderr.substring(0, 200)}`);
    }

    if (lower.includes('http error 404') || lower.includes('not found') || lower.includes('unable to extract')) {
      return new ContentNotFoundError(`Instagram content not found: ${stderr.substring(0, 200)}`, 'instagram');
    }

    if (lower.includes('unsupported url')) {
      return new PermanentError(`Instagram unsupported URL: ${stderr.substring(0, 200)}`);
    }

    if (lower.includes('timeout') || lower.includes('timed out')) {
      return new TransientError(`Instagram timeout: ${stderr.substring(0, 200)}`);
    }

    // Datacenter block or generic geo-block on Instagram
    if (lower.includes('http error 403') || lower.includes('forbidden') || lower.includes('your ip address is blocked')) {
      return new DatacenterBlockedError(`Instagram 403 (likely datacenter block): ${stderr.substring(0, 200)}`, 'instagram');
    }

    return new TransientError(`Instagram yt-dlp unknown error: ${stderr.substring(0, 200)}`);
  }

  private pickMostSpecificError(cobaltErr: Error, ytdlpErr: Error): Error {
    if (ytdlpErr instanceof AccessBlockedError) return ytdlpErr;
    if (cobaltErr instanceof AccessBlockedError) return cobaltErr;
    if (ytdlpErr instanceof PermanentError) return ytdlpErr;
    if (cobaltErr instanceof PermanentError) return cobaltErr;
    return ytdlpErr;
  }
}
