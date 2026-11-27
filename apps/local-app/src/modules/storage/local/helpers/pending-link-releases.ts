import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { BusyError } from '../../../../common/errors/error-types';
import {
  EXTERNAL_TASK_UNLINK_PENDING,
  type ExternalEstimateLogIdentity,
} from '../../models/domain.models';
import { readSettingMap, writeSetting } from './external-link-receipts';

/**
 * Home's record of the unlinks it asked a VM to make, by link id, each with the attempts
 * that have not been refused. Each dispatch to the VM is one attempt. One without a
 * definitive refusal may have been committed, or may still commit, so it stays until
 * home's copy drops the link; meanwhile the link's tasks take no new estimate, since the
 * next pull may remove the link resolving one needs. Removing the project's binding
 * forgets them: home owns the project's links again. Every helper runs inside the
 * caller's transaction.
 */
const RELEASES_KEY = 'remotes.home.pendingLinkReleases';

interface PendingLinkRelease {
  projectId: string;
  epicId: string;
  /** The tasks whose links the unlink removes, over every attempt. */
  tasks: ExternalEstimateLogIdentity[];
  /** Attempts the VM has not refused. */
  attempts: string[];
  since: string;
}

function readReleases(db: Database.Database): Record<string, PendingLinkRelease> {
  return readSettingMap<PendingLinkRelease>(db, RELEASES_KEY, 'pending link releases');
}

function writeReleases(db: Database.Database, releases: Record<string, PendingLinkRelease>): void {
  writeSetting(db, RELEASES_KEY, JSON.stringify(releases), new Date().toISOString());
}

function linkAtHome(db: Database.Database, linkId: string): boolean {
  return db.prepare('SELECT 1 FROM external_task_links WHERE id = ?').get(linkId) !== undefined;
}

const sameTask = (a: ExternalEstimateLogIdentity, b: ExternalEstimateLogIdentity): boolean =>
  a.projectId === b.projectId &&
  a.provider === b.provider &&
  a.remoteScopeKey === b.remoteScopeKey &&
  a.remoteTaskId === b.remoteTaskId;

/** Records a new attempt to release `linkId`, for `tasks`, and returns its id. */
export function openLinkReleaseAttempt(
  db: Database.Database,
  linkId: string,
  release: Pick<PendingLinkRelease, 'projectId' | 'epicId' | 'tasks'>,
): string {
  const releases = readReleases(db);
  const open = releases[linkId];
  const attempt = randomUUID();
  releases[linkId] = {
    projectId: release.projectId,
    epicId: release.epicId,
    tasks: [
      ...(open?.tasks ?? []),
      ...release.tasks.filter((task) => !open?.tasks.some((known) => sameTask(known, task))),
    ],
    attempts: [...(open?.attempts ?? []), attempt],
    since: open?.since ?? new Date().toISOString(),
  };
  writeReleases(db, releases);
  return attempt;
}

/**
 * Forgets `attempt` (when given: the VM answered it and changed nothing), then the whole
 * release once no attempt remains or home's copy has dropped the link.
 */
export function closeLinkReleaseAttempt(
  db: Database.Database,
  linkId: string,
  attempt: string | null,
): void {
  const releases = readReleases(db);
  const release = releases[linkId];
  if (!release) return;
  release.attempts = release.attempts.filter((candidate) => candidate !== attempt);
  if (release.attempts.length === 0 || !linkAtHome(db, linkId)) delete releases[linkId];
  writeReleases(db, releases);
}

/**
 * The parent links of the managed projections whose recognition link is `task`'s: a
 * release of one of them removes that link too, also when the projection was confirmed
 * after the release was opened.
 */
function managedParentLinkIds(
  db: Database.Database,
  task: ExternalEstimateLogIdentity,
): Set<string> {
  const rows = db
    .prepare(
      `SELECT m.parent_source_link_id_snapshot AS linkId
       FROM external_task_links l
       JOIN external_managed_subtask_links m
         ON m.id = json_extract(l.source_snapshot, '$.managedProjectionId')
       WHERE l.project_id = ? AND l.provider = ? AND l.remote_scope_key = ?
         AND l.remote_task_id = ?`,
    )
    .all(task.projectId, task.provider, task.remoteScopeKey, task.remoteTaskId) as {
    linkId: string;
  }[];
  return new Set(rows.map((row) => row.linkId));
}

/**
 * Refuses while an open release removes a link of `task`: one it saved, or the parent
 * link of `task`'s managed projection. Forgets every release whose link home's copy has
 * dropped, also those of other tasks.
 */
export function assertNoLinkReleasePending(
  db: Database.Database,
  task: ExternalEstimateLogIdentity,
): void {
  const releases = readReleases(db);
  if (Object.keys(releases).length === 0) return;
  const managedParents = managedParentLinkIds(db, task);
  let closed = false;
  for (const [linkId, release] of Object.entries(releases)) {
    if (!linkAtHome(db, linkId)) {
      delete releases[linkId];
      closed = true;
      continue;
    }
    if (managedParents.has(linkId) || release.tasks.some((known) => sameTask(known, task))) {
      throw new BusyError('This task is being unlinked; reload it before logging time.', {
        reason: EXTERNAL_TASK_UNLINK_PENDING,
      });
    }
  }
  if (closed) writeReleases(db, releases);
}

/** Forgets the releases of `projectId`, whose links home owns again. */
export function forgetLinkReleases(db: Database.Database, projectId: string): void {
  const releases = readReleases(db);
  const kept = Object.fromEntries(
    Object.entries(releases).filter(([, release]) => release.projectId !== projectId),
  );
  if (Object.keys(kept).length !== Object.keys(releases).length) writeReleases(db, kept);
}
