import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../../common/errors/error-types';
import type { ExternalTaskLink } from '../../models/domain.models';

/**
 * Claimed-VM state of the projects whose ordinary links home seeded: `{ projectId: seededAt }`.
 * Until a project is seeded, the VM's link table may lack home's links, so it neither writes
 * links nor sends its link table home. Every helper runs inside the caller's transaction.
 */
const SEEDED_KEY = 'remotes.host.seededLinkProjects';
/** Last receipt `seq` handed out; it never goes back, also after home acknowledged them all. */
const SEQ_KEY = 'remotes.host.linkReceiptSeq';

export function readSeededLinkProjects(db: Database.Database): Record<string, string> {
  return readSettingMap<string>(db, SEEDED_KEY, 'seeded link projects');
}

export function markLinkProjectsSeeded(db: Database.Database, projectIds: readonly string[]): void {
  if (projectIds.length === 0) return;
  const now = new Date().toISOString();
  const map = readSeededLinkProjects(db);
  for (const projectId of projectIds) map[projectId] ??= now;
  writeSetting(db, SEEDED_KEY, JSON.stringify(map), now);
}

export function forgetSeededLinkProject(db: Database.Database, projectId: string): void {
  const map = readSeededLinkProjects(db);
  if (!(projectId in map)) return;
  delete map[projectId];
  writeSetting(db, SEEDED_KEY, JSON.stringify(map), new Date().toISOString());
}

/** VM link writes need the seed: before it, home's links are not on the VM yet. */
export function assertLinkProjectSeeded(db: Database.Database, projectId: string): void {
  if (projectId in readSeededLinkProjects(db)) return;
  throw new AppError(
    'This project is still receiving its ClickUp and Jira links from home; try again shortly.',
    'PROJECT_NOT_SEEDED',
    409,
    { projectId, retryable: true },
  );
}

/** Records an ordinary link set or unlink for home; returns the receipt id. */
export function writeLinkReceipt(
  db: Database.Database,
  kind: 'set' | 'release',
  link: Pick<
    ExternalTaskLink,
    'id' | 'epicId' | 'projectId' | 'provider' | 'remoteScopeKey' | 'remoteTaskId'
  >,
): string {
  const now = new Date().toISOString();
  const stored = db.prepare('SELECT value FROM settings WHERE key = ?').get(SEQ_KEY) as
    | { value: string }
    | undefined;
  const { maxSeq } = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM external_link_receipts')
    .get() as { maxSeq: number };
  const seq = Math.max(stored ? Number(JSON.parse(stored.value)) : 0, maxSeq) + 1;
  writeSetting(db, SEQ_KEY, JSON.stringify(seq), now);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO external_link_receipts
       (id, seq, kind, project_id, epic_id, link_id, provider, remote_scope_key, remote_task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    seq,
    kind,
    link.projectId,
    link.epicId,
    link.id,
    link.provider,
    link.remoteScopeKey,
    link.remoteTaskId,
    now,
  );
  return id;
}

/** The JSON object map stored under `key`; `{}` when the key is unset. */
export function readSettingMap<T>(
  db: Database.Database,
  key: string,
  label: string,
): Record<string, T> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return {};
  const parsed: unknown = JSON.parse(row.value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${label} setting`);
  }
  return parsed as Record<string, T>;
}

export function writeSetting(db: Database.Database, key: string, value: string, now: string): void {
  db.prepare(
    `INSERT INTO settings (id, key, value, created_at, updated_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now, now);
}
