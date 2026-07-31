import { Injectable, Inject } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { createLogger } from '../../../common/logging/logger';
import { GUEST_SANDBOX_ROOT_PATH } from '../../guests/constants';

const logger = createLogger('ProjectEgressConfig');
const SETTINGS_KEY = 'cloud.egress.enabledProjects';
const NEW_PROJECTS_DEFAULT_ENABLED_KEY = 'cloud.egress.newProjectsDefaultEnabled';

interface ProjectRow {
  id: string;
  rootPath: string;
}

@Injectable()
export class ProjectEgressConfigService {
  private readonly sqlite: Database.Database;

  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(this.db);
  }

  /** Effective API: unknown/deleted projects are disabled regardless of stored overrides. */
  isEnabled(projectId: string): boolean {
    const project = this.sqlite
      .prepare('SELECT id, root_path AS rootPath FROM projects WHERE id = ?')
      .get(projectId) as ProjectRow | undefined;
    if (!project) {
      return false;
    }

    return this.isEffectivelyEnabled(project, this.getMap(), this.isNewProjectsDefaultEnabled());
  }

  /** Effective API: projectless events depend only on current live project rows. */
  hasAnyEnabled(): boolean {
    const projects = this.sqlite
      .prepare('SELECT id, root_path AS rootPath FROM projects')
      .all() as ProjectRow[];
    const map = this.getMap();
    const newProjectsDefaultEnabled = this.isNewProjectsDefaultEnabled();

    for (const project of projects) {
      if (this.isEffectivelyEnabled(project, map, newProjectsDefaultEnabled)) {
        return true;
      }
    }
    return false;
  }

  /** Raw override API: preserves the existing write contract, including unknown project IDs. */
  setEnabled(projectId: string, enabled: boolean): void {
    const map = this.getMap();
    map.set(projectId, enabled);
    this.persist(map);
    logger.info({ projectId, enabled }, 'Project egress config updated');
  }

  /** Raw override API: returns valid stored booleans, including inert stale project IDs. */
  getAll(): Record<string, boolean> {
    return Object.fromEntries(this.getMap());
  }

  private isEffectivelyEnabled(
    project: ProjectRow,
    map: Map<string, boolean>,
    newProjectsDefaultEnabled: boolean,
  ): boolean {
    const explicit = map.get(project.id);
    if (explicit !== undefined) {
      return explicit;
    }

    return newProjectsDefaultEnabled && project.rootPath !== GUEST_SANDBOX_ROOT_PATH;
  }

  private isNewProjectsDefaultEnabled(): boolean {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(NEW_PROJECTS_DEFAULT_ENABLED_KEY) as { value: unknown } | undefined;
    if (!row) {
      return false;
    }

    try {
      const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      return parsed === true;
    } catch {
      return false;
    }
  }

  private getMap(): Map<string, boolean> {
    const row = this.sqlite
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(SETTINGS_KEY) as { value: unknown } | undefined;

    const map = new Map<string, boolean>();
    if (row) {
      try {
        const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return map;
        }
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'boolean') map.set(k, v);
        }
      } catch {
        logger.warn('Failed to parse egress config — resetting');
      }
    }

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
  }
}
