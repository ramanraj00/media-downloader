export enum ErrorType {
  PERMANENT = 'permanent',
  TRANSIENT = 'transient',
  RATE_LIMIT = 'rate_limit',
  AUTH_REQUIRED = 'auth_required',
  NOT_FOUND = 'not_found',
  PRIVATE = 'private',
  TOO_LARGE = 'too_large',
  UNSUPPORTED = 'unsupported',
}

export interface BaseError extends Error {
  type: ErrorType;
  isRetryable: boolean;
  platform?: string;
}
