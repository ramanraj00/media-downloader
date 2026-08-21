import { ClassificationResult, CredentialAction } from './types';

export function classifyYouTube(msg: string, currentIdentityId?: string): ClassificationResult | null {
  
  if (msg.includes('sign in to confirm your age') || msg.includes('age restricted')) {
    return {
      errorType: 'age_restricted' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: false,
      reason: 'YouTube Age Restriction',
      confidence: 'EXACT'
    };
  }

  if (msg.includes('uploader has not made this video available in your country') || msg.includes('not available in your country')) {
    return {
      errorType: 'geo_blocked' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: false,
      reason: 'YouTube Geo Block',
      confidence: 'EXACT'
    };
  }

  // Fallback to generic
  return null;
}
