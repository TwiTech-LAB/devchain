import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createLogger } from '../../common/logging/logger';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import {
  ConnectLastChoicesSchema,
  connectChoiceKey,
  type ConnectLastChoices,
} from './connect-choices.dto';
import type { DockerPlanItem } from './docker/docker-plan.dto';

const logger = createLogger('ConnectChoicesStore');
const SETTINGS_KEY = 'connect.lastChoices';

@Injectable()
export class ConnectChoicesStore {
  private readonly sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
  }

  get(projectId: string): ConnectLastChoices | null {
    return this.readMap()[projectId] ?? null;
  }

  recordAttach(projectId: string, remoteId: string, includeDocker: boolean): void {
    const map = this.readMap();
    this.write(map, projectId, {
      remoteId,
      includeDocker,
      items: map[projectId]?.items ?? {},
      savedAt: new Date().toISOString(),
    });
  }

  recordPlan(
    projectId: string,
    remoteId: string,
    items: readonly Pick<
      DockerPlanItem,
      'kind' | 'name' | 'linkedReasons' | 'choices' | 'selectedMode'
    >[],
  ): void {
    const map = this.readMap();
    const offered = items.filter(
      (item) => item.linkedReasons.length > 0 && item.choices.length > 0,
    );
    this.write(map, projectId, {
      remoteId,
      includeDocker:
        map[projectId]?.includeDocker ?? items.some((item) => item.selectedMode !== null),
      items: Object.fromEntries(
        offered.map((item) => [
          connectChoiceKey(item),
          {
            included: item.selectedMode !== null,
            ...(item.selectedMode === null ? {} : { mode: item.selectedMode }),
          },
        ]),
      ),
      savedAt: new Date().toISOString(),
    });
  }

  private write(
    map: Record<string, ConnectLastChoices>,
    projectId: string,
    choices: ConnectLastChoices,
  ): void {
    map[projectId] = ConnectLastChoicesSchema.parse(choices);
    const now = choices.savedAt;
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SETTINGS_KEY, JSON.stringify(map), now, now);
  }

  private readMap(): Record<string, ConnectLastChoices> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row) return {};
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const map: Record<string, ConnectLastChoices> = {};
      for (const [projectId, value] of Object.entries(parsed)) {
        const choices = ConnectLastChoicesSchema.safeParse(value);
        if (choices.success) map[projectId] = choices.data;
      }
      return map;
    } catch {
      logger.warn('Stored Connect choices are invalid; using the defaults');
      return {};
    }
  }
}
