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
  ParseOptions,
  SessionReaderAdapter,
  SessionSourceRef,
} from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMessage } from '../dtos/unified-session.types';
import { coalesceAssistantTurns, foldTurnParts } from '../adapters/utils/coalesce-turns';
import {
  computeLeadingContinuationFold,
  deriveMergeInputsFromMessages,
  describeTail,
  mergeMetrics,
} from './metrics-merge';
import {
  anchorsEqual,
  hashFileAnchors,
  type FileContentAnchors,
  type FileFreshnessSnapshot,
} from './bounded-anchor-proof';
import { lastCompleteLineEnd } from '../parsers/bounded-line-read';
import { MetricsService } from '../../metrics/services/metrics.service';
import type { CacheStats } from '../../metrics/types/metrics.types';
import type { UnifiedChunk } from '../dtos/unified-chunk.types';
import { buildChunks } from '../builders/chunk-builder';

const DEFAULT_CACHE_IDLE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_CACHE_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;
const SAFE_INTEGER_LOW_BITS = 0x20_0000;
/** FIFO cap on the per-session full-parse cost record (bounds it without a lifecycle hook). */
const FULL_PARSE_COST_CAP = 256;

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
  sourceIdentity: string;
  session: UnifiedSession;
  lastOffset: number;
  lastSize: number;
  lastMtime: number;
  /** Stable filesystem identity for file-backed sources; absent for DB sources. */
  fileIdentity?: string;
  /**
   * Bounded head/tail SHA-256 anchors over the `[0, lastOffset)` accepted bytes of the
   * parsed file generation (see {@link FileContentAnchors}); absent for DB sources.
   */
  fileContentAnchors?: FileContentAnchors;
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
  /**
   * Opaque per-adapter continuation state from the last incremental parse (Codex token
   * baseline), threaded into the next `parseIncremental` so the adapter skips rescanning
   * earlier bytes. Cleared (undefined) by a full parse. File-delta adapters only.
   */
  continuationState?: unknown;
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
  /**
   * Accepted append proof anchors for the entry's `[0, lastOffset)` bytes (file sources
   * only; see {@link SessionCacheEntry.fileContentAnchors}). Exposed so downstream lane
   * state can carry the proven anchors without re-hashing.
   */
  fileContentAnchors?: FileContentAnchors;
  /**
   * Accepted opaque continuation state for the entry (see
   * {@link SessionCacheEntry.continuationState}). Exposed so downstream lane state can carry
   * it forward without re-deriving it.
   */
  continuationState?: unknown;
}

/**
 * The generation of a cache entry BEFORE a refresh mutated it: the values a viewing client
 * holds when it created/last-read the entry. {@link SessionCacheService.refreshIfPresent}
 * reports it so the watcher can adopt it as its previous generation and emit a correct delta
 * (or nothing, on a cache hit) when it switches from the lane to the body path.
 */
export interface PreParseGeneration {
  sourceVersion: number;
  messageCount: number;
  chunkCount: number;
}

export type RefreshIfPresentResult =
  | { present: false; lastFullParse?: { seq: number; durationMs: number } }
  | { present: true; preParse: PreParseGeneration; result: GetOrParseResult };

/** Whether a parse may create a new entry (`always`) or must only refresh an existing one. */
type ParseMode = 'always' | 'ifPresent';

interface ParseSnapshot {
  /** Absent only for an `ifPresent` pass that found no entry (see {@link absent}). */
  result?: GetOrParseResult;
  freshnessToken: unknown;
  /** An `ifPresent` refresh found no same-identity entry — nothing parsed, nothing created. */
  absent?: boolean;
  /** Generation of the entry before an `ifPresent` refresh mutated it. */
  preParse?: PreParseGeneration;
}

interface ParseFlight {
  sourceIdentity: string;
  generation: number;
  promise: Promise<ParseSnapshot>;
  next?: ParseFlight;
}

