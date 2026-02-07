import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type Database from 'better-sqlite3';
import { createLogger } from '../../../common/logging/logger';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { WatchersService } from '../../watchers/services/watchers.service';
import { seedCompactOnIdleWatcherSeeder } from '../seeders/0001_seed_compact_on_idle_watcher';

export const DATA_SEEDERS = 'DATA_SEEDERS';
const JOURNAL_KEY = 'seeders.journal';

export interface SeederContext {
  storage: StorageService;
  watchersService: WatchersService;
  db: BetterSQLite3Database;
  logger: ReturnType<typeof createLogger>;
}

export interface DataSeeder {
  name: string;
  version: number;
  run: (ctx: SeederContext) => Promise<void>;
}

export const REGISTERED_DATA_SEEDERS: DataSeeder[] = [seedCompactOnIdleWatcherSeeder];

interface SeederJournalEntry {
  version: number;
  executedAt: string;
}

type SeederJournal = Record<string, SeederJournalEntry>;

function isSeederJournalEntry(value: unknown): value is SeederJournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.version === 'number' && typeof record.executedAt === 'string';
}

function isSeederJournal(value: unknown): value is SeederJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  for (const entry of Object.values(value)) {
    if (!isSeederJournalEntry(entry)) {
      return false;
    }
  }

  return true;
}

@Injectable()
export class DataSeederService implements OnModuleInit {
  private readonly logger = createLogger('DataSeederService');
  private readonly sqlite: Database.Database;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly watchersService: WatchersService,
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    @Inject(DATA_SEEDERS) private readonly seeders: DataSeeder[],
  ) {
    this.sqlite = getRawSqliteClient(this.db);
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.runPendingSeeders();
    } catch (error) {
      this.logger.error({ error }, 'Failed to initialize DataSeederService');
    }
  }

  private async runPendingSeeders(): Promise<void> {
    if (this.seeders.length === 0) {
      this.logger.debug('No registered seeders; skipping startup seeding');
      return;
    }

    const journal = this.loadJournal();

    for (const seeder of this.seeders) {
      const previous = journal[seeder.name];
      if (previous && previous.version === seeder.version) {
        this.logger.debug(
          { seederName: seeder.name, seederVersion: seeder.version },
          'Seeder already executed for this version; skipping',
        );
        continue;
      }

      const seederLogger = this.logger.child({
        seederName: seeder.name,
        seederVersion: seeder.version,
      });

      try {
        await seeder.run({
          storage: this.storage,
          watchersService: this.watchersService,
          db: this.db,
          logger: seederLogger,
        });

        journal[seeder.name] = {
          version: seeder.version,
          executedAt: new Date().toISOString(),
        };
        this.persistJournal(journal);

        this.logger.info(
          { seederName: seeder.name, seederVersion: seeder.version },
          'Seeder executed successfully',
        );
      } catch (error) {
        this.logger.error(
          { error, seederName: seeder.name, seederVersion: seeder.version },
          'Seeder execution failed; will retry on next startup',
        );
      }
    }
  }

  private loadJournal(): SeederJournal {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(JOURNAL_KEY) as
      | { value?: unknown }
      | undefined;

    if (!row || row.value === undefined || row.value === null) {
      return {};
    }

    try {
      const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      if (isSeederJournal(parsed)) {
        return parsed;
      }
    } catch (error) {
      this.logger.warn({ error }, 'Failed to parse seeder journal; resetting to empty journal');
    }

    return {};
  }

  private persistJournal(journal: SeederJournal): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `
        INSERT INTO settings (id, key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      )
      .run(randomUUID(), JOURNAL_KEY, JSON.stringify(journal), now, now);
  }
}
