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

// Lifecycle/activity writes join caller-owned boundaries; discovery/backfill own queued admission.
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

  restoreRunning(sessionId: string, tmuxSessionName: string, now: string): void {
    this.sqlite
      .prepare(
        `UPDATE sessions SET status = 'running', tmux_session_id = ?, ended_at = NULL,
             last_activity_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(tmuxSessionName, now, now, sessionId);
  }

  rollbackRestore(
    sessionId: string,
    status: string,
    endedAt: string | null,
    tmuxSessionId: string | null,
    now: string,
  ): void {
    this.sqlite
      .prepare(
        `UPDATE sessions SET status = ?, ended_at = ?, tmux_session_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, endedAt, tmuxSessionId, now, sessionId);
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
