import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../common/logging/logger';
import { TransactionRunner } from '../../../storage/db/transaction-runner';
import {
  defaultGithubStarState,
  GithubStarStateSchema,
  type GithubStarState,
} from '../../../github-star/github-star.dto';

const logger = createLogger('GithubStarSettingsDelegate');

export const GITHUB_STAR_STATE_SETTING_KEY = 'githubStar.state';
export interface GithubStarDelegateContext {
  sqlite: Database.Database;
}

/**
 * Owns the raw `githubStar.state` settings row. The row is outside
 * `SettingsSchema` and `PUT /api/settings`, so a Settings page save cannot
 * overwrite it. A missing or invalid row reads as the default state.
 */
export class GithubStarSettingsDelegate {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(context: GithubStarDelegateContext) {
    this.sqlite = context.sqlite;
    this.transactions = new TransactionRunner(context.sqlite);
  }

  getGithubStarState(): GithubStarState {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(GITHUB_STAR_STATE_SETTING_KEY) as { value: string } | undefined;
    if (!row) return defaultGithubStarState();

    let raw: unknown;
    try {
      raw = JSON.parse(row.value);
    } catch (error) {
      logger.warn({ error }, 'Failed to parse githubStar.state setting');
      return defaultGithubStarState();
    }
    const parsed = GithubStarStateSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'Invalid githubStar.state setting');
      return defaultGithubStarState();
    }
    return parsed.data;
  }

  /**
   * Read-modify-write in one queued immediate transaction. `mutate` must be
   * synchronous; returning the same object skips the write. Resolves to the
   * state stored after the transaction.
   */
  async updateGithubStarState(
    mutate: (state: GithubStarState) => GithubStarState,
  ): Promise<GithubStarState> {
    return this.transactions.runImmediateQueued(() => {
      const current = this.getGithubStarState();
      const next = mutate(current);
      if (next === current) return current;
      const validated = GithubStarStateSchema.parse(next);
      this.writeRaw(JSON.stringify(validated));
      return validated;
    });
  }

  private writeRaw(value: string): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), GITHUB_STAR_STATE_SETTING_KEY, value, now, now);
  }
}
