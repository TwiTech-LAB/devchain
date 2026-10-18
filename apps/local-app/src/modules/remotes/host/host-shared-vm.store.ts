import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import { AppError, IOError } from '../../../common/errors/error-types';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import {
  readAbandonedProjects,
  writeAbandonedProjects,
} from '../../storage/local/helpers/host-abandoned-projects';
import { SharedVmNoticeSchema } from './shared-vm.contract';
import type { SharedVmInbox, SharedVmNotice } from './shared-vm.contract';

const NOTICES_KEY = 'host.noticeInbox';
const NoticesSchema = z.array(SharedVmNoticeSchema);

@Injectable()
export class HostSharedVmStore {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  connectedCount(): number {
    return this.occupancy().connectedCount;
  }

  async readOccupancy(): Promise<ReturnType<HostSharedVmStore['occupancy']>> {
    try {
      // WAL reads can miss an import admitted before the destroy fence. Taking
      // the write lock first waits for those transactions to commit or roll back.
      return await this.transactions.runImmediateQueued(() => this.occupancy());
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') {
        throw new AppError(
          'The VM occupancy snapshot is temporarily unavailable.',
          'VM_OCCUPANCY_UNAVAILABLE',
          503,
        );
      }
      throw error;
    }
  }

  occupancy(): { connectedCount: number; connectedProjectIds: string[] } {
    const abandoned = new Set(readAbandonedProjects(this.sqlite));
    const projects = this.sqlite
      .prepare('SELECT id FROM projects WHERE is_template = 0')
      .all() as Array<{ id: string }>;
    const connectedProjectIds = projects
      .filter(({ id }) => !abandoned.has(id))
      .map(({ id }) => id)
      .sort();
    return { connectedCount: connectedProjectIds.length, connectedProjectIds };
  }

  async abandon(projectId: string): Promise<void> {
    await this.transactions.runImmediateQueued(() => {
      writeAbandonedProjects(this.sqlite, [...readAbandonedProjects(this.sqlite), projectId]);
    });
  }

  notices(): SharedVmNotice[] {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(NOTICES_KEY) as
      | { value: string }
      | undefined;
    if (!row) return [];
    try {
      return NoticesSchema.parse(JSON.parse(row.value));
    } catch {
      throw new IOError('The host notice inbox is invalid.');
    }
  }

  async receive(notice: SharedVmInbox): Promise<SharedVmNotice> {
    return this.transactions.runImmediateQueued(() => {
      const stored = SharedVmNoticeSchema.parse({ ...notice, id: randomUUID() });
      this.writeNotices([...this.notices(), stored]);
      return stored;
    });
  }

  async dismiss(id: string): Promise<void> {
    await this.transactions.runImmediateQueued(() => {
      const notices = this.notices();
      const next = notices.filter((notice) => notice.id !== id);
      if (next.length !== notices.length) this.writeNotices(next);
    });
  }

  private writeNotices(notices: SharedVmNotice[]): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(NOTICES_KEY, JSON.stringify(notices), now, now);
  }
}
