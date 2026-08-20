import { Platform } from '@media-downloader/types';
import { AppError, TransientError, PermanentError, RateLimitError, ContentNotFoundError, ContentPrivateError, IdentityBlockedError } from '../errors';

export function classifyPlatformError(stderrOrMsg: string, platform: string, currentIdentityId?: string): AppError {
  const msg = (stderrOrMsg || '').toLowerCase();

  // 1. Genuine 404 / Deleted Content Checks
  if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist') || msg.includes('deleted')) {
    return new ContentNotFoundError(`${platform}: Content not found or deleted`, platform);
  }

  // 2. Rate Limit Checks (429 / Too Many Requests)
  if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit') || msg.includes('ratelimit')) {
    // Extract Retry-After if present
    const match = msg.match(/retry-after:\s*(\d+)/i) || msg.match(/retry in (\d+)s/i);
    const retryAfterMs = match ? parseInt(match[1], 10) * 1000 : 5000;
    return new RateLimitError(`${platform}: Rate limited`, retryAfterMs, platform);
  }

  // 3. 403 Anti-bot / Challenge / Session Invalidation
  if (
    msg.includes('403') ||
    msg.includes('challenge_required') ||
    msg.includes('checkpoint_required') ||
    msg.includes('confirm you’re not a bot') ||
    msg.includes('confirm you\'re not a bot') ||
    msg.includes('login required') ||
    msg.includes('cookie expired') ||
    msg.includes('session expired') ||
    msg.includes('ip blocked')
  ) {
    if (currentIdentityId) {
      return new IdentityBlockedError(`${platform}: Identity ${currentIdentityId} received anti-bot challenge / 403`, currentIdentityId, platform);
    }
    return new IdentityBlockedError(`${platform}: Default anonymous identity received anti-bot challenge / 403`, 'anonymous', platform);
  }

  // 4. Genuine Private Content
  if (msg.includes('account is private') || msg.includes('this post is private')) {
    return new ContentPrivateError(`${platform}: Post is from a private account`, platform);
  }

  // 5. Default Fallback
  return new TransientError(`${platform}: Download attempt failed: ${stderrOrMsg.substring(0, 150)}`, undefined, platform);
}
