import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { AppError } from '../../../common/errors/error-types';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';

const SETTINGS_KEY = 'host.dockerVolumeAssociations';
const RecordSchema = z
  .object({
    projectId: z.string().min(1),
    volume: z.string().min(1),
    composeProject: z.string().min(1),
    recordedAt: z.string().datetime(),
  })
  .strict();
type Association = z.infer<typeof RecordSchema>;

/**
 * VM-verified associations survive removal of the live Compose holder. They are VM-local Docker
 * bookkeeping, not project data, so they bypass the project write gate: Connect records them
 * while the host replica is frozen (push_replica precedes docker_push).
 */
@Injectable()
export class HostDockerVolumeAssociationsStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  matches(projectId: string, volume: string, composeProject: string): boolean {
    return this.read().some(
      (record) =>
        record.projectId === projectId &&
        record.volume === volume &&
        record.composeProject === composeProject,
    );
  }

  async record(
    projectId: string,
    volumes: Array<{ volume: string; composeProject: string }>,
  ): Promise<void> {
    if (!volumes.length) return;
    await this.transactions.runImmediateQueued(() => {
      const records = this.read().filter(
        (record) => !volumes.some((v) => v.volume === record.volume),
      );
      const recordedAt = new Date().toISOString();
      this.write([
        ...records,
        ...volumes.map((volume) => RecordSchema.parse({ projectId, ...volume, recordedAt })),
      ]);
    });
  }

  async delete(volume: string): Promise<void> {
    await this.transactions.runImmediateQueued(() => {
      const records = this.read();
      const kept = records.filter((record) => record.volume !== volume);
      if (kept.length !== records.length) this.write(kept);
    });
  }

  private read(): Association[] {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return [];
    try {
      return z.array(RecordSchema).parse(JSON.parse(row.value));
    } catch {
      throw new AppError(
        'Stored Docker volume associations are invalid',
        'DOCKER_VOLUME_ASSOCIATIONS_INVALID',
        500,
      );
    }
  }

  private write(records: Association[]): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(records), now, now);
  }
}
