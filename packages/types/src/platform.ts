export enum Platform {
  INSTAGRAM = 'instagram',
  TWITTER = 'twitter',
  TIKTOK = 'tiktok',
  REDDIT = 'reddit',
  UNKNOWN = 'unknown',
}

export interface PlatformAdapter {
  platform: Platform;
  canHandle(url: URL): boolean;
  extract(url: URL): Promise<any>;
  download(metadata: any, outputDir: string): Promise<any>;
}
