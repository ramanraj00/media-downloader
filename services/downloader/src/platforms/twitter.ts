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
const logger = createLogger('TwitterAdapter');

/**
 * Platform capability flags for the extraction router.
 */
export const TWITTER_CAPABILITIES = {
  supportsAuthenticatedExtraction: true,  // Twitter supports cookie-based auth in yt-dlp
  supportsEgressFallback: true,           // Support proxies
};

export class TwitterAdapter extends PlatformAdapter {
  platform = Platform.TWITTER;

  canHandle(url: string): boolean {
    const domains = ['twitter.com', 'x.com', 't.co', 'fixupx.com', 'vxtwitter.com', 'fxtwitter.com'];
    return domains.some(d => url.includes(d));
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

    // Tier 3: Fall back to vxTwitter API (Great for images that yt-dlp misses)
    try {
      return await this.tryVxTwitter(url, outputDir);
    } catch (err: any) {
      logger.warn({ url, errorType: err.constructor.name }, 'vxTwitter extraction also failed');
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

  private classifyYtDlpError(stderr: string, url: string): Error {
    const lower = stderr.toLowerCase();

    // Rate limiting
    if (lower.includes('http error 429') || lower.includes('too many requests')) {
      return new TransientError(`Twitter rate limited: ${stderr.substring(0, 200)}`);
    }

    // Content not found
    if (lower.includes('http error 404') || lower.includes('not found') || lower.includes('unable to extract')) {
      return new ContentNotFoundError(`Twitter content not found: ${stderr.substring(0, 200)}`, 'twitter');
    }

    // Auth required - age restricted or private tweet
    if (lower.includes('account authentication is required') || lower.includes('cookies') || lower.includes('age restricted')) {
      return new AuthRequiredError(`Twitter auth required: ${stderr.substring(0, 200)}`, 'twitter');
    }

    if (lower.includes('unsupported url')) {
      return new PermanentError(`Twitter unsupported URL: ${stderr.substring(0, 200)}`);
    }

    if (lower.includes('timeout') || lower.includes('timed out')) {
      return new TransientError(`Twitter timeout: ${stderr.substring(0, 200)}`);
    }

    if (lower.includes('http error 403') || lower.includes('forbidden') || lower.includes('your ip address is blocked')) {
      return new DatacenterBlockedError(`Twitter 403 (likely datacenter block): ${stderr.substring(0, 200)}`, 'twitter');
    }

    return new TransientError(`Twitter yt-dlp unknown error: ${stderr.substring(0, 200)}`);
  }

  private async tryVxTwitter(url: string, outputDir: string): Promise<import("@media-downloader/types").ExtractionResult> {
    logger.info({ url }, 'Tier 3: Attempting vxTwitter extraction (Image fallback)');
    
    // Convert url to api.vxtwitter.com
    let vxUrl = url.replace('twitter.com', 'vxtwitter.com').replace('x.com', 'vxtwitter.com');
    // Ensure we are calling the API
    const match = vxUrl.match(/vxtwitter\.com\/(.*?)\/status\/(\d+)/);
    if (!match) throw new PermanentError('Invalid Twitter URL for vxTwitter');
    const apiUrl = `https://api.vxtwitter.com/${match[1]}/status/${match[2]}`;

    const res = await fetch(apiUrl);
    if (!res.ok) throw new PermanentError(`vxTwitter API returned ${res.status}`);
    const data = await res.json();
    
    if (!data.hasMedia || !data.media_extended || data.media_extended.length === 0) {
       throw new ContentNotFoundError('No media found in vxTwitter response', 'twitter');
    }

    // Prefer video if available, else first image
    const media = data.media_extended.find((m: any) => m.type === 'video') || data.media_extended[0];
    const mediaUrl = media.url;
    
    // Download the media
    const ext = mediaUrl.split('.').pop()?.split('?')[0] || 'jpg';
    const filePath = path.join(outputDir, `vxtwitter_${match[2]}.${ext}`);
    
    const mediaRes = await fetch(mediaUrl);
    if (!mediaRes.ok) throw new PermanentError(`Failed to download media from ${mediaUrl}`);
    
    const buffer = await mediaRes.arrayBuffer();
    fs.writeFileSync(filePath, Buffer.from(buffer));
    
    return {
      status: 'success',
      source: 'other',
      filePath,
      metadata: {
        url,
        platform: this.platform,
        title: data.text,
        fileSize: buffer.byteLength,
        ext,
        hasVideo: media.type === 'video',
        hasAudio: media.type === 'video',
      }
    };
  }

  private pickMostSpecificError(cobaltErr: Error, ytdlpErr: Error): Error {
    if (ytdlpErr instanceof AccessBlockedError) return ytdlpErr;
    if (cobaltErr instanceof AccessBlockedError) return cobaltErr;
    if (ytdlpErr instanceof PermanentError) return ytdlpErr;
    if (cobaltErr instanceof PermanentError) return cobaltErr;
    return ytdlpErr;
  }
}
