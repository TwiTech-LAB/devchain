import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  forwardRef,
} from '@nestjs/common';
import { stat } from 'fs/promises';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { createLogger } from '../../../common/logging/logger';
import { PtyService } from '../../terminal/services/pty.service';
import { PreflightService } from '../../core/services/preflight.service';
import { ProviderMcpEnsureService } from '../../providers/services/provider-mcp-ensure.service';
import { STORAGE_SERVICE, StorageService } from '../../storage/interfaces/storage.interface';
import { SessionDto, SessionHistoryItemDto, SessionHistoryResponseDto } from '../dtos/sessions.dto';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import { TerminalSessionRegistry } from '../../terminal/services/terminal-session/terminal-session-registry';
import { aggregatePresence } from './agent-presence-aggregator';
import { EventsService } from '../../events/services/events.service';
import { SessionCoordinatorService } from './session-coordinator.service';
import { HooksConfigService } from '../../hooks/services/hooks-config.service';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { RuntimeContextCaptureService } from '../../runtime-context-capture/runtime-context-capture.service';
import { ClaudeLaunchSettingsMaterializerService } from '../../runtime-context-capture/claude-launch-settings-materializer.service';
import { CodexPluginProfileMaterializerService } from '../../runtime-context-capture/codex-plugin-profile-materializer.service';
import type { SessionTerminationContext } from '../../events/catalog/session.stopped';

const logger = createLogger('SessionsService');

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

interface HistorySessionRow {
  id: string;
  provider_session_id: string | null;
  provider_name_at_launch: string | null;
  status: 'stopped' | 'failed';
  started_at: string;
  ended_at: string | null;
  last_activity_at: string | null;
  size_bytes: number | null;
  transcript_path: string | null;
  name: string | null;
}

/**
 * SessionsService
 * Orchestrates session lifecycle: terminate, query, inject
 *
 * Launch and restore are now handled by SessionLaunchPipeline and
 * SessionRestorePipeline in session-runtime/.
 */
