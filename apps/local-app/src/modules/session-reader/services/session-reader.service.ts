import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { SessionCacheService, type SourceChangeKind } from './session-cache.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { buildChunks } from '../builders/chunk-builder';
import { decodeCursor, encodeCursor } from './transcript-cursor';
import { truncateMessages, truncateChunks } from './transcript-truncation';
import type { SessionSourceRef } from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMetrics, UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';
import type { CacheStats } from '../../metrics/types/metrics.types';
import { TranscriptWatcherService } from './transcript-watcher.service';
import { PRICING_SERVICE, type PricingServiceInterface } from './pricing.interface';
import { RuntimeContextCaptureService } from '../../runtime-context-capture/runtime-context-capture.service';
import {
  RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT,
  type RuntimeContextCaptureTupleChangedPayload,
} from '../../runtime-context-capture/runtime-context-capture.service';
import { resolveContextWindow } from '../../runtime-context-capture/context-window-policy';
import { EventsService } from '../../events/services/events.service';

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
  pages?: { cursor: string; size: number; response: UnifiedChunkedResponse }[];
}

export interface TranscriptIndexWindow {
  pageSize: number;
  firstVirtualIndex?: number;
  lastVirtualIndex?: number;
  live?: boolean;
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
const MAX_INDEX_CHUNK_BODIES = 200;

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

interface ReadyAdapterResolution {
  pending?: false;
  adapter: ReturnType<SessionReaderAdapterFactory['getAdapter']> & object;
  transcriptPath: string;
  sourceRef: SessionSourceRef;
  providerName: string;
}

interface PendingAdapterResolution {
  pending: true;
  transcriptPath: string;
  providerName: string;
}

type AdapterResolution = ReadyAdapterResolution | PendingAdapterResolution;

@Injectable()
export class SessionReaderService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionReaderService.name);
  private readonly parsedSessionFlights = new Map<string, Promise<ParsedSessionResult>>();
  private readonly runtimeContextPublications = new Set<Promise<unknown>>();

  constructor(
    private readonly adapterFactory: SessionReaderAdapterFactory,
    private readonly pathValidator: TranscriptPathValidator,
    private readonly sessionCacheService: SessionCacheService,
    private readonly sessionsService: SessionsService,
    private readonly transcriptWatcherService?: TranscriptWatcherService,
    @Optional()
    @Inject(PRICING_SERVICE)
    private readonly pricingService?: PricingServiceInterface,
    @Optional()
    private readonly runtimeContextCapture?: RuntimeContextCaptureService,
    @Optional()
    private readonly events?: EventsService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.runtimeContextPublications);
  }

  @OnEvent(RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT)
  handleRuntimeContextTupleChanged(payload: RuntimeContextCaptureTupleChangedPayload): void {
    this.sessionCacheService.invalidateDto(payload.sessionId);
    // Do NOT clear the watcher's last summary metrics: a lane session (no cache entry) has
    // nothing to fall back to, so every sidebar read would trigger an O(file) getSummary. The
    // context window is resolved at read time (resolveMetricsContextWindow), so the retained
    // metrics stay correct without re-parsing.

    if (!this.events) return;
    const publication = this.events
      .publish('session.runtime-context.updated', { sessionId: payload.sessionId })
      .catch((error: unknown) => {
        this.logger.error(
          { error, sessionId: payload.sessionId },
          'Failed to publish runtime context update',
        );
      })
      .finally(() => {
        this.runtimeContextPublications.delete(publication);
      });
    this.runtimeContextPublications.add(publication);
  }

  getChunksCacheStats(): CacheStats {
    return this.sessionCacheService.getChunksCacheStats();
  }

  /**
   * Get full parsed transcript for a session.
   *
   * Resolution chain: session's historical provider → adapter → parse
   */
  async getTranscript(sessionId: string, options?: GetTranscriptOptions): Promise<UnifiedSession> {
    const { session: parsedSession } = await this.getParsedSession(sessionId);
    const session = this.withResolvedContextWindow(sessionId, parsedSession);
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
    const { session: unadornedSession, parseTiming } = await this.getParsedSession(sessionId);
    const parsedSession = this.withResolvedContextWindow(sessionId, unadornedSession);

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
    const resolution = await this.resolveAdapter(sessionId);
    if (resolution.pending) {
      return this.toTranscriptSummary(
        sessionId,
        this.createPendingTranscriptResult(sessionId, resolution, 0).session,
      );
    }
    const { adapter, sourceRef, providerName } = resolution;
    if (this.sessionCacheService.getEntry(sessionId)) {
      const cachedSession = await this.sessionCacheService.getFreshSession(
        sessionId,
        sourceRef,
        adapter,
      );
      if (cachedSession) {
        return this.toTranscriptSummary(sessionId, cachedSession);
      }
    }

    const watcherMetrics = this.transcriptWatcherService?.getLastKnownSummaryMetrics(sessionId);
    if (watcherMetrics) {
      const metrics = this.resolveMetricsContextWindow(sessionId, watcherMetrics);
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
          const metrics = this.resolveMetricsContextWindow(sessionId, summary.metrics);
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
    const metrics = this.resolveMetricsContextWindow(sessionId, session.metrics);
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

    return this.projectChunkPage(allChunks, startIndex, chunkSize);
  }

  private projectChunkPage(
    allChunks: UnifiedChunk[],
    startIndex: number,
    chunkSize: number,
  ): UnifiedChunkedResponse {
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
   * Get transcript metadata and optional bounded pages from the same parsed session.
   */
  async getTranscriptIndex(
    sessionId: string,
    window?: TranscriptIndexWindow,
  ): Promise<TranscriptIndex> {
    if (window) this.validateIndexWindow(window);
    const { session, parseTiming } = await this.getParsedSession(sessionId);
    const chunks = session.chunks ?? buildChunks(session.messages);
    const pages = window ? this.projectIndexPages(chunks, window) : undefined;

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
      ...(pages ? { pages } : {}),
    };
  }

  private validateIndexWindow(window: TranscriptIndexWindow): void {
    const { pageSize, firstVirtualIndex, lastVirtualIndex, live } = window;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_CHUNK_SIZE) {
      throw new ValidationError(`pageSize must be an integer between 1 and ${MAX_CHUNK_SIZE}`);
    }
    for (const value of [firstVirtualIndex, lastVirtualIndex]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw new ValidationError('Virtual indices must be nonnegative safe integers');
      }
    }
    if (live !== undefined && typeof live !== 'boolean') {
      throw new ValidationError('live must be a boolean');
    }
    if (lastVirtualIndex !== undefined) {
      const width = lastVirtualIndex - (firstVirtualIndex ?? 0) + 1;
      if (width < 1 || width > MAX_INDEX_CHUNK_BODIES) {
        throw new ValidationError(
          `Visible window must contain 1 to ${MAX_INDEX_CHUNK_BODIES} chunks`,
        );
      }
    }
  }

  private projectIndexPages(
    chunks: UnifiedChunk[],
    window: TranscriptIndexWindow,
  ): NonNullable<TranscriptIndex['pages']> {
    if (chunks.length === 0) return [];
    const { pageSize } = window;
    const lastIndex = chunks.length - 1;
    const visibleStart = Math.min(window.firstVirtualIndex ?? 0, lastIndex);
    const visibleEnd = Math.max(
      visibleStart,
      Math.min(window.lastVirtualIndex ?? pageSize * 2 - 1, lastIndex),
    );
    const retainedStart = Math.max(0, visibleStart - pageSize);
    const retainedEnd = Math.min(lastIndex, visibleEnd + pageSize);
    const alignPageStart = (index: number) => Math.floor(index / pageSize) * pageSize;
    const viewportRange = {
      start: alignPageStart(retainedStart),
      end: Math.min(chunks.length, alignPageStart(retainedEnd) + pageSize),
    };
    const ranges = [viewportRange];
    if (window.live) {
      const tailStart = alignPageStart(Math.max(0, chunks.length - pageSize));
      if (tailStart <= viewportRange.end) {
        viewportRange.end = chunks.length;
      } else {
        ranges.push({ start: tailStart, end: chunks.length });
      }
    }

    // Count aligned bodies before enumerating pages; alignment can exceed the visible window.
    const bodyCount = ranges.reduce((count, range) => count + range.end - range.start, 0);
    if (bodyCount > MAX_INDEX_CHUNK_BODIES) {
      throw new ValidationError(`Transcript window exceeds ${MAX_INDEX_CHUNK_BODIES} chunk bodies`);
    }
    const pages: NonNullable<TranscriptIndex['pages']> = [];
    for (const range of ranges) {
      for (let offset = range.start; offset < range.end; offset += pageSize) {
        const size = Math.min(pageSize, chunks.length - offset);
        pages.push({
          cursor: chunks[offset].id,
          size,
          response: this.projectChunkPage(chunks, offset, size),
        });
      }
    }
    return pages;
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
      const metrics = this.resolveMetricsContextWindow(sessionId, session.metrics);
      return {
        kind: 'delta',
        cursor: sinceCursor,
        replaceFromChunkId: null,
        replaceFromChunkIndex,
        deltaChunks: [],
        deltaMessages: [],
        metrics,
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
    const metrics = this.resolveMetricsContextWindow(sessionId, session.metrics);

    return {
      kind: 'delta',
      cursor,
      replaceFromChunkId,
      replaceFromChunkIndex,
      deltaChunks,
      deltaMessages,
      metrics,
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
    const resolution = await this.resolveAdapter(sessionId);
    const resolveMs = performance.now() - tResolve;
    if (resolution.pending) {
      return this.createPendingTranscriptResult(sessionId, resolution, resolveMs);
    }
    const { adapter, sourceRef, providerName } = resolution;

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

    // The parsed cache owns the unadorned UnifiedSession. Consumers receive a sibling
    // wrapper so derived chunks never create a back-reference from the parsed entry.
    const sessionWithChunks: UnifiedSession = { ...session, chunks };

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

  /**
   * Claude and other file-backed providers can announce a session id/path before
   * writing the first transcript entry. Keep that live pre-file window readable
   * as an empty generation. The result is deliberately NOT cached: every later
   * request re-runs path validation and naturally transitions to the real source
   * as soon as the provider materializes it.
   */
  private createPendingTranscriptResult(
    sessionId: string,
    resolution: PendingAdapterResolution,
    resolveMs: number,
  ): ParsedSessionResult {
    const metrics: UnifiedMetrics = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalContextConsumption: 0,
      compactionCount: 0,
      phaseBreakdowns: [],
      visibleContextTokens: 0,
      totalContextTokens: 0,
      contextWindowTokens: 0,
      costUsd: 0,
      primaryModel: '',
      durationMs: 0,
      messageCount: 0,
      isOngoing: true,
    };
    return {
      session: {
        id: sessionId,
        providerName: resolution.providerName,
        filePath: resolution.transcriptPath,
        messages: [],
        chunks: [],
        metrics,
        isOngoing: true,
        warnings: ['Transcript is waiting for the provider to write its first entry'],
      },
      parseTiming: {
        resolveMs,
        parseOrCacheHitMs: 0,
        buildChunksMs: 0,
        cacheHit: false,
        sourceChangeKind: 'unknown-full-parse',
        fileSizeBytes: 0,
        fileMtimeMs: 0,
        sourceVersion: 0,
        providerName: resolution.providerName,
      },
    };
  }

  private toTranscriptSummary(sessionId: string, session: UnifiedSession): TranscriptSummary {
    const metrics = this.resolveMetricsContextWindow(sessionId, session.metrics);
    return {
      sessionId,
      providerName: session.providerName,
      metrics,
      messageCount: metrics.messageCount,
      isOngoing: metrics.isOngoing,
    };
  }

  private withResolvedContextWindow(sessionId: string, session: UnifiedSession): UnifiedSession {
    const metrics = this.resolveMetricsContextWindow(sessionId, session.metrics);
    return metrics === session.metrics ? session : { ...session, metrics };
  }

  private resolveMetricsContextWindow(sessionId: string, metrics: UnifiedMetrics): UnifiedMetrics {
    if (!this.pricingService) return metrics;

    const liveContext = this.runtimeContextCapture?.getLiveContext(sessionId);
    const catalogContextWindowTokens = this.pricingService.getCatalogContextWindowSize(
      metrics.primaryModel,
    );
    const session = this.sessionsService.getSession(sessionId);
    const providerNameAtLaunch = session?.providerNameAtLaunch?.toLowerCase() ?? null;
    const capture = liveContext?.claudeCapture;
    const eligibleCapture =
      capture &&
      providerNameAtLaunch === 'claude' &&
      session?.providerSessionId === capture.claudeSessionId &&
      capture.modelId === metrics.primaryModel &&
      metrics.primaryModel.startsWith('claude-')
        ? capture
        : null;
    const resolution = resolveContextWindow({
      primaryModel: metrics.primaryModel,
      configuredOverride: liveContext?.configuredOverride ?? null,
      claudeCapture: eligibleCapture,
      // Codex records the effective runtime window in token_count events. That
      // provider-native value is more precise than the catalog's API maximum.
      providerReportedContextWindowTokens:
        providerNameAtLaunch === 'codex' ? metrics.contextWindowTokens : null,
      catalogContextWindowTokens,
    });

    if (metrics.contextWindowTokens === resolution.contextWindowTokens) return metrics;
    return {
      ...metrics,
      contextWindowTokens: resolution.contextWindowTokens,
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
   * Resolve the adapter from the provider recorded at launch, then validate the transcript path.
   */
  private async resolveAdapter(sessionId: string): Promise<AdapterResolution> {
    // 1. Look up session
    const session = this.sessionsService.getSession(sessionId);
    if (!session) {
      throw new NotFoundError('Session', sessionId);
    }

    // Historical sessions remain readable after their live provider/config/agent rows are removed.
    const adapter = session.providerNameAtLaunch
      ? this.adapterFactory.getAdapter(session.providerNameAtLaunch)
      : session.transcriptPath
        ? this.adapterFactory.getAdapterForPath(session.transcriptPath)
        : undefined;
    if (!adapter) {
      const providerLabel = session.providerNameAtLaunch ?? 'unknown';
      throw new ValidationError(
        `Provider "${providerLabel}" does not support session reading. Supported: ${this.adapterFactory.getSupportedProviders().join(', ')}`,
        { providerName: session.providerNameAtLaunch },
      );
    }
    const providerName = adapter.providerName.toLowerCase();

    // A live provider may not have emitted its path hook yet. This is a normal
    // startup state, not malformed RPC input. Historical sessions retain the
    // existing validation error because no future provider write can repair them.
    if (!session.transcriptPath) {
      if (session.status === 'running') {
        return { pending: true, transcriptPath: '', providerName };
      }
      throw new ValidationError('Session does not have a transcript path', { sessionId });
    }

    // 3. Validate transcript path
    let validatedPath: string;
    try {
      validatedPath = await this.pathValidator.validateForRead(
        session.transcriptPath,
        providerName,
      );
    } catch (error) {
      if (
        session.status === 'running' &&
        (adapter.sourceKind ?? 'file') === 'file' &&
        this.isMissingTranscriptFileError(error)
      ) {
        return {
          pending: true,
          transcriptPath: session.transcriptPath,
          providerName,
        };
      }
      throw error;
    }

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
      pending: false,
      adapter,
      transcriptPath: validatedPath,
      sourceRef,
      providerName,
    };
  }

  private isMissingTranscriptFileError(error: unknown): boolean {
    return (
      error instanceof ValidationError &&
      error.details?.['category'] === 'file-access' &&
      error.details?.['reason'] === 'missing'
    );
  }
}
