import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { EventsService } from '../../events/services/events.service';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import {
  ProviderAdapterFactory,
  isHookCapable,
  isTranscriptDiscoveryCapable,
} from '../../providers/adapters';
import { readFileHead } from '../adapters/utils/file-search.util';
import type {
  SessionFileInfo,
  SessionReaderAdapter,
  TranscriptCandidateMetadata,
} from '../adapters/session-reader-adapter.interface';
import type { ClaudeHooksSessionStartedEventPayload } from '../../events/catalog/claude.hooks.session.started';
import type { SessionStartedEventPayload } from '../../events/catalog/session.started';

/** Max retries for auto-discovery when file doesn't exist yet */
const DISCOVERY_MAX_RETRIES = 6;

/** Delay before each retry attempt (ms), indexed by the completed attempt number */
const DISCOVERY_RETRY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** Initial attempt plus configured retries */
const DISCOVERY_MAX_ATTEMPTS = DISCOVERY_MAX_RETRIES + 1;

/** Max candidate files scanned for content matching */
const CONTENT_MATCH_MAX_CANDIDATES = 200;

/** Max bytes to scan from JSONL providers (Codex/Claude-style) */
const CONTENT_SEARCH_MAX_BYTES_JSONL = 16_384;

/** Timestamp heuristic match window around session.started timestamp */
const CONTENT_TIMESTAMP_WINDOW_MS = 120_000;

/** Tight metadata match window before final retry */
const METADATA_TIMESTAMP_WINDOW_MS = 30_000;

/** Warn threshold for discovered transcript file size (10MB) */
const DISCOVERED_FILE_WARN_BYTES = 10 * 1024 * 1024;

interface CandidateReadResult {
  file: SessionFileInfo;
  content: string;
  contentTimestamp: Date | null;
  candidateMetadata?: TranscriptCandidateMetadata;
}

type MatchType = 'metadata' | 'metadata+content' | 'content' | 'short-id' | 'timestamp-fallback';

interface CandidateMatch {
  file: SessionFileInfo;
  matchType: MatchType;
}

interface AssignedTranscriptPathRow {
  id: string;
  transcript_path: string | null;
}

export type PersistOutcome =
  | { kind: 'persisted'; sessionId: string }
  | { kind: 'persistedPathOnly'; sessionId: string }
  | { kind: 'backfilledId'; sessionId: string }
  | { kind: 'alreadyComplete'; sessionId: string }
  | { kind: 'pathMismatch'; sessionId: string; existing: string; incoming: string }
  | { kind: 'skipped'; sessionId: string; reason: string };

type DiscoveryGate =
  | { needsAny: true; transcriptPath: string | null; providerSessionId: string | null }
  | { needsAny: false };

interface SessionDiscoveryRow {
  transcript_path: string | null;
  provider_session_id: string | null;
  provider_name_at_launch: string | null;
}

interface ProviderSessionIdBackfillInput {
  sessionId: string;
  providerName: string;
  transcriptPath: string;
  providerSessionId: string | null;
  emitEvent?: boolean;
}

