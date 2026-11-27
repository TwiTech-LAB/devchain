import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { TransactionRunner } from '../db/transaction-runner';
import type {
  SessionTranscriptMetadata,
  SessionTranscriptRow,
  TranscriptBindInput,
  TranscriptBindOutcome,
  TranscriptBackfillInput,
  TranscriptBackfillOutcome,
} from './session-transcript.types';
import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../db/db.provider';
import { getRawSqliteClient } from '../db/sqlite-raw';
import type { Agent } from '../models/domain.models';
import type { SessionDto } from '../../sessions/dtos/sessions.dto';
import type { ActiveSessionInfo } from '../../session-terminal-runtime/dtos/active-session-info.dto';

interface SessionRow {
  id: string;
  epic_id: string | null;
  agent_id: string | null;
  tmux_session_id: string | null;
  provider_session_id: string | null;
  provider_name_at_launch: string | null;
  status: 'running' | 'stopped' | 'failed';
  started_at: string;
  ended_at: string | null;
  last_activity_at: string | null;
  activity_state: 'idle' | 'busy' | null;
  busy_since: string | null;
  transcript_path: string | null;
  name: string | null;
  created_at: string;
  updated_at: string;
}

interface ActiveSessionRow {
  id: string;
  agent_id: string;
  project_id: string;
  tmux_session_id: string | null;
  status: 'running';
  started_at: string;
  last_activity_at: string | null;
  activity_state: 'idle' | 'busy' | null;
  name: string | null;
  provider_name_at_launch: string | null;
}

export interface RunningSessionIdentity {
  id: string;
  agentId: string | null;
  status: 'running';
  startedAt: string;
  inheritedSessionIds: string[];
}

/** A running row before the inherited ids are parsed from their JSON text. */
type RunningSessionRow = Omit<RunningSessionIdentity, 'inheritedSessionIds'> & {
  inheritedSessionIds: string | null;
};

function parseInheritedSessionIds(value: string | null): string[] {
  if (value === null) return [];

  try {
    const ids: unknown = JSON.parse(value);
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string' && id.length === 36)
      : [];
  } catch {
    return [];
  }
}

export interface SessionTreeRow {
  id: string;
  agentId: string | null;
  agentName: string | null;
  parentSessionId: string | null;
  kind: 'session' | 'save_point';
  status: SessionRow['status'];
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string | null;
  providerSessionId: string | null;
  providerNameAtLaunch: string | null;
  transcriptPath: string | null;
  sizeBytes: number | null;
  name: string | null;
}

export interface SessionTreeCursor {
  s: string;
  i: string;
}

/** Newest first for the session tree and for the flat history. */
export const SESSION_RECENCY_SORT = 'COALESCE(last_activity_at, ended_at, started_at)';

/** The name of the agent that owns a row of `table` (a `sessions` table name or alias). */
export function ownerNameColumn(table: string): string {
  return `(SELECT name FROM agents WHERE agents.id = ${table}.agent_id)`;
}

/** Callers must name the table `sessions` without an alias: the owner name subquery reads it. */
const TREE_COLUMNS = `id, agent_id AS agentId,
  ${ownerNameColumn('sessions')} AS agentName,
  parent_session_id AS parentSessionId, kind, status,
  started_at AS startedAt, ended_at AS endedAt, last_activity_at AS lastActivityAt,
  provider_session_id AS providerSessionId, provider_name_at_launch AS providerNameAtLaunch,
  transcript_path AS transcriptPath, size_bytes AS sizeBytes, name`;

/** Whose sessions a list shows: the viewing agent only, or every agent of its family. */
export type SessionListScope = 'agent' | 'family';

/** A profile's family key, normalized as the profile API does; null for no slug or a blank one. */
export function familyKey(familySlug: string | null): string | null {
  return familySlug?.trim().toLowerCase() || null;
}

/**
 * The ids of the agents in the family of `agentId`, that agent included; empty for an unknown
 * agent. Profiles with the same `familyKey` form one family; a profile without a key forms a
 * family of its own agents. Disabled agents stay members: their sessions are family history.
 * Only agents of the same project count. Keys are compared here, not in SQL: SQLite `LOWER` and
 * `TRIM` fold only ASCII letters and spaces, so imported slugs such as `\tÉquipe` would split.
 */
export function resolveFamilyAgentIds(sqlite: Database.Database, agentId: string): string[] {
  const agents = sqlite
    .prepare<{ agentId: string }, { id: string; profileId: string; familySlug: string | null }>(
      `SELECT member.id, member.profile_id AS profileId, profile.family_slug AS familySlug
       FROM agents self
       JOIN agents member ON member.project_id = self.project_id
       JOIN agent_profiles profile ON profile.id = member.profile_id
       WHERE self.id = @agentId`,
    )
    .all({ agentId });
  const self = agents.find(({ id }) => id === agentId);
  if (!self) return [];
  const key = familyKey(self.familySlug);
  return agents
    .filter(
      (agent) =>
        agent.profileId === self.profileId || (key !== null && familyKey(agent.familySlug) === key),
    )
    .map(({ id }) => id);
}

/** Selects the sessions a list of one agent shows. Queries using `where` must bind `params`. */
export interface SessionOwnerFilter {
  where(column?: string): string;
  params: { agentId: string; familyAgentIds: string };
}

/** Read from a source row: its inherited ids followed by its own id, oldest first. */
const SOURCE_AND_INHERITED_IDS = identityIds('sessions');

