import { ClassificationResult, CredentialAction } from './types';

export function classifyInstagram(msg: string, currentIdentityId?: string): ClassificationResult | null {
  // Instagram specific rules that override or clarify generics
  
  if (msg.includes('challenge_required') || msg.includes('checkpoint_required')) {
    return {
      errorType: 'identity_blocked' as any,
      credentialAction: CredentialAction.BLOCK,
      retryable: true,
      reason: 'Instagram challenge_required / checkpoint_required',
      confidence: 'EXACT'
    };
  }

  if (msg.includes('feedback_required')) {
    return {
      errorType: 'rate_limit' as any, // Usually action block / spam limit
      credentialAction: CredentialAction.COOLDOWN, 
      retryable: true,
      reason: 'Instagram feedback_required (soft action block)',
      confidence: 'EXACT'
    };
  }

  // Fallback to generic
  return null;
}
