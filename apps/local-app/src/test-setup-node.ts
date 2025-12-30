/**
 * Lightweight test setup for backend (node environment) tests.
 * Does NOT import @testing-library/jest-dom to reduce memory overhead.
 */
import { Logger } from '@nestjs/common';

// Silence NestJS Logger output during tests to keep logs readable.
Logger.overrideLogger(false);

// Polyfill setImmediate for libraries (e.g., pino/thread-stream) in Jest environment
// eslint-disable-next-line @typescript-eslint/no-explicit-any
if (!(global as any).setImmediate) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).setImmediate = (fn: (...args: any[]) => void, ...args: any[]) =>
    setTimeout(fn, 0, ...args);
}
