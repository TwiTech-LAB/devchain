import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createLogger } from '../../../common/logging/logger';
import type {
  CacheStatsProvider,
  RetainedRootsProvider,
  StatsProvider,
  MetricsSnapshot,
  CacheStats,
  CacheAggregateStats,
  CacheStatsCollection,
  FrameBufferStats,
  SocketStats,
  PtyStats,
  EventLoopDelayStats,
  AccountingInfo,
} from '../types/metrics.types';
import { estimateObjectBytes, type ObjectIdentitySet } from '../helpers/byte-accounting.helper';

const logger = createLogger('MetricsService');

const DEFAULT_LOG_INTERVAL_MS = 60_000;
const CACHE_SNAPSHOT_TTL_MS = 10_000;

class TransactionalObjectIdentitySet implements ObjectIdentitySet {
  private readonly pending = new Set<object>();

  constructor(private readonly committed: WeakSet<object>) {}

  has(value: object): boolean {
    return this.committed.has(value) || this.pending.has(value);
  }

  add(value: object): this {
    this.pending.add(value);
    return this;
  }

  commit(): void {
    for (const value of this.pending) {
      this.committed.add(value);
    }
  }
}

interface CacheSnapshotCache {
  computedAt: number;
  value: CacheStatsCollection;
}

const ACCOUNTING_INFO: AccountingInfo = {
  method:
    'transactional unique object-graph snapshot for retained-root providers; additive fallback for providers without roots',
  sharedGraphRule:
    'each provider stages visited identities and commits them only after its complete walk succeeds — failed providers cannot suppress shared objects from later healthy providers; successful cross-cache sharing is counted once and cycles are safe',
  perCacheViews:
    'parsed/chunks per-cache bytes are walk-attribution shares from the shared aggregate walk (additive, order-dependent); DTO per-cache bytes are the independent JSON wire-size view (not additive with the others); callers must not sum all per-cache values — do not sum per-cache views; use aggregate.bytesEstimated for the unique retained-bytes snapshot',
  approximation:
    'aggregate retained-size estimate uses property keys + primitive sizes + object/array overhead, not serialized JSON length; DTO per-cache bytes use the pre-computed JSON.stringify wire length',
  hotPathSafety:
    'byte estimation runs on-demand only (metrics endpoint / periodic log), never on cache read/write paths; entry counts and hit/miss counters are always-on and O(1)',
  budgeting:
    'transcript composite budget uses deterministic cache-write proxies: file source bytes (2x parsed + 1x chunks), session-local token/message estimates for DB sources, and the DTO wire length already computed at DTO cache creation; aggregate.budgetUsedBytes is the enforced value and aggregate.bytesEstimated remains the independent retained-graph snapshot',
};

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly eventLoopMonitor = monitorEventLoopDelay();
  private readonly cacheStatsProviders = new Map<
    string,
    { stats: CacheStatsProvider; retainedRoots?: RetainedRootsProvider }
  >();
  private readonly statsProviders = new Map<string, StatsProvider>();
  private cacheSnapshotCache?: CacheSnapshotCache;
  private periodicLogTimer?: NodeJS.Timeout;

  registerCacheStatsProvider(
    name: string,
    provider: CacheStatsProvider,
    retainedRoots?: RetainedRootsProvider,
  ): void {
    this.cacheStatsProviders.set(name, { stats: provider, retainedRoots });
    this.cacheSnapshotCache = undefined;
  }

  registerStatsProvider(name: string, provider: StatsProvider): void {
    this.statsProviders.set(name, provider);
  }

  onModuleInit(): void {
    this.eventLoopMonitor.enable();

    const intervalMs = this.parseLogInterval();
    if (intervalMs > 0) {
      this.periodicLogTimer = setInterval(() => {
        try {
          logger.info(this.getMetrics(), 'metrics.periodic');
        } catch (err) {
          logger.error({ error: String(err) }, 'metrics.periodic.failed');
        }
      }, intervalMs);
      this.periodicLogTimer.unref();
    }
  }

  onModuleDestroy(): void {
    this.eventLoopMonitor.disable();
    if (this.periodicLogTimer) {
      clearInterval(this.periodicLogTimer);
      this.periodicLogTimer = undefined;
    }
  }

  getMetrics(): MetricsSnapshot {
    const mem = process.memoryUsage();
    const cacheSnapshot = this.getCacheSnapshot();

    const frameBuffers = this.getStat<FrameBufferStats>('frameBuffers', {
      sessions: 0,
      totalFrames: 0,
      bytesEstimated: 0,
      maxBufferCapacity: 0,
    });
    const sockets = this.getStat<SocketStats>('sockets', { connectedClients: 0 });
    const pty = this.getStat<PtyStats>('pty', { activeSessions: 0 });
    return {
      timestamp: new Date().toISOString(),
      process: {
        pid: process.pid,
        memory: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
        },
        eventLoopDelay: this.getEventLoopDelay(),
        listeners: {
          SIGINT: process.listenerCount('SIGINT'),
          SIGTERM: process.listenerCount('SIGTERM'),
          uncaughtException: process.listenerCount('uncaughtException'),
          unhandledRejection: process.listenerCount('unhandledRejection'),
        },
      },
      caches: cacheSnapshot,
      frameBuffers,
      pty,
      sockets,
      accounting: ACCOUNTING_INFO,
    };
  }

  private getCacheSnapshot(): CacheStatsCollection {
    const now = Date.now();
    if (
      this.cacheSnapshotCache &&
      now - this.cacheSnapshotCache.computedAt < CACHE_SNAPSHOT_TTL_MS
    ) {
      return this.cloneCacheSnapshot(this.cacheSnapshotCache.value);
    }

    const value = this.computeCacheSnapshot();
    this.cacheSnapshotCache = { computedAt: now, value };
    return this.cloneCacheSnapshot(value);
  }

  private computeCacheSnapshot(): CacheStatsCollection {
    const aggregateSeen = new WeakSet<object>();
    const caches: Record<string, CacheStats> = {};
    let aggregateEntries = 0;
    let aggregateBytes = 0;
    let aggregateHits = 0;
    let aggregateMisses = 0;
    let providersFailed = 0;
    let budgetUsedBytes: number | undefined;
    let budgetBytes: number | undefined;
    let evictions: number | undefined;

    for (const [name, provider] of this.cacheStatsProviders) {
      try {
        const stats = { ...provider.stats() };
        let providerBytes = stats.bytesEstimated;
        if (provider.retainedRoots) {
          const providerSeen = new TransactionalObjectIdentitySet(aggregateSeen);
          const retainedRoots = Array.from(provider.retainedRoots());
          providerBytes = retainedRoots.reduce<number>(
            (total, root) => total + estimateObjectBytes(root, providerSeen),
            0,
          );
          if (stats.bytesMethod === 'deferred-to-aggregate') {
            stats.bytesEstimated = providerBytes;
            stats.bytesMethod = 'object-graph-walk';
          }
          providerSeen.commit();
        }
        caches[name] = stats;
        aggregateEntries += stats.entries;
        aggregateBytes += providerBytes;
        aggregateHits += stats.hits;
        aggregateMisses += stats.misses;
        if (stats.budgetUsedBytes !== undefined) budgetUsedBytes = stats.budgetUsedBytes;
        if (stats.budgetBytes !== undefined) budgetBytes = stats.budgetBytes;
        if (stats.evictions !== undefined) evictions = stats.evictions;
      } catch (err) {
        providersFailed += 1;
        caches[name] = {
          entries: 0,
          bytesEstimated: 0,
          hits: 0,
          misses: 0,
          hitRate: 0,
        };
        logger.warn({ cache: name, error: String(err) }, 'cache stats provider failed');
      }
    }

    const aggregate: CacheAggregateStats = {
      entries: aggregateEntries,
      bytesEstimated: aggregateBytes,
      hits: aggregateHits,
      misses: aggregateMisses,
      hitRate:
        aggregateHits + aggregateMisses > 0 ? aggregateHits / (aggregateHits + aggregateMisses) : 0,
      providersFailed,
      ...(budgetUsedBytes !== undefined ? { budgetUsedBytes } : {}),
      ...(budgetBytes !== undefined ? { budgetBytes } : {}),
      ...(evictions !== undefined ? { evictions } : {}),
    };
    return { ...caches, aggregate };
  }

  private cloneCacheSnapshot(snapshot: CacheStatsCollection): CacheStatsCollection {
    return Object.fromEntries(
      Object.entries(snapshot).map(([name, stats]) => [name, { ...stats }]),
    ) as CacheStatsCollection;
  }

  private getStat<T>(name: string, fallback: T): T {
    const provider = this.statsProviders.get(name);
    if (!provider) return fallback;
    try {
      return provider() as T;
    } catch (err) {
      logger.warn({ stat: name, error: String(err) }, 'stats provider failed');
      return fallback;
    }
  }

  private getEventLoopDelay(): EventLoopDelayStats | null {
    const h = this.eventLoopMonitor;
    const nanoseconds = {
      min: h.min,
      max: h.max,
      mean: h.mean,
      stddev: h.stddev,
      p99: h.percentile(99),
      p99_5: h.percentile(99.5),
    };
    if (
      nanoseconds.min > Number.MAX_SAFE_INTEGER ||
      Object.values(nanoseconds).some((value) => !Number.isFinite(value))
    ) {
      return null;
    }
    const NS_TO_MS = 1e6;
    const milliseconds: EventLoopDelayStats = {
      minMs: nanoseconds.min / NS_TO_MS,
      maxMs: nanoseconds.max / NS_TO_MS,
      meanMs: nanoseconds.mean / NS_TO_MS,
      stddevMs: nanoseconds.stddev / NS_TO_MS,
      p99Ms: nanoseconds.p99 / NS_TO_MS,
      p99_5Ms: nanoseconds.p99_5 / NS_TO_MS,
    };
    return Object.values(milliseconds).every(Number.isFinite) ? milliseconds : null;
  }

  private parseLogInterval(): number {
    const raw = process.env.METRICS_LOG_INTERVAL_MS;
    if (!raw) return DEFAULT_LOG_INTERVAL_MS;
    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOG_INTERVAL_MS;
    return parsed;
  }
}