@Injectable()
export class SessionsService {
  private sqlite: ReturnType<typeof getRawSqliteClient>;
  private txRunner: TransactionRunner;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(forwardRef(() => TerminalIOService)) private readonly terminalIO: TerminalIOService,
    @Inject(forwardRef(() => PtyService)) private readonly ptyService: PtyService,
    @Inject(forwardRef(() => PreflightService)) private readonly preflightService: PreflightService,
    private readonly mcpEnsureService: ProviderMcpEnsureService,
    private readonly sessionCoordinator: SessionCoordinatorService,
    private readonly hooksConfigService: HooksConfigService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    @Inject(forwardRef(() => EventsService))
    private readonly eventsService: EventsService,
    @Inject(forwardRef(() => TerminalSessionRegistry))
    private readonly terminalSessionRegistry: TerminalSessionRegistry,
    private readonly runtimeContextCapture: RuntimeContextCaptureService,
    private readonly claudeLaunchSettings: ClaudeLaunchSettingsMaterializerService,
    private readonly codexPluginProfiles: CodexPluginProfileMaterializerService,
  ) {
    this.sqlite = getRawSqliteClient(this.db);
    this.txRunner = new TransactionRunner(this.sqlite);
    logger.info('SessionsService initialized');
  }

  /**
   * Terminate a session
   */
  async terminateSession(sessionId: string, termination: SessionTerminationContext): Promise<void> {
    logger.info({ sessionId }, 'Terminating session');

    // Resolve the lock key without performing any lifecycle effects. Launch and
    // restore use the same agent key, so their publication windows finish before
    // termination can inspect or dismantle the session they are creating.
    const source = this.sqlite
      .prepare('SELECT id, agent_id FROM sessions WHERE id = ?')
      .get(sessionId) as { id: string; agent_id: string | null } | undefined;
    if (!source) {
      logger.warn({ sessionId }, 'Session not found, treating as already terminated');
      return;
    }

    await this.sessionCoordinator.withAgentLock(source.agent_id ?? source.id, async () => {
      const session = this.getSession(sessionId);
      if (!session) {
        logger.warn({ sessionId }, 'Session disappeared while waiting to terminate');
        return;
      }

      if (session.status !== 'running') {
        logger.info(
          { sessionId, status: session.status },
          'Session already stopped, treating as success',
        );
        if (session.tmuxSessionId) {
          const destroyResult = await this.terminalIO.destroyExpectedSession(
            { name: session.tmuxSessionId },
            { onUnknownError: 'retire' },
          );
          if (destroyResult.outcome === 'unknown-error') throw destroyResult.error;
        }
        this.ptyService.stopStreaming(sessionId);
        this.terminalSessionRegistry.dispose(sessionId);
        this.runtimeContextCapture.clear(sessionId);
        this.claudeLaunchSettings.cleanupSessionSync(sessionId);
        await this.codexPluginProfiles.cleanupSession(sessionId);
        return;
      }

      // Durable state remains running until tmux destruction is confirmed or
      // tmux authoritatively reports that the exact session is absent.
      if (session.tmuxSessionId) {
        const destroyResult = await this.terminalIO.destroyExpectedSession(
          { name: session.tmuxSessionId },
          { onUnknownError: 'rearm', sessionId },
        );
        if (destroyResult.outcome === 'unknown-error') throw destroyResult.error;
        if (destroyResult.outcome === 'known-absent') {
          logger.warn(
            { sessionId, tmuxSessionId: session.tmuxSessionId },
            'Tmux session already gone, cleaning up database record',
          );
        }
      }

      this.ptyService.stopStreaming(sessionId);
      this.terminalSessionRegistry.dispose(sessionId);
      this.runtimeContextCapture.clear(sessionId);
      this.claudeLaunchSettings.cleanupSessionSync(sessionId);
      await this.codexPluginProfiles.cleanupSession(sessionId).catch(() => {
        logger.warn(
          { sessionId, errorCode: 'CODEX_PROFILE_CLEANUP_FAILED' },
          'Failed to clean Codex profile lifecycle after session termination',
        );
      });

      // Best-effort: read transcript file size at stop time to avoid per-request stat on history queries.
      // If transcript_path is NULL or stat fails (deleted file, race with auto-discovery), leave size_bytes NULL.
      let sizeBytes: number | null = null;
      if (session.transcriptPath) {
        try {
          const fileStat = await stat(session.transcriptPath);
          sizeBytes = fileStat.size;
        } catch (error) {
          logger.warn(
            { error, sessionId, transcriptPath: session.transcriptPath },
            'Could not stat transcript file for size_bytes — leaving NULL (best-effort)',
          );
        }
      }

      // Update session status; fold size_bytes into the same statement to keep stop atomic.
      const now = new Date().toISOString();
      this.sqlite
        .prepare(
          `
        UPDATE sessions
        SET status = ?, ended_at = ?, size_bytes = ?, updated_at = ?
        WHERE id = ?
      `,
        )
        .run('stopped', now, sizeBytes, now, sessionId);

      logger.info({ sessionId }, 'Session terminated');

      // EventsService.publish uses synchronous emission. Keeping publication in
      // the locked branch cannot acquire the coordinator re-entrantly.
      await this.eventsService.publish('session.stopped', { sessionId, ...termination });

      if (session.agentId) {
        try {
          await this.eventsService.publish('session.presence.changed', {
            agentId: session.agentId,
            online: false,
            sessionId: null,
          });
        } catch (error) {
          logger.warn(
            { error, agentId: session.agentId, sessionId },
            'Failed to broadcast presence update',
          );
        }
      }
    });
  }

  async getAgentSessionHistory(
    agentId: string,
    projectId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<SessionHistoryResponseDto> {
    const agent = await this.storage.getAgent(agentId);
    if (agent.projectId !== projectId) {
      throw new ForbiddenException('PROJECT_MISMATCH');
    }

    const clampedLimit = Math.min(Math.max(1, limit), 100);
    const sortExpr = `COALESCE(last_activity_at, ended_at, started_at)`;
    const selectCols = `id, provider_session_id, provider_name_at_launch, status, started_at, ended_at, last_activity_at, size_bytes, transcript_path, name`;
    const baseStatus = `status IN ('stopped','failed')`;

    // Total count uses base filters only — no cursor predicate (stable across pages)
    const { cnt: total } = this.sqlite
      .prepare(`SELECT COUNT(*) as cnt FROM sessions WHERE agent_id = ? AND ${baseStatus}`)
      .get(agentId) as { cnt: number };

    // Decode opaque cursor
    let cursorSortKey: string | null = null;
    let cursorId: string | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as {
          s: string;
          i: string;
        };
        cursorSortKey = decoded.s;
        cursorId = decoded.i;
      } catch {
        // Malformed cursor — treat as first page
      }
    }

    let rows: HistorySessionRow[];
    if (cursorSortKey && cursorId) {
      rows = this.sqlite
        .prepare(
          `SELECT ${selectCols} FROM sessions
           WHERE agent_id = ? AND ${baseStatus}
             AND (${sortExpr} < ? OR (${sortExpr} = ? AND id < ?))
           ORDER BY ${sortExpr} DESC, id DESC
           LIMIT ?`,
        )
        .all(
          agentId,
          cursorSortKey,
          cursorSortKey,
          cursorId,
          clampedLimit + 1,
        ) as HistorySessionRow[];
    } else {
      rows = this.sqlite
        .prepare(
          `SELECT ${selectCols} FROM sessions
           WHERE agent_id = ? AND ${baseStatus}
           ORDER BY ${sortExpr} DESC, id DESC
           LIMIT ?`,
        )
        .all(agentId, clampedLimit + 1) as HistorySessionRow[];
    }

    const hasMore = rows.length > clampedLimit;
    const pageRows = hasMore ? rows.slice(0, clampedLimit) : rows;

    // Lazy size backfill — bounded to current page, best-effort
    const now = new Date().toISOString();
    for (const row of pageRows) {
      if (row.size_bytes === null && row.transcript_path !== null) {
        try {
          const fileStat = await stat(row.transcript_path);
          this.sqlite
            .prepare(`UPDATE sessions SET size_bytes = ?, updated_at = ? WHERE id = ?`)
            .run(fileStat.size, now, row.id);
          row.size_bytes = fileStat.size;
        } catch {
          // best-effort — leave NULL
        }
      }
    }

    let nextCursor: string | null = null;
    if (hasMore && pageRows.length > 0) {
      const last = pageRows[pageRows.length - 1];
      const sortKey = last.last_activity_at ?? last.ended_at ?? last.started_at;
      nextCursor = Buffer.from(JSON.stringify({ s: sortKey, i: last.id })).toString('base64url');
    }

    const items: SessionHistoryItemDto[] = pageRows.map((row) => ({
      id: row.id,
      providerSessionId: row.provider_session_id ?? null,
      providerNameAtLaunch: row.provider_name_at_launch,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at,
      sizeBytes: row.size_bytes,
      transcriptAvailable: row.transcript_path !== null,
      name: row.name ?? null,
    }));

    return { items, nextCursor, hasMore, total };
  }

  /**
   * Running sessions that already have a persisted transcript path — the inputs
   * needed to re-attach a transcript watcher after a local-app restart.
   *
   * The transcript watcher only otherwise starts on `session.started` (i.e. when a
   * session is launched), so without rehydration, sessions that were already
   * running before boot lose live `session.transcript.updated` events until they
   * are reopened. See {@link TranscriptWatcherRehydrator}.
   */
  listRunningTranscriptSessions(): Array<{
    sessionId: string;
    transcriptPath: string;
    providerName: string;
    providerSessionId: string | null;
  }> {
    const rows = this.sqlite
      .prepare(
        `SELECT id, transcript_path, provider_name_at_launch, provider_session_id
         FROM sessions
         WHERE status = 'running'
           AND transcript_path IS NOT NULL
           AND provider_name_at_launch IS NOT NULL`,
      )
      .all() as Array<{
      id: string;
      transcript_path: string | null;
      provider_name_at_launch: string | null;
      provider_session_id: string | null;
    }>;
    return rows
      .filter((r) => r.transcript_path && r.provider_name_at_launch)
      .map((r) => ({
        sessionId: r.id,
        transcriptPath: r.transcript_path!,
        providerName: r.provider_name_at_launch!,
        providerSessionId: r.provider_session_id ?? null,
      }));
  }

  /**
   * Get session by ID
   */
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
      logger.debug({ sessionId }, 'Session not found in database');
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

  /**
   * List all active sessions
   */
  async listActiveSessions(
    projectId?: string,
    allowedAgentIds?: Set<string>,
  ): Promise<SessionDto[]> {
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

    let sessions = rows.map((row) => ({
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
    }));

    if (projectId) {
      let agentSet = allowedAgentIds;
      if (!agentSet) {
        const agents = await this.storage.listAgents(projectId);
        agentSet = new Set(agents.items.map((agent) => agent.id));
      }
      sessions = sessions.filter((session) => session.agentId && agentSet!.has(session.agentId));
    }

    return sessions;
  }

  /**
   * Get active session for a specific agent (fast DB-only check, no tmux validation)
   * Returns the session if found, null otherwise
   */
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

    if (!row) {
      return null;
    }

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

  /**
   * Fast check for active sessions in a project (no tmux validation)
   * Used by import guard to quickly detect if sessions need to be stopped
   */
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

    return rows.map((row) => ({
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
    }));
  }

  /**
   * Get agent presence: map agentId to session info
   * Returns map of agentId → { online: boolean, sessionId?: string }
   */
  async getAgentPresence(projectId?: string): Promise<
    Map<
      string,
      {
        online: boolean;
        sessionId?: string;
        activityState?: 'idle' | 'busy' | null;
        lastActivityAt?: string | null;
        busySince?: string | null;
        idleSince?: string | null;
        currentActivityTitle?: string | null;
      }
    >
  > {
    let allowedAgentIds: Set<string> | undefined;
    if (projectId) {
      const agents = await this.storage.listAgents(projectId);
      allowedAgentIds = new Set(agents.items.map((agent) => agent.id));
    }

    const activeSessions = await this.listActiveSessions(projectId, allowedAgentIds);

    const sessionAgentMappings = activeSessions
      .filter((s) => s.agentId)
      .map((s) => ({ sessionId: s.id, agentId: s.agentId! }));

    const aggregated = aggregatePresence(
      this.terminalSessionRegistry,
      sessionAgentMappings,
      allowedAgentIds,
    );

    const presenceMap = new Map<
      string,
      {
        online: boolean;
        sessionId?: string;
        activityState?: 'idle' | 'busy' | null;
        lastActivityAt?: string | null;
        busySince?: string | null;
        idleSince?: string | null;
        currentActivityTitle?: string | null;
      }
    >();

    for (const session of activeSessions) {
      if (session.agentId) {
        const agg = aggregated.get(session.agentId);
        presenceMap.set(session.agentId, {
          online: true,
          sessionId: session.id,
          activityState: agg?.activityState ?? session.activityState ?? null,
          lastActivityAt: agg?.lastActivityAt ?? session.lastActivityAt ?? null,
          busySince: agg?.busySince ?? session.busySince ?? null,
          idleSince: agg?.idleSince ?? null,
          currentActivityTitle: null,
        });
      }
    }

    if (allowedAgentIds) {
      for (const agentId of allowedAgentIds) {
        if (!presenceMap.has(agentId)) {
          presenceMap.set(agentId, { online: false });
        }
      }
    }

    return presenceMap;
  }

  /**
   * Shared ownership guard for session-id-centric mutations (rename / delete
   * record) over BOTH the REST controllers and the mobile cloud-tunnel RPCs.
   * Centralizing it here prevents the two transports' guards from drifting.
   *
   * Chain (mirrors the original REST controller logic):
   *   (1) session exists                  → NotFoundError ('not_found', 404)
   *   (2) session.agentId present         → ForbiddenError ('forbidden', 403)
   *   (3) agent.projectId === projectId   → ForbiddenError ('forbidden', 403)
   *
   * Throws domain `AppError`s (not NestJS HTTP exceptions) so the tunnel's
   * `toJsonRpcError` preserves the domain code under `error.data.code`; the REST
   * layer's global `AllExceptionsFilter` maps the same errors to 404/403.
   * Returns the loaded session so callers can layer extra checks (e.g. delete's
   * running-status guard).
   */
  async validateSessionInProject(sessionId: string, projectId: string): Promise<SessionDto> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session', sessionId);
    }
    if (!session.agentId) {
      throw new ForbiddenError('PROJECT_MISMATCH', {
        code: 'SESSION_PROJECT_MISMATCH',
        sessionId,
      });
    }
    const agent = await this.storage.getAgent(session.agentId);
    if (agent.projectId !== projectId) {
      throw new ForbiddenError('PROJECT_MISMATCH', {
        code: 'SESSION_PROJECT_MISMATCH',
        sessionId,
        projectId,
      });
    }
    return session;
  }

  updateName(sessionId: string, name: string | null): SessionDto {
    const trimmed = name?.trim() || null;

    if (trimmed !== null && trimmed.length > 120) {
      throw new ValidationError('Session name must be 120 characters or fewer', {
        sessionId,
        length: trimmed.length,
      });
    }

    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(`UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?`)
      .run(trimmed, now, sessionId);

    if (result.changes === 0) {
      throw new NotFoundError('Session', sessionId);
    }

    const updated = this.getSession(sessionId);
    if (!updated) {
      throw new NotFoundError('Session', sessionId);
    }
    return updated;
  }

  hardDeleteRecord(sessionId: string): { deleted: boolean } {
    const session = this.getSession(sessionId);
    if (session?.status === 'running') {
      throw new ValidationError('Cannot delete a running session', { sessionId });
    }

    return this.txRunner.runImmediate(() => {
      this.sqlite
        .prepare('DELETE FROM chat_thread_session_invites WHERE session_id = ?')
        .run(sessionId);
      const result = this.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
      return { deleted: result.changes > 0 };
    });
  }

  /**
   * Inject text into an active session's tmux pane and submit it.
   * Uses bracketed paste + Enter to improve reliability across provider TUIs.
   * Throttles per agent to avoid overlapping pastes.
   */
  async injectTextIntoSession(
    sessionId: string,
    text: string,
  ): Promise<{ confirmed: boolean; method?: string }> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(`Session not found: ${sessionId}`);
    }

    if (session.status !== 'running') {
      throw new ValidationError(`Session is not running: ${sessionId}`, {
        sessionId,
        status: session.status,
      });
    }

    if (!session.tmuxSessionId) {
      throw new ValidationError(`Session has no tmux session: ${sessionId}`, {
        sessionId,
      });
    }

    logger.info({ sessionId, tmuxSessionId: session.tmuxSessionId }, 'Injecting text into session');

    const agentId = session.agentId ?? undefined;
    const postPasteDelayMs = agentId
      ? await this.providerAdapterFactory.getPostPasteDelayMsForAgent(agentId)
      : undefined;

    if (!agentId) {
      // deliverImmediate: no agent context, no gap enforcement possible
      const result = await this.terminalIO.deliverImmediate({ name: session.tmuxSessionId }, text, {
        submitKeys: ['Enter'],
        postPasteDelayMs,
      });
      return { confirmed: result.confirmed, method: result.method };
    }

    const draftKeys = await this.providerAdapterFactory.getPromptDraftKeysForAgent(agentId);

    const result = await this.terminalIO.deliver({ name: session.tmuxSessionId }, text, {
      agentId,
      submitKeys: ['Enter'],
      postPasteDelayMs,
      draftKeys,
    });

    return { confirmed: result.confirmed, method: result.method };
  }
}
