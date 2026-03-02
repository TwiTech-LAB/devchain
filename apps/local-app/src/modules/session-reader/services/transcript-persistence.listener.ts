import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { EventsService } from '../../events/services/events.service';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { readFileHead } from '../adapters/utils/file-search.util';
import type { SessionFileInfo } from '../adapters/session-reader-adapter.interface';
import type { ClaudeHooksSessionStartedEventPayload } from '../../events/catalog/claude.hooks.session.started';
import type { SessionStartedEventPayload } from '../../events/catalog/session.started';

/** Max retries for auto-discovery when file doesn't exist yet */
const DISCOVERY_MAX_RETRIES = 3;

/** Delay between discovery retries (ms) */
const DISCOVERY_RETRY_DELAY_MS = 2_000;

/** Max candidate files scanned for content matching */
const CONTENT_MATCH_MAX_CANDIDATES = 50;

/** Max bytes to scan from JSONL providers (Codex/Claude-style) */
const CONTENT_SEARCH_MAX_BYTES_JSONL = 16_384;

/** Max bytes to scan from JSON providers (Gemini-style) */
const CONTENT_SEARCH_MAX_BYTES_JSON = 32_768;

/** Timestamp heuristic match window around session.started timestamp */
const CONTENT_TIMESTAMP_WINDOW_MS = 120_000;

/** Warn threshold for discovered transcript file size (10MB) */
const DISCOVERED_FILE_WARN_BYTES = 10 * 1024 * 1024;

interface CandidateReadResult {
  file: SessionFileInfo;
  content: string;
  contentTimestamp: Date | null;
}

