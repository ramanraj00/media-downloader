export enum ErrorType {
  PERMANENT = 'permanent',
  TRANSIENT = 'transient',
  RATE_LIMIT = 'rate_limit',
  AUTH_REQUIRED = 'auth_required',
  AUTH_INVALID = 'auth_invalid',
  NOT_FOUND = 'not_found',
  PRIVATE = 'private',
  GEO_BLOCKED = 'geo_blocked',
  AGE_RESTRICTED = 'age_restricted',
  TOO_LARGE = 'too_large',
  UNSUPPORTED = 'unsupported',
  IDENTITY_BLOCKED = 'identity_blocked',
  IDENTITIES_EXHAUSTED = 'identities_exhausted',
  CIRCUIT_OPEN = 'circuit_open',
  INFRASTRUCTURE = 'infrastructure',
  EXTRACTOR = 'extractor',
}

export interface BaseError extends Error {
  type: ErrorType;
  isRetryable: boolean;
  platform?: string;
  credentialAction?: string;
}
