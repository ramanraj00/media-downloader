import { Platform, DownloadResult } from '@media-downloader/types';

export abstract class PlatformAdapter {
  abstract platform: Platform;
  
  abstract canHandle(url: string): boolean;
  
  abstract download(url: string, outputDir: string): Promise<DownloadResult>;

  protected getBaseYtDlpOpts(outputDir: string): string[] {
    return [
      '--quiet',
      '--no-warnings',
      '--no-playlist',
      '-o', `${outputDir}/%(id)s.%(ext)s`,
      '--socket-timeout', '60',
      '--retries', '3',
      '--extractor-retries', '3',
      '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    ];
  }
}