type ContentMatchType = 'full' | 'short';

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
    const { transcriptPath, claudeSessionId, sessionId, agentId, projectId } = payload;

    // Skip if no transcript path provided
    if (!transcriptPath) {
      this.logger.debug(
        { sessionId, claudeSessionId },
        'No transcriptPath in hook payload — skipping persistence',
      );
      return;
    }

    // Skip if no session to update
    if (!sessionId) {
      this.logger.warn(
        { claudeSessionId, transcriptPath },
        'Hook payload missing sessionId — cannot persist transcript path',
      );
      return;
    }

    // Validate path shape (does not check file existence)
    let normalizedPath: string;
    try {
      normalizedPath = this.validator.validateShape(transcriptPath, 'claude');
    } catch (error) {
      this.logger.warn(
        { error, transcriptPath, sessionId },
        'Transcript path failed validation — skipping persistence',
      );
      return;
    }

    // Update session record
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE sessions
         SET transcript_path = ?, claude_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(normalizedPath, claudeSessionId, now, sessionId);

    if (result.changes === 0) {
      this.logger.warn(
        { sessionId, claudeSessionId },
        'Session not found for transcript persistence — hook may have arrived before session record was created',
      );
      return;
    }

    this.logger.log(
      { sessionId, transcriptPath: normalizedPath, claudeSessionId },
      'Persisted transcript metadata to session',
    );

    // Publish discovery event (only if agentId is available)
    if (agentId) {
      await this.events.publish('session.transcript.discovered', {
        sessionId,
        agentId,
        projectId,
        transcriptPath: normalizedPath,
        providerName: 'claude',
      });
    }
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

    for (let attempt = 1; attempt <= DISCOVERY_MAX_RETRIES; attempt++) {
      const isFinalAttempt = attempt === DISCOVERY_MAX_RETRIES;

      // Check if already discovered (via hooks or previous retry)
      if (this.hasTranscriptPath(sessionId)) {
        this.logger.debug(
          { sessionId, attempt },
          'Transcript already discovered — skipping auto-discovery',
        );
        return;
      }

      const files = await adapter.discoverSessionFile({ projectRoot });
      if (files.length > 0) {
        if (providerName === 'claude') {
          // Preserve existing Claude behavior: use most-recent file only.
          await this.persistDiscoveredPath(sessionId, agentId, projectId, files[0], providerName);
          return;
        }

        const candidates = await this.readCandidates(files, providerName, sessionId);
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

          await this.persistDiscoveredPath(
            sessionId,
            agentId,
            projectId,
            contentMatch.file,
            providerName,
          );
          return;
        }

        if (isFinalAttempt) {
          const sessionStartedAt = this.getSessionStartedAt(sessionId);
          if (sessionStartedAt) {
            const timestampHeuristicMatch = this.findByContentTimestampWindow(
              candidates,
              sessionStartedAt,
              CONTENT_TIMESTAMP_WINDOW_MS,
            );
            if (timestampHeuristicMatch) {
              this.logger.warn(
                {
                  sessionId,
                  providerName,
                  filePath: timestampHeuristicMatch.filePath,
                  attempt,
                  candidatesScanned: candidates.length,
                  hint: 'initial prompt may omit {session_id}',
                },
                'Auto-discovered transcript via timestamp heuristic fallback',
              );

              await this.persistDiscoveredPath(
                sessionId,
                agentId,
                projectId,
                timestampHeuristicMatch,
                providerName,
              );
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
            hint: providerName === 'claude' ? undefined : 'initial prompt may omit {session_id}',
          },
          'Transcript not found after all discovery retries',
        );
      } else {
        this.logger.debug(
          { sessionId, providerName, attempt, maxRetries: DISCOVERY_MAX_RETRIES },
          'Transcript file not found — will retry',
        );
        await this.delay(DISCOVERY_RETRY_DELAY_MS);
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

  private hasTranscriptPath(sessionId: string): boolean {
    const row = this.sqlite
      .prepare('SELECT transcript_path FROM sessions WHERE id = ?')
      .get(sessionId) as { transcript_path: string | null } | undefined;

    return !!row?.transcript_path;
  }

  private async persistDiscoveredPath(
    sessionId: string,
    agentId: string,
    projectId: string,
    file: SessionFileInfo,
    providerName: string,
  ): Promise<void> {
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
      return;
    }

    // Persist only if transcript_path is still null (prevent race with hooks)
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE sessions
         SET transcript_path = ?, updated_at = ?
         WHERE id = ? AND transcript_path IS NULL`,
      )
      .run(normalizedPath, now, sessionId);

    if (result.changes === 0) {
      this.logger.debug(
        { sessionId },
        'Session transcript_path already set (hook won race) or session not found — skipping',
      );
      return;
    }

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
    });
  }

  private async readCandidates(
    files: SessionFileInfo[],
    providerName: string,
    sessionId?: string,
  ): Promise<CandidateReadResult[]> {
    const maxBytes = this.getSearchMaxBytes(providerName);
    const candidates: CandidateReadResult[] = [];
    const filesToScan = files.slice(0, CONTENT_MATCH_MAX_CANDIDATES);

    for (const file of filesToScan) {
      const content = await readFileHead(file.filePath, maxBytes);
      if (content === null) {
        continue;
      }

      candidates.push({
        file,
        content,
        contentTimestamp: this.extractContentTimestamp(content),
      });

      if (sessionId && content.includes(sessionId)) {
        // Full UUID match can short-circuit scanning safely.
        break;
      }
    }

    return candidates;
  }

  private findMatchByContent(
    candidates: CandidateReadResult[],
    sessionId: string,
  ): { file: SessionFileInfo; matchType: ContentMatchType } | null {
    const fullMatch = candidates.find((candidate) => candidate.content.includes(sessionId));
    if (fullMatch) {
      return { file: fullMatch.file, matchType: 'full' };
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
      return { file: shortMatches[0].file, matchType: 'short' };
    }

    if (shortMatches.length > 1) {
      this.logger.warn(
        { sessionId, shortId, shortMatchCount: shortMatches.length },
        'Short session prefix matched multiple transcript candidates — refusing ambiguous match',
      );
    }

    return null;
  }

  private extractContentTimestamp(content: string): Date | null {
    const codexTimestampMatch = content.match(/"timestamp"\s*:\s*"([^"]+)"/);
    if (codexTimestampMatch?.[1]) {
      const parsed = new Date(codexTimestampMatch[1]);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    const geminiStartTimeMatch = content.match(/"startTime"\s*:\s*"([^"]+)"/);
    if (geminiStartTimeMatch?.[1]) {
      const parsed = new Date(geminiStartTimeMatch[1]);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return null;
  }

  private findByContentTimestampWindow(
    candidates: CandidateReadResult[],
    sessionStartedAt: Date,
    windowMs: number,
  ): SessionFileInfo | null {
    const matchesInWindow = candidates.filter((candidate) => {
      if (!candidate.contentTimestamp) {
        return false;
      }

      const deltaMs = Math.abs(candidate.contentTimestamp.getTime() - sessionStartedAt.getTime());
      return deltaMs <= windowMs;
    });

    if (matchesInWindow.length !== 1) {
      return null;
    }

    return matchesInWindow[0].file;
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
    return providerName === 'gemini'
      ? CONTENT_SEARCH_MAX_BYTES_JSON
      : CONTENT_SEARCH_MAX_BYTES_JSONL;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
