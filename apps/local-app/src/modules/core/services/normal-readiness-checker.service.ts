import { execFile } from 'child_process';
import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import type { HealthReadinessChecker } from './health.service';

@Injectable()
export class NormalReadinessCheckerService implements HealthReadinessChecker, OnModuleInit {
  private tmuxAvailablePromise?: Promise<boolean>;

  constructor(@Optional() @Inject('DB_CONNECTION') private readonly db?: BetterSQLite3Database) {}

  onModuleInit(): void {
    this.tmuxAvailablePromise = this.checkTmuxReady();
  }

  async getChecks(): Promise<Record<string, 'ok' | 'fail'>> {
    const [dbReady, tmuxReady] = await Promise.all([this.checkDbReady(), this.getTmuxReady()]);
    return {
      db: dbReady ? 'ok' : 'fail',
      tmux: tmuxReady ? 'ok' : 'fail',
    };
  }

  private async checkDbReady(): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    try {
      const sqlite = getRawSqliteClient(this.db);
      sqlite.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  private getTmuxReady(): Promise<boolean> {
    if (!this.tmuxAvailablePromise) {
      this.tmuxAvailablePromise = this.checkTmuxReady();
    }
    return this.tmuxAvailablePromise;
  }

  private checkTmuxReady(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile('tmux', ['-V'], (error) => {
        resolve(!error);
      });
    });
  }
}
