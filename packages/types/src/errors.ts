export enum ErrorType {
  PERMANENT = 'permanent',
  TRANSIENT = 'transient',
  RATE_LIMIT = 'rate_limit',
  AUTH_REQUIRED = 'auth_required',
  NOT_FOUND = 'not_found',
  PRIVATE = 'private',
  TOO_LARGE = 'too_large',
  UNSUPPORTED = 'unsupported',
  IDENTITY_BLOCKED = 'identity_blocked',
  IDENTITIES_EXHAUSTED = 'identities_exhausted',
  CIRCUIT_OPEN = 'circuit_open',
}

export interface BaseError extends Error {
  type: ErrorType;
  isRetryable: boolean;
  platform?: string;
}