@Injectable()
export class SessionCacheService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(SessionCacheService.name);
  private readonly cache = new Map<string, SessionCacheEntry>();
  private readonly parseFlights = new Map<string, ParseFlight>();
  private flightGeneration = 0;
  private hits = 0;
  private misses = 0;
  private chunksHits = 0;
  private chunksMisses = 0;
  private dtoHits = 0;
  private dtoMisses = 0;
  private budgetUsedBytes = 0;
  private evictions = 0;
  /** Service-wide monotonic counter, bumped on every recorded full parse. */
  private fullParseSeq = 0;
  /**
   * Last full-parse cost per session (`{ seq, durationMs }`), keyed by sessionId. Kept OUTSIDE the
   * entry cache so it survives eviction and {@link invalidate}: a large viewed session whose entry
   * cannot stay resident is served by the watcher's metrics-only lane, and the lane reads this to
   * tell whether a reader just paid a costly full parse and so re-applies the refresh cooldown.
   * FIFO-capped at {@link FULL_PARSE_COST_CAP}; a dropped record costs at most one unthrottled pass.
   */
  private readonly fullParseCosts = new Map<string, { seq: number; durationMs: number }>();
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
    this.fullParseCosts.clear();
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
    if (cached.sourceIdentity !== this.sourceIdentity(ref)) return undefined;
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
    const sourceIdentity = this.sourceIdentity(this.toSourceRef(source, adapter));
    const arrivalGeneration = this.flightGeneration;
    const existing = this.parseFlights.get(sessionId);
    if (!existing) {
      return (await this.startParseFlight(sessionId, source, adapter).promise).result!;
    }
    let flight: ParseFlight = existing;

    for (;;) {
      const sameSource = flight.sourceIdentity === sourceIdentity;
      let snapshot: ParseSnapshot | undefined;
      try {
        snapshot = await flight.promise;
      } catch (error) {
        if (sameSource) throw error;
      }
      // An absent snapshot (an `ifPresent` refresh that created nothing) is never a shareable
      // result: a viewer that joined it must fall through and start its own real parse.
      const shareable = snapshot && !snapshot.absent ? snapshot : undefined;
      // A snapshot started after arrival bounds waiting even if the source keeps growing.
      if (sameSource && shareable && flight.generation > arrivalGeneration) {
        return this.sharedResult(shareable.result!);
      }

      const next: ParseFlight | undefined = flight.next ?? this.parseFlights.get(sessionId);
      if (next) {
        flight = next;
        continue;
      }

      // Waiters retain this link locally, including when the follow-up self-evicts
      // and settles before a slower waiter resumes. No settled flight stays in the map.
      const refresh = this.startParseFlight(
        sessionId,
        source,
        adapter,
        sameSource ? shareable : undefined,
      );
      flight.next = refresh;
      return (await refresh.promise).result!;
    }
  }

  /**
   * Refresh a session ONLY when a same-identity entry is already cached, otherwise report
   * `absent` without parsing or creating anything. The presence check and the refresh run as
   * one flight so they cannot race eviction into recreating the entry (the thrash path a
   * `getEntry` + `getOrParse` pair would take). The watcher's metrics-only lane uses this to
   * stay off the cache until a reader creates an entry.
   */
  async refreshIfPresent(
    sessionId: string,
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
  ): Promise<RefreshIfPresentResult> {
    const snapshot = await this.resolveIfPresentFlight(sessionId, source, adapter);
    return this.toRefreshResult(sessionId, snapshot);
  }

  /**
   * Settle an `ifPresent` pass through the SAME successor-aware chain {@link getOrParseResult}
   * walks (`flight.next ?? parseFlights.get`), so it never installs a competing flight beside one
   * a `getOrParse` waiter already chained — which would run two full parses for the same key at
   * once. It adopts any same-source snapshot from a flight that STARTED after arrival, and only
   * starts its OWN flight at the tail. That tail flight is `ifPresent`, so it never creates an
   * entry; a `getOrParse` waiter's created/refreshed entry is instead observed by sharing its
   * (non-absent) snapshot.
   */
  private async resolveIfPresentFlight(
    sessionId: string,
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
  ): Promise<ParseSnapshot> {
    const sourceIdentity = this.sourceIdentity(this.toSourceRef(source, adapter));
    const arrivalGeneration = this.flightGeneration;
    const existing = this.parseFlights.get(sessionId);
    if (!existing) {
      return this.startParseFlight(sessionId, source, adapter, undefined, 'ifPresent').promise;
    }
    let flight: ParseFlight = existing;
    for (;;) {
      const sameSource = flight.sourceIdentity === sourceIdentity;
      let snapshot: ParseSnapshot | undefined;
      try {
        snapshot = await flight.promise;
      } catch {
        // A failed flight yields nothing to adopt; continue to its successor or our own pass.
      }
      // An absent snapshot (a prior `ifPresent` pass that created nothing) is never adopted: a
      // later flight may hold the entry, so keep walking exactly as `getOrParseResult` does.
      const shareable = snapshot && !snapshot.absent ? snapshot : undefined;
      // A snapshot from a flight that started after arrival reflects the post-arrival state.
      if (sameSource && shareable && flight.generation > arrivalGeneration) {
        return shareable;
      }

      const next: ParseFlight | undefined = flight.next ?? this.parseFlights.get(sessionId);
      if (next) {
        flight = next;
        continue;
      }

      const refresh = this.startParseFlight(
        sessionId,
        source,
        adapter,
        sameSource ? shareable : undefined,
        'ifPresent',
      );
      flight.next = refresh;
      return refresh.promise;
    }
  }

  private toRefreshResult(sessionId: string, snapshot: ParseSnapshot): RefreshIfPresentResult {
    if (snapshot.absent || !snapshot.result) {
      const record = this.fullParseCosts.get(sessionId);
      return record
        ? { present: false, lastFullParse: { seq: record.seq, durationMs: record.durationMs } }
        : { present: false };
    }
    // Our own `ifPresent` flight supplies the true pre-parse generation and classification.
    if (snapshot.preParse) {
      return { present: true, preParse: snapshot.preParse, result: snapshot.result };
    }
    // A shared `getOrParse` (`always`) successor carries no pre-parse generation, and its
    // classification (e.g. `same-file-rewrite` after growth during a held full parse) describes
    // the READER's parse, not a change this caller observed. Hand it over exactly as
    // `getOrParseResult` shares a joined flight: a cache hit on the adopted generation. A lane
    // watcher that adopts that generation then publishes nothing (the reader already holds it);
    // a body-path watcher still sees a changed cache hit and requires a refetch, as before.
    return {
      present: true,
      preParse: this.preParseFromResult(snapshot.result),
      result: this.sharedResult(snapshot.result),
    };
  }

  private startParseFlight(
    sessionId: string,
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
    previous?: ParseSnapshot,
    mode: ParseMode = 'always',
  ): ParseFlight {
    const sourceIdentity = this.sourceIdentity(this.toSourceRef(source, adapter));
    const flight: ParseFlight = {
      sourceIdentity,
      generation: ++this.flightGeneration,
      promise: Promise.resolve()
        .then(() => this.parseSession(sessionId, source, adapter, sourceIdentity, previous, mode))
        .finally(() => {
          if (this.parseFlights.get(sessionId) === flight) {
            this.parseFlights.delete(sessionId);
          }
        }),
    };
    this.parseFlights.set(sessionId, flight);
    return flight;
  }

  private sharedResult(result: GetOrParseResult): GetOrParseResult {
    this.hits += 1;
    return { ...result, cacheHit: true, sourceChangeKind: 'cache-hit', boundaryFold: false };
  }

  /**
   * Run and time a full parse, recording its cost for the session. The watcher's lane reads this
   * (via {@link refreshIfPresent}) to re-apply the refresh cooldown when a reader pays a costly full
   * parse for a session whose entry cannot stay resident.
   */
  private async timedFullParse(
    sessionId: string,
    adapter: SessionReaderAdapter,
    filePath: string,
    threadRef: SessionSourceRef | undefined,
  ): Promise<UnifiedSession> {
    const startedAt = performance.now();
    const session = threadRef
      ? await adapter.parseFullSession(filePath, threadRef)
      : await adapter.parseFullSession(filePath);
    this.recordFullParse(sessionId, performance.now() - startedAt);
    return session;
  }

  private recordFullParse(sessionId: string, durationMs: number): void {
    this.fullParseSeq += 1;
    // FIFO cap: only a NEW session key can grow the map; evict the oldest key when it is full.
    if (!this.fullParseCosts.has(sessionId) && this.fullParseCosts.size >= FULL_PARSE_COST_CAP) {
      const oldest = this.fullParseCosts.keys().next().value;
      if (oldest !== undefined) this.fullParseCosts.delete(oldest);
    }
    this.fullParseCosts.set(sessionId, { seq: this.fullParseSeq, durationMs });
  }

  private async parseSession(
    sessionId: string,
    source: string | SessionSourceRef,
    adapter: SessionReaderAdapter,
    sourceIdentity: string,
    previous?: ParseSnapshot,
    mode: ParseMode = 'always',
  ): Promise<ParseSnapshot> {
    const now = Date.now();
    const ref = this.toSourceRef(source, adapter);
    // Legacy string callers keep the original adapter call shape (filePath only);
    // ref callers thread the source-ref through to the adapter.
    const threadRef = typeof source !== 'string' ? ref : undefined;
    let freshness = await this.computeFreshness(ref, adapter);
    const retained = this.cache.get(sessionId);
    const cached = retained?.sourceIdentity === sourceIdentity ? retained : undefined;

    // `ifPresent` refresh: the entry may have been evicted during the freshness await above.
    // Report absent instead of parsing so an eviction can never be recreated as a retained
    // entry (the metrics-only lane must never touch the cache).
    if (mode === 'ifPresent' && !cached) {
      return { absent: true, freshnessToken: freshness.token };
    }
    // Capture the entry's generation BEFORE this refresh mutates it (for the lane→body switch).
    const preParse = mode === 'ifPresent' && cached ? this.preParseGeneration(cached) : undefined;

    if (previous && JSON.stringify(previous.freshnessToken) === JSON.stringify(freshness.token)) {
      if (cached && cached.session === previous.result?.session)
        this.touchLru(sessionId, cached, now);
      return {
        result: this.sharedResult(previous.result!),
        freshnessToken: freshness.token,
        preParse,
      };
    }

    const freshSession = this.takeFreshCachedSession(sessionId, cached, freshness.token, now);
    if (freshSession && cached) {
      return {
        result: this.toGetOrParseResult(freshSession, cached, true, 'cache-hit'),
        freshnessToken: freshness.token,
        preParse,
      };
    }

    this.misses += 1;

    let session: UnifiedSession;
    let lastOffset: number;
    let boundaryFold = false;
    let acceptedFileAnchors: FileContentAnchors | undefined;
    // Opaque adapter continuation state to store on the new entry; only an accepted incremental
    // parse carries one forward. A full parse (any branch below) leaves it undefined = cleared.
    let continuationState: unknown;
    const sameFileIdentity =
      ref.kind !== 'file' ||
      (cached?.fileIdentity !== undefined && cached.fileIdentity === freshness.fileIdentity);
    const fileReplaced = cached !== undefined && ref.kind === 'file' && !sameFileIdentity;
    const sameIdentityGrowth =
      cached !== undefined &&
      ref.kind === 'file' &&
      sameFileIdentity &&
      freshness.size > cached.lastSize;
    // Pre-parse proof: re-read the cached prefix's bounded head/tail anchors and require
    // BOTH to match the stored pair. Inode continuity and growth alone are insufficient —
    // the earlier bytes must still be the exact parsed prefix before an incremental read
    // may extend the cached session.
    const growthAnchors =
      sameIdentityGrowth && cached.fileContentAnchors !== undefined
        ? await this.tryHashFileAnchors(ref.filePath, freshness, cached.lastOffset)
        : undefined;
    const provenSameFileAppend =
      sameIdentityGrowth &&
      cached.fileContentAnchors !== undefined &&
      anchorsEqual(growthAnchors, cached.fileContentAnchors);
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

    if (cached && provenSameFileAppend && cached.fileContentAnchors) {
      this.logger.debug(
        { sessionId, lastOffset: cached.lastOffset, currentSize: freshness.size },
        'Incremental parse (source grew)',
      );

      // Bound delta reads to the proven snapshot size: a file that grows mid-parse yields no
      // bytes beyond it (they arrive next pass). Snapshot adapters re-read from 0 and ignore
      // the bound, so it is not threaded for them.
      const incOptions: ParseOptions = { byteOffset: cached.lastOffset, includeToolCalls: true };
      if (adapter.incrementalMode === 'delta') {
        incOptions.endByteOffset = freshness.size;
      }
      // Carry the prior opaque continuation state (e.g. Codex token baseline) into this parse
      // so the adapter can skip rescanning earlier bytes. Absent → the adapter falls back.
      if (cached.continuationState !== undefined) {
        incOptions.continuationState = cached.continuationState;
      }
      let tentativeResult: IncrementalResult | undefined = threadRef
        ? await adapter.parseIncremental(ref.filePath, incOptions, threadRef)
        : await adapter.parseIncremental(ref.filePath, incOptions);
      const newOffset = tentativeResult.nextByteOffset;

      // Post-parse proof: the file must still be the same inode and no shorter than the
      // snapshot (allowGrowth), the proven prefix anchors must STILL match (no mid-parse
      // rewrite), and only then do we capture the accepted-prefix anchors ending at the new
      // offset for the next append's pre-parse proof. Any mismatch, missing proof, or a
      // regressing offset discards the tentative result and falls back to a full parse.
      const prefixHeld =
        newOffset >= cached.lastOffset &&
        anchorsEqual(
          await this.tryHashFileAnchors(ref.filePath, freshness, cached.lastOffset, true),
          cached.fileContentAnchors,
        );
      const proofAnchors = prefixHeld
        ? await this.tryHashFileAnchors(ref.filePath, freshness, newOffset, true)
        : undefined;
      if (proofAnchors === undefined) {
        this.logger.debug(
          { sessionId },
          'Discarding incremental parse because its proven file revision drifted',
        );
        tentativeResult = undefined;
        freshness = await this.computeFreshness(ref, adapter);
        sourceChangeKind = this.classifyUnsafeFileChange(cached, freshness);
        session = await this.timedFullParse(sessionId, adapter, ref.filePath, threadRef);
        lastOffset = freshness.size;
      } else {
        const acceptedResult = tentativeResult;
        acceptedFileAnchors = proofAnchors;
        continuationState = acceptedResult.continuationState;
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
          // Shared with the watcher's metrics-only lane: the cache derives the merged-array inputs
          // (count, visible-context tokens, duration) from all messages, the lane from running state.
          const mergedMetrics = acceptedResult.metrics
            ? mergeMetrics(
                cached.session.metrics,
                acceptedResult.metrics,
                deriveMergeInputsFromMessages(cached.session.metrics, mergedMessages),
              )
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
      session = await this.timedFullParse(sessionId, adapter, ref.filePath, threadRef);
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

    const fileContentAnchors = await this.resolveStoredAnchors(
      ref,
      freshness,
      lastOffset,
      acceptedFileAnchors,
    );

    // A replacement entry owns every retained representation for this session.
    // Replacing it drops stale chunks/DTOs atomically before budget enforcement.
    this.deleteEntry(sessionId);
    const sourceWeightBytes = this.estimateSourceWeight(ref, session, freshness.size);
    const entry: SessionCacheEntry = {
      sourceIdentity,
      session,
      lastOffset,
      lastSize: freshness.size,
      lastMtime: freshness.mtimeMs,
      fileIdentity: freshness.fileIdentity,
      fileContentAnchors,
      sourceVersion: freshness.sourceVersion,
      freshnessToken: freshness.token,
      lastAccessedAt: now,
      sourceWeightBytes,
      weights: { parsed: sourceWeightBytes * 2, chunks: 0, dto: 0 },
      boundaryFold,
      continuationState,
    };
    this.cache.set(sessionId, entry);
    this.budgetUsedBytes += entry.weights.parsed;
    this.enforceBudget();

    return {
      result: this.toGetOrParseResult(session, entry, false, sourceChangeKind),
      freshnessToken: freshness.token,
      preParse,
    };
  }

  getEntry(sessionId: string): SessionCacheEntry | undefined {
    return this.cache.get(sessionId);
  }

  /**
   * The generation a viewing client holds for an entry (its chunk count from the cached chunks
   * when a reader set them, else built once). Captured before an `ifPresent` refresh so the
   * watcher can emit a correct delta on the lane→body switch.
   */
  private preParseGeneration(entry: SessionCacheEntry): PreParseGeneration {
    return {
      sourceVersion: entry.sourceVersion,
      messageCount: entry.session.messages.length,
      chunkCount: entry.chunks?.chunks.length ?? buildChunks(entry.session.messages).length,
    };
  }

  /**
   * The pre-refresh generation to report when an `ifPresent` caller SHARES a concurrent
   * `getOrParse` result (which captured no pre-parse generation): the result's own generation, so
   * the watcher adopts it as its previous and the lane→body switch publishes nothing rather than a
   * spurious full-refetch. The cache stores sessions without derived chunks, so chunkCount is built.
   */
  private preParseFromResult(result: GetOrParseResult): PreParseGeneration {
    return {
      sourceVersion: result.sourceVersion,
      messageCount: result.session.messages.length,
      chunkCount: result.session.chunks?.length ?? buildChunks(result.session.messages).length,
    };
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
    if (
      !cached ||
      this.cache.get(sessionId) !== cached ||
      JSON.stringify(cached.freshnessToken) !== JSON.stringify(freshnessToken)
    ) {
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
      boundaryFold: cacheHit ? false : entry.boundaryFold,
      fileContentAnchors: entry.fileContentAnchors,
      continuationState: entry.continuationState,
    };
  }

  /** Move entry to end of Map insertion order (LRU touch). */
  private touchLru(sessionId: string, entry: SessionCacheEntry, now: number): void {
    if (this.cache.get(sessionId) !== entry) return;
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
    // The fold DECISION (how many leading messages continue the tail's turn) is shared with
    // the watcher's metrics-only lane so the two paths never drift; this method then performs
    // the message-level merge the cache needs.
    const { foldCount, tailMutatedWithoutNewMessage } = computeLeadingContinuationFold(
      describeTail(tail),
      newMessages,
    );

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
      tailMutatedWithoutNewMessage,
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

  /**
   * Wrap the shared bounded anchor proof, turning a drifted/unavailable snapshot into
   * `undefined` (an unsafe append) rather than throwing on the hot path.
   */
  private async tryHashFileAnchors(
    filePath: string,
    expected: FileFreshnessSnapshot,
    offset: number,
    allowGrowth = false,
  ): Promise<FileContentAnchors | undefined> {
    try {
      return await hashFileAnchors(filePath, expected, offset, allowGrowth);
    } catch (error) {
      this.logger.debug({ error, filePath }, 'File anchor proof unavailable — append is unsafe');
      return undefined;
    }
  }

  /**
   * The bounded anchors to store over `[0, lastOffset)` for a new entry; file sources only.
   *
   * The accepted-append path already proved its anchors and ends on a line boundary by
   * construction. Every full-parse path (no accepted anchors) hashes them now under a strict
   * same-snapshot assertion, but ONLY when the snapshot ends on a line boundary. A full parse that
   * catches the file mid-write — its final line still unterminated — stores NO proof, so the next
   * change re-parses in full and the completed line is read exactly once. Without this,
   * `[0, lastOffset)` ending inside that line would be accepted as an append and the incremental
   * parse would start mid-line and drop the message. lastOffset is never rewound: parseFullSession
   * already parsed the line when it was complete JSON, so rewinding would duplicate it. Empty
   * snapshots and a file that changed mid-parse also store no anchors.
   */
  private async resolveStoredAnchors(
    ref: SessionSourceRef,
    freshness: FileFreshnessSnapshot,
    lastOffset: number,
    acceptedFileAnchors: FileContentAnchors | undefined,
  ): Promise<FileContentAnchors | undefined> {
    if (ref.kind !== 'file') return undefined;
    if (acceptedFileAnchors) return acceptedFileAnchors;
    if (!(await this.snapshotEndsOnLineBoundary(ref.filePath, lastOffset))) return undefined;
    return this.tryHashFileAnchors(ref.filePath, freshness, lastOffset);
  }

  /**
   * Whether the parsed snapshot `[0, offset)` ends on a line boundary — the byte before `offset`
   * is a newline, or the snapshot is empty. A full parse that caught the file mid-write ends inside
   * an unterminated last line and fails this check, so it stores no append proof. On a read error
   * the snapshot is treated as NOT on a boundary (fail closed to a safe full re-parse next change).
   */
  private async snapshotEndsOnLineBoundary(filePath: string, offset: number): Promise<boolean> {
    try {
      return (await lastCompleteLineEnd(filePath, 0, offset)) === offset;
    } catch (error) {
      this.logger.debug(
        { error, filePath },
        'Line-boundary probe failed — withholding append proof',
      );
      return false;
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

  private sourceIdentity(ref: SessionSourceRef): string {
    return JSON.stringify([
      ref.providerName.trim().toLowerCase(),
      ref.kind,
      ref.filePath,
      ref.kind === 'db' ? ref.providerSessionId : undefined,
    ]);
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
