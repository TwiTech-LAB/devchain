import { Inject, Injectable, Logger } from '@nestjs/common';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { SessionCacheService } from './session-cache.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { stat } from 'node:fs/promises';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { buildChunks } from '../builders/chunk-builder';
import { decodeCursor, encodeCursor } from './transcript-cursor';
import { truncateMessages, truncateChunks } from './transcript-truncation';
import { ProviderAdapterFactory, isContextWindowCapable } from '../../providers/adapters';
import type { UnifiedSession, UnifiedMetrics, UnifiedMessage } from '../dtos/unified-session.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';

/** Transcript summary (metrics + session-level metadata) */
export interface TranscriptSummary {
  sessionId: string;
  providerName: string;
  metrics: UnifiedMetrics;
  messageCount: number;
  isOngoing: boolean;
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
  fileSizeBytes: number;
  fileMtimeMs: number;
  providerName: string;
}

export interface TranscriptToolResult {
  sessionId: string;
  toolCallId: string;
  content: string | unknown[];
  isError: boolean;
  fullLength: number;
}

export interface TranscriptTailResponse {
  cursor: string;
  replaceFromChunkIndex: number;
  deltaChunks: UnifiedChunk[];
  deltaMessages: UnifiedMessage[];
  metrics: UnifiedMetrics;
  totalChunkCount: number;
  totalMessageCount: number;
}

const DEFAULT_CHUNK_SIZE = 20;
const MAX_CHUNK_SIZE = 100;

const CHUNKS_CACHE_MAX_ENTRIES = 20;

interface ParseTimingData {
  resolveMs: number;
  parseOrCacheHitMs: number;
  buildChunksMs: number;
  cacheHit: boolean;
  fileSizeBytes: number;
  fileMtimeMs: number;
  providerName: string;
}

@Injectable()
export class SessionReaderService {
  private readonly logger = new Logger(SessionReaderService.name);
  private readonly chunksCache = new Map<string, { chunks: UnifiedChunk[]; lastOffset: number }>();

  constructor(
    private readonly adapterFactory: SessionReaderAdapterFactory,
    private readonly pathValidator: TranscriptPathValidator,
    private readonly sessionCacheService: SessionCacheService,
    private readonly sessionsService: SessionsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providerAdapterFactory: ProviderAdapterFactory,
  ) {}

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
    const { session } = await this.getParsedSession(sessionId);
    const metrics: UnifiedMetrics = session.metrics;

    return {
      sessionId,
      providerName: session.providerName,
      metrics,
      messageCount: metrics.messageCount,
      isOngoing: metrics.isOngoing,
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
    const { session } = await this.getParsedSession(sessionId);
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
   * Returns delta chunks and messages after the cursor's message count.
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

    const { session } = await this.getParsedSession(sessionId);
    const chunks = session.chunks ?? buildChunks(session.messages);

    if (cursorData.messageCount > session.messages.length) {
      return null;
    }

    const replaceFromChunkIndex = Math.max(0, cursorData.chunkCount - 1);
    const deltaMessages = truncateMessages(session.messages.slice(cursorData.messageCount));
    const deltaChunks = truncateChunks(chunks.slice(replaceFromChunkIndex));

    let fileSizeBytes = 0;
    try {
      const { transcriptPath } = await this.resolveAdapter(sessionId);
      fileSizeBytes = (await stat(transcriptPath)).size;
    } catch {
      /* best effort */
    }

    const cursor = encodeCursor(fileSizeBytes, session.messages.length, chunks.length);

    return {
      cursor,
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

  private async getParsedSession(
    sessionId: string,
  ): Promise<{ session: UnifiedSession; parseTiming: ParseTimingData }> {
    const tResolve = performance.now();
    const { adapter, transcriptPath, providerName, oneMillionContextEnabled } =
      await this.resolveAdapter(sessionId);
    const resolveMs = performance.now() - tResolve;

    const tParse = performance.now();
    const { session, cacheHit, lastOffset, lastSize, lastMtime } =
      await this.sessionCacheService.getOrParseWithMeta(sessionId, transcriptPath, adapter);
    const parseOrCacheHitMs = performance.now() - tParse;

    const cachedChunks = this.chunksCache.get(sessionId);
    let buildChunksMs = 0;
    if (cachedChunks && cachedChunks.lastOffset === lastOffset) {
      session.chunks = cachedChunks.chunks;
    } else {
      const tBuild = performance.now();
      session.chunks = buildChunks(session.messages);
      buildChunksMs = performance.now() - tBuild;
      this.chunksCache.set(sessionId, { chunks: session.chunks, lastOffset });
      if (this.chunksCache.size > CHUNKS_CACHE_MAX_ENTRIES) {
        const oldest = this.chunksCache.keys().next().value;
        if (oldest !== undefined) this.chunksCache.delete(oldest);
      }
    }

    let enrichedSession = session;
    const providerAdapter = this.providerAdapterFactory.getAdapter(providerName);
    if (isContextWindowCapable(providerAdapter)) {
      const overrideWindow = providerAdapter.getReadTimeContextWindow(
        session.metrics.primaryModel,
        oneMillionContextEnabled,
      );
      if (overrideWindow != null) {
        enrichedSession = {
          ...session,
          metrics: { ...session.metrics, contextWindowTokens: overrideWindow },
        };
      }
    }

    return {
      session: enrichedSession,
      parseTiming: {
        resolveMs,
        parseOrCacheHitMs,
        buildChunksMs,
        cacheHit,
        fileSizeBytes: lastSize,
        fileMtimeMs: lastMtime,
        providerName,
      },
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

    this.logger.debug(
      { sessionId, providerName, transcriptPath: validatedPath },
      'Resolved adapter for session transcript',
    );

    return { adapter, transcriptPath: validatedPath, providerName, oneMillionContextEnabled };
  }
}
