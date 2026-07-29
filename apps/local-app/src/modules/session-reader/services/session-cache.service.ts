import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type {
  IncrementalResult,
  SessionReaderAdapter,
  SessionSourceRef,
} from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMetrics, UnifiedMessage } from '../dtos/unified-session.types';
import { estimateVisibleFromMessages } from '../adapters/utils/estimate-content-tokens';
import { isToolResultOnlyMessage } from '../adapters/utils/tool-result-fold';
import { coalesceAssistantTurns, foldTurnParts } from '../adapters/utils/coalesce-turns';
import { MetricsService } from '../../metrics/services/metrics.service';
import type { CacheStats } from '../../metrics/types/metrics.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';

const DEFAULT_CACHE_IDLE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_CACHE_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const SAFE_INTEGER_LOW_BITS = 0x20_0000;
const FILE_HASH_CHUNK_BYTES = 64 * 1024;

interface FileContentDigests {
  prefixDigest: string;
  fullDigest: string;
}

interface FileFreshnessSnapshot {
  size: number;
  mtimeMs: number;
  fileIdentity?: string;
}

/**
 * Compress replacement-sensitive file stats into the cursor's numeric field.
 * Equality is the only contract: the SHA-256 truncation is stable across restarts
 * for unchanged stats, but like every 53-bit fingerprint has a theoretical collision.
 */
