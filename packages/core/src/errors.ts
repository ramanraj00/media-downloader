import { ErrorType, BaseError } from '@media-downloader/types';

export class AppError extends Error implements BaseError {
  public type: ErrorType;
  public isRetryable: boolean;
  public platform?: string;
  public credentialAction?: string;

  constructor(message: string, type: ErrorType, isRetryable: boolean, platform?: string, credentialAction?: string) {
    super(message);
    this.name = this.constructor.name;
    this.type = type;
    this.isRetryable = isRetryable;
    this.platform = platform;
    this.credentialAction = credentialAction;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ─── Permanent Errors (terminal, no recovery possible) ───────────────────────

export class PermanentError extends AppError {
  constructor(message: string, type: ErrorType = ErrorType.PERMANENT, platform?: string, credentialAction: string = 'KEEP') {
    super(message, type, false, platform, credentialAction);
  }
}

export class ContentNotFoundError extends PermanentError {
  constructor(message: string, platform?: string, credentialAction: string = 'KEEP') {
    super(message, ErrorType.NOT_FOUND, platform, credentialAction);
  }
}

export class ContentPrivateError extends PermanentError {
  constructor(message: string, platform?: string, credentialAction: string = 'KEEP') {
    super(message, ErrorType.PRIVATE, platform, credentialAction);
  }
}

export class FileTooLargeError extends PermanentError {
  constructor(message: string = 'File exceeds maximum allowed size') {
    super(message, ErrorType.TOO_LARGE, undefined, 'KEEP');
  }
}

export class UnsupportedURLError extends PermanentError {
  constructor(message: string = 'URL is not supported') {
    super(message, ErrorType.UNSUPPORTED, undefined, 'KEEP');
  }
}

export class AuthInvalidError extends PermanentError {
  constructor(message: string, platform?: string, credentialAction: string = 'DISABLE') {
    super(message, ErrorType.AUTH_INVALID, platform, credentialAction);
  }
}

// ─── Access Blocked Errors (not permanent — recoverable via alternate egress/auth) ──

/**
 * Base class for errors where the content exists but the current access method
 * is insufficient (geo-restriction, datacenter IP block, authentication required).
 * These are NOT permanent — they signal that the engine should try alternate tiers.
 */
export class AccessBlockedError extends AppError {
  constructor(message: string, type: ErrorType, platform?: string, credentialAction: string = 'KEEP') {
    // isRetryable = false here because these are not BullMQ-level retries;
    // they are tier-level transitions handled by the extraction router.
    super(message, type, false, platform, credentialAction);
  }
}

export class GeoBlockedError extends AccessBlockedError {
  constructor(message: string, platform?: string) {
    super(message, ErrorType.GEO_BLOCKED, platform, 'KEEP');
  }
}

export class DatacenterBlockedError extends AccessBlockedError {
  constructor(message: string, platform?: string) {
    super(message, ErrorType.DATACENTER_BLOCKED, platform, 'KEEP');
  }
}

export class AuthRequiredError extends AccessBlockedError {
  constructor(message: string, platform?: string) {
    super(message, ErrorType.AUTH_REQUIRED, platform, 'KEEP');
  }
}

export class AgeRestrictedError extends AccessBlockedError {
  constructor(message: string, platform?: string) {
    super(message, ErrorType.AGE_RESTRICTED, platform, 'KEEP');
  }
}

// ─── Retryable Errors (BullMQ backoff/retry) ─────────────────────────────────

export class TransientError extends AppError {
  constructor(message: string, type: ErrorType = ErrorType.TRANSIENT, platform?: string, credentialAction: string = 'COOLDOWN') {
    super(message, type, true, platform, credentialAction);
  }
}

export class RateLimitError extends TransientError {
  public retryAfterMs: number;

  constructor(message: string, retryAfterMs: number = 60000, platform?: string, credentialAction: string = 'COOLDOWN') {
    super(message, ErrorType.RATE_LIMIT, platform, credentialAction);
    this.retryAfterMs = retryAfterMs;
  }
}

export class InfrastructureError extends TransientError {
  constructor(message: string, platform?: string, credentialAction: string = 'KEEP') {
    super(message, ErrorType.INFRASTRUCTURE, platform, credentialAction);
  }
}

export class ExtractorError extends TransientError {
  constructor(message: string, platform?: string, credentialAction: string = 'KEEP') {
    super(message, ErrorType.EXTRACTOR, platform, credentialAction);
  }
}

export class IdentityBlockedError extends TransientError {
  public identityId: string;
  constructor(message: string, identityId: string, platform?: string, credentialAction: string = 'BLOCK') {
    super(message, ErrorType.IDENTITY_BLOCKED, platform, credentialAction);
    this.identityId = identityId;
  }
}

export class IdentitiesExhaustedError extends TransientError {
  constructor(message: string = 'All platform identities are currently exhausted', platform?: string) {
    super(message, ErrorType.IDENTITIES_EXHAUSTED, platform, 'KEEP');
  }
}

export class CircuitBreakerOpenError extends TransientError {
  constructor(message: string, platform?: string) {
    super(message, ErrorType.CIRCUIT_OPEN, platform, 'KEEP');
  }
}
