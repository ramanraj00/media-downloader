import crypto from 'crypto';
import { Platform } from '@media-downloader/types';
import { detectPlatform } from './platform';

export function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

export function normalizeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    
    // Remove common tracking parameters
    const trackingParams = ['igshid', 'igsh', 'utm_source', 'utm_medium', 'utm_campaign', 's', 't'];
    trackingParams.forEach(param => url.searchParams.delete(param));
    
    // Normalize domains
    let hostname = url.hostname.replace(/^www\./, '');
    
    if (['x.com', 'fixupx.com', 'vxtwitter.com', 'fxtwitter.com'].includes(hostname)) {
      hostname = 'twitter.com';
    } else if (['old.reddit.com', 'new.reddit.com'].includes(hostname)) {
      hostname = 'reddit.com';
    } else if (hostname === 'vm.tiktok.com' || hostname === 'vt.tiktok.com') {
      // These are shortlinks, we can't fully normalize without resolving, but we can standardise the domain
      hostname = 'tiktok.com';
    } else if (hostname === 'instagr.am') {
      hostname = 'instagram.com';
    }

    url.hostname = hostname;
    
    // Remove trailing slashes from path
    url.pathname = url.pathname.replace(/\/$/, '');
    
    return url.toString();
  } catch (e) {
    return urlStr; // Return as is if parsing fails
  }
}

export function hashUrl(normalizedUrl: string): string {
  return crypto.createHash('sha256').update(normalizedUrl).digest('hex').substring(0, 16);
}

export function isSupportedUrl(url: string): boolean {
  return detectPlatform(url) !== Platform.UNKNOWN;
}
