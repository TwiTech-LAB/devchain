import type Database from 'better-sqlite3';
import { z } from 'zod';
import { IOError } from '../../../../common/errors/error-types';

export const HOST_ABANDONED_PROJECTS_KEY = 'host.abandonedProjects';
const AbandonedSchema = z.array(z.string());

export function readAbandonedProjects(sqlite: Database.Database): string[] {
  const row = sqlite
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(HOST_ABANDONED_PROJECTS_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    return AbandonedSchema.parse(JSON.parse(row.value));
  } catch {
    throw new IOError('The hosted abandoned-project list is invalid.');
  }
}

/** The caller owns the write transaction; this key never enters a replica slice. */
export function writeAbandonedProjects(sqlite: Database.Database, projects: string[]): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, created_at, updated_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(HOST_ABANDONED_PROJECTS_KEY, JSON.stringify([...new Set(projects)].sort()), now, now);
}

export function clearAbandonedProjects(sqlite: Database.Database, projectIds: string[]): void {
  const abandoned = readAbandonedProjects(sqlite);
  const imported = new Set(projectIds);
  const next = abandoned.filter((id) => !imported.has(id));
  if (next.length !== abandoned.length) writeAbandonedProjects(sqlite, next);
}