@Injectable()
export class TranscriptPersistenceListener {
  private readonly logger = new Logger(TranscriptPersistenceListener.name);
  private readonly sqlite: Database.Database;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly validator: TranscriptPathValidator,
    private readonly events: EventsService,
    private readonly adapterFactory: SessionReaderAdapterFactory,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
  ) {
    this.sqlite = getRawSqliteClient(db);
  }

  // ---------------------------------------------------------------------------
  // Hook-based discovery (existing)
  // ---------------------------------------------------------------------------

  @OnEvent('claude.hooks.session.started', { async: true })
  async handleHookSessionStarted(payload: ClaudeHooksSessionStartedEventPayload): Promise<void> {
    try {
      await this.processHookPayload(payload);
    } catch (error) {
      // Non-blocking: log but never propagate
      this.logger.error(
        { error, sessionId: payload.sessionId, claudeSessionId: payload.claudeSessionId },
        'Failed to persist transcript metadata — continuing silently',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Auto-discovery on session launch (new)
  // ---------------------------------------------------------------------------

  @OnEvent('session.started', { async: true })
  async handleSessionStarted(payload: SessionStartedEventPayload): Promise<void> {
    try {
      await this.discoverTranscriptWithRetry(payload.sessionId, payload.agentId);
    } catch (error) {
      this.logger.error(
        { error, sessionId: payload.sessionId },
        'Failed to auto-discover transcript — continuing silently',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Hook-based persistence
  // ---------------------------------------------------------------------------

  private async processHookPayload(payload: ClaudeHooksSessionStartedEventPayload): Promise<void> {
    const providerName = (payload.providerName ?? 'claude').toLowerCase();

    // Bind-vs-confirm derives from HookCapability.hooksProvideTranscriptPath:
    // claude (=true) binds from the hook; copilot (=false) confirms a launch-time
    // binding. Legacy default: absent providerName → 'claude' → bind (identical).
    // Unresolvable or non-hook-capable adapter → confirm-only (fail-safe).
    if (!this.hooksBindTranscriptPath(providerName)) {
      this.confirmProviderHookLifecycle(payload, providerName);
      return;
    }

    const { transcriptPath, sessionId, agentId, projectId } = payload;
    const providerSessionId = payload.providerSessionId ?? payload.claudeSessionId;

    // Skip if no transcript path provided
    if (!transcriptPath) {
      this.logger.debug(
        { sessionId, providerSessionId },
        'No transcriptPath in hook payload — skipping persistence',
      );
      return;
    }

    // Skip if no session to update
    if (!sessionId) {
      this.logger.warn(
        { providerSessionId, transcriptPath },
        'Hook payload missing sessionId — cannot persist transcript path',
      );
      return;
    }

    // Validate path shape (does not check file existence)
    let normalizedPath: string;
    try {
      normalizedPath = this.validator.validateShape(transcriptPath, providerName);
    } catch (error) {
      this.logger.warn(
        { error, transcriptPath, sessionId },
        'Transcript path failed validation — skipping persistence',
      );
      return;
    }

    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE sessions
         SET transcript_path = ?, provider_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(normalizedPath, providerSessionId, now, sessionId);

    if (result.changes === 0) {
      this.logger.warn(
        { sessionId, providerSessionId },
        'Session not found for transcript persistence — hook may have arrived before session record was created',
      );
      return;
    }

    this.logger.log(
      { sessionId, transcriptPath: normalizedPath, providerSessionId },
      'Persisted transcript metadata to session',
    );

    // Publish discovery event (only if agentId is available)
    if (agentId) {
      await this.events.publish('session.transcript.discovered', {
        sessionId,
        agentId,
        projectId,
        transcriptPath: normalizedPath,
        providerName,
        providerSessionId: providerSessionId ?? undefined,
      });
    }
  }

  /**
   * Resolve whether the provider's hook provides the transcript path (bind) or
   * merely confirms a deterministic Phase-1 binding. Returns false when the
   * adapter is unresolvable or lacks HookCapability (fail-safe → confirm-only).
   */
  private hooksBindTranscriptPath(providerName: string): boolean {
    try {
      const adapter = this.providerAdapterFactory.getAdapter(providerName);
      return isHookCapable(adapter) && adapter.hooksProvideTranscriptPath;
    } catch {
      return false;
    }
  }

  /**
   * Provider hook lifecycle CONFIRMATION (Copilot — HookCapability adopter #2).
   *
   * Unlike Claude (whose transcript binding comes FROM the hook), providers that
   * bind deterministically at launch already have `transcript_path` +
   * `provider_session_id` set by Phase-1 by the time the hook fires. So this path
   * NEVER (re)binds: it verifies the hook's ids/path agree with the bound session
   * and WARNS on mismatch, leaving the row untouched (a rebind primitive is
   * deliberately out of scope — backlog). Copilot `SessionStart` carries no
   * `transcriptPath` (confirm by provider session id only); `Stop` carries it
   * (confirm both). Idempotent and side-effect-free on the happy path.
   */
  private confirmProviderHookLifecycle(
    payload: ClaudeHooksSessionStartedEventPayload,
    providerName: string,
  ): void {
    const { sessionId, transcriptPath } = payload;
    const incomingProviderSessionId = payload.providerSessionId ?? payload.claudeSessionId ?? null;

    if (!sessionId) {
      this.logger.warn(
        { providerName, providerSessionId: incomingProviderSessionId },
        'Provider hook missing sessionId — cannot confirm lifecycle binding',
      );
      return;
    }

    const row = this.sqlite
      .prepare('SELECT transcript_path, provider_session_id FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { transcript_path: string | null; provider_session_id: string | null }
      | undefined;

    if (!row) {
      this.logger.warn(
        { sessionId, providerName },
        'Provider hook for unknown session — skipping (Phase-1 owns binding; no rebind)',
      );
      return;
    }

    // Confirm the provider session id Phase-1 bound deterministically.
    if (
      incomingProviderSessionId &&
      row.provider_session_id &&
      incomingProviderSessionId !== row.provider_session_id
    ) {
      this.logger.warn(
        {
          sessionId,
          providerName,
          bound: row.provider_session_id,
          incoming: incomingProviderSessionId,
        },
        'Provider hook provider_session_id mismatch — NOT overwriting bound session (rebind unsupported)',
      );
      return;
    }

    // Confirm the transcript path when the hook carries one (Copilot `Stop`).
    if (
      transcriptPath &&
      row.transcript_path &&
      this.normalizePathForCompare(transcriptPath) !==
        this.normalizePathForCompare(row.transcript_path)
    ) {
      this.logger.warn(
        { sessionId, providerName, bound: row.transcript_path, incoming: transcriptPath },
        'Provider hook transcript_path mismatch — NOT overwriting bound session (rebind unsupported)',
      );
      return;
    }

    this.logger.debug(
      { sessionId, providerName, stage: transcriptPath ? 'stop' : 'sessionStart' },
      'Provider hook lifecycle confirmed (idempotent; Phase-1 owns binding)',
    );
  }

  // ---------------------------------------------------------------------------
  // Private: Auto-discovery with retry
  // ---------------------------------------------------------------------------

  private async discoverTranscriptWithRetry(sessionId: string, agentId: string): Promise<void> {
    // Resolve provider chain: agent → providerConfig → provider
    const resolution = await this.resolveProviderChain(agentId);
    if (!resolution) return;

    const providerName = resolution.providerName.toLowerCase();
    const { projectRoot, projectId } = resolution;

    const adapter = this.adapterFactory.getAdapter(providerName);
    if (!adapter) {
      this.logger.debug(
        { sessionId, providerName },
        'No session-reader adapter for provider — skipping auto-discovery',
      );
      return;
    }

    const realpathCache = new Map<string, string>();
    let resolvedProjectRoot: string | null = null;
    const getResolvedProjectRoot = async (): Promise<string> => {
      if (!resolvedProjectRoot) {
        resolvedProjectRoot = await this.safeRealpathCached(projectRoot, realpathCache);
      }
      return resolvedProjectRoot;
    };

    for (let attempt = 1; attempt <= DISCOVERY_MAX_ATTEMPTS; attempt++) {
      const isFinalAttempt = attempt === DISCOVERY_MAX_ATTEMPTS;

      // Check if discovery/backfill is already complete (via hooks or previous retry)
      const gate = this.getDiscoveryGate(sessionId);
      if (!gate.needsAny) {
        this.logger.debug(
          { sessionId, attempt },
          'Transcript metadata already complete — skipping auto-discovery',
        );
        return;
      }

      // DB-backed adapters additionally need the launch timestamp for SQL
      // window-matching. Both shapes now carry `sessionId`: file adapters that
      // bind deterministically (Copilot derives `…/session-state/<sessionId>/`)
      // read it, while existing file adapters (Claude/Codex) ignore it —
      // a backward-compatible widening of the discovery context.
      const discoveryContext =
        adapter.sourceKind === 'db'
          ? {
              projectRoot,
              sessionStartedAt: this.getSessionStartedAt(sessionId) ?? undefined,
              sessionId,
            }
          : { projectRoot, sessionId };
      const files = await adapter.discoverSessionFile(discoveryContext);

      // DB-backed sources (e.g. OpenCode): one container holds many sessions, so
      // discovery is the adapter's structured SQL match — NOT JSONL head-reading.
      // Dedupe by (path, providerSessionId) with an ambiguity guard.
      if (adapter.sourceKind === 'db') {
        const stop = await this.handleDbBackedDiscovery(
          files,
          sessionId,
          agentId,
          projectId,
          providerName,
          attempt,
          isFinalAttempt,
        );
        if (stop) return;
        if (!isFinalAttempt) await this.delayBeforeRetry(attempt);
        continue;
      }

      if (files.length > 0) {
        const provAdapter = this.resolveProviderAdapter(providerName);
        if (
          provAdapter &&
          isTranscriptDiscoveryCapable(provAdapter) &&
          provAdapter.transcriptDiscoveryStrategy === 'first'
        ) {
          const outcome = await this.persistDiscoveredPath(
            sessionId,
            agentId,
            projectId,
            files[0],
            providerName,
          );
          if (this.shouldStopAfterPersistOutcome(outcome, isFinalAttempt, attempt)) {
            return;
          }
          await this.delayBeforeRetry(attempt);
          continue;
        }

        const readCandidates = await this.readCandidates(files, providerName, adapter, sessionId);
        const candidates = await this.excludeAlreadyAssignedCandidates(
          readCandidates,
          sessionId,
          realpathCache,
        );

        if (adapter.extractCandidateMetadata) {
          const sessionStartedAt = this.getSessionStartedAt(sessionId);
          if (sessionStartedAt) {
            const metadataMatch = await this.findByMetadata(candidates, {
              projectRootRealpath: await getResolvedProjectRoot(),
              sessionStartedAt,
              attempt,
              maxRetries: DISCOVERY_MAX_ATTEMPTS,
              realpathCache,
              sessionId,
            });

            if (metadataMatch) {
              this.logger.log(
                {
                  sessionId,
                  providerName,
                  filePath: metadataMatch.file.filePath,
                  matchType: metadataMatch.matchType,
                  attempt,
                  candidatesScanned: candidates.length,
                },
                'Auto-discovered transcript via Codex metadata match',
              );

              const outcome = await this.persistDiscoveredPath(
                sessionId,
                agentId,
                projectId,
                metadataMatch.file,
                providerName,
              );
              if (this.shouldStopAfterPersistOutcome(outcome, isFinalAttempt, attempt)) {
                return;
              }
              await this.delayBeforeRetry(attempt);
              continue;
            }
          }
        }

        const contentMatch = this.findMatchByContent(candidates, sessionId);

        if (contentMatch) {
          this.logger.log(
            {
              sessionId,
              providerName,
              filePath: contentMatch.file.filePath,
              matchType: contentMatch.matchType,
              attempt,
              candidatesScanned: candidates.length,
            },
            'Auto-discovered transcript via content match',
          );

          const outcome = await this.persistDiscoveredPath(
            sessionId,
            agentId,
            projectId,
            contentMatch.file,
            providerName,
          );
          if (this.shouldStopAfterPersistOutcome(outcome, isFinalAttempt, attempt)) {
            return;
          }
          await this.delayBeforeRetry(attempt);
          continue;
        }

        if (isFinalAttempt) {
          const sessionStartedAt = this.getSessionStartedAt(sessionId);
          if (sessionStartedAt) {
            // Workspace filtering is presence-based: narrow by cwd only when at
            // least one candidate surfaced a workspacePath. Providers whose
            // adapter yields no workspace metadata rank all in-window matches.
            const hasWorkspaceMetadata = candidates.some(
              (candidate) => candidate.candidateMetadata?.workspacePath,
            );
            const timestampHeuristicMatch = await this.findByContentTimestampWindow(
              candidates,
              sessionStartedAt,
              CONTENT_TIMESTAMP_WINDOW_MS,
              hasWorkspaceMetadata ? await getResolvedProjectRoot() : null,
              realpathCache,
            );
            if (timestampHeuristicMatch) {
              this.logger.warn(
                {
                  sessionId,
                  providerName,
                  filePath: timestampHeuristicMatch.filePath,
                  matchType: 'timestamp-fallback',
                  attempt,
                  candidatesScanned: candidates.length,
                  hint: 'initial prompt may omit {session_id}',
                },
                'Auto-discovered transcript via timestamp heuristic fallback',
              );

              const outcome = await this.persistDiscoveredPath(
                sessionId,
                agentId,
                projectId,
                timestampHeuristicMatch,
                providerName,
              );
              this.shouldStopAfterPersistOutcome(outcome, isFinalAttempt, attempt);
              return;
            }
          }
        }
      }

      if (isFinalAttempt) {
        this.logger.warn(
          {
            sessionId,
            providerName,
            attempt,
            maxRetries: DISCOVERY_MAX_RETRIES,
          },
          'Transcript not found after all discovery retries',
        );
      } else {
        this.logger.debug(
          { sessionId, providerName, attempt, maxRetries: DISCOVERY_MAX_RETRIES },
          'Transcript file not found — will retry',
        );
        await this.delayBeforeRetry(attempt);
      }
    }
  }

  private async resolveProviderChain(
    agentId: string,
  ): Promise<{ providerName: string; projectRoot: string; projectId: string } | null> {
    try {
      const agent = await this.storage.getAgent(agentId);
      const config = await this.storage.getProfileProviderConfig(agent.providerConfigId);
      const provider = await this.storage.getProvider(config.providerId);
      const project = await this.storage.getProject(agent.projectId);

      return {
        providerName: provider.name,
        projectRoot: project.rootPath,
        projectId: project.id,
      };
    } catch (error) {
      this.logger.warn(
        { error, agentId },
        'Failed to resolve provider chain — skipping auto-discovery',
      );
      return null;
    }
  }

  private getDiscoveryGate(sessionId: string): DiscoveryGate {
    const row = this.sqlite
      .prepare('SELECT transcript_path, provider_session_id FROM sessions WHERE id = ?')
      .get(sessionId) as
      | { transcript_path: string | null; provider_session_id: string | null }
      | undefined;

    if (!row) {
      return { needsAny: true, transcriptPath: null, providerSessionId: null };
    }

    if (row.transcript_path && row.provider_session_id) {
      return { needsAny: false };
    }

    return {
      needsAny: true,
      transcriptPath: row.transcript_path,
      providerSessionId: row.provider_session_id,
    };
  }

  /**
   * DB-backed discovery (e.g. OpenCode): the adapter already returned SQL-matched
   * candidates (each a `(dbPath, ses_…)` pair). Exclude `ses_` ids already owned
   * by other sessions, then:
   * - exactly one unassigned → persist it.
   * - more than one → ambiguous: warn and retry (never blind newest-pick).
   * - none → retry.
   * Returns `true` when the retry loop should stop (success or give-up).
   */
  private async handleDbBackedDiscovery(
    files: SessionFileInfo[],
    sessionId: string,
    agentId: string,
    projectId: string,
    providerName: string,
    attempt: number,
    isFinalAttempt: boolean,
  ): Promise<boolean> {
    const candidates = this.excludeAssignedDbCandidates(files, sessionId);

    if (candidates.length === 1) {
      const outcome = await this.persistDiscoveredPath(
        sessionId,
        agentId,
        projectId,
        candidates[0],
        providerName,
      );
      return this.shouldStopAfterPersistOutcome(outcome, isFinalAttempt, attempt);
    }

    if (candidates.length > 1) {
      this.logger.warn(
        { sessionId, providerName, candidateCount: candidates.length, attempt },
        'Ambiguous DB-backed session match (multiple unassigned candidates) — retrying instead of guessing',
      );
      if (isFinalAttempt) {
        this.logger.warn(
          { sessionId, providerName },
          'DB-backed discovery still ambiguous after final attempt — left unassigned',
        );
        return true;
      }
      return false;
    }

    if (isFinalAttempt) {
      this.logger.warn(
        { sessionId, providerName, attempt },
        'No DB-backed session candidate found after final discovery attempt',
      );
      return true;
    }
    return false;
  }

  /**
   * Exclude candidates whose `(transcriptPath, providerSessionId)` is already
   * owned by another session. The shared container path alone does NOT exclude a
   * candidate (that's what distinguishes DB dedupe from the path-only file rule).
   */
  private excludeAssignedDbCandidates(
    files: SessionFileInfo[],
    sessionId: string,
  ): SessionFileInfo[] {
    if (files.length === 0) return files;

    const rows = this.sqlite
      .prepare(
        `SELECT transcript_path, provider_session_id FROM sessions
         WHERE provider_session_id IS NOT NULL AND id != ?`,
      )
      .all(sessionId) as { transcript_path: string | null; provider_session_id: string }[];

    const taken = new Set<string>();
    for (const row of rows) {
      if (row.transcript_path) {
        taken.add(this.dbCandidateKey(row.transcript_path, row.provider_session_id));
      }
    }

    return files.filter(
      (file) =>
        !(
          file.providerSessionId &&
          taken.has(this.dbCandidateKey(file.filePath, file.providerSessionId))
        ),
    );
  }

  private dbCandidateKey(transcriptPath: string, providerSessionId: string): string {
    return `${this.normalizePathForCompare(transcriptPath)}\0${providerSessionId}`;
  }

  private async persistDiscoveredPath(
    sessionId: string,
    agentId: string,
    projectId: string,
    file: SessionFileInfo,
    providerName: string,
  ): Promise<PersistOutcome> {
    if (file.sizeBytes > DISCOVERED_FILE_WARN_BYTES) {
      this.logger.warn(
        { filePath: file.filePath, sizeBytes: file.sizeBytes },
        'Discovered transcript exceeds 10MB',
      );
    }

    // Validate path shape
    let normalizedPath: string;
    try {
      normalizedPath = this.validator.validateShape(file.filePath, providerName);
    } catch (error) {
      this.logger.warn(
        { error, filePath: file.filePath, sessionId },
        'Discovered transcript path failed validation — skipping',
      );
      return { kind: 'skipped', sessionId, reason: 'validationFailed' };
    }

    const providerSessionId = file.providerSessionId ?? null;
    const now = new Date().toISOString();

    let transactionOpen = false;
    this.sqlite.prepare('BEGIN').run();
    transactionOpen = true;
    try {
      const row = this.sqlite
        .prepare(
          `SELECT transcript_path, provider_session_id, provider_name_at_launch
           FROM sessions
           WHERE id = ?`,
        )
        .get(sessionId) as SessionDiscoveryRow | undefined;

      if (!row) {
        this.sqlite.prepare('COMMIT').run();
        transactionOpen = false;
        return { kind: 'skipped', sessionId, reason: 'sessionNotFound' };
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
            this.sqlite.prepare('COMMIT').run();
            transactionOpen = false;
            this.logger.warn(
              { sessionId, conflictingSessionId: conflict.id, providerSessionId, providerName },
              'Provider session id already bound to another session — skipping',
            );
            return { kind: 'skipped', sessionId, reason: 'providerSessionIdTaken' };
          }
        }

        this.sqlite
          .prepare(
            `UPDATE sessions
             SET transcript_path = ?, provider_session_id = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(normalizedPath, providerSessionId, now, sessionId);
        this.sqlite.prepare('COMMIT').run();
        transactionOpen = false;

        if (providerSessionId || !this.requiresProviderSessionIdForRestore(providerName)) {
          this.logger.log(
            { sessionId, transcriptPath: normalizedPath, providerName },
            'Auto-discovered and persisted transcript path',
          );

          await this.events.publish('session.transcript.discovered', {
            sessionId,
            agentId,
            projectId,
            transcriptPath: normalizedPath,
            providerName,
            providerSessionId: providerSessionId ?? undefined,
          });
          return { kind: 'persisted', sessionId };
        }

        this.logger.log(
          { sessionId, transcriptPath: normalizedPath, providerName, pathOnly: true },
          'Auto-discovered and persisted transcript path without provider session id',
        );
        await this.events.publish('session.transcript.discovered', {
          sessionId,
          agentId,
          projectId,
          transcriptPath: normalizedPath,
          providerName,
          providerSessionId: providerSessionId ?? undefined,
        });
        return { kind: 'persistedPathOnly', sessionId };
      }

      this.sqlite.prepare('COMMIT').run();
      transactionOpen = false;

      return this.backfillProviderSessionIdForTranscriptPath({
        sessionId,
        providerName,
        transcriptPath: normalizedPath,
        providerSessionId,
      });
    } catch (error) {
      if (transactionOpen) {
        this.sqlite.prepare('ROLLBACK').run();
      }
      throw error;
    }
  }

  async backfillProviderSessionIdForTranscriptPath(
    input: ProviderSessionIdBackfillInput,
  ): Promise<PersistOutcome> {
    const incomingPath = this.normalizePathForCompare(input.transcriptPath);
    const now = new Date().toISOString();
    const emitEvent = input.emitEvent ?? true;

    let transactionOpen = false;
    this.sqlite.prepare('BEGIN').run();
    transactionOpen = true;
    try {
      const row = this.sqlite
        .prepare(
          `SELECT transcript_path, provider_session_id, provider_name_at_launch
           FROM sessions
           WHERE id = ?`,
        )
        .get(input.sessionId) as SessionDiscoveryRow | undefined;

      if (!row) {
        this.sqlite.prepare('COMMIT').run();
        transactionOpen = false;
        return { kind: 'skipped', sessionId: input.sessionId, reason: 'sessionNotFound' };
      }

      if (!row.transcript_path) {
        this.sqlite.prepare('COMMIT').run();
        transactionOpen = false;
        return { kind: 'skipped', sessionId: input.sessionId, reason: 'noTranscriptPath' };
      }

      const existingPath = this.normalizePathForCompare(row.transcript_path);
      if (existingPath !== incomingPath) {
        this.sqlite.prepare('COMMIT').run();
        transactionOpen = false;
        this.logger.warn(
          {
            sessionId: input.sessionId,
            existing: row.transcript_path,
            incoming: input.transcriptPath,
          },
          'Discovered transcript path does not match existing session path — skipping',
        );
        return {
          kind: 'pathMismatch',
          sessionId: input.sessionId,
          existing: row.transcript_path,
          incoming: input.transcriptPath,
        };
      }

      if (row.provider_session_id) {
        this.sqlite.prepare('COMMIT').run();
        transactionOpen = false;
        return { kind: 'alreadyComplete', sessionId: input.sessionId };
      }

      if (!input.providerSessionId) {
        this.sqlite.prepare('COMMIT').run();
        transactionOpen = false;
        if (this.requiresProviderSessionIdForRestore(input.providerName)) {
          if (emitEvent) {
            this.logger.log(
              {
                sessionId: input.sessionId,
                transcriptPath: input.transcriptPath,
                providerName: input.providerName,
                pathOnly: true,
              },
              'Discovered transcript path still lacks provider session id',
            );
          }
          return { kind: 'persistedPathOnly', sessionId: input.sessionId };
        }

        // Claude's provider id comes from hook payloads, not transcript metadata.
        // Adapter-based Case B therefore no-ops for Claude unless a future adapter
        // starts returning a providerSessionId explicitly.
        return { kind: 'skipped', sessionId: input.sessionId, reason: 'noIdAvailable' };
      }

      if (
        row.provider_name_at_launch &&
        row.provider_name_at_launch.toLowerCase() !== input.providerName.toLowerCase()
      ) {
        this.sqlite.prepare('COMMIT').run();
        transactionOpen = false;
        return { kind: 'skipped', sessionId: input.sessionId, reason: 'providerMismatch' };
      }

      const result = this.sqlite
        .prepare(
          `UPDATE sessions
           SET provider_session_id = ?, updated_at = ?
           WHERE id = ? AND provider_session_id IS NULL`,
        )
        .run(input.providerSessionId, now, input.sessionId);
      this.sqlite.prepare('COMMIT').run();
      transactionOpen = false;

      if (result.changes === 0) {
        return { kind: 'alreadyComplete', sessionId: input.sessionId };
      }

      if (emitEvent) {
        this.logger.log(
          {
            sessionId: input.sessionId,
            providerName: input.providerName,
            providerSessionId: input.providerSessionId,
            repaired: true,
          },
          'Backfilled provider session id for discovered transcript',
        );

        await this.events.publish('session.providerSessionId.discovered', {
          sessionId: input.sessionId,
          providerSessionId: input.providerSessionId,
          providerName: input.providerName,
        });
      }

      return { kind: 'backfilledId', sessionId: input.sessionId };
    } catch (error) {
      if (transactionOpen) {
        this.sqlite.prepare('ROLLBACK').run();
      }
      throw error;
    }
  }

  private shouldStopAfterPersistOutcome(
    outcome: PersistOutcome,
    isFinalAttempt: boolean,
    attempt?: number,
    maxRetries = DISCOVERY_MAX_RETRIES,
  ): boolean {
    switch (outcome.kind) {
      case 'persisted':
      case 'backfilledId':
      case 'alreadyComplete':
        return true;
      case 'persistedPathOnly':
        if (isFinalAttempt) {
          this.logger.warn(
            {
              sessionId: outcome.sessionId,
              reason: 'providerSessionIdNotFlushed',
              attempt,
              maxRetries,
            },
            'Provider session id not available after final discovery attempt',
          );
          return true;
        }
        return false;
      case 'pathMismatch':
      case 'skipped':
        this.logger.warn(outcome, 'Transcript persistence did not complete');
        return true;
    }
  }

  private normalizePathForCompare(filePath: string): string {
    return path.normalize(path.resolve(filePath));
  }

  private async safeRealpath(filePath: string): Promise<string> {
    try {
      return path.normalize(await fs.realpath(filePath));
    } catch {
      return this.normalizePathForCompare(filePath);
    }
  }

  private async safeRealpathCached(filePath: string, cache: Map<string, string>): Promise<string> {
    const cached = cache.get(filePath);
    if (cached) {
      return cached;
    }

    const resolved = await this.safeRealpath(filePath);
    cache.set(filePath, resolved);
    return resolved;
  }

  private requiresProviderSessionIdForRestore(providerName: string): boolean {
    const provAdapter = this.resolveProviderAdapter(providerName);
    if (provAdapter && isTranscriptDiscoveryCapable(provAdapter)) {
      return provAdapter.providerSessionIdRequiredForRestore ?? false;
    }
    return false;
  }

  private async readCandidates(
    files: SessionFileInfo[],
    providerName: string,
    adapter: SessionReaderAdapter,
    sessionId?: string,
  ): Promise<CandidateReadResult[]> {
    const maxBytes = this.getSearchMaxBytes(providerName);
    const candidates: CandidateReadResult[] = [];
    const filesToScan = files.slice(0, this.getContentMatchMaxCandidates(providerName));

    for (const file of filesToScan) {
      const content = await readFileHead(file.filePath, maxBytes);
      if (content === null) {
        continue;
      }
      const candidateMetadata = adapter.extractCandidateMetadata?.(content);
      const fileWithProviderSessionId =
        candidateMetadata?.providerSessionId && !file.providerSessionId
          ? { ...file, providerSessionId: candidateMetadata.providerSessionId }
          : file;

      candidates.push({
        file: fileWithProviderSessionId,
        content,
        contentTimestamp:
          adapter.extractContentTimestamp?.(content) ?? this.extractContentTimestamp(content),
        candidateMetadata,
      });

      if (sessionId && content.includes(sessionId)) {
        // Full UUID match can short-circuit scanning safely.
        break;
      }
    }

    return candidates;
  }

  private async excludeAlreadyAssignedCandidates(
    candidates: CandidateReadResult[],
    sessionId: string,
    realpathCache: Map<string, string>,
  ): Promise<CandidateReadResult[]> {
    if (candidates.length === 0) {
      return candidates;
    }

    const assignedRows = this.sqlite
      .prepare('SELECT id, transcript_path FROM sessions WHERE transcript_path IS NOT NULL')
      .all() as AssignedTranscriptPathRow[];
    if (assignedRows.length === 0) {
      return candidates;
    }

    const ownedByOtherSession = new Set<string>();
    for (const row of assignedRows) {
      if (!row.transcript_path || row.id === sessionId) {
        continue;
      }
      ownedByOtherSession.add(await this.safeRealpathCached(row.transcript_path, realpathCache));
    }

    if (ownedByOtherSession.size === 0) {
      return candidates;
    }

    const filtered: CandidateReadResult[] = [];
    for (const candidate of candidates) {
      const candidatePath = await this.safeRealpathCached(candidate.file.filePath, realpathCache);
      if (!ownedByOtherSession.has(candidatePath)) {
        filtered.push(candidate);
      }
    }

    return filtered;
  }

  private findMatchByContent(
    candidates: CandidateReadResult[],
    sessionId: string,
  ): CandidateMatch | null {
    const fullMatch = candidates.find((candidate) => candidate.content.includes(sessionId));
    if (fullMatch) {
      return { file: fullMatch.file, matchType: 'content' };
    }

    const shortId = sessionId.slice(0, 8);
    if (shortId.length === 0) {
      return null;
    }

    const shortMatches = candidates.filter(
      (candidate) =>
        candidate.content.includes(`Session ${shortId}`) || candidate.content.includes(shortId),
    );

    if (shortMatches.length === 1) {
      return { file: shortMatches[0].file, matchType: 'short-id' };
    }

    if (shortMatches.length > 1) {
      this.logger.warn(
        { sessionId, shortId, shortMatchCount: shortMatches.length },
        'Short session prefix matched multiple transcript candidates — refusing ambiguous match',
      );
    }

    return null;
  }

  private async findByMetadata(
    candidates: CandidateReadResult[],
    ctx: {
      projectRootRealpath: string;
      sessionStartedAt: Date;
      attempt: number;
      maxRetries: number;
      realpathCache: Map<string, string>;
      sessionId: string;
    },
  ): Promise<CandidateMatch | null> {
    const windowMs =
      ctx.attempt === ctx.maxRetries ? CONTENT_TIMESTAMP_WINDOW_MS : METADATA_TIMESTAMP_WINDOW_MS;
    const metadataCandidates: CandidateReadResult[] = [];

    for (const candidate of candidates) {
      const metadata = candidate.candidateMetadata;
      if (!metadata?.providerSessionId || !metadata.workspacePath || !metadata.timestamp) {
        continue;
      }

      const metaTimestamp = new Date(metadata.timestamp);
      if (Number.isNaN(metaTimestamp.getTime())) {
        continue;
      }

      const metaCwd = await this.safeRealpathCached(metadata.workspacePath, ctx.realpathCache);
      if (metaCwd !== ctx.projectRootRealpath) {
        continue;
      }

      const deltaMs = Math.abs(metaTimestamp.getTime() - ctx.sessionStartedAt.getTime());
      if (deltaMs <= windowMs) {
        metadataCandidates.push(candidate);
      }
    }

    if (metadataCandidates.length === 0) {
      return null;
    }

    metadataCandidates.sort((a, b) => {
      const aTimestamp = new Date(a.candidateMetadata?.timestamp ?? 0).getTime();
      const bTimestamp = new Date(b.candidateMetadata?.timestamp ?? 0).getTime();
      return (
        Math.abs(aTimestamp - ctx.sessionStartedAt.getTime()) -
        Math.abs(bTimestamp - ctx.sessionStartedAt.getTime())
      );
    });

    if (metadataCandidates.length === 1) {
      return { file: metadataCandidates[0].file, matchType: 'metadata' };
    }

    const contentMatch = this.findMatchByContent(metadataCandidates, ctx.sessionId);
    if (contentMatch) {
      return { file: contentMatch.file, matchType: 'metadata+content' };
    }

    return null;
  }

  private extractContentTimestamp(content: string): Date | null {
    const timestampMatch = content.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (timestampMatch?.[1]) {
      const parsed = new Date(timestampMatch[1]);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return null;
  }

  private async findByContentTimestampWindow(
    candidates: CandidateReadResult[],
    sessionStartedAt: Date,
    windowMs: number,
    projectRootRealpath: string | null,
    realpathCache: Map<string, string>,
  ): Promise<SessionFileInfo | null> {
    const matchesInWindow: CandidateReadResult[] = [];
    for (const candidate of candidates) {
      if (!candidate.contentTimestamp) {
        continue;
      }

      const deltaMs = Math.abs(candidate.contentTimestamp.getTime() - sessionStartedAt.getTime());
      if (deltaMs <= windowMs) {
        matchesInWindow.push(candidate);
      }
    }

    if (matchesInWindow.length === 0) {
      return null;
    }

    const cwdFilteredMatches: CandidateReadResult[] = [];
    if (projectRootRealpath) {
      for (const candidate of matchesInWindow) {
        if (!candidate.candidateMetadata?.workspacePath) {
          continue;
        }
        const metaCwd = await this.safeRealpathCached(
          candidate.candidateMetadata.workspacePath,
          realpathCache,
        );
        if (metaCwd === projectRootRealpath) {
          cwdFilteredMatches.push(candidate);
        }
      }
    }

    const matchesToRank = cwdFilteredMatches.length > 0 ? cwdFilteredMatches : matchesInWindow;
    const rankedMatches = [...matchesToRank].sort((a, b) => {
      const aDelta = Math.abs(a.contentTimestamp!.getTime() - sessionStartedAt.getTime());
      const bDelta = Math.abs(b.contentTimestamp!.getTime() - sessionStartedAt.getTime());
      return aDelta - bDelta;
    });

    if (rankedMatches.length > 1) {
      const firstDelta = Math.abs(
        rankedMatches[0].contentTimestamp!.getTime() - sessionStartedAt.getTime(),
      );
      const secondDelta = Math.abs(
        rankedMatches[1].contentTimestamp!.getTime() - sessionStartedAt.getTime(),
      );
      if (firstDelta === secondDelta) {
        return null;
      }
    }

    return rankedMatches[0].file;
  }

  private getSessionStartedAt(sessionId: string): Date | null {
    const row = this.sqlite
      .prepare('SELECT started_at FROM sessions WHERE id = ?')
      .get(sessionId) as { started_at: string | null } | undefined;

    if (!row?.started_at) {
      return null;
    }

    const startedAt = new Date(row.started_at);
    if (Number.isNaN(startedAt.getTime())) {
      this.logger.warn(
        { sessionId, startedAt: row.started_at },
        'Session started_at is invalid — skipping timestamp heuristic',
      );
      return null;
    }

    return startedAt;
  }

  private getSearchMaxBytes(providerName: string): number {
    const provAdapter = this.resolveProviderAdapter(providerName);
    if (
      provAdapter &&
      isTranscriptDiscoveryCapable(provAdapter) &&
      provAdapter.transcriptContentSearchMaxBytes
    ) {
      return provAdapter.transcriptContentSearchMaxBytes;
    }
    return CONTENT_SEARCH_MAX_BYTES_JSONL;
  }

  private getContentMatchMaxCandidates(providerName: string): number {
    const provAdapter = this.resolveProviderAdapter(providerName);
    if (
      provAdapter &&
      isTranscriptDiscoveryCapable(provAdapter) &&
      provAdapter.contentMatchMaxCandidates
    ) {
      return provAdapter.contentMatchMaxCandidates;
    }
    return CONTENT_MATCH_MAX_CANDIDATES;
  }

  private resolveProviderAdapter(providerName: string) {
    try {
      return this.providerAdapterFactory.getAdapter(providerName);
    } catch {
      return undefined;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private delayBeforeRetry(attempt: number): Promise<void> {
    return this.delay(
      DISCOVERY_RETRY_BACKOFF_MS[attempt - 1] ??
        DISCOVERY_RETRY_BACKOFF_MS[DISCOVERY_RETRY_BACKOFF_MS.length - 1],
    );
  }
}
