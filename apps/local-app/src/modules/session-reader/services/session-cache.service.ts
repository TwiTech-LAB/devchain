import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import type { SessionReaderAdapter } from '../adapters/session-reader-adapter.interface';
import type { UnifiedSession, UnifiedMetrics, UnifiedMessage } from '../dtos/unified-session.types';
import { estimateVisibleFromMessages } from '../adapters/utils/estimate-content-tokens';

/** Cache TTL in milliseconds (10 minutes) */
const CACHE_TTL_MS = 10 * 60 * 1_000;

/** Maximum number of cached session entries */
const CACHE_MAX_ENTRIES = 20;

export interface SessionCacheEntry {
  session: UnifiedSession;
  lastOffset: number;
  lastSize: number;
  lastMtime: number;
  cachedAt: number;
}

@Injectable()
export class SessionCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(SessionCacheService.name);
  private readonly cache = new Map<string, SessionCacheEntry>();

  onModuleDestroy(): void {
    this.cache.clear();
  }

  /**
   * Get or parse a session with incremental parsing and file-change detection.
   *
   * - Cache hit: file unchanged + TTL valid → return cached session
   * - Append-only: currentSize > lastSize → incremental parse from offset
   * - Truncation or TTL expired: full reparse via adapter
   */
  async getOrParse(
    sessionId: string,
    filePath: string,
    adapter: SessionReaderAdapter,
  ): Promise<UnifiedSession> {
    const now = Date.now();
    const fileStat = await this.statFile(filePath);
    const cached = this.cache.get(sessionId);

    // Cache hit: TTL valid + file unchanged (same size + mtime)
    if (
      cached &&
      now - cached.cachedAt < CACHE_TTL_MS &&
      fileStat.size === cached.lastSize &&
      fileStat.mtimeMs === cached.lastMtime
    ) {
      this.logger.debug({ sessionId }, 'Session cache hit');
      this.touchLru(sessionId, cached);
      return cached.session;
    }

    let session: UnifiedSession;
    let lastOffset: number;

    // Incremental parse: file grew (append-only pattern)
    if (cached && fileStat.size > cached.lastSize) {
      this.logger.debug(
        { sessionId, lastOffset: cached.lastOffset, currentSize: fileStat.size },
        'Incremental parse (file grew)',
      );

      const result = await adapter.parseIncremental(filePath, {
        byteOffset: cached.lastOffset,
        includeToolCalls: true,
      });

      const newMessages = result.entries as UnifiedMessage[];

      if (adapter.incrementalMode === 'snapshot') {
        // Snapshot mode returns the full session state on each incremental parse.
        const snapshotMetrics = result.metrics ?? cached.session.metrics;
        session = {
          ...cached.session,
          messages: newMessages,
          metrics: snapshotMetrics,
          isOngoing: snapshotMetrics.isOngoing,
          warnings: this.mergeWarnings(cached.session.warnings, result.warnings),
        };
      } else {
        const mergedMessages = [...cached.session.messages, ...newMessages];
        const mergedMetrics = result.metrics
          ? this.mergeMetrics(cached.session.metrics, result.metrics, mergedMessages)
          : cached.session.metrics;

        session = {
          ...cached.session,
          messages: mergedMessages,
          metrics: mergedMetrics,
          isOngoing: mergedMetrics.isOngoing,
          warnings: this.mergeWarnings(cached.session.warnings, result.warnings),
        };
      }
      lastOffset = result.nextByteOffset;
    } else {
      // Full reparse: no cache, TTL expired, or file shrank (truncation)
      if (cached && fileStat.size < cached.lastSize) {
        this.logger.debug({ sessionId }, 'Full reparse (file truncated)');
      }
      session = await adapter.parseFullSession(filePath);
      lastOffset = fileStat.size;
    }

    // Store in cache (evict oldest if needed)
    this.evictIfNeeded(sessionId);
    this.cache.delete(sessionId);
    this.cache.set(sessionId, {
      session,
      lastOffset,
      lastSize: fileStat.size,
      lastMtime: fileStat.mtimeMs,
      cachedAt: now,
    });

    return session;
  }

  /** Invalidate a specific session's cache entry. */
  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of entries in cache. */
  get size(): number {
    return this.cache.size;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Move entry to end of Map insertion order (LRU touch). */
  private touchLru(sessionId: string, entry: SessionCacheEntry): void {
    this.cache.delete(sessionId);
    this.cache.set(sessionId, entry);
  }

  /** Evict the least-recently-used entry if at capacity. */
  private evictIfNeeded(sessionId: string): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES && !this.cache.has(sessionId)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
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

  private async statFile(filePath: string): Promise<{ size: number; mtimeMs: number }> {
    const stat = await fs.stat(filePath);
    return { size: stat.size, mtimeMs: stat.mtime.getTime() };
  }
}
