export interface CacheStats {
  entries: number;
  bytesEstimated: number;
  hits: number;
  misses: number;
  hitRate: number;
  /**
   * How bytesEstimated was derived. Most caches use 'object-graph-walk' (retained-size
   * estimate). Caches that store a pre-computed serialized length use 'json-stringify-length'
   * for their standalone view; aggregate accounting can instead walk registered retained roots.
   */
  bytesMethod?: 'object-graph-walk' | 'json-stringify-length' | 'deferred-to-aggregate';
  /** Composite-cache budget usage; present only on the provider that owns the budget. */
  budgetUsedBytes?: number;
  /** Configured ceiling for budgetUsedBytes. */
  budgetBytes?: number;
  /** Whole-entry evictions performed to remain within the composite budget. */
  evictions?: number;
}

export interface FrameBufferStats {
  sessions: number;
  totalFrames: number;
  bytesEstimated: number;
  maxBufferCapacity: number;
}

export interface SocketStats {
  connectedClients: number;
  /** Fresh tmux captures performed for terminal seeds (cache hits do not increment). */
  terminalSeedCaptures?: number;
  terminalQueuedBytes?: number;
  terminalInFlightBytes?: number;
  terminalDesynchronizedClients?: number;
  terminalDesynchronizedLanes?: number;
  terminalDroppedFrames?: number;
  terminalDroppedBytes?: number;
  terminalQueues?: Record<
    string,
    {
      queuedBytes: number;
      inFlightBytes: number;
      desynchronized: boolean;
      droppedFrames: number;
      droppedBytes: number;
      engineBufferedPackets: number;
      lanes: Record<
        string,
        {
          queuedBytes: number;
          desynchronized: boolean;
          recoveryActive: boolean;
          recoveryEpoch?: number;
          droppedFrames: number;
          droppedBytes: number;
        }
      >;
    }
  >;
}

export interface PtyStats {
  activeSessions: number;
}

export interface EventLoopDelayStats {
  minMs: number;
  maxMs: number;
  meanMs: number;
  stddevMs: number;
  p99Ms: number;
  p99_5Ms: number;
}

export interface ProcessListenerStats {
  SIGINT: number;
  SIGTERM: number;
  uncaughtException: number;
  unhandledRejection: number;
}

export interface ProcessMemoryStats {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface ProcessStats {
  pid: number;
  memory: ProcessMemoryStats;
  eventLoopDelay: EventLoopDelayStats | null;
  listeners: ProcessListenerStats;
}

export interface CacheAggregateStats extends CacheStats {
  /** Providers that threw and were excluded from every aggregate counter. */
  providersFailed: number;
}

export interface CacheStatsCollection {
  [name: string]: CacheStats | CacheAggregateStats;
  aggregate: CacheAggregateStats;
}

export interface AccountingInfo {
  method: string;
  sharedGraphRule: string;
  perCacheViews: string;
  approximation: string;
  hotPathSafety: string;
  budgeting: string;
}

export interface MetricsSnapshot {
  timestamp: string;
  process: ProcessStats;
  caches: CacheStatsCollection;
  frameBuffers: FrameBufferStats;
  pty: PtyStats;
  sockets: SocketStats;
  accounting: AccountingInfo;
}

export type CacheStatsProvider = () => CacheStats;
export type RetainedRootsProvider = () => Iterable<unknown>;
export type StatsProvider<T = unknown> = () => T;
