import { ClassificationResult, CredentialAction } from './types';

export function classifyCobalt(msg: string): ClassificationResult | null {
  
  if (msg.includes('429') || msg.includes('too many requests') || msg.includes('rate limit')) {
    return {
      errorType: 'rate_limit' as any,
      credentialAction: CredentialAction.COOLDOWN,
      retryable: true,
      reason: 'Cobalt Rate Limit',
      confidence: 'EXACT'
    };
  }

  if (msg.includes('404') || msg.includes('not found')) {
    return {
      errorType: 'not_found' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: false,
      reason: 'Cobalt Content Not Found',
      confidence: 'EXACT'
    };
  }

  if (msg.includes('401') || msg.includes('authentication required')) {
    return {
      errorType: 'auth_invalid' as any,
      credentialAction: CredentialAction.KEEP, // Don't block our identities for Cobalt's auth issues
      retryable: true,
      reason: 'Cobalt Auth Error',
      confidence: 'EXACT'
    };
  }

  if (msg.includes('403') || msg.includes('forbidden')) {
    return {
      errorType: 'extractor' as any,
      credentialAction: CredentialAction.KEEP, 
      retryable: true,
      reason: 'Cobalt Provider Access Error',
      confidence: 'EXACT'
    };
  }

  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('timeout') || msg.includes('econnreset') || msg.includes('fetch failed')) {
    return {
      errorType: 'infrastructure' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: true,
      reason: 'Cobalt Infrastructure Error',
      confidence: 'EXACT'
    };
  }

  if (msg.includes('error:') || msg.includes('failed')) {
    return {
      errorType: 'extractor' as any,
      credentialAction: CredentialAction.KEEP,
      retryable: true,
      reason: 'Cobalt Processing Error',
      confidence: 'STRONG'
    };
  }

  return null;
}