function fileSourceVersion(stat: {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}): number {
  const digest = createHash('sha256')
    .update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`)
    .digest();
  return digest.readUInt32BE(0) * SAFE_INTEGER_LOW_BITS + (digest.readUInt32BE(4) >>> 11);
}

export const TRANSCRIPT_CACHE_CONFIG = Symbol('TRANSCRIPT_CACHE_CONFIG');

export interface TranscriptCacheConfig {
  budgetBytes: number;
  idleTtlMs: number;
  sweepIntervalMs: number;
}

export function getTranscriptCacheConfig(): TranscriptCacheConfig {
  return {
    budgetBytes: positiveIntegerFromEnv(
      process.env.TRANSCRIPT_CACHE_MAX_BYTES,
      DEFAULT_CACHE_BUDGET_BYTES,
    ),
    idleTtlMs: positiveIntegerFromEnv(
      process.env.TRANSCRIPT_CACHE_IDLE_TTL_MS,
      DEFAULT_CACHE_IDLE_TTL_MS,
    ),
    sweepIntervalMs: positiveIntegerFromEnv(
      process.env.TRANSCRIPT_CACHE_SWEEP_INTERVAL_MS,
      DEFAULT_CACHE_SWEEP_INTERVAL_MS,
    ),
  };
}

export interface CachedChunks {
  chunks: UnifiedChunk[];
  sourceVersion: number;
}

export interface CachedTranscriptDto {
  result: Record<string, unknown>;
  responseBytes: number;
  maxToolResultLength: number;
  enrichmentFingerprint: string;
}

export interface CompositeWeights {
  parsed: number;
  chunks: number;
  dto: number;
}

export interface SessionCacheEntry {
  session: UnifiedSession;
  lastOffset: number;
  lastSize: number;
  lastMtime: number;
  /** Stable filesystem identity for file-backed sources; absent for DB sources. */
  fileIdentity?: string;
  /** SHA-256 of exactly `lastOffset` accepted bytes from the parsed file generation. */
  fileContentDigest?: string;
  /**
   * Numeric source revision (file: deterministic stat fingerprint; DB: the
   * token's `maxUpdated`, i.e. max `time_updated` across the session — see
   * {@link dbSourceVersion}).
   * Drives chunk-cache invalidation and the cursor's first component.
   */
  sourceVersion: number;
  /** Opaque freshness token (see {@link SessionReaderAdapter.getFreshnessToken}). */
  freshnessToken: unknown;
  lastAccessedAt: number;
  sourceWeightBytes: number;
  weights: CompositeWeights;
  chunks?: CachedChunks;
  dto?: CachedTranscriptDto;
  /**
   * True when the parse that produced this entry folded LEADING tool-result-only entries
   * of an incremental slice onto the cached tail assistant (a cache-boundary fold). It
   * mutates the tail while adding ZERO new messages, so the watcher must publish an
   * in-place tail replacement rather than suppressing the change. Always `false` for a
   * full reparse / snapshot / cache hit.
   */
  boundaryFold: boolean;
}

export type SourceChangeKind =
  | 'cache-hit'
  | 'same-file-append'
  | 'file-replacement'
  | 'file-truncation'
  | 'same-file-rewrite'
  | 'db-update'
  | 'unknown-full-parse';

export interface GetOrParseResult {
  session: UnifiedSession;
  cacheHit: boolean;
  sourceChangeKind: SourceChangeKind;
  lastOffset: number;
  lastSize: number;
  lastMtime: number;
  /** Numeric source revision compared by equality (see {@link SessionCacheEntry.sourceVersion}). */
  sourceVersion: number;
  /** See {@link SessionCacheEntry.boundaryFold}. */
  boundaryFold: boolean;
}

@Injectable()
export class SessionCacheService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(SessionCacheService.name);
  private readonly cache = new Map<string, SessionCacheEntry>();
  private hits = 0;
  private misses = 0;
  private chunksHits = 0;
  private chunksMisses = 0;
  private dtoHits = 0;
  private dtoMisses = 0;
  private budgetUsedBytes = 0;
  private evictions = 0;
  private idleSweepTimer?: NodeJS.Timeout;
  private readonly config: TranscriptCacheConfig;

  constructor(
    private readonly metricsService: MetricsService,
    @Optional()
    @Inject(TRANSCRIPT_CACHE_CONFIG)
    config?: TranscriptCacheConfig,
  ) {
    this.config = config ?? getTranscriptCacheConfig();
  }

  onModuleInit(): void {
    this.metricsService.registerCacheStatsProvider(
      'parsed',
      () => this.getCacheStats(),
      () => Array.from(this.cache.values(), (entry) => entry.session),
    );
    this.metricsService.registerCacheStatsProvider(
      'chunks',
      () => this.getChunksCacheStats(),
      () => this.getChunksRetainedRoots(),
    );
    this.idleSweepTimer = setInterval(() => this.sweepIdleEntries(), this.config.sweepIntervalMs);
    this.idleSweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
    this.clear();
  }

  getCacheStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      bytesEstimated: 0,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      bytesMethod: 'deferred-to-aggregate',
      budgetUsedBytes: this.budgetUsedBytes,
      budgetBytes: this.config.budgetBytes,
      evictions: this.evictions,
    };
  }

  getChunksCacheStats(): CacheStats {
    const total = this.chunksHits + this.chunksMisses;
    let entries = 0;
    for (const entry of this.cache.values()) {
      if (entry.chunks) entries += 1;
    }
    return {
      entries,
      bytesEstimated: 0,
      hits: this.chunksHits,
      misses: this.chunksMisses,
      hitRate: total > 0 ? this.chunksHits / total : 0,
      bytesMethod: 'deferred-to-aggregate',
    };
  }

  getDtoCacheStats(): CacheStats {
    let entries = 0;
    let bytesEstimated = 0;
    for (const entry of this.cache.values()) {
      if (!entry.dto) continue;
      entries += 1;
      bytesEstimated += entry.dto.responseBytes;
    }
    const total = this.dtoHits + this.dtoMisses;
    return {
      entries,
      bytesEstimated,
      hits: this.dtoHits,
      misses: this.dtoMisses,
      hitRate: total > 0 ? this.dtoHits / total : 0,
      bytesMethod: 'json-stringify-length',
    };
  }

  /**
   * Return the cached session only when source freshness still matches.
   * This read never parses or materializes a replacement session.
   */
  async getFreshSession(
    sessionId: string,
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
  ): Promise<UnifiedSession | undefined> {
    const cached = this.cache.get(sessionId);
    if (!cached) return undefined;

    const ref = this.toSourceRef(source, adapter);
    const freshness = await this.computeFreshness(ref, adapter);
    return this.takeFreshCachedSession(sessionId, cached, freshness.token, Date.now());
  }

  /**
   * Get or parse a session with incremental parsing and source-change detection.
   *
   * - Cache hit: source unchanged (freshness token equal) → return cached
   * - Append-only: the same file identity grew → incremental parse from offset
   * - Replacement/truncation: full reparse via adapter
   *
   * `source` accepts either a plain `filePath` (legacy/file callers) or a fully
   * resolved {@link SessionSourceRef}. When a ref is supplied, it is threaded into
   * the adapter's `parseFullSession` / `parseIncremental` so DB-backed adapters can
   * locate the session via `providerSessionId`.
   */
  async getOrParse(
    sessionId: string,
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
  ): Promise<UnifiedSession> {
    return (await this.getOrParseResult(sessionId, source, adapter)).session;
  }

  async getOrParseWithMeta(
    sessionId: string,
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
  ): Promise<GetOrParseResult> {
    return this.getOrParseResult(sessionId, source, adapter);
  }

  private async getOrParseResult(
    sessionId: string,
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
  ): Promise<GetOrParseResult> {
    const now = Date.now();
    const ref = this.toSourceRef(source, adapter);
    // Legacy string callers keep the original adapter call shape (filePath only);
    // ref callers thread the source-ref through to the adapter.
    const threadRef = typeof source !== 'string' ? ref : undefined;
    let freshness = await this.computeFreshness(ref, adapter);
    const cached = this.cache.get(sessionId);

    const freshSession = this.takeFreshCachedSession(sessionId, cached, freshness.token, now);
    if (freshSession && cached) {
      return this.toGetOrParseResult(freshSession, cached, true, 'cache-hit');
    }

    this.misses += 1;

    let session: UnifiedSession;
    let lastOffset: number;
    let boundaryFold = false;
    let acceptedFileDigests: FileContentDigests | undefined;
    const sameFileIdentity =
      ref.kind !== 'file' ||
      (cached?.fileIdentity !== undefined && cached.fileIdentity === freshness.fileIdentity);
    const fileReplaced = cached !== undefined && ref.kind === 'file' && !sameFileIdentity;
    const sameIdentityGrowth =
      cached !== undefined &&
      ref.kind === 'file' &&
      sameFileIdentity &&
      freshness.size > cached.lastSize;
    const growthDigests =
      sameIdentityGrowth && cached.fileContentDigest !== undefined
        ? await this.tryHashFileContent(ref.filePath, freshness, cached.lastOffset)
        : undefined;
    const provenSameFileAppend =
      sameIdentityGrowth &&
      cached.fileContentDigest !== undefined &&
      growthDigests?.prefixDigest === cached.fileContentDigest;
    let sourceChangeKind: SourceChangeKind = !cached
      ? 'unknown-full-parse'
      : ref.kind === 'db'
        ? 'db-update'
        : fileReplaced
          ? 'file-replacement'
          : freshness.size > cached.lastSize
            ? provenSameFileAppend
              ? 'same-file-append'
              : 'same-file-rewrite'
            : freshness.size < cached.lastSize
              ? 'file-truncation'
              : 'same-file-rewrite';

    // Inode continuity and growth are insufficient: earlier bytes must still match the
    // exact parsed prefix before an incremental read can safely extend the cached session.
    if (cached && provenSameFileAppend && growthDigests) {
      this.logger.debug(
        { sessionId, lastOffset: cached.lastOffset, currentSize: freshness.size },
        'Incremental parse (source grew)',
      );

      const incOptions = { byteOffset: cached.lastOffset, includeToolCalls: true };
      let tentativeResult: IncrementalResult | undefined = threadRef
        ? await adapter.parseIncremental(ref.filePath, incOptions, threadRef)
        : await adapter.parseIncremental(ref.filePath, incOptions);

      const postParseDigests = await this.tryHashFileContent(
        ref.filePath,
        freshness,
        freshness.size,
      );
      if (postParseDigests?.fullDigest !== growthDigests.fullDigest) {
        this.logger.debug(
          { sessionId },
          'Discarding incremental parse because its proven file revision drifted',
        );
        tentativeResult = undefined;
        freshness = await this.computeFreshness(ref, adapter);
        sourceChangeKind = this.classifyUnsafeFileChange(cached, freshness);
        session = threadRef
          ? await adapter.parseFullSession(ref.filePath, threadRef)
          : await adapter.parseFullSession(ref.filePath);
        lastOffset = freshness.size;
      } else {
        const acceptedResult = tentativeResult;
        acceptedFileDigests = postParseDigests;
        const newMessages = acceptedResult.entries as UnifiedMessage[];

        if (adapter.incrementalMode === 'snapshot') {
          // Snapshot mode returns the full session state on each incremental parse.
          const snapshotMetrics = acceptedResult.metrics ?? cached.session.metrics;
          session = {
            ...cached.session,
            messages: newMessages,
            metrics: snapshotMetrics,
            isOngoing: snapshotMetrics.isOngoing,
            warnings: this.mergeWarnings(cached.session.warnings, acceptedResult.warnings),
          };
        } else {
          // Cache-boundary continuation fold: a slice can begin with a LEADING RUN of
          // tool-result-only entries AND/OR continuation assistants whose turn started in a
          // PRIOR slice (the parser's parse-local fold has no target across the byteOffset
          // boundary). Fold them onto the cached tail assistant so the live/incremental path
          // matches the full-parse coalesce (no inflated messageCount). See
          // {@link SessionCacheEntry.boundaryFold}.
          const folded = this.foldLeadingContinuationIntoCachedTail(
            cached.session.messages,
            newMessages,
          );
          boundaryFold = folded.tailMutatedWithoutNewMessage;
          const mergedMessages = folded.merged;
          const mergedMetrics = acceptedResult.metrics
            ? this.mergeMetrics(cached.session.metrics, acceptedResult.metrics, mergedMessages)
            : cached.session.metrics;

          session = {
            ...cached.session,
            messages: mergedMessages,
            metrics: mergedMetrics,
            isOngoing: mergedMetrics.isOngoing,
            warnings: this.mergeWarnings(cached.session.warnings, acceptedResult.warnings),
          };
        }
        lastOffset = acceptedResult.nextByteOffset;
      }
    } else {
      // Full reparse: no cache, replacement, truncation, or same-size rewrite.
      if (fileReplaced) {
        this.logger.debug({ sessionId }, 'Full reparse (source replaced)');
      } else if (cached && freshness.size < cached.lastSize) {
        this.logger.debug({ sessionId }, 'Full reparse (source truncated)');
      }
      session = threadRef
        ? await adapter.parseFullSession(ref.filePath, threadRef)
        : await adapter.parseFullSession(ref.filePath);
      lastOffset = freshness.size;
    }

    // Unified assistant-turn coalescing (single source of truth) — the central choke-point.
    // Runs AFTER `session` is built from ANY branch (full reparse / snapshot / delta) and
    // BEFORE the cache store, so every provider gets identical turn-collapsing and
    // `messageCount === messages.length` holds. Claude/Codex parsers already coalesce → this
    // is a proven no-op for them; OpenCode (snapshot mode) is deflated here; on the delta path
    // `foldLeadingContinuationIntoCachedTail` already merged the boundary run, so the full-
    // array pass is a no-op there too. Also corrects the snapshot path's `messageCount`
    // (set from raw adapter output) via the recompute in the coalescer's returned metrics.
    const coalesced = coalesceAssistantTurns(session);
    // The coalescer returns the ORIGINAL `messages` reference on a true no-op (Claude/Codex,
    // or a delta already folded), so only rebuild the session object when turns actually
    // collapsed — preserving reference identity + the adapter's metrics for the no-op path.
    if (coalesced.messages !== session.messages) {
      session = { ...session, messages: coalesced.messages, metrics: coalesced.metrics };
    }
    session = this.withoutDerivedChunks(session);

    const fileContentDigest =
      ref.kind === 'file'
        ? lastOffset === freshness.size && acceptedFileDigests !== undefined
          ? acceptedFileDigests.fullDigest
          : (await this.tryHashFileContent(ref.filePath, freshness, lastOffset))?.prefixDigest
        : undefined;

    // A replacement entry owns every retained representation for this session.
    // Replacing it drops stale chunks/DTOs atomically before budget enforcement.
    this.deleteEntry(sessionId);
    const sourceWeightBytes = this.estimateSourceWeight(ref, session, freshness.size);
    const entry: SessionCacheEntry = {
      session,
      lastOffset,
      lastSize: freshness.size,
      lastMtime: freshness.mtimeMs,
      fileIdentity: freshness.fileIdentity,
      fileContentDigest,
      sourceVersion: freshness.sourceVersion,
      freshnessToken: freshness.token,
      lastAccessedAt: now,
      sourceWeightBytes,
      weights: { parsed: sourceWeightBytes * 2, chunks: 0, dto: 0 },
      boundaryFold,
    };
    this.cache.set(sessionId, entry);
    this.budgetUsedBytes += entry.weights.parsed;
    this.enforceBudget();

    return {
      session,
      cacheHit: false,
      sourceChangeKind,
      lastOffset,
      lastSize: freshness.size,
      lastMtime: freshness.mtimeMs,
      sourceVersion: freshness.sourceVersion,
      boundaryFold,
    };
  }

  getEntry(sessionId: string): SessionCacheEntry | undefined {
    return this.cache.get(sessionId);
  }

  getChunks(sessionId: string, sourceVersion: number): UnifiedChunk[] | undefined {
    const entry = this.cache.get(sessionId);
    if (!entry?.chunks || entry.chunks.sourceVersion !== sourceVersion) {
      this.chunksMisses += 1;
      return undefined;
    }
    this.chunksHits += 1;
    this.touchLru(sessionId, entry, Date.now());
    return entry.chunks.chunks;
  }

  setChunks(sessionId: string, sourceVersion: number, chunks: UnifiedChunk[]): void {
    const entry = this.cache.get(sessionId);
    if (!entry || entry.sourceVersion !== sourceVersion) return;

    this.budgetUsedBytes -= entry.weights.chunks;
    entry.chunks = { chunks, sourceVersion };
    entry.weights.chunks = entry.sourceWeightBytes;
    this.budgetUsedBytes += entry.weights.chunks;
    this.touchLru(sessionId, entry, Date.now());
    this.enforceBudget();
  }

  getDto(
    sessionId: string,
    maxToolResultLength: number,
    enrichmentFingerprint: string,
  ): CachedTranscriptDto | undefined {
    const entry = this.cache.get(sessionId);
    const dto = entry?.dto;
    if (
      !entry ||
      !dto ||
      dto.maxToolResultLength !== maxToolResultLength ||
      dto.enrichmentFingerprint !== enrichmentFingerprint
    ) {
      this.dtoMisses += 1;
      return undefined;
    }
    this.dtoHits += 1;
    this.touchLru(sessionId, entry, Date.now());
    return dto;
  }

  setDto(sessionId: string, dto: CachedTranscriptDto): void {
    const entry = this.cache.get(sessionId);
    if (!entry) return;

    this.budgetUsedBytes -= entry.weights.dto;
    entry.dto = dto;
    entry.weights.dto = dto.responseBytes;
    this.budgetUsedBytes += entry.weights.dto;
    this.touchLru(sessionId, entry, Date.now());
    this.enforceBudget();
  }

  invalidateDto(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (!entry?.dto) return;

    this.budgetUsedBytes -= entry.weights.dto;
    entry.dto = undefined;
    entry.weights.dto = 0;
  }

  getDtoRetainedRoots(): Iterable<unknown> {
    return Array.from(this.cache.values(), (entry) => entry.dto?.result);
  }

  getChunksRetainedRoots(): Iterable<unknown> {
    return Array.from(this.cache.values(), (entry) => entry.chunks?.chunks);
  }

  sweepIdleEntries(now = Date.now()): number {
    let swept = 0;
    for (const [sessionId, entry] of this.cache) {
      if (now - entry.lastAccessedAt < this.config.idleTtlMs) continue;
      this.deleteEntry(sessionId);
      swept += 1;
    }
    return swept;
  }

  /** Invalidate a specific session's cache entry. */
  invalidate(sessionId: string): void {
    this.deleteEntry(sessionId);
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
    this.budgetUsedBytes = 0;
  }

  /** Number of entries in cache. */
  get size(): number {
    return this.cache.size;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private takeFreshCachedSession(
    sessionId: string,
    cached: SessionCacheEntry | undefined,
    freshnessToken: unknown,
    now: number,
  ): UnifiedSession | undefined {
    if (!cached || JSON.stringify(cached.freshnessToken) !== JSON.stringify(freshnessToken)) {
      return undefined;
    }

    this.logger.debug({ sessionId }, 'Session cache hit');
    this.touchLru(sessionId, cached, now);
    this.hits += 1;
    return cached.session;
  }

  private toGetOrParseResult(
    session: UnifiedSession,
    entry: SessionCacheEntry,
    cacheHit: boolean,
    sourceChangeKind: SourceChangeKind,
  ): GetOrParseResult {
    return {
      session,
      cacheHit,
      sourceChangeKind,
      lastOffset: entry.lastOffset,
      lastSize: entry.lastSize,
      lastMtime: entry.lastMtime,
      sourceVersion: entry.sourceVersion,
      boundaryFold: entry.boundaryFold,
    };
  }

  /** Move entry to end of Map insertion order (LRU touch). */
  private touchLru(sessionId: string, entry: SessionCacheEntry, now: number): void {
    entry.lastAccessedAt = now;
    this.cache.delete(sessionId);
    this.cache.set(sessionId, entry);
  }

  private enforceBudget(): void {
    while (this.budgetUsedBytes > this.config.budgetBytes && this.cache.size > 0) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.deleteEntry(oldestKey);
        this.evictions += 1;
      }
    }
  }

  private deleteEntry(sessionId: string): void {
    const entry = this.cache.get(sessionId);
    if (!entry) return;
    this.budgetUsedBytes -= this.entryWeight(entry);
    this.cache.delete(sessionId);
  }

  private entryWeight(entry: SessionCacheEntry): number {
    return entry.weights.parsed + entry.weights.chunks + entry.weights.dto;
  }

  private estimateSourceWeight(
    ref: SessionSourceRef,
    session: UnifiedSession,
    sourceSize: number,
  ): number {
    if (ref.kind === 'file') return Math.max(1, sourceSize);

    // A DB container's file size is shared by many sessions. Use session-local token/message
    // proxies instead so one OpenCode session cannot claim the whole database allocation.
    const tokenProxy =
      Math.max(
        session.metrics.totalContextConsumption,
        session.metrics.totalTokens,
        session.metrics.visibleContextTokens,
      ) * 4;
    return Math.max(1_024, tokenProxy, session.messages.length * 256);
  }

  private withoutDerivedChunks(session: UnifiedSession): UnifiedSession {
    if (session.chunks === undefined) return session;
    const parsedSession = { ...session };
    delete parsedSession.chunks;
    return parsedSession;
  }

  /**
   * Cache-boundary continuation fold.
   *
   * An incremental slice parsed from a byteOffset can BEGIN with continuation content whose
   * assistant turn started in a PRIOR slice — the parser's parse-local fold/coalesce has no
   * target across the boundary (its `lastAssistantMessage` resets per parse), so the content
   * arrives as standalone messages and would inflate the live count. This folds a LEADING RUN
   * of such continuation messages onto the cached TAIL assistant so the live/incremental path
   * produces the SAME coalesced count as a full parse; `messageCount === messages.length` is
   * preserved (the metric is recomputed from the merged array, never decoupled).
   *
   * The run consumes a message when it is EITHER a tool-result-only entry (Case A:
   * `[tool_result, …]`) OR a continuation assistant (Case B: the slice begins directly with
   * the resumed assistant). It STOPS — a turn boundary — at the first: real user prompt;
   * `isCompactSummary` entry; sidechain mismatch vs the tail; or (Claude) a tail whose
   * `stopReason === 'end_turn'` (a completed turn is a new turn, not a continuation — the
   * guard advances as continuation assistants merge). Mirrors the per-provider parser
   * semantics (Tasks 1/2).
   *
   * The tail is CLONED — the cached message object prior callers may hold is never mutated.
   * `tailMutatedWithoutNewMessage` is true iff the run consumed the WHOLE slice (zero net new
   * messages) — the watcher consumes it (via `boundaryFold`) to publish a zero-count in-place
   * tail replacement. When the slice also carries a genuinely new message after the run, the
   * normal positive-delta publish already covers the mutated tail chunk.
   */
  private foldLeadingContinuationIntoCachedTail(
    cachedMessages: UnifiedMessage[],
    newMessages: UnifiedMessage[],
  ): { merged: UnifiedMessage[]; tailMutatedWithoutNewMessage: boolean } {
    const tail = cachedMessages[cachedMessages.length - 1];
    if (!tail || tail.role !== 'assistant' || newMessages.length === 0) {
      return { merged: [...cachedMessages, ...newMessages], tailMutatedWithoutNewMessage: false };
    }

    // Walk the LEADING run, advancing the end_turn guard as continuation assistants merge.
    let foldCount = 0;
    let tailStopReason = tail.stopReason ?? null;
    while (foldCount < newMessages.length) {
      const m = newMessages[foldCount];
      if (m.isSidechain !== tail.isSidechain) break; // sidechain transition → new context
      if (m.isCompactSummary) break; // compaction boundary
      const isToolResult = isToolResultOnlyMessage(m);
      const isContinuationAssistant = m.role === 'assistant';
      if (!isToolResult && !isContinuationAssistant) break; // real user prompt → new turn
      // Claude over-merge guard: a completed turn does not continue into a new assistant.
      if (isContinuationAssistant && tailStopReason === 'end_turn') break;
      if (isContinuationAssistant) tailStopReason = m.stopReason ?? null;
      foldCount += 1;
    }

    if (foldCount === 0) {
      return { merged: [...cachedMessages, ...newMessages], tailMutatedWithoutNewMessage: false };
    }

    // Clone the tail (do NOT mutate the cached object) and fold the run onto it.
    const foldedTail: UnifiedMessage = {
      ...tail,
      content: [...tail.content],
      toolCalls: [...tail.toolCalls],
      toolResults: [...tail.toolResults],
    };
    for (let i = 0; i < foldCount; i += 1) {
      // Shared merge primitive (`coalesce-turns.ts`): concat content/toolCalls/toolResults,
      // sum usage, and advance the persisted completion signal — identical to the full-array
      // coalescer, so the delta path and the central pass never drift.
      foldTurnParts(foldedTail, newMessages[i]);
    }

    const remaining = newMessages.slice(foldCount);
    return {
      merged: [...cachedMessages.slice(0, -1), foldedTail, ...remaining],
      tailMutatedWithoutNewMessage: remaining.length === 0,
    };
  }

  /**
   * Merge existing session metrics with incremental parse metrics.
   *
   * Token totals and cost are additive. Latest-state fields (isOngoing,
   * primaryModel, visibleContextTokens) come from the incremental result.
   * Compaction-related fields are kept from the existing metrics since they
   * cannot be reliably computed incrementally — they refresh on full reparse.
   */
  private mergeMetrics(
    existing: UnifiedMetrics,
    incremental: UnifiedMetrics,
    allMessages: UnifiedMessage[],
  ): UnifiedMetrics {
    const inputTokens = existing.inputTokens + incremental.inputTokens;
    const outputTokens = existing.outputTokens + incremental.outputTokens;
    const cacheReadTokens = existing.cacheReadTokens + incremental.cacheReadTokens;
    const cacheCreationTokens = existing.cacheCreationTokens + incremental.cacheCreationTokens;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

    // Duration from first to last message timestamp
    let durationMs = existing.durationMs;
    if (allMessages.length >= 2) {
      durationMs =
        allMessages[allMessages.length - 1].timestamp.getTime() -
        allMessages[0].timestamp.getTime();
    }

    // Models: union of both sets
    const modelsSet = new Set<string>();
    if (existing.primaryModel) modelsSet.add(existing.primaryModel);
    if (incremental.primaryModel) modelsSet.add(incremental.primaryModel);
    if (existing.modelsUsed) existing.modelsUsed.forEach((m) => modelsSet.add(m));
    if (incremental.modelsUsed) incremental.modelsUsed.forEach((m) => modelsSet.add(m));
    const modelsUsed = modelsSet.size > 1 ? Array.from(modelsSet) : undefined;

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
      costUsd: existing.costUsd + incremental.costUsd,
      primaryModel: incremental.primaryModel ?? existing.primaryModel,
      modelsUsed,
      isOngoing: incremental.isOngoing,
      // Recomputed from all messages (compaction-aware) on every merge
      // to avoid staleness between full reparses.
      visibleContextTokens: estimateVisibleFromMessages(allMessages),
      // Assistant usage snapshot always implies positive total tokens;
      // 0 means no assistant/token_count was observed in this delta slice.
      totalContextTokens:
        incremental.totalContextTokens > 0
          ? incremental.totalContextTokens
          : existing.totalContextTokens,
      contextWindowTokens: incremental.contextWindowTokens ?? existing.contextWindowTokens,
      messageCount: allMessages.length,
      durationMs,
      // Compaction fields: kept from existing (refreshed on full reparse)
      totalContextConsumption: existing.totalContextConsumption,
      compactionCount: existing.compactionCount,
      phaseBreakdowns: existing.phaseBreakdowns,
    };
  }

  /** Merge warnings from existing + incremental results with deduplication. */
  private mergeWarnings(existing?: string[], incremental?: string[]): string[] | undefined {
    const combined = new Set<string>();
    if (existing) existing.forEach((w) => combined.add(w));
    if (incremental) incremental.forEach((w) => combined.add(w));
    return combined.size > 0 ? Array.from(combined) : undefined;
  }

  private async statFile(filePath: string): Promise<{
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    fileIdentity: string;
  }> {
    const stat = await fs.stat(filePath);
    return {
      size: stat.size,
      mtimeMs: stat.mtime.getTime(),
      dev: stat.dev,
      ino: stat.ino,
      fileIdentity: `${stat.dev}:${stat.ino}`,
    };
  }

  private classifyUnsafeFileChange(
    cached: SessionCacheEntry,
    current: FileFreshnessSnapshot,
  ): SourceChangeKind {
    if (
      cached.fileIdentity === undefined ||
      current.fileIdentity === undefined ||
      cached.fileIdentity !== current.fileIdentity
    ) {
      return 'file-replacement';
    }
    if (current.size < cached.lastSize) {
      return 'file-truncation';
    }
    return 'same-file-rewrite';
  }

  private async tryHashFileContent(
    filePath: string,
    expected: FileFreshnessSnapshot,
    prefixLength: number,
  ): Promise<FileContentDigests | undefined> {
    try {
      return await this.hashFileContent(filePath, expected, prefixLength);
    } catch (error) {
      this.logger.debug({ error, filePath }, 'File prefix proof unavailable — append is unsafe');
      return undefined;
    }
  }

  private async hashFileContent(
    filePath: string,
    expected: FileFreshnessSnapshot,
    prefixLength: number,
  ): Promise<FileContentDigests> {
    if (
      !Number.isSafeInteger(prefixLength) ||
      prefixLength < 0 ||
      prefixLength > expected.size ||
      expected.fileIdentity === undefined
    ) {
      throw new Error('Invalid file prefix proof bounds');
    }

    const handle = await fs.open(filePath, 'r');
    const assertStableSnapshot = async (): Promise<void> => {
      const current = await handle.stat();
      if (
        current.size !== expected.size ||
        current.mtime.getTime() !== expected.mtimeMs ||
        `${current.dev}:${current.ino}` !== expected.fileIdentity
      ) {
        throw new Error('File changed while computing append proof');
      }
    };

    try {
      await assertStableSnapshot();
      const prefixHash = createHash('sha256');
      const fullHash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(
        Math.min(FILE_HASH_CHUNK_BYTES, Math.max(1, expected.size)),
      );
      let position = 0;

      while (position < expected.size) {
        const requested = Math.min(buffer.byteLength, expected.size - position);
        const { bytesRead } = await handle.read(buffer, 0, requested, position);
        if (bytesRead === 0) {
          throw new Error('File ended while computing append proof');
        }

        const chunk = buffer.subarray(0, bytesRead);
        fullHash.update(chunk);
        const prefixBytes = Math.min(bytesRead, Math.max(0, prefixLength - position));
        if (prefixBytes > 0) {
          prefixHash.update(chunk.subarray(0, prefixBytes));
        }
        position += bytesRead;
      }

      await assertStableSnapshot();
      return {
        prefixDigest: prefixHash.digest('hex'),
        fullDigest: fullHash.digest('hex'),
      };
    } finally {
      await handle.close();
    }
  }

  /** Normalize a `filePath | SessionSourceRef` argument into a SessionSourceRef. */
  private toSourceRef(
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
  ): SessionSourceRef {
    if (typeof source === 'string') {
      return {
        filePath: source,
        providerName: adapter.providerName,
        kind: adapter.sourceKind ?? 'file',
      };
    }
    return source;
  }

  /**
   * Compute the cache freshness inputs for a source:
   * - `token`: opaque staleness token (adapter-provided, else default file token).
   * - `sourceVersion`: numeric equality revision (file: stat fingerprint; DB: see below).
   * - `size` / `mtimeMs`: byte stats used for append/truncation detection and
   *   backward-compatible cache metadata.
   * - `fileIdentity`: device/inode identity used to distinguish append from replacement.
   *
   * File sources fingerprint size, mtime, device, and inode so atomic replacement
   * advances the revision even when byte size is unchanged. DB sources derive it
   * from the adapter's freshness token instead — see {@link dbSourceVersion} for
   * why the container file size is unusable there.
   */
  private async computeFreshness(
    ref: SessionSourceRef,
    adapter: SessionReaderAdapter,
  ): Promise<{
    token: unknown;
    sourceVersion: number;
    size: number;
    mtimeMs: number;
    fileIdentity?: string;
  }> {
    const { size, mtimeMs, dev, ino, fileIdentity } = await this.statFile(ref.filePath);
    // Default file token mirrors {@link defaultFileFreshnessToken} but reuses the
    // stat above to avoid a redundant fs.stat call on the hot path.
    const adapterToken = adapter.getFreshnessToken
      ? await adapter.getFreshnessToken(ref)
      : { mtimeMs, size, dev, ino };
    // A custom file token is still bound to filesystem identity so an atomic rewrite
    // cannot keep a stale entry warm. DB tokens remain fully adapter-owned because a
    // shared container inode does not identify an individual session revision.
    const token =
      ref.kind === 'file' && adapter.getFreshnessToken ? { adapterToken, dev, ino } : adapterToken;
    const sourceVersion =
      ref.kind === 'db'
        ? this.dbSourceVersion(token, size)
        : fileSourceVersion({ size, mtimeMs, dev, ino });
    return {
      token,
      sourceVersion,
      size,
      mtimeMs,
      fileIdentity: ref.kind === 'file' ? fileIdentity : undefined,
    };
  }

  /**
   * Derive a per-session, revision-tracking `sourceVersion` for a DB source from
   * its opaque freshness token.
   *
   * Why not the filesystem-stat fingerprint used by file sources? A DB-backed
   * source (e.g. OpenCode) keeps *many* sessions in one `opencode.db`, and in-place
   * WAL part edits mutate rows without changing that shared container's main-file
   * stats. A stat-based `sourceVersion` would therefore be (a) identical for every
   * session in the file and (b) frozen across exactly the in-place-edit case
   * `getTranscriptTail` must surface — making the tail a no-op.
   *
   * The token's `maxUpdated` (max `time_updated` over the session's
   * session/message/part rows) advances on BOTH new parts and in-place edits, so
   * it is the change-tracking signal we key on. `count` alone is insufficient: it
   * does not move on an in-place edit (the core scenario of this task).
   *
   * NOTE: parent design decision #4 specced DB `sourceVersion` = `max(rowid)` /
   * `count`; that misses in-place part edits, so we deliberately deviate to the
   * `maxUpdated`-driven value here.
   */
  private dbSourceVersion(token: unknown, fallbackSize: number): number {
    if (token && typeof token === 'object') {
      const t = token as { maxUpdated?: unknown };
      if (typeof t.maxUpdated === 'number' && Number.isFinite(t.maxUpdated)) {
        return t.maxUpdated;
      }
    }
    return fallbackSize;
  }
}

function positiveIntegerFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
