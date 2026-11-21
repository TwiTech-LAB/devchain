import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { resolve } from 'node:path';
import { AppError, NotFoundError } from '../../../common/errors/error-types';
import { inside } from '../../../common/filesystem/vm-home-path';
import { createLogger } from '../../../common/logging/logger';
import { shareId } from '../../file-sync/share-paths';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import type { SharedFolderEntriesPort } from '../ports/shared-folder-entries.port';
import {
  SHARED_FOLDER_OVERLAP,
  SharedFolderEntrySchema,
  type SharedFolderEntry,
} from './shared-folders.dto';

const logger = createLogger('SharedFoldersStore');
/** This PC's user folders shared with VMs; never sent to a VM. */
const SETTINGS_KEY = 'remotes.sharedFolders';

@Injectable()
export class SharedFoldersStore implements SharedFolderEntriesPort {
  private readonly sqlite: Database.Database;
  private readonly transactions: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.transactions = new TransactionRunner(this.sqlite);
  }

  list(remoteId?: string): SharedFolderEntry[] {
    return Object.values(this.readMap())
      .filter((entry) => remoteId === undefined || entry.remoteId === remoteId)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  get(remoteId: string, id: string): SharedFolderEntry {
    const entry = this.readMap()[id];
    if (!entry || entry.remoteId !== remoteId) throw new NotFoundError('Shared folder', id);
    return entry;
  }

  sharedPaths(): string[] {
    return Object.values(this.readMap()).map((entry) => entry.path);
  }

  /**
   * Adds the share of `path`, which the caller already resolved. Refuses a path that is, holds
   * or sits inside a share of any VM; the check and the write are one transaction.
   */
  add(remoteId: string, path: string, ignores: string[]): SharedFolderEntry {
    const absolute = resolve(path);
    return this.transactions.runImmediate(() => {
      const map = this.readMap();
      const other = Object.values(map).find(
        (entry) => inside(absolute, entry.path) || inside(entry.path, absolute),
      );
      if (other)
        throw new AppError(
          other.path === absolute
            ? `${absolute} is already shared${other.remoteId === remoteId ? ' with this VM' : ' with another VM'}.`
            : `Cannot share ${absolute}: it overlaps the shared folder ${other.path}.`,
          SHARED_FOLDER_OVERLAP,
          409,
          { path: other.path, remoteId: other.remoteId },
        );
      const entry = SharedFolderEntrySchema.parse({
        id: shareId(absolute),
        remoteId,
        path: absolute,
        ignores,
        patternsApplied: true,
        createdAt: new Date().toISOString(),
      });
      map[entry.id] = entry;
      this.write(map);
      return entry;
    });
  }

  update(
    remoteId: string,
    id: string,
    patch: Partial<Pick<SharedFolderEntry, 'ignores' | 'patternsApplied'>>,
  ): SharedFolderEntry {
    return this.transactions.runImmediate(() => {
      const map = this.readMap();
      const current = map[id];
      if (!current || current.remoteId !== remoteId) throw new NotFoundError('Shared folder', id);
      const entry = SharedFolderEntrySchema.parse({ ...current, ...patch });
      map[id] = entry;
      this.write(map);
      return entry;
    });
  }

  remove(remoteId: string, path: string): void {
    this.removeWhere((entry) => entry.remoteId === remoteId && entry.path === resolve(path));
  }

  removeById(remoteId: string, id: string): void {
    this.removeWhere((entry) => entry.remoteId === remoteId && entry.id === id);
  }

  /** Removes every entry of the VM and returns them. */
  removeForRemote(remoteId: string): SharedFolderEntry[] {
    return this.removeWhere((entry) => entry.remoteId === remoteId);
  }

  private removeWhere(match: (entry: SharedFolderEntry) => boolean): SharedFolderEntry[] {
    return this.transactions.runImmediate(() => {
      const map = this.readMap();
      const removed = Object.values(map).filter(match);
      if (removed.length)
        this.write(Object.fromEntries(Object.entries(map).filter(([, entry]) => !match(entry))));
      return removed;
    });
  }

  private write(map: Record<string, SharedFolderEntry>): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(map), now, now);
  }

  private readMap(): Record<string, SharedFolderEntry> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return {};
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const map: Record<string, SharedFolderEntry> = {};
      for (const value of Object.values(parsed)) {
        const entry = SharedFolderEntrySchema.safeParse(value);
        if (entry.success) map[entry.data.id] = entry.data;
      }
      return map;
    } catch {
      logger.warn('Stored shared folders are invalid; using an empty list');
      return {};
    }
  }
}
