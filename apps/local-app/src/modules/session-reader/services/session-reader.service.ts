import { Inject, Injectable, Logger } from '@nestjs/common';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { SessionCacheService, type SourceChangeKind } from './session-cache.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { buildChunks } from '../builders/chunk-builder';
import { decodeCursor, encodeCursor } from './transcript-cursor';
import { truncateMessages, truncateChunks } from './transcript-truncation';
import { ProviderAdapterFactory, isContextWindowCapable } from '../../providers/adapters';
import type { SessionSourceRef } from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMetrics, UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';
import type { CacheStats } from '../../metrics/types/metrics.types';
import { TranscriptWatcherService } from './transcript-watcher.service';

/** Transcript summary (metrics + session-level metadata) */
export interface TranscriptSummary {
  sessionId: string;
  providerName: string;
  metrics: UnifiedMetrics;
  messageCount: number;
  isOngoing: boolean;
}

/**
 * Summary plus the opaque tail cursor, minted from the same parse — lets a
 * client bootstrap cursor-tail polling without a separate full-transcript fetch.
 */
export interface TranscriptSummaryWithCursor extends TranscriptSummary {
  cursor: string;
}

/** Paginated UnifiedChunk response with cursor-stable IDs */
export interface UnifiedChunkedResponse {
  chunks: UnifiedChunk[];
  nextCursor: string | null;
  prevCursor: string | null;
  totalCount: number;
}

/** Lightweight transcript index for initial load */
export interface TranscriptIndex {
  cursor: string;
  totals: {
    messageCount: number;
    chunkCount: number;
  };
  chunkIds: string[];
  latestOutputPreview: string | null;
  providerName: string;
  isOngoing: boolean;
}

/** @deprecated Use UnifiedChunkedResponse. Retained for backward compatibility during migration. */
export interface ChunkedTranscriptResponse {
  chunks: TranscriptChunk[];
  nextCursor: string | null;
  hasMore: boolean;
  totalChunks: number;
}

/** @deprecated Use UnifiedChunk. Retained for backward compatibility during migration. */
export interface TranscriptChunk {
  chunkId: string;
  index: number;
  messages: UnifiedMessage[];
  messageCount: number;
  startTimestamp: string | null;
  endTimestamp: string | null;
}

export interface GetTranscriptOptions {
  maxToolResultLength?: number;
}

export interface TranscriptTimingData {
  resolveMs: number;
  parseOrCacheHitMs: number;
  buildChunksMs: number;
  applyToolResultTruncationMs: number;
  cacheHit: boolean;
  sourceChangeKind: SourceChangeKind;
  fileSizeBytes: number;
  fileMtimeMs: number;
  /** Numeric source revision used by transcript cursors and derived-cache keys. */
  sourceVersion: number;
  providerName: string;
}

export interface TranscriptToolResult {
  sessionId: string;
  toolCallId: string;
  content: string | unknown[];
  isError: boolean;
  fullLength: number;
}

export interface TranscriptTailDeltaResponse {
  kind: 'delta';
  cursor: string;
  /**
   * Window-stable splice anchor: the stable id of the first chunk in
   * `deltaChunks` (the chunk that was last at cursor time). A windowed client
   * locates this id in its own loaded window and replaces from there, which
   * correctly handles the last chunk *growing* in place. `null` on a no-op
   * (empty delta). Authoritative for mobile.
   */
  replaceFromChunkId: string | null;
  /** Absolute index, retained for non-windowed callers; `replaceFromChunkId` is authoritative. */
  replaceFromChunkIndex: number;
  deltaChunks: UnifiedChunk[];
  deltaMessages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  totalChunkCount: number;
  totalMessageCount: number;
}

export interface TranscriptTailFullRefetchRequiredResponse {
  kind: 'full-refetch-required';
  sourceChangeKind: SourceChangeKind;
}

export type TranscriptTailResponse =
  | TranscriptTailDeltaResponse
  | TranscriptTailFullRefetchRequiredResponse;

