import { Platform } from '@media-downloader/types';

const PLATFORM_PATTERNS = {
  [Platform.INSTAGRAM]: [
    /instagram\.com/i,
    /instagr\.am/i,
  ],
  [Platform.TWITTER]: [
    /twitter\.com/i,
    /x\.com/i,
    /t\.co/i,
    /fixupx\.com/i,
    /vxtwitter\.com/i,
    /fxtwitter\.com/i,
  ],
  [Platform.TIKTOK]: [
    /tiktok\.com/i,
    /vm\.tiktok\.com/i,
    /vt\.tiktok\.com/i,
  ],
  [Platform.REDDIT]: [
    /reddit\.com/i,
    /v\.redd\.it/i,
    /i\.redd\.it/i,
  ],
};

export function detectPlatform(url: string): Platform {
  for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
    if (patterns.some(pattern => pattern.test(url))) {
      return platform as Platform;
    }
  }
  return Platform.UNKNOWN;
}
