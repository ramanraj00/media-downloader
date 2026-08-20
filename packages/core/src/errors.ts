import { ErrorType, BaseError } from '@media-downloader/types';

export class AppError extends Error implements BaseError {
  public type: ErrorType;
  public isRetryable: boolean;
  public platform?: string;

  constructor(message: string, type: ErrorType, isRetryable: boolean, platform?: string) {
    super(message);
    this.name = this.constructor.name;
    this.type = type;
    this.isRetryable = isRetryable;
    this.platform = platform;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class PermanentError extends AppError {
  constructor(message: string, type: ErrorType = ErrorType.PERMANENT, platform?: string) {
    super(message, type, false, platform);
  }
}

export class TransientError extends AppError {
  constructor(message: string, type: ErrorType = ErrorType.TRANSIENT, platform?: string) {
    super(message, type, true, platform);
  }
}

export class RateLimitError extends TransientError {
  public retryAfterMs: number;

  constructor(message: string, retryAfterMs: number = 60000, platform?: string) {
    super(message, ErrorType.RATE_LIMIT, platform);
    this.retryAfterMs = retryAfterMs;
  }
}

export class AuthRequiredError extends PermanentError {
  constructor(message: string, platform?: string) {
    super(message, ErrorType.AUTH_REQUIRED, platform);
  }
}

export class ContentNotFoundError extends PermanentError {
  constructor(message: string, platform?: string) {
    super(message, ErrorType.NOT_FOUND, platform);
  }
}

export class ContentPrivateError extends PermanentError {
  constructor(message: string, platform?: string) {
    super(message, ErrorType.PRIVATE, platform);
  }
}

export class FileTooLargeError extends PermanentError {
  constructor(message: string = 'File exceeds maximum allowed size') {
    super(message, ErrorType.TOO_LARGE);
  }
}

export class UnsupportedURLError extends PermanentError {
  constructor(message: string = 'URL is not supported') {
    super(message, ErrorType.UNSUPPORTED);
  }
}
