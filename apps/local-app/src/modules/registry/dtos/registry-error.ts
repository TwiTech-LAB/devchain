import { AppError } from '../../../common/errors/error-types';

/**
 * Error thrown by registry client operations
 */
export class RegistryError extends AppError {
  constructor(
    message: string,
    public readonly cause?: Error,
    details?: Record<string, unknown>,
  ) {
    super(message, 'registry_error', 502, details);
    if (cause) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

/**
 * Error thrown when registry is unavailable
 */
export class RegistryUnavailableError extends AppError {
  constructor(message = 'Template registry is currently unavailable') {
    super(message, 'registry_unavailable', 503);
  }
}

/**
 * Error thrown when checksum verification fails
 */
export class ChecksumMismatchError extends AppError {
  constructor(expected: string, received: string) {
    super('Template checksum verification failed', 'checksum_mismatch', 400, {
      expected,
      received,
    });
  }
}
