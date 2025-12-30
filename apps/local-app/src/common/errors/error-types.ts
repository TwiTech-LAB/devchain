export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    super(
      `${resource}${identifier ? ` with identifier ${identifier}` : ''} not found`,
      'not_found',
      404,
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'validation_error', 400, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'conflict', 409, details);
  }
}

export class OptimisticLockError extends AppError {
  constructor(resource: string, identifier: string, details?: Record<string, unknown>) {
    super(
      `${resource} with identifier ${identifier} was modified by another operation. Please refresh and try again.`,
      'optimistic_lock_error',
      409,
      details,
    );
  }
}

export class StorageError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'storage_error', 500, details);
  }
}

export class IOError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'io_error', 500, details);
  }
}

export class BusyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'busy', 409, details);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'timeout', 408, details);
  }
}
