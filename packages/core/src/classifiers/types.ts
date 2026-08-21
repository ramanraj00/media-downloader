import { ErrorType } from '@media-downloader/types';

export enum CredentialAction {
  BLOCK = 'BLOCK',           // 403 Anti-bot -> Quarantined
  COOLDOWN = 'COOLDOWN',     // 429 Rate Limit or Unknown generic -> Backoff
  DISABLE = 'DISABLE',       // Invalid Auth -> Burned completely
  KEEP = 'KEEP'              // Infrastructure/Content error -> Do not burn credential
}

export type ConfidenceLevel = 'EXACT' | 'STRONG' | 'AMBIGUOUS';

export interface ClassificationResult {
  errorType: ErrorType;
  credentialAction: CredentialAction;
  retryable: boolean;
  retryAfterMs?: number;
  reason: string;
  confidence: ConfidenceLevel;
}
