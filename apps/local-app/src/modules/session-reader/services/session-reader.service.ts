import { Inject, Injectable, Logger } from '@nestjs/common';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import { buildChunks } from '../builders/chunk-builder';
import type {
  UnifiedSession,
  UnifiedMetrics,
  UnifiedMessage,
  UnifiedToolResult,
} from '../dtos/unified-session.types';

/** Transcript summary (metrics + session-level metadata) */
export interface TranscriptSummary {
  sessionId: string;
  providerName: string;
  metrics: UnifiedMetrics;
  messageCount: number;
  isOngoing: boolean;
}

/** Paginated chunk response */
export interface ChunkedTranscriptResponse {
  chunks: TranscriptChunk[];
  nextCursor: string | null;
  hasMore: boolean;
  totalChunks: number;
}

/** A single chunk of messages */
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

export interface TranscriptToolResult {
  sessionId: string;
  toolCallId: string;
  content: string | unknown[];
  isError: boolean;
  fullLength: number;
}

const DEFAULT_CHUNK_SIZE = 20;
const MAX_CHUNK_SIZE = 100;

/** Default cache TTL in milliseconds (30 seconds) */
const DEFAULT_CACHE_TTL_MS = 30_000;
/** Cache TTL for large transcripts in milliseconds (120 seconds) */
const LARGE_SESSION_CACHE_TTL_MS = 120_000;
/** Transcript size threshold for large-session cache behavior */
const LARGE_SESSION_MESSAGE_THRESHOLD = 1_000;

/** Maximum number of cached transcript entries */
const CACHE_MAX_ENTRIES = 20;

interface TranscriptCacheEntry {
  session: UnifiedSession;
  cachedAt: number;
  ttlMs: number;
}

@Injectable()
export class SessionReaderService {
  private readonly logger = new Logger(SessionReaderService.name);
  private readonly transcriptCache = new Map<string, TranscriptCacheEntry>();

  constructor(
    private readonly adapterFactory: SessionReaderAdapterFactory,
    private readonly pathValidator: TranscriptPathValidator,
    private readonly sessionsService: SessionsService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /**
   * Get full parsed transcript for a session.
   *
   * Resolution chain: session → agent → providerConfig → provider → adapter → parse
   */
  async getTranscript(sessionId: string, options?: GetTranscriptOptions): Promise<UnifiedSession> {
    const session = await this.getParsedSession(sessionId);
    const maxToolResultLength = options?.maxToolResultLength;
    if (maxToolResultLength === undefined) {
      return session;
    }
    return this.applyToolResultTruncation(session, maxToolResultLength);
  }

  /**
   * Get summary metrics for a session transcript.
   */
  async getTranscriptSummary(sessionId: string): Promise<TranscriptSummary> {
    const session = await this.getParsedSession(sessionId);
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
   * Get full (untruncated) tool result content by tool call id.
   */
  async getToolResult(sessionId: string, toolCallId: string): Promise<TranscriptToolResult> {
    const session = await this.getParsedSession(sessionId);

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

  /**
   * Get or parse a session transcript with in-memory LRU caching.
   * Avoids full file reparse when paginating through chunks.
   */
  private async getParsedSession(sessionId: string): Promise<UnifiedSession> {
    const now = Date.now();
    const cached = this.transcriptCache.get(sessionId);

    if (cached && now - cached.cachedAt < cached.ttlMs) {
      this.logger.debug({ sessionId }, 'Transcript cache hit');
      // LRU: move to end of insertion order
      this.transcriptCache.delete(sessionId);
      this.transcriptCache.set(sessionId, cached);
      return cached.session;
    }

    const { adapter, transcriptPath } = await this.resolveAdapter(sessionId);
    const session = await adapter.parseFullSession(transcriptPath);
    session.chunks = buildChunks(session.messages);

    // Evict oldest entry if at capacity
    if (this.transcriptCache.size >= CACHE_MAX_ENTRIES && !this.transcriptCache.has(sessionId)) {
      const oldestKey = this.transcriptCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.transcriptCache.delete(oldestKey);
      }
    }

    // Insert (or replace stale entry)
    const ttlMs = this.getCacheTtlMs(session);

    this.transcriptCache.delete(sessionId);
    this.transcriptCache.set(sessionId, { session, cachedAt: now, ttlMs });

    return session;
  }

  private getCacheTtlMs(session: UnifiedSession): number {
    return session.messages.length > LARGE_SESSION_MESSAGE_THRESHOLD
      ? LARGE_SESSION_CACHE_TTL_MS
      : DEFAULT_CACHE_TTL_MS;
  }

  private applyToolResultTruncation(session: UnifiedSession, maxLength: number): UnifiedSession {
    if (!Number.isInteger(maxLength) || maxLength < 1) {
      throw new ValidationError('maxToolResultLength must be a positive integer');
    }

    const truncatedByToolCallId = new Map<string, UnifiedToolResult>();

    const messages = session.messages.map((message) => {
      const truncatedToolResults = message.toolResults.map((result) => {
        const truncated = this.truncateToolResult(result, maxLength);
        truncatedByToolCallId.set(result.toolCallId, truncated);
        return truncated;
      });

      const content = message.content.map((block) => {
        if (block.type !== 'tool_result') return block;
        const truncated = truncatedByToolCallId.get(block.toolCallId);
        if (!truncated) return block;
        return {
          ...block,
          content: truncated.content,
          isTruncated: truncated.isTruncated,
          fullLength: truncated.fullLength,
        };
      });

      return {
        ...message,
        content,
        toolResults: truncatedToolResults,
      };
    });

    const serializedMessageById = new Map(messages.map((message) => [message.id, message]));
    const chunks = session.chunks?.map((chunk) => {
      const chunkMessages = chunk.messages.map(
        (message) => serializedMessageById.get(message.id) ?? message,
      );

      if (chunk.type !== 'ai' || !('semanticSteps' in chunk) || !chunk.semanticSteps) {
        return { ...chunk, messages: chunkMessages };
      }

      const truncateToolResultStep = (step: (typeof chunk.semanticSteps)[number]) => {
        if (step.type !== 'tool_result' || !step.content.toolCallId) {
          return step;
        }

        const truncated = truncatedByToolCallId.get(step.content.toolCallId);
        if (!truncated || !truncated.isTruncated) {
          return step;
        }

        return {
          ...step,
          content: {
            ...step.content,
            toolResultContent: truncated.content,
            isTruncated: true,
            fullLength: truncated.fullLength,
          },
        };
      };

      const semanticSteps = chunk.semanticSteps.map(truncateToolResultStep);
      const turns = chunk.turns.map((turn) => ({
        ...turn,
        steps: turn.steps.map(truncateToolResultStep),
      }));

      return { ...chunk, messages: chunkMessages, semanticSteps, turns };
    });

    return {
      ...session,
      messages,
      chunks,
    };
  }

  private truncateToolResult(result: UnifiedToolResult, maxLength: number): UnifiedToolResult {
    if (typeof result.content !== 'string') {
      return result;
    }

    const fullLength = result.content.length;
    if (fullLength <= maxLength) {
      return result;
    }

    return {
      ...result,
      content: result.content.slice(0, maxLength) + '…',
      isTruncated: true,
      fullLength,
    };
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

    return { adapter, transcriptPath: validatedPath, providerName };
  }
}