const DEFAULT_CHUNK_SIZE = 20;
const MAX_CHUNK_SIZE = 100;

function requiresFullRefetch(
  sourceChangeKind: SourceChangeKind,
  revisionChanged: boolean,
): boolean {
  switch (sourceChangeKind) {
    case 'same-file-append':
    case 'db-update':
      return false;
    case 'file-replacement':
    case 'file-truncation':
    case 'same-file-rewrite':
      return true;
    case 'cache-hit':
    case 'unknown-full-parse':
      return revisionChanged;
    default:
      return assertNever(sourceChangeKind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled source change kind: ${String(value)}`);
}

interface ParseTimingData {
  resolveMs: number;
  parseOrCacheHitMs: number;
  buildChunksMs: number;
  cacheHit: boolean;
  sourceChangeKind: SourceChangeKind;
  fileSizeBytes: number;
  fileMtimeMs: number;
  /** Numeric source revision compared by equality — cursor first component. */
  sourceVersion: number;
  providerName: string;
}

interface ParsedSessionResult {
  session: UnifiedSession;
  parseTiming: ParseTimingData;
}

@Injectable()
export class SessionReaderService {
  private readonly logger = new Logger(SessionReaderService.name);
  private readonly parsedSessionFlights = new Map<string, Promise<ParsedSessionResult>>();

  constructor(
    private readonly adapterFactory: SessionReaderAdapterFactory,
    private readonly pathValidator: TranscriptPathValidator,
    private readonly sessionCacheService: SessionCacheService,
    private readonly sessionsService: SessionsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
    private readonly transcriptWatcherService?: TranscriptWatcherService,
  ) {}

  getChunksCacheStats(): CacheStats {
    return this.sessionCacheService.getChunksCacheStats();
  }

  /**
   * Get full parsed transcript for a session.
   *
   * Resolution chain: session → agent → providerConfig → provider → adapter → parse
   */
  async getTranscript(sessionId: string, options?: GetTranscriptOptions): Promise<UnifiedSession> {
    const { session } = await this.getParsedSession(sessionId);
    const maxToolResultLength = options?.maxToolResultLength;
    if (maxToolResultLength === undefined) {
      return session;
    }
    return this.applyToolResultTruncation(session, maxToolResultLength);
  }

  async getTranscriptWithTimings(
    sessionId: string,
    options?: GetTranscriptOptions,
  ): Promise<{ session: UnifiedSession; timing: TranscriptTimingData }> {
    const { session: parsedSession, parseTiming } = await this.getParsedSession(sessionId);

    const maxToolResultLength = options?.maxToolResultLength;
    const tTrunc = performance.now();
    const session =
      maxToolResultLength !== undefined
        ? this.applyToolResultTruncation(parsedSession, maxToolResultLength)
        : parsedSession;
    const applyToolResultTruncationMs = performance.now() - tTrunc;

    return {
      session,
      timing: {
        ...parseTiming,
        applyToolResultTruncationMs,
      },
    };
  }

  /**
   * Get summary metrics for a session transcript.
   */
  async getTranscriptSummary(sessionId: string): Promise<TranscriptSummary> {
    const { adapter, sourceRef, providerName, oneMillionContextEnabled } =
      await this.resolveAdapter(sessionId);
    if (this.sessionCacheService.getEntry(sessionId)) {
      const cachedSession = await this.sessionCacheService.getFreshSession(
        sessionId,
        sourceRef,
        adapter,
      );
      if (cachedSession) {
        return this.toTranscriptSummary(
          sessionId,
          this.applyContextWindowEnrichment(cachedSession, providerName, oneMillionContextEnabled),
        );
      }
    }

    const watcherMetrics = this.transcriptWatcherService?.getLastKnownSummaryMetrics(sessionId);
    if (watcherMetrics) {
      const metrics = this.applyContextWindowToMetrics(
        watcherMetrics,
        providerName,
        oneMillionContextEnabled,
      );
      return {
        sessionId,
        providerName,
        metrics,
        messageCount: metrics.messageCount,
        isOngoing: metrics.isOngoing,
      };
    }

    if (adapter.getSummary) {
      try {
        const summary = await adapter.getSummary(sourceRef);
        if (summary) {
          const metrics = this.applyContextWindowToMetrics(
            summary.metrics,
            providerName,
            oneMillionContextEnabled,
          );
          return {
            sessionId,
            providerName,
            metrics,
            messageCount: metrics.messageCount,
            isOngoing: metrics.isOngoing,
          };
        }
      } catch (error) {
        this.logger.warn(
          { error, sessionId, providerName },
          'Lightweight transcript summary unavailable — falling back to full parse',
        );
      }
    }

    const { session } = await this.getParsedSession(sessionId);
    return this.toTranscriptSummary(sessionId, session);
  }

  /**
   * Get summary metrics PLUS the opaque tail cursor for the session, computed
   * from a single parse (no extra full-transcript fetch). The cursor is the
   * same opaque format `getTranscriptTail(since)` consumes, so a client can load
   * the summary on session-open and immediately begin cursor-tail polling.
   */
  async getTranscriptSummaryWithCursor(sessionId: string): Promise<TranscriptSummaryWithCursor> {
    const { session, parseTiming } = await this.getParsedSession(sessionId);
    const metrics: UnifiedMetrics = session.metrics;
    const chunks = session.chunks ?? buildChunks(session.messages);
    const cursor = encodeCursor(parseTiming.sourceVersion, session.messages.length, chunks.length);

    return {
      sessionId,
      providerName: session.providerName,
      metrics,
      messageCount: metrics.messageCount,
      isOngoing: metrics.isOngoing,
      cursor,
    };
  }

  /**
   * Get paginated transcript chunks.
   */
  async getTranscriptChunks(
    sessionId: string,
    cursor?: string,
    limit?: number,
  ): Promise<ChunkedTranscriptResponse> {
    const chunkSize = Math.min(Math.max(limit ?? DEFAULT_CHUNK_SIZE, 1), MAX_CHUNK_SIZE);
    const startIndex = cursor ? parseInt(cursor, 10) : 0;

    if (isNaN(startIndex) || startIndex < 0) {
      throw new ValidationError('Invalid cursor: must be a non-negative integer');
    }

    const session = await this.getTranscript(sessionId);
    const messages = session.messages;

    // Build chunks
    const totalChunks = Math.ceil(messages.length / chunkSize);
    const chunks: TranscriptChunk[] = [];

    // Calculate which chunks to return based on cursor
    // cursor = chunk index to start from
    const chunkStartIndex = startIndex;

    // Return one "page" of chunks (just the requested chunk range)
    // For simplicity, each API call returns one chunk at the cursor position
    if (chunkStartIndex < totalChunks) {
      const msgStart = chunkStartIndex * chunkSize;
      const msgEnd = Math.min(msgStart + chunkSize, messages.length);
      const chunkMessages = messages.slice(msgStart, msgEnd);

      chunks.push({
        chunkId: `chunk-${chunkStartIndex}`,
        index: chunkStartIndex,
        messages: chunkMessages,
        messageCount: chunkMessages.length,
        startTimestamp: chunkMessages.length > 0 ? chunkMessages[0].timestamp.toISOString() : null,
        endTimestamp:
          chunkMessages.length > 0
            ? chunkMessages[chunkMessages.length - 1].timestamp.toISOString()
            : null,
      });
    }

    const hasMore = chunkStartIndex + 1 < totalChunks;
    const nextCursor = hasMore ? String(chunkStartIndex + 1) : null;

    return {
      chunks,
      nextCursor,
      hasMore,
      totalChunks,
    };
  }

  /**
   * Get a single chunk by ID.
   */
  async getTranscriptChunk(
    sessionId: string,
    chunkId: string,
    chunkSize?: number,
  ): Promise<TranscriptChunk> {
    const size = Math.min(Math.max(chunkSize ?? DEFAULT_CHUNK_SIZE, 1), MAX_CHUNK_SIZE);

    // Parse chunk index from chunkId (format: "chunk-N")
    const match = chunkId.match(/^chunk-(\d+)$/);
    if (!match) {
      throw new ValidationError(`Invalid chunkId format: ${chunkId}. Expected "chunk-N".`);
    }

    const chunkIndex = parseInt(match[1], 10);
    const session = await this.getTranscript(sessionId);
    const messages = session.messages;

    const totalChunks = Math.ceil(messages.length / size);
    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      throw new NotFoundError('TranscriptChunk', chunkId);
    }

    const msgStart = chunkIndex * size;
    const msgEnd = Math.min(msgStart + size, messages.length);
    const chunkMessages = messages.slice(msgStart, msgEnd);

    return {
      chunkId,
      index: chunkIndex,
      messages: chunkMessages,
      messageCount: chunkMessages.length,
      startTimestamp: chunkMessages.length > 0 ? chunkMessages[0].timestamp.toISOString() : null,
      endTimestamp:
        chunkMessages.length > 0
          ? chunkMessages[chunkMessages.length - 1].timestamp.toISOString()
          : null,
    };
  }

  /**
   * Get paginated UnifiedChunk[] with cursor-stable chunk IDs.
   * Does NOT call getTranscript() — uses getParsedSession() directly.
   */
  async getUnifiedTranscriptChunks(
    sessionId: string,
    cursor?: string,
    limit?: number,
    direction: 'forward' | 'backward' = 'forward',
  ): Promise<UnifiedChunkedResponse> {
    const chunkSize = Math.min(Math.max(limit ?? DEFAULT_CHUNK_SIZE, 1), MAX_CHUNK_SIZE);

    const { session } = await this.getParsedSession(sessionId);
    const allChunks = session.chunks ?? buildChunks(session.messages);

    let startIndex: number;

    if (!cursor) {
      startIndex = direction === 'forward' ? 0 : Math.max(0, allChunks.length - chunkSize);
    } else {
      const cursorIndex = allChunks.findIndex((c) => c.id === cursor);
      if (cursorIndex === -1) {
        throw new ValidationError(`Invalid cursor: chunk "${cursor}" not found`);
      }
      if (direction === 'forward') {
        startIndex = cursorIndex;
      } else {
        startIndex = Math.max(0, cursorIndex - chunkSize + 1);
      }
    }

    const endIndex = Math.min(startIndex + chunkSize, allChunks.length);
    const windowChunks = allChunks.slice(startIndex, endIndex);

    const nextCursor = endIndex < allChunks.length ? allChunks[endIndex].id : null;
    const prevCursor = startIndex > 0 ? allChunks[startIndex - 1].id : null;

    return {
      chunks: truncateChunks(windowChunks),
      nextCursor,
      prevCursor,
      totalCount: allChunks.length,
    };
  }

  /**
   * Get a single UnifiedChunk by chunk ID.
   * Does NOT call getTranscript() — uses getParsedSession() directly.
   */
  async getUnifiedTranscriptChunk(sessionId: string, chunkId: string): Promise<UnifiedChunk> {
    const { session } = await this.getParsedSession(sessionId);
    const allChunks = session.chunks ?? buildChunks(session.messages);

    const chunk = allChunks.find((c) => c.id === chunkId);
    if (!chunk) {
      throw new NotFoundError('TranscriptChunk', chunkId);
    }

    return truncateChunks([chunk])[0];
  }

  /**
   * Get lightweight transcript index for initial-load summary.
   * Returns chunk IDs and metadata without semantic-step content.
   */
  async getTranscriptIndex(sessionId: string): Promise<TranscriptIndex> {
    const { session, parseTiming } = await this.getParsedSession(sessionId);
    const chunks = session.chunks ?? buildChunks(session.messages);

    let latestOutputPreview: string | null = null;
    for (let i = chunks.length - 1; i >= 0; i--) {
      const chunk = chunks[i];
      if (chunk.type === 'ai' && 'semanticSteps' in chunk) {
        const outputStep = [...chunk.semanticSteps].reverse().find((s) => s.type === 'output');
        if (outputStep?.content.outputText) {
          latestOutputPreview = outputStep.content.outputText.slice(0, 200);
          break;
        }
      }
    }

    return {
      cursor: encodeCursor(parseTiming.sourceVersion, session.messages.length, chunks.length),
      totals: {
        messageCount: session.messages.length,
        chunkCount: chunks.length,
      },
      chunkIds: chunks.map((c) => c.id),
      latestOutputPreview,
      providerName: session.providerName,
      isOngoing: session.metrics.isOngoing,
    };
  }

  /**
   * Get transcript tail since a cursor position.
   * Returns a delta only when overlap is safe, otherwise requires a canonical refetch.
   * Returns null if the cursor is expired (message count exceeds current total).
   */
  async getTranscriptTail(
    sessionId: string,
    sinceCursor: string,
  ): Promise<TranscriptTailResponse | null> {
    const cursorData = decodeCursor(sinceCursor);
    if (!cursorData) {
      throw new ValidationError('Invalid cursor format');
    }

    const { session, parseTiming } = await this.getParsedSession(sessionId);
    const chunks = session.chunks ?? buildChunks(session.messages);

    const replaceFromChunkIndex = Math.max(0, cursorData.chunkCount - 1);

    // DB-backed sources can mutate parts without growing the message count, so
    // their classified updates retain the in-place last-chunk replacement path.
    const revisionChanged = cursorData.fileSize !== parseTiming.sourceVersion;
    const messageCountUnchanged = cursorData.messageCount === session.messages.length;

    if (requiresFullRefetch(parseTiming.sourceChangeKind, revisionChanged)) {
      return {
        kind: 'full-refetch-required',
        sourceChangeKind: parseTiming.sourceChangeKind,
      };
    }

    if (cursorData.messageCount > session.messages.length) {
      return null;
    }

    // True no-op only when BOTH the count AND the source revision are unchanged →
    // return a TRUE-empty delta with the cursor untouched (preserves the client's
    // adaptive backoff). Otherwise fall through to emit a delta.
    if (messageCountUnchanged && !revisionChanged) {
      return {
        kind: 'delta',
        cursor: sinceCursor,
        replaceFromChunkId: null,
        replaceFromChunkIndex,
        deltaChunks: [],
        deltaMessages: [],
        metrics: session.metrics,
        totalChunkCount: chunks.length,
        totalMessageCount: session.messages.length,
      };
    }

    const deltaMessages = truncateMessages(session.messages.slice(cursorData.messageCount));
    const deltaChunks = truncateChunks(chunks.slice(replaceFromChunkIndex));
    // Window-stable anchor: the stable id of the first delta chunk (the chunk
    // that was last at cursor time). Lets a windowed client splice regardless of
    // absolute position and handles the last chunk growing in place.
    const replaceFromChunkId = deltaChunks[0]?.id ?? null;

    // First cursor component is the numeric source revision taken from the same
    // parse — no extra resolve/stat round-trip, and source-type agnostic.
    const cursor = encodeCursor(parseTiming.sourceVersion, session.messages.length, chunks.length);

    return {
      kind: 'delta',
      cursor,
      replaceFromChunkId,
      replaceFromChunkIndex,
      deltaChunks,
      deltaMessages,
      metrics: session.metrics,
      totalChunkCount: chunks.length,
      totalMessageCount: session.messages.length,
    };
  }

  /**
   * Get full (untruncated) tool result content by tool call id.
   */
  async getToolResult(sessionId: string, toolCallId: string): Promise<TranscriptToolResult> {
    const { session } = await this.getParsedSession(sessionId);

    for (const message of session.messages) {
      const match = message.toolResults.find((result) => result.toolCallId === toolCallId);
      if (!match) continue;

      return {
        sessionId,
        toolCallId,
        content: match.content,
        isError: match.isError,
        fullLength: this.getToolResultContentLength(match.content),
      };
    }

    throw new NotFoundError('ToolResult', toolCallId);
  }

  // ---------------------------------------------------------------------------
  // Private: Caching & Resolution
  // ---------------------------------------------------------------------------

  private getParsedSession(sessionId: string): Promise<ParsedSessionResult> {
    const existing = this.parsedSessionFlights.get(sessionId);
    if (existing) return existing;

    // One flight owns the complete cache freshness check. Removing it at settlement
    // ensures the next request rechecks the source instead of pinning a stale result.
    const flight = this.loadParsedSession(sessionId).finally(() => {
      if (this.parsedSessionFlights.get(sessionId) === flight) {
        this.parsedSessionFlights.delete(sessionId);
      }
    });
    this.parsedSessionFlights.set(sessionId, flight);
    return flight;
  }

  private async loadParsedSession(sessionId: string): Promise<ParsedSessionResult> {
    const tResolve = performance.now();
    const { adapter, sourceRef, providerName, oneMillionContextEnabled } =
      await this.resolveAdapter(sessionId);
    const resolveMs = performance.now() - tResolve;

    const tParse = performance.now();
    const { session, cacheHit, sourceChangeKind, lastSize, lastMtime, sourceVersion } =
      await this.sessionCacheService.getOrParseWithMeta(sessionId, sourceRef, adapter);
    const parseOrCacheHitMs = performance.now() - tParse;

    const cachedChunks = this.sessionCacheService.getChunks(sessionId, sourceVersion);
    let buildChunksMs = 0;
    let chunks: UnifiedChunk[];
    if (cachedChunks) {
      chunks = cachedChunks;
    } else {
      const tBuild = performance.now();
      chunks = buildChunks(session.messages);
      buildChunksMs = performance.now() - tBuild;
      this.sessionCacheService.setChunks(sessionId, sourceVersion, chunks);
    }

    const enrichedSession = this.applyContextWindowEnrichment(
      session,
      providerName,
      oneMillionContextEnabled,
    );
    // The parsed cache owns the unadorned UnifiedSession. Consumers receive a sibling
    // wrapper so derived chunks never create a back-reference from the parsed entry.
    const sessionWithChunks: UnifiedSession = { ...enrichedSession, chunks };

    return {
      session: sessionWithChunks,
      parseTiming: {
        resolveMs,
        parseOrCacheHitMs,
        buildChunksMs,
        cacheHit,
        sourceChangeKind,
        fileSizeBytes: lastSize,
        fileMtimeMs: lastMtime,
        sourceVersion,
        providerName,
      },
    };
  }

  private applyContextWindowEnrichment(
    session: UnifiedSession,
    providerName: string,
    oneMillionContextEnabled: boolean,
  ): UnifiedSession {
    const metrics = this.applyContextWindowToMetrics(
      session.metrics,
      providerName,
      oneMillionContextEnabled,
    );
    return metrics === session.metrics ? session : { ...session, metrics };
  }

  private applyContextWindowToMetrics(
    metrics: UnifiedMetrics,
    providerName: string,
    oneMillionContextEnabled: boolean,
  ): UnifiedMetrics {
    const providerAdapter = this.providerAdapterFactory.getAdapter(providerName);
    if (isContextWindowCapable(providerAdapter)) {
      const overrideWindow = providerAdapter.getReadTimeContextWindow(
        metrics.primaryModel,
        oneMillionContextEnabled,
      );
      if (overrideWindow != null) {
        return { ...metrics, contextWindowTokens: overrideWindow };
      }
    }
    return metrics;
  }

  private toTranscriptSummary(sessionId: string, session: UnifiedSession): TranscriptSummary {
    const metrics: UnifiedMetrics = session.metrics;
    return {
      sessionId,
      providerName: session.providerName,
      metrics,
      messageCount: metrics.messageCount,
      isOngoing: metrics.isOngoing,
    };
  }

  private applyToolResultTruncation(session: UnifiedSession, maxLength: number): UnifiedSession {
    if (!Number.isInteger(maxLength) || maxLength < 1) {
      throw new ValidationError('maxToolResultLength must be a positive integer');
    }

    const messages = truncateMessages(session.messages, maxLength);
    const chunks = session.chunks ? truncateChunks(session.chunks, maxLength, messages) : undefined;

    if (messages === session.messages && chunks === session.chunks) return session;

    return { ...session, messages, chunks };
  }

  private getToolResultContentLength(content: string | unknown[]): number {
    if (typeof content === 'string') {
      return content.length;
    }
    try {
      return JSON.stringify(content).length;
    } catch {
      return String(content).length;
    }
  }

  /**
   * Resolve session → agent → providerConfig → provider → adapter, validate transcript path.
   */
  private async resolveAdapter(sessionId: string): Promise<{
    adapter: ReturnType<SessionReaderAdapterFactory['getAdapter']> & object;
    transcriptPath: string;
    sourceRef: SessionSourceRef;
    providerName: string;
    oneMillionContextEnabled: boolean;
  }> {
    // 1. Look up session
    const session = this.sessionsService.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session', sessionId);
    }

    // 2. Ensure transcript path is set
    if (!session.transcriptPath) {
      throw new ValidationError('Session does not have a transcript path', { sessionId });
    }

    // 3. Resolve agent → providerConfig → provider
    if (!session.agentId) {
      throw new ValidationError('Session does not have an associated agent', { sessionId });
    }

    let providerName: string;
    let oneMillionContextEnabled = false;
    try {
      const agent = await this.storage.getAgent(session.agentId);
      if (!agent.providerConfigId) {
        throw new ValidationError('Agent does not have a provider configuration', {
          agentId: agent.id,
        });
      }
      const config = await this.storage.getProfileProviderConfig(agent.providerConfigId);
      const provider = await this.storage.getProvider(config.providerId);
      providerName = provider.name.toLowerCase();
      oneMillionContextEnabled = !!provider.oneMillionContextEnabled;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      throw new ValidationError('Failed to resolve provider for session', {
        sessionId,
        error: String(error),
      });
    }

    // 4. Get adapter for the provider
    const adapter = this.adapterFactory.getAdapter(providerName);
    if (!adapter) {
      throw new ValidationError(
        `Provider "${providerName}" does not support session reading. Supported: ${this.adapterFactory.getSupportedProviders().join(', ')}`,
        { providerName },
      );
    }

    // 5. Validate transcript path
    const validatedPath = await this.pathValidator.validateForRead(
      session.transcriptPath,
      providerName,
    );

    // Generalized source reference threaded through the cache into the adapter so
    // DB-backed adapters can locate the session via `providerSessionId`. `kind`
    // is adapter-declared (defaults to 'file'); existing file adapters resolve to
    // a file source with identical behavior. `providerSessionId` is populated from
    // the persisted session row for DB sources (the OpenCode adapter requires it
    // to locate the session inside the shared container); it stays undefined for
    // file sources, so their behavior is byte-identical.
    const sourceRef: SessionSourceRef = {
      filePath: validatedPath,
      providerName,
      providerSessionId:
        adapter.sourceKind === 'db' ? (session.providerSessionId ?? undefined) : undefined,
      kind: adapter.sourceKind ?? 'file',
    };

    this.logger.debug(
      { sessionId, providerName, transcriptPath: validatedPath, sourceKind: sourceRef.kind },
      'Resolved adapter for session transcript',
    );

    return {
      adapter,
      transcriptPath: validatedPath,
      sourceRef,
      providerName,
      oneMillionContextEnabled,
    };
  }
}
