import { Platform } from '@media-downloader/types';
import { AppError, TransientError, ExtractorError, InfrastructureError, RateLimitError, AuthInvalidError, ContentNotFoundError, ContentPrivateError, GeoBlockedError, AgeRestrictedError, IdentityBlockedError } from '../errors';
import { ClassificationResult, CredentialAction, ConfidenceLevel } from './types';
import { classifyInstagram } from './instagram';
import { classifyTikTok } from './tiktok';
import { classifyYouTube } from './youtube';
import { classifyCobalt } from './cobalt';

export function classifyPlatformError(
  stderrOrMsg: string, 
  platform: string, 
  currentIdentityId?: string
): ClassificationResult {
  const msg = (stderrOrMsg || '').toLowerCase();

  // Route to platform-specific classifiers if applicable
  if (platform === Platform.INSTAGRAM) {
    const igResult = classifyInstagram(msg, currentIdentityId);
    if (igResult) return igResult;
  } else if (platform === Platform.TIKTOK) {
    const ttResult = classifyTikTok(msg, currentIdentityId);
    if (ttResult) return ttResult;
  } else if (platform === Platform.YOUTUBE) {
    const ytResult = classifyYouTube(msg, currentIdentityId);
    if (ytResult) return ytResult;
  } else if (platform === 'cobalt') {
    const cbResult = classifyCobalt(msg);
    if (cbResult) return cbResult;
  }

  // Generic Deterministic Ordering

  // 1. Explicit Permanent Content Signals
  if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist') || msg.includes('deleted') || msg.includes('removed by the user') || msg.includes('video unavailable')) {
    return {
      errorType: 'not_found' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: false,
      reason: 'Explicit 404 / content not found',
      confidence: 'STRONG'
    };
  }

  // 2. Explicit Geo/Age/Private Signals
  if (msg.includes('not available in your country') || msg.includes('geo-blocked')) {
    return {
      errorType: 'geo_blocked' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: false,
      reason: 'Explicit Geo-block',
      confidence: 'STRONG'
    };
  }
  if (msg.includes('sign in to confirm your age') || msg.includes('age restricted')) {
    return {
      errorType: 'age_restricted' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: false,
      reason: 'Explicit Age Restriction',
      confidence: 'STRONG'
    };
  }
  if (msg.includes('account is private') || msg.includes('this post is private')) {
    return {
      errorType: 'private' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: false,
      reason: 'Explicit Private Content',
      confidence: 'STRONG'
    };
  }

  // 3. Authentication-Invalid Signals
  if (msg.includes('invalid username/password') || msg.includes('invalid credentials') || msg.includes('session expired') || msg.includes('cookies are no longer valid') || msg.includes('login failed')) {
    return {
      errorType: 'auth_invalid' as any,
      credentialAction: CredentialAction.DISABLE,
      retryable: true,
      reason: 'Explicit Invalid Authentication',
      confidence: 'STRONG'
    };
  }

  // 4. Explicit Anti-Bot / Identity Signals
  if (msg.includes('challenge_required') || msg.includes('checkpoint_required') || msg.includes('captcha required') || msg.includes('verify you are human') || msg.includes("verify you're human") || msg.includes('unusual activity') || msg.includes('suspicious login') || msg.includes("confirm you're not a bot") || msg.includes('confirm you are not a bot')) {
    return {
      errorType: 'identity_blocked' as any,
      credentialAction: CredentialAction.BLOCK,
      retryable: true,
      reason: 'Explicit Anti-bot challenge',
      confidence: 'EXACT'
    };
  }

  // 5. Rate-Limit Signals
  if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit') || msg.includes('ratelimit') || msg.includes('temporarily rate limited')) {
    const match = msg.match(/retry-after:\s*(\d+)/i) || msg.match(/retry in (\d+)s/i);
    const retryAfterMs = match ? parseInt(match[1], 10) * 1000 : 5000;
    return {
      errorType: 'rate_limit' as any,
      credentialAction: CredentialAction.COOLDOWN,
      retryable: true,
      retryAfterMs,
      reason: 'Explicit Rate Limit',
      confidence: 'STRONG'
    };
  }

  // 6. Generic 403 / Access Denied
  if (msg.includes('403') || msg.includes('access denied') || msg.includes('forbidden') || msg.includes('login required')) {
    // If we have a credential context, we MIGHT consider it blocked if it happens frequently, but per rule: DO NOT explicitly block on ambiguous 403.
    // Instead we map to Transient, and cooldown the credential safely to avoid burning it.
    return {
      errorType: 'transient' as any,
      credentialAction: CredentialAction.COOLDOWN, // Safe fallback, don't block
      retryable: true,
      reason: 'Ambiguous 403 or Access Denied',
      confidence: 'AMBIGUOUS'
    };
  }

  // 7. Infrastructure / Network Signals
  if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('econnrefused') || msg.includes('socket hang up') || msg.includes('network is unreachable') || msg.includes('fetch failed') || msg.includes('connection reset by peer') || msg.includes('tls handshake timeout') || msg.includes('dns resolution failed') || msg.includes('http 500') || msg.includes('http 502') || msg.includes('http 503') || msg.includes('http 504') || msg.includes('http error 500') || msg.includes('http error 503')) {
    return {
      errorType: 'infrastructure' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: true,
      reason: 'Infrastructure / Network Error',
      confidence: 'EXACT'
    };
  }

  // 8. Extractor Error (yt-dlp specific breaking)
  if (msg.includes('extractorerror') || msg.includes('unable to extract') || msg.includes('unsupported url') || msg.includes('malformed')) {
    return {
      errorType: 'extractor' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: true, // Maybe yt-dlp update will fix it, or we try fallback
      reason: 'Extractor / Parser error',
      confidence: 'STRONG'
    };
  }

  // 9. UNKNOWN generic
  return {
    errorType: 'transient' as any,
    credentialAction: CredentialAction.COOLDOWN, // Safe fallback for unknown errors tied to a credential
    retryable: true,
    reason: 'Unknown error',
    confidence: 'AMBIGUOUS'
  };
}

export function buildAppError(result: ClassificationResult, platform: string, currentIdentityId?: string): AppError {
  const message = `${platform}: ${result.reason} (Action: ${result.credentialAction})`;
  switch (result.errorType) {
    case 'not_found': return new ContentNotFoundError(message, platform);
    case 'private': return new ContentPrivateError(message, platform);
    case 'geo_blocked': return new GeoBlockedError(message, platform);
    case 'age_restricted': return new AgeRestrictedError(message, platform);
    case 'auth_invalid': return new AuthInvalidError(message, platform);
    case 'identity_blocked': return new IdentityBlockedError(message, currentIdentityId || 'anonymous', platform);
    case 'rate_limit': return new RateLimitError(message, result.retryAfterMs, platform);
    case 'infrastructure': return new InfrastructureError(message, platform);
    case 'extractor': return new ExtractorError(message, platform);
    default: return new TransientError(message, undefined, platform);
  }
}