/** Never change it: stored `Before rollback` rows are found by the IDs derived from it. */
const BEFORE_ROLLBACK_NAMESPACE = '9d90e103-d150-4ff8-a8d2-55cf6b1a775e';

/** The row ID of a session's one `Before rollback` record: a version 5 UUID of the session ID. */
export function beforeRollbackRecordId(sessionId: string): string {
  const namespace = Buffer.from(BEFORE_ROLLBACK_NAMESPACE.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(namespace).update(sessionId, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A save point whose ID is derived from its parent: the parent's `Before rollback` record. */
export function isBeforeRollbackRecord(
  row: Pick<SessionTreeRow, 'id' | 'kind' | 'parentSessionId'>,
): boolean {
  return (
    row.kind === 'save_point' &&
    row.parentSessionId !== null &&
    row.id === beforeRollbackRecordId(row.parentSessionId)
  );
}

export interface RollbackRecordCopy {
  providerSessionId: string;
  transcriptPath: string;
  sizeBytes: number | null;
}

/** A running session that shares an identity with another session. */
export interface RunningLineageSession {
  sessionId: string;
  agentId: string | null;
  agentName: string | null;
}

/** A write refused because a running row shares the identity it would set running. */
type LineageRunning = { outcome: 'lineageRunning'; running: RunningLineageSession };
/** A write refused because the row is not stopped or failed. */
type InvalidState = { outcome: 'invalidState' };

/** An agent's launch config: the values a restore switch replaces and may put back. */
type AgentLaunchConfig = Pick<Agent, 'providerConfigId' | 'modelOverride' | 'effortOverride'>;

/** The config a restore writes to the target agent, with no model or effort override. */
export interface RestoreAgentSwitch {
  providerConfigId: string;
  providerId: string;
}

export type RestoreClaim =
  | {
      outcome: 'claimed';
      movedSavePointIds: string[];
      /** What `rollbackRestore` puts back on the target agent; null without a switch. */
      agentRevert: RestoreAgentRevert | null;
    }
  | LineageRunning
  | { outcome: 'runningOnOtherAgent'; agentId: string | null }
  | { outcome: 'switchConfigRefused'; reason: SwitchConfigRefusal }
  | InvalidState;

/** Why the switch config no longer fits the target agent when the claim checks it again. */
export type SwitchConfigRefusal = 'configNotFound' | 'configProfileMismatch' | 'providerMismatch';

/** What `rollbackRestore` puts back on the target agent after a restore with a switch. */
export interface RestoreAgentRevert {
  agentId: string;
  switchConfigId: string;
  prior: AgentLaunchConfig;
}

export type ForkInsert = { outcome: 'inserted' } | LineageRunning;

export type RollbackCommit = { outcome: 'committed' } | InvalidState | LineageRunning;

/**
 * A row's inherited ids as a JSON array. Stored text that is not a JSON array counts as none, as
 * the session resolver reads it (`parseInheritedSessionIds`); `json_insert` would leave an object
 * or a scalar unchanged and drop the row's own id. CASE evaluates `json_type` only on valid JSON.
 */
function inheritedIds(table: string): string {
  const inherited = `${table}.inherited_session_ids`;
  return `CASE WHEN json_valid(${inherited})
    THEN CASE json_type(${inherited}) WHEN 'array' THEN ${inherited} ELSE '[]' END
    ELSE '[]' END`;
}

/** The identity set of a `sessions` row as a JSON array: its inherited ids and its own id. */
function identityIds(table: string): string {
  return `json_insert(${inheritedIds(table)}, '$[#]', ${table}.id)`;
}

/**
 * The ids a fork of a `sessions` row inherits, which is the fork's identity set apart from its
 * fresh id. `insertForkedSession` stores it as the fork's `inherited_session_ids`.
 */
function forkIdentityIds(table: string): string {
  return `CASE WHEN ${table}.kind = 'save_point' THEN ${inheritedIds(table)} ELSE ${identityIds(table)} END`;
}

// Lineage writes run caller-owned project admission inside their queued transactions.
@Injectable()
export class SessionRowStore {
  private readonly sqlite: Database.Database;
  private readonly txRunner: TransactionRunner;

  constructor(@Inject(DB_CONNECTION) db: BetterSQLite3Database) {
    this.sqlite = getRawSqliteClient(db);
    this.txRunner = new TransactionRunner(this.sqlite);
  }

  getSession(sessionId: string): SessionDto | null {
    const row = this.sqlite
      .prepare(
        `
      SELECT id, epic_id, agent_id, tmux_session_id, provider_session_id, provider_name_at_launch, status, started_at, ended_at, last_activity_at, activity_state, busy_since, transcript_path, name, created_at, updated_at
      FROM sessions
      WHERE id = ?
    `,
      )
      .get(sessionId) as SessionRow | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      epicId: row.epic_id,
      agentId: row.agent_id,
      tmuxSessionId: row.tmux_session_id,
      providerSessionId: row.provider_session_id ?? null,
      providerNameAtLaunch: row.provider_name_at_launch ?? null,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at ?? null,
      activityState: row.activity_state ?? null,
      busySince: row.busy_since ?? null,
      transcriptPath: row.transcript_path ?? null,
      name: row.name ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getSessionTreeRow(sessionId: string): SessionTreeRow | null {
    const row = this.sqlite
      .prepare(`SELECT ${TREE_COLUMNS} FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionTreeRow | undefined;
    return row ?? null;
  }

  listSessionTreeRows(agentId: string): SessionTreeRow[] {
    return this.sqlite
      .prepare(
        `SELECT ${TREE_COLUMNS} FROM sessions WHERE agent_id = ?
         ORDER BY ${SESSION_RECENCY_SORT} DESC, id DESC`,
      )
      .all(agentId) as SessionTreeRow[];
  }

  listFamilyAgentIds(agentId: string): string[] {
    return resolveFamilyAgentIds(this.sqlite, agentId);
  }

  /** Resolves the family once, so each query of one request reads the same owner set. */
  ownerFilter(agentId: string, scope: SessionListScope): SessionOwnerFilter {
    const family = scope === 'family';
    return {
      where: (column = 'agent_id') =>
        family
          ? `${column} IN (SELECT value FROM json_each(@familyAgentIds))`
          : `${column} = @agentId`,
      params: {
        agentId,
        familyAgentIds: JSON.stringify(family ? this.listFamilyAgentIds(agentId) : []),
      },
    };
  }

  /**
   * A page of tree roots with all their visible descendants. A visible row whose parent is not
   * visible is a root, so a fork stays listed after its parent moved to an agent out of scope.
   */
  getSessionTreePage(
    agentId: string,
    cursor: SessionTreeCursor | null,
    limit: number,
    scope: SessionListScope = 'agent',
  ): { rows: SessionTreeRow[]; total: number; next: SessionTreeCursor | null } {
    const owners = this.ownerFilter(agentId, scope);
    const visible = owners.where();
    const roots = `${visible} AND (parent_session_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM sessions parent
      WHERE parent.id = sessions.parent_session_id AND ${owners.where('parent.agent_id')}))`;
    const { total } = this.sqlite
      .prepare(`SELECT COUNT(*) AS total FROM sessions WHERE ${roots}`)
      .get(owners.params) as { total: number };
    const page = this.sqlite
      .prepare(
        `SELECT id AS i, ${SESSION_RECENCY_SORT} AS s FROM sessions
         WHERE ${roots} AND (@sort IS NULL OR (${SESSION_RECENCY_SORT}, id) < (@sort, @id))
         ORDER BY s DESC, id DESC LIMIT @take`,
      )
      .all({
        ...owners.params,
        sort: cursor?.s ?? null,
        id: cursor?.i ?? null,
        take: limit + 1,
      }) as SessionTreeCursor[];
    const pageRoots = page.slice(0, limit);
    if (pageRoots.length === 0) return { rows: [], total, next: null };

    // Materialize the visible edges once so recursion can look up children by parent.
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE visible_edges AS MATERIALIZED (
           SELECT id, parent_session_id FROM sessions
           WHERE ${visible} AND parent_session_id IS NOT NULL
         ), tree(session_id, root_order, depth) AS (
           SELECT value, key, 0 FROM json_each(@rootIds)
           UNION ALL
           SELECT child.id, tree.root_order, tree.depth + 1
           FROM tree JOIN visible_edges child ON child.parent_session_id = tree.session_id
         )
         SELECT ${TREE_COLUMNS} FROM tree CROSS JOIN sessions ON id = tree.session_id
         ORDER BY tree.root_order, tree.depth, ${SESSION_RECENCY_SORT} DESC, id DESC`,
      )
      .all({
        ...owners.params,
        rootIds: JSON.stringify(pageRoots.map(({ i }) => i)),
      }) as SessionTreeRow[];

    return { rows, total, next: page.length > limit ? pageRoots[pageRoots.length - 1] : null };
  }

  listActiveSessions(): SessionDto[] {
    const rows = this.sqlite
      .prepare(
        `
      SELECT id, epic_id, agent_id, tmux_session_id, status, started_at, ended_at, last_activity_at, activity_state, busy_since, transcript_path, name, created_at, updated_at
      FROM sessions
      WHERE status = 'running'
      ORDER BY started_at DESC
    `,
      )
      .all() as SessionRow[];

    return rows.map((row) => this.toSessionSummary(row));
  }

  listRunningSessionIdentities(): RunningSessionIdentity[] {
    const rows = this.sqlite
      .prepare<[], RunningSessionRow>(
        `SELECT id, agent_id AS agentId, status, started_at AS startedAt,
                inherited_session_ids AS inheritedSessionIds
         FROM sessions WHERE status = 'running'
         ORDER BY started_at DESC`,
      )
      .all();

    return rows.map((row) => ({
      ...row,
      inheritedSessionIds: parseInheritedSessionIds(row.inheritedSessionIds),
    }));
  }

  getActiveSessionForAgent(agentId: string): SessionDto | null {
    const row = this.sqlite
      .prepare(
        `
        SELECT id, epic_id, agent_id, tmux_session_id, status,
               started_at, ended_at, last_activity_at, activity_state,
               busy_since, transcript_path, name,
               created_at, updated_at
        FROM sessions
        WHERE status = 'running' AND agent_id = ?
        ORDER BY started_at DESC
        LIMIT 1
      `,
      )
      .get(agentId) as SessionRow | undefined;

    return row ? this.toSessionSummary(row) : null;
  }

  getActiveSessionsForProject(projectId: string): SessionDto[] {
    const rows = this.sqlite
      .prepare(
        `
        SELECT s.id, s.epic_id, s.agent_id, s.tmux_session_id, s.status,
               s.started_at, s.ended_at, s.last_activity_at, s.activity_state,
               s.busy_since, s.transcript_path, s.name,
               s.created_at, s.updated_at
        FROM sessions s
        JOIN agents a ON s.agent_id = a.id
        WHERE s.status = 'running' AND a.project_id = ?
        ORDER BY s.started_at DESC
      `,
      )
      .all(projectId) as SessionRow[];

    return rows.map((row) => this.toSessionSummary(row));
  }

  getActiveSessionInfo(agentId: string, projectId: string): ActiveSessionInfo | null {
    const row = this.sqlite
      .prepare(
        `
        SELECT s.id, s.agent_id, a.project_id, s.tmux_session_id, s.status,
               s.started_at, s.last_activity_at, s.activity_state, s.name, s.provider_name_at_launch
        FROM sessions s
        JOIN agents a ON s.agent_id = a.id
        WHERE s.status = 'running' AND s.agent_id = ? AND a.project_id = ?
        ORDER BY s.started_at DESC
        LIMIT 1
      `,
      )
      .get(agentId, projectId) as ActiveSessionRow | undefined;

    return row ? this.toActiveSessionInfo(row) : null;
  }

  getSessionProjectScope(
    sessionId: string,
  ): { sessionId: string; agentId: string | null; projectId: string } | null {
    const row = this.sqlite
      .prepare(
        `
        SELECT s.id, s.agent_id, a.project_id
        FROM sessions s
        JOIN agents a ON s.agent_id = a.id
        WHERE s.id = ?
        LIMIT 1
      `,
      )
      .get(sessionId) as { id: string; agent_id: string | null; project_id: string } | undefined;

    return row ? { sessionId: row.id, agentId: row.agent_id, projectId: row.project_id } : null;
  }

  listActiveSessionInfos(projectId: string): ActiveSessionInfo[] {
    const rows = this.sqlite
      .prepare(
        `
        SELECT s.id, s.agent_id, a.project_id, s.tmux_session_id, s.status,
               s.started_at, s.last_activity_at, s.activity_state, s.name, s.provider_name_at_launch
        FROM sessions s
        JOIN agents a ON s.agent_id = a.id
        WHERE s.status = 'running' AND a.project_id = ?
        ORDER BY s.started_at DESC
      `,
      )
      .all(projectId) as ActiveSessionRow[];

    return rows.map((row) => this.toActiveSessionInfo(row));
  }

  listRunningProviderSessions(): Pick<ActiveSessionInfo, 'sessionId' | 'providerNameAtLaunch'>[] {
    const rows = this.sqlite
      .prepare(
        `
      SELECT id, provider_name_at_launch FROM sessions WHERE status = 'running'
    `,
      )
      .all() as { id: string; provider_name_at_launch: string | null }[];
    return rows.map((row) => ({
      sessionId: row.id,
      providerNameAtLaunch: row.provider_name_at_launch,
    }));
  }

  private toSessionSummary(row: SessionRow): SessionDto {
    return {
      id: row.id,
      epicId: row.epic_id,
      agentId: row.agent_id,
      tmuxSessionId: row.tmux_session_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at ?? null,
      activityState: row.activity_state ?? null,
      busySince: row.busy_since ?? null,
      transcriptPath: row.transcript_path ?? null,
      name: row.name ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toActiveSessionInfo(row: ActiveSessionRow): ActiveSessionInfo {
    return {
      sessionId: row.id,
      agentId: row.agent_id,
      projectId: row.project_id,
      status: row.status,
      tmuxSessionId: row.tmux_session_id,
      startedAt: row.started_at,
      lastActivityAt: row.last_activity_at,
      activityState: row.activity_state,
      name: row.name,
      providerNameAtLaunch: row.provider_name_at_launch,
    };
  }

  stopSession(sessionId: string, stoppedAt: string, sizeBytes: number | null): void {
    this.sqlite
      .prepare(
        `
        UPDATE sessions
        SET status = ?, ended_at = ?, size_bytes = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run('stopped', stoppedAt, sizeBytes, stoppedAt, sessionId);
  }

  updateName(sessionId: string, name: string | null, now: string): number {
    return this.sqlite
      .prepare(`UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?`)
      .run(name, now, sessionId).changes;
  }

  deleteRecord(sessionId: string): boolean {
    this.sqlite
      .prepare('DELETE FROM chat_thread_session_invites WHERE session_id = ?')
      .run(sessionId);
    const result = this.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return result.changes > 0;
  }

  insertSession(
    sessionId: string,
    epicId: string | null,
    agentId: string,
    tmuxSessionName: string,
    providerName: string,
    now: string,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO sessions (id, epic_id, agent_id, tmux_session_id, status, started_at, provider_name_at_launch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        epicId,
        agentId,
        tmuxSessionName,
        'running',
        now,
        providerName.toLowerCase(),
        now,
        now,
      );
  }

  /** Inserts a running fork, unless a running row shares an id of its identity set. */
  async insertForkedSession(input: {
    sessionId: string;
    parentSessionId: string;
    agentId: string;
    epicId: string | null;
    tmuxSessionName: string;
    providerName: string;
    now: string;
    admit: () => void;
  }): Promise<ForkInsert> {
    return this.txRunner.runImmediateQueued((): ForkInsert => {
      input.admit();
      const running = this.findRunningForkLineage(input.parentSessionId);
      if (running) return { outcome: 'lineageRunning', running };
      // VALUES keeps the foreign key check active when the source has been deleted.
      this.sqlite
        .prepare(
          `INSERT INTO sessions (id, parent_session_id, kind, epic_id, agent_id, tmux_session_id,
                                 status, provider_name_at_launch, started_at, created_at, updated_at,
                                 inherited_session_ids)
           VALUES (?, ?, 'session', ?, ?, ?, 'running', ?, ?, ?, ?,
                   (SELECT ${forkIdentityIds('sessions')} FROM sessions WHERE id = ?))`,
        )
        .run(
          input.sessionId,
          input.parentSessionId,
          input.epicId,
          input.agentId,
          input.tmuxSessionName,
          input.providerName.toLowerCase(),
          input.now,
          input.now,
          input.now,
          input.parentSessionId,
        );
      return { outcome: 'inserted' };
    });
  }

  async bindForkTranscript(input: TranscriptBindInput & { admit: () => void }): Promise<number> {
    return this.txRunner.runImmediateQueued(() => {
      input.admit();
      return this.writeTranscriptBinding(input);
    });
  }

  /**
   * `busy` means a turn started after the caller read `sourceBusySince`, so the copy can hold an
   * unfinished turn. `notRunning` means the source stopped or was deleted.
   */
  insertSavePoint(input: {
    sessionId: string;
    sourceSessionId: string;
    sourceBusySince: string | null;
    providerSessionId: string;
    transcriptPath: string;
    sizeBytes: number | null;
    now: string;
    admit: () => void;
  }): Promise<'inserted' | 'busy' | 'notRunning'> {
    return this.txRunner.runImmediateQueued(() => {
      const running = "id = ? AND kind = 'session' AND status = 'running'";
      input.admit();
      const result = this.sqlite
        .prepare(
          `INSERT INTO sessions (id, parent_session_id, kind, agent_id, provider_name_at_launch,
                                 status, provider_session_id, transcript_path, size_bytes,
                                 started_at, ended_at, created_at, updated_at, inherited_session_ids)
           SELECT ?, id, 'save_point', agent_id, provider_name_at_launch,
                  'stopped', ?, ?, ?, ?, ?, ?, ?, ${SOURCE_AND_INHERITED_IDS}
           FROM sessions
           WHERE ${running} AND activity_state IS NOT 'busy' AND busy_since IS ?`,
        )
        .run(
          input.sessionId,
          input.providerSessionId,
          input.transcriptPath,
          input.sizeBytes,
          input.now,
          input.now,
          input.now,
          input.now,
          input.sourceSessionId,
          input.sourceBusySince,
        );
      if (result.changes > 0) return 'inserted';
      const source = this.sqlite
        .prepare(`SELECT 1 FROM sessions WHERE ${running}`)
        .get(input.sourceSessionId);
      return source ? 'busy' : 'notRunning';
    });
  }

  /**
   * Binds a stopped or failed session to its rollback copy and sets it running, with a fresh
   * activity state. With `record`, the same transaction writes the session's `Before rollback`
   * row; an existing row is updated in place, so forks of it keep their parent. Writes nothing when
   * a running row shares an id of the session's identity set, or the session is no longer stopped
   * or failed or no longer owned by `ownerId`.
   */
  commitRollback(input: {
    sessionId: string;
    ownerId: string;
    providerSessionId: string;
    transcriptPath: string;
    tmuxSessionName: string;
    now: string;
    record: RollbackRecordCopy | null;
    admit: () => void;
  }): Promise<RollbackCommit> {
    return this.txRunner.runImmediateQueued((): RollbackCommit => {
      input.admit();
      const running = this.findRunningLineage(input.sessionId);
      if (running) return { outcome: 'lineageRunning', running };
      const { record, now } = input;
      if (record) {
        this.sqlite
          .prepare(
            `INSERT INTO sessions (id, parent_session_id, kind, agent_id, provider_name_at_launch,
                                   status, provider_session_id, transcript_path, size_bytes, name,
                                   started_at, ended_at, created_at, updated_at,
                                   inherited_session_ids)
             SELECT ?, id, 'save_point', agent_id, provider_name_at_launch,
                    'stopped', ?, ?, ?, NULL, ?, ?, ?, ?, ${SOURCE_AND_INHERITED_IDS}
             FROM sessions
             WHERE id = ? AND kind = 'session' AND status IN ('stopped', 'failed') AND agent_id = ?
             ON CONFLICT(id) DO UPDATE SET
               provider_session_id = excluded.provider_session_id,
               transcript_path = excluded.transcript_path,
               size_bytes = excluded.size_bytes,
               name = NULL,
               started_at = excluded.started_at,
               ended_at = excluded.ended_at,
               updated_at = excluded.updated_at,
               inherited_session_ids = excluded.inherited_session_ids`,
          )
          .run(
            beforeRollbackRecordId(input.sessionId),
            record.providerSessionId,
            record.transcriptPath,
            record.sizeBytes,
            now,
            now,
            now,
            now,
            input.sessionId,
            input.ownerId,
          );
      }
      const bound = this.sqlite
        .prepare(
          `UPDATE sessions
           SET provider_session_id = ?, transcript_path = ?, size_bytes = NULL,
               activity_state = NULL, busy_since = NULL, status = 'running', tmux_session_id = ?,
               ended_at = NULL, last_activity_at = ?, updated_at = ?
           WHERE id = ? AND kind = 'session' AND status IN ('stopped', 'failed') AND agent_id = ?`,
        )
        .run(
          input.providerSessionId,
          input.transcriptPath,
          input.tmuxSessionName,
          now,
          now,
          input.sessionId,
          input.ownerId,
        ).changes;
      return bound > 0 ? { outcome: 'committed' } : { outcome: 'invalidState' };
    });
  }

  /**
   * Sets a stopped or failed session running under `targetId`, only while `ownerId` still owns it
   * and no running row shares its identity set. When the owner changes, the session's direct save
   * points move with it; forks keep their owner. With `agentSwitch`, the target agent gets that
   * config with no overrides, only while the config still exists, belongs to the agent's profile
   * and has that provider. Writes nothing unless the claim wins.
   */
  claimRestore(input: {
    sessionId: string;
    ownerId: string;
    targetId: string;
    tmuxSessionName: string;
    now: string;
    admit: () => void;
    agentSwitch?: RestoreAgentSwitch;
  }): Promise<RestoreClaim> {
    return this.txRunner.runImmediateQueued((): RestoreClaim => {
      input.admit();
      const running = this.findRunningLineage(input.sessionId);
      if (running) return { outcome: 'lineageRunning', running };
      const { agentSwitch } = input;
      const refusal = agentSwitch ? this.switchConfigRefusal(input.targetId, agentSwitch) : null;
      if (refusal) return { outcome: 'switchConfigRefused', reason: refusal };
      const claimed = this.sqlite
        .prepare(
          `UPDATE sessions SET status = 'running', agent_id = @targetId, tmux_session_id = @tmux,
               ended_at = NULL, last_activity_at = @now, updated_at = @now
           WHERE id = @sessionId AND kind = 'session' AND status IN ('stopped', 'failed')
             AND agent_id = @ownerId`,
        )
        .run({
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          targetId: input.targetId,
          tmux: input.tmuxSessionName,
          now: input.now,
        }).changes;
      if (claimed === 0) {
        const row = this.sqlite
          .prepare('SELECT status, agent_id AS agentId FROM sessions WHERE id = ?')
          .get(input.sessionId) as
          | { status: SessionRow['status']; agentId: string | null }
          | undefined;
        return row?.status === 'running' && row.agentId !== input.targetId
          ? { outcome: 'runningOnOtherAgent', agentId: row.agentId }
          : { outcome: 'invalidState' };
      }
      const agentRevert: RestoreAgentRevert | null = agentSwitch
        ? {
            agentId: input.targetId,
            switchConfigId: agentSwitch.providerConfigId,
            prior: this.switchAgentConfig(input.targetId, agentSwitch.providerConfigId, input.now),
          }
        : null;
      if (input.ownerId === input.targetId) {
        return { outcome: 'claimed', movedSavePointIds: [], agentRevert };
      }

      const savePoints = "parent_session_id = ? AND kind = 'save_point' AND agent_id = ?";
      const movedSavePointIds = (
        this.sqlite
          .prepare(`SELECT id FROM sessions WHERE ${savePoints} ORDER BY id`)
          .all(input.sessionId, input.ownerId) as Array<{ id: string }>
      ).map(({ id }) => id);
      this.sqlite
        .prepare(`UPDATE sessions SET agent_id = ?, updated_at = ? WHERE ${savePoints}`)
        .run(input.targetId, input.now, input.sessionId, input.ownerId);
      return { outcome: 'claimed', movedSavePointIds, agentRevert };
    });
  }

  private switchConfigRefusal(
    agentId: string,
    agentSwitch: RestoreAgentSwitch,
  ): SwitchConfigRefusal | null {
    const config = this.sqlite
      .prepare(
        `SELECT c.provider_id AS providerId,
                c.profile_id = (SELECT profile_id FROM agents WHERE id = ?) AS inProfile
         FROM profile_provider_configs c WHERE c.id = ?`,
      )
      .get(agentId, agentSwitch.providerConfigId) as
      | { providerId: string; inProfile: number | null }
      | undefined;
    if (!config) return 'configNotFound';
    if (config.inProfile !== 1) return 'configProfileMismatch';
    if (config.providerId !== agentSwitch.providerId) return 'providerMismatch';
    return null;
  }

  private switchAgentConfig(
    agentId: string,
    providerConfigId: string,
    now: string,
  ): AgentLaunchConfig {
    const prior = this.sqlite
      .prepare(
        `SELECT provider_config_id AS providerConfigId, model_override AS modelOverride,
                effort_override AS effortOverride
         FROM agents WHERE id = ?`,
      )
      .get(agentId) as AgentLaunchConfig;
    this.sqlite
      .prepare(
        `UPDATE agents SET provider_config_id = ?, model_override = NULL, effort_override = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(providerConfigId, now, agentId);
    return prior;
  }

  /**
   * The running session, other than `excludeSessionId`, whose identity set (its id plus its
   * inherited ids) meets the identity set of `sessionId`; null when there is none. Two such rows
   * running at once make MCP session lookup ambiguous for both.
   */
  findRunningLineage(
    sessionId: string,
    excludeSessionId: string | null = null,
  ): RunningLineageSession | null {
    return this.findRunningOverlap(sessionId, identityIds, [sessionId, excludeSessionId]);
  }

  /** As {@link findRunningLineage}, for the identity set a new fork of `sourceId` would have. */
  findRunningForkLineage(
    sourceId: string,
    excludeSessionId: string | null = null,
  ): RunningLineageSession | null {
    return this.findRunningOverlap(sourceId, forkIdentityIds, [excludeSessionId]);
  }

  /** The newest running row outside `exclude` whose identity set meets `identity` of `sessionId`. */
  private findRunningOverlap(
    sessionId: string,
    identity: (table: string) => string,
    exclude: ReadonlyArray<string | null>,
  ): RunningLineageSession | null {
    const row = this.sqlite
      .prepare(
        `SELECT running.id AS sessionId, running.agent_id AS agentId,
                ${ownerNameColumn('running')} AS agentName
         FROM sessions source
         JOIN sessions running ON running.status = 'running'
         WHERE source.id = @sessionId
           AND running.id NOT IN (SELECT value FROM json_each(@exclude))
           AND EXISTS (
             SELECT 1 FROM json_each(${identityIds('running')}) mine
             JOIN json_each(${identity('source')}) theirs ON theirs.value = mine.value)
         ORDER BY running.started_at DESC, running.id DESC
         LIMIT 1`,
      )
      .get({
        sessionId,
        exclude: JSON.stringify(exclude.filter((id): id is string => id !== null)),
      }) as RunningLineageSession | undefined;
    return row ?? null;
  }

  bindRestoredProvider(sessionId: string, providerName: string): void {
    this.sqlite
      .prepare(
        'UPDATE sessions SET provider_name_at_launch = ? WHERE id = ? AND provider_name_at_launch IS NULL',
      )
      .run(providerName.toLowerCase(), sessionId);
  }

  /**
   * Puts back the row's prior state and owner, and the owner of exactly the given save points. An
   * owner deleted since the claim leaves the row and those save points with their current owner,
   * which deletion could not touch while the row ran: the owner stays valid and nothing stays running.
   * With `agentRevert`, the agent gets its prior config back only while it still has the switch
   * config with no overrides, so a later edit stays. Returns whether the agent row was written.
   */
  rollbackRestore(
    prior: Pick<
      SessionRow,
      'id' | 'agent_id' | 'status' | 'ended_at' | 'tmux_session_id' | 'provider_name_at_launch'
    >,
    now: string,
    movedSavePointIds: readonly string[] = [],
    agentRevert?: RestoreAgentRevert,
  ): Promise<{ agentReverted: boolean }> {
    const owner = 'COALESCE((SELECT id FROM agents WHERE id = @owner), agent_id)';
    return this.txRunner.runImmediateQueued(() => {
      // The prior config can be deleted once no agent uses it; the agent then keeps the switch.
      const agentReverted =
        agentRevert !== undefined &&
        this.sqlite
          .prepare(
            `UPDATE agents SET provider_config_id = @priorConfigId, model_override = @model,
                 effort_override = @effort, updated_at = @now
             WHERE id = @agentId AND provider_config_id = @switchConfigId
               AND model_override IS NULL AND effort_override IS NULL
               AND EXISTS (SELECT 1 FROM profile_provider_configs c
                           WHERE c.id = @priorConfigId AND c.profile_id = agents.profile_id)`,
          )
          .run({
            priorConfigId: agentRevert.prior.providerConfigId,
            model: agentRevert.prior.modelOverride,
            effort: agentRevert.prior.effortOverride,
            now,
            agentId: agentRevert.agentId,
            switchConfigId: agentRevert.switchConfigId,
          }).changes > 0;
      this.sqlite
        .prepare(
          `UPDATE sessions SET agent_id = ${owner}, status = @status, ended_at = @endedAt,
               tmux_session_id = @tmux, provider_name_at_launch = @provider, updated_at = @now
           WHERE id = @id`,
        )
        .run({
          owner: prior.agent_id,
          status: prior.status,
          endedAt: prior.ended_at,
          tmux: prior.tmux_session_id,
          provider: prior.provider_name_at_launch,
          now,
          id: prior.id,
        });
      if (movedSavePointIds.length > 0) {
        this.sqlite
          .prepare(
            `UPDATE sessions SET agent_id = ${owner}, updated_at = @now
             WHERE kind = 'save_point' AND id IN (SELECT value FROM json_each(@ids))`,
          )
          .run({ owner: prior.agent_id, now, ids: JSON.stringify(movedSavePointIds) });
      }
      return { agentReverted };
    });
  }

  retireConfirmedLoss(sessionId: string, now: string): void {
    this.sqlite
      .prepare(
        `UPDATE sessions
         SET status = 'failed', ended_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(now, now, sessionId);
  }

  markLaunchFailed(sessionId: string, now: string): void {
    this.sqlite
      .prepare('UPDATE sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?')
      .run('failed', now, now, sessionId);
  }

  stopOrphan(sessionId: string, now: string): void {
    this.sqlite
      .prepare(`UPDATE sessions SET status = 'stopped', ended_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, sessionId);
  }

  markBusy(sessionId: string, now: string): void {
    this.sqlite
      .prepare(
        `UPDATE sessions SET activity_state = 'busy', busy_since = ?, last_activity_at = ?,
                updated_at = ? WHERE id = ?`,
      )
      .run(now, now, now, sessionId);
  }

  stampLastActivity(sessionId: string, now: string): void {
    this.sqlite
      .prepare(`UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, sessionId);
  }

  markIdleWithActivity(sessionId: string, now: string): void {
    this.sqlite
      .prepare(
        `UPDATE sessions SET activity_state = 'idle', last_activity_at = ?, updated_at = ?
            WHERE id = ?`,
      )
      .run(now, now, sessionId);
  }

  markIdle(sessionId: string, now: string): void {
    this.sqlite
      .prepare(`UPDATE sessions SET activity_state = 'idle', updated_at = ? WHERE id = ?`)
      .run(now, sessionId);
  }

  getTranscriptMetadata(sessionId: string): SessionTranscriptMetadata | undefined {
    return this.sqlite
      .prepare('SELECT transcript_path, provider_session_id FROM sessions WHERE id = ?')
      .get(sessionId) as SessionTranscriptMetadata | undefined;
  }

  bindTranscriptFromHook(input: TranscriptBindInput): number {
    return this.writeTranscriptBinding(input);
  }

  async bindDiscoveredTranscript(input: TranscriptBindInput): Promise<TranscriptBindOutcome> {
    const { sessionId, transcriptPath: normalizedPath, providerSessionId } = input;
    return this.txRunner.runImmediateQueued((): TranscriptBindOutcome => {
      const row = this.readTranscriptRow(sessionId);

      if (!row) {
        return { kind: 'sessionNotFound' };
      }

      if (!row.transcript_path) {
        // Uniqueness guard on (path, providerSessionId): for DB-backed sources
        // many sessions share one container path, so two concurrent discoveries
        // could otherwise bind the same `ses_…`. No-op for file adapters whose
        // candidates carry no providerSessionId (NULL → path-only semantics).
        if (providerSessionId) {
          const conflict = this.sqlite
            .prepare(
              `SELECT id FROM sessions
               WHERE id != ? AND provider_session_id = ? AND transcript_path = ?`,
            )
            .get(sessionId, providerSessionId, normalizedPath) as { id: string } | undefined;
          if (conflict) {
            return { kind: 'providerSessionIdTaken', conflictingSessionId: conflict.id };
          }
        }

        this.writeTranscriptBinding(input);
        return { kind: 'bound' };
      }

      return { kind: 'needsBackfill' };
    });
  }

  /**
   * Set provider_session_id only when absent — the guarded counterpart of
   * bindTranscriptFromHook for confirm-only providers (e.g. Devin) whose hook
   * carries the authoritative id before any transcript file exists. The
   * provider-name guard rejects misdelivery to a session launched under a
   * different provider.
   */
  bindProviderSessionIdIfAbsent(input: {
    sessionId: string;
    providerSessionId: string;
    providerName: string;
    updatedAt: string;
  }): number {
    return this.sqlite
      .prepare(
        `UPDATE sessions
         SET provider_session_id = ?, updated_at = ?
         WHERE id = ?
           AND provider_session_id IS NULL
           AND (provider_name_at_launch IS NULL OR LOWER(provider_name_at_launch) = LOWER(?))`,
      )
      .run(input.providerSessionId, input.updatedAt, input.sessionId, input.providerName).changes;
  }

  async backfillTranscriptProviderSessionId(
    input: TranscriptBackfillInput,
  ): Promise<TranscriptBackfillOutcome> {
    const { normalizedTranscriptPath: incomingPath, updatedAt: now } = input;
    return this.txRunner.runImmediateQueued((): TranscriptBackfillOutcome => {
      const row = this.readTranscriptRow(input.sessionId);

      if (!row) {
        return { kind: 'skipped', sessionId: input.sessionId, reason: 'sessionNotFound' };
      }

      if (!row.transcript_path) {
        return { kind: 'skipped', sessionId: input.sessionId, reason: 'noTranscriptPath' };
      }

      const existingPath = path.normalize(path.resolve(row.transcript_path));
      if (existingPath !== incomingPath) {
        return {
          kind: 'pathMismatch',
          sessionId: input.sessionId,
          existing: row.transcript_path,
          incoming: input.transcriptPath,
        };
      }

      if (row.provider_session_id) {
        return { kind: 'alreadyComplete', sessionId: input.sessionId };
      }

      if (!input.providerSessionId) {
        return { kind: 'noIdAvailable' };
      }

      if (
        row.provider_name_at_launch &&
        row.provider_name_at_launch.toLowerCase() !== input.providerName.toLowerCase()
      ) {
        return { kind: 'skipped', sessionId: input.sessionId, reason: 'providerMismatch' };
      }

      const result = this.sqlite
        .prepare(
          `UPDATE sessions
           SET provider_session_id = ?, updated_at = ?
           WHERE id = ? AND provider_session_id IS NULL`,
        )
        .run(input.providerSessionId, now, input.sessionId);

      if (result.changes === 0) {
        return { kind: 'alreadyComplete', sessionId: input.sessionId };
      }

      return { kind: 'backfilledId', sessionId: input.sessionId };
    });
  }

  private readTranscriptRow(sessionId: string): SessionTranscriptRow | undefined {
    return this.sqlite
      .prepare(
        `SELECT transcript_path, provider_session_id, provider_name_at_launch
         FROM sessions
         WHERE id = ?`,
      )
      .get(sessionId) as SessionTranscriptRow | undefined;
  }

  private writeTranscriptBinding(input: TranscriptBindInput): number {
    return this.sqlite
      .prepare(
        `UPDATE sessions
         SET transcript_path = ?, provider_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.transcriptPath, input.providerSessionId, input.updatedAt, input.sessionId).changes;
  }
}
