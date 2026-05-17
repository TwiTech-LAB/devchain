import { Injectable, Inject } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('ProjectEgressConfig');
const SETTINGS_KEY = 'cloud.egress.enabledProjects';

@Injectable()
export class ProjectEgressConfigService {
  private sqlite: Database.Database;
  private cache: Map<string, boolean> | null = null;

  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(this.db);
  }

  isEnabled(projectId: string): boolean {
    return this.getMap().get(projectId) ?? false;
  }

  hasAnyEnabled(): boolean {
    for (const enabled of this.getMap().values()) {
      if (enabled) return true;
    }
    return false;
  }

  setEnabled(projectId: string, enabled: boolean): void {
    const map = this.getMap();
    map.set(projectId, enabled);
    this.persist(map);
    logger.info({ projectId, enabled }, 'Project egress config updated');
  }

  getAll(): Record<string, boolean> {
    return Object.fromEntries(this.getMap());
  }

  private getMap(): Map<string, boolean> {
    if (this.cache) return this.cache;

    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;

    const map = new Map<string, boolean>();
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as Record<string, boolean>;
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'boolean') map.set(k, v);
        }
      } catch {
        logger.warn('Failed to parse egress config — resetting');
      }
    }

    this.cache = map;
    return map;
  }

  private persist(map: Map<string, boolean>): void {
    const now = new Date().toISOString();
    const value = JSON.stringify(Object.fromEntries(map));

    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, value, now, now);

    this.cache = map;
  }
}
