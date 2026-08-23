import { ClassificationResult, CredentialAction } from './types';

export function classifyTikTok(msg: string, currentIdentityId?: string): ClassificationResult | null {
  
  if (msg.includes('captcha required') || msg.includes('verify you are human') || msg.includes("verify you're human") || msg.includes('unusual activity')) {
    return {
      errorType: 'identity_blocked' as any,
      credentialAction: CredentialAction.BLOCK,
      retryable: true,
      reason: 'TikTok Captcha / Anti-bot',
      confidence: 'EXACT'
    };
  }

  if (msg.includes('video currently unavailable') || msg.includes('video deleted')) {
    return {
      errorType: 'not_found' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: false,
      reason: 'TikTok Video Deleted / Unavailable',
      confidence: 'EXACT'
    };
  }

  // Fallback to generic
  return null;
}
