import { PlatformAdapter } from './adapter';
import { Platform, DownloadResult } from '@media-downloader/types';
import { TransientError, PermanentError } from '@media-downloader/core';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';

const execAsync = util.promisify(exec);

export class TwitterAdapter extends PlatformAdapter {
  platform = Platform.TWITTER;

  canHandle(url: string): boolean {
    const domains = ['twitter.com', 'x.com', 't.co', 'fixupx.com', 'vxtwitter.com', 'fxtwitter.com'];
    return domains.some(d => url.includes(d));
  }

  async download(url: string, outputDir: string, identityId?: string): Promise<DownloadResult> {
    const opts = this.getBaseYtDlpOpts(outputDir);
    
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
        sourceLayer: 'anonymous',
        downloadTimeMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.handleYtDlpError(error.stderr || error.message);
      throw error;
    }
  }
  
  private resolveFile(outputDir: string, id: string, ext: string): string {
    const files = fs.readdirSync(outputDir);
    const downloaded = files.find(f => !f.endsWith('.part') && !f.endsWith('.ytdl') && !f.endsWith('.json'));
    
    if (downloaded) return path.join(outputDir, downloaded);
    throw new PermanentError(`File not found in output directory ${outputDir}`);
  }

  private handleYtDlpError(stderr: string) {
    const msg = stderr.toLowerCase();
    
    if (msg.includes('404') || msg.includes('not found')) {
      throw new PermanentError('Content not found or deleted', undefined, this.platform);
    }
    
    throw new TransientError(`Download failed: ${stderr.substring(0, 100)}`, undefined, this.platform);
  }
}
