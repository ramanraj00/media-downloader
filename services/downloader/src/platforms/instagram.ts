import { PlatformAdapter } from './adapter';
import { Platform, DownloadResult } from '@media-downloader/types';
import { TransientError, RateLimitError, PermanentError } from '@media-downloader/core';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = util.promisify(exec);

export class InstagramAdapter extends PlatformAdapter {
  platform = Platform.INSTAGRAM;

  canHandle(url: string): boolean {
    return url.includes('instagram.com') || url.includes('instagr.am');
  }

  async download(url: string, outputDir: string): Promise<DownloadResult> {
    const opts = this.getBaseYtDlpOpts(outputDir);
    opts.push('--sleep-interval', '2', '--max-sleep-interval', '5');

    // Add cookie file if exists
    const cookiePath = path.join(process.cwd(), 'cookies', 'instagram.txt');
    if (fs.existsSync(cookiePath)) {
      opts.push('--cookies', cookiePath);
    }

    const command = `yt-dlp ${opts.join(' ')} --dump-json "${url}"`;
    
    try {
      const startTime = Date.now();
      const { stdout } = await execAsync(command);
      
      const info = JSON.parse(stdout);
      
      const actualPath = this.resolveFile(outputDir, info.id, info.ext);
      
      return {
        filePath: actualPath,
        info: {
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
        },
        sourceLayer: fs.existsSync(cookiePath) ? 'cookies' : 'anonymous',
        downloadTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.handleYtDlpError(error.stderr || error.message);
      throw error;
    }
  }
  
  private resolveFile(outputDir: string, id: string, ext: string): string {
    const expected = path.join(outputDir, `${id}.${ext}`);
    if (fs.existsSync(expected)) return expected;
    
    const files = fs.readdirSync(outputDir);
    const downloaded = files.find(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));
    
    if (downloaded) return path.join(outputDir, downloaded);
    throw new PermanentError(`File not found in output directory ${outputDir}`);
  }

  private handleYtDlpError(stderr: string) {
    const msg = stderr.toLowerCase();
    
    if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) {
      throw new RateLimitError('Instagram: Rate limited', 60000, this.platform);
    }
    
    if (msg.includes('404') || msg.includes('not found')) {
      throw new PermanentError('Content not found or deleted', undefined, this.platform);
    }
    
    if (msg.includes('login required') || msg.includes('private')) {
      throw new PermanentError('Content is private or requires login', undefined, this.platform);
    }
    
    throw new TransientError(`Download failed: ${stderr.substring(0, 100)}`, undefined, this.platform);
  }
}
