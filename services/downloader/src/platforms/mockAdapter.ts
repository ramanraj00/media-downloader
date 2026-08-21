import { PlatformAdapter } from './adapter';
import { DownloadResult, Platform } from '@media-downloader/types';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export class MockAdapter extends PlatformAdapter {
  platform = 'mock' as Platform;

  constructor() {
    super();
  }

  canHandle(url: string): boolean {
    return url.startsWith('mock://');
  }

  async download(url: string, outputDir: string, creds?: string): Promise<DownloadResult> {
    const outputPath = path.join(outputDir, `mock_${crypto.randomUUID()}.mp4`);
    
    // Generate a valid 1-second blank MP4 video using ffmpeg so that Processor's ffprobe doesn't crash
    const { execSync } = require('child_process');
    execSync(`ffmpeg -y -f lavfi -i color=c=black:s=640x480:d=1 -c:v libx264 -preset ultrafast -f mp4 "${outputPath}" 2>/dev/null`);
    
    return {
      filePath: outputPath,
      info: {
        url,
        platform: 'mock' as any,
        ext: 'mp4'
      },
      sourceLayer: 'primary',
      downloadTimeMs: 100
    };
  }
}

