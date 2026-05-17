import type Database from 'better-sqlite3';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('TransactionRunner');

/**
 * WAL-safe transaction runner using BEGIN IMMEDIATE.
 *
 * Provides a single entry point for explicit multi-step transactions
 * on the raw better-sqlite3 client. Commits on success, rolls back on
 * failure, and logs (but does not mask) rollback errors.
 *
 * Usage:
 *   const runner = new TransactionRunner(rawClient);
 *   const result = runner.runImmediate(() => {
 *     // Drizzle or raw operations here
 *     return value;
 *   });
 */
export class TransactionRunner {
  constructor(private readonly rawClient: Database.Database) {}

  runImmediate<T>(fn: () => T): T {
    this.rawClient.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.rawClient.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollbackOrLog(error);
      throw error;
    }
  }

  async runImmediateAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.rawClient.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      this.rawClient.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollbackOrLog(error);
      throw error;
    }
  }

  private rollbackOrLog(originalError: unknown): void {
    try {
      this.rawClient.exec('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ rollbackError, originalError }, 'ROLLBACK failed after transaction error');
    }
  }
}
