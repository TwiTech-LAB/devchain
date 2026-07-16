import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

export const DEBUG_METRICS_POLL_MS = 10_000;
export const DEBUG_METRICS_HISTORY_LIMIT = 60;

export interface DebugCacheStats {
  entries: number;
  bytesEstimated: number;
  hits: number;
  misses: number;
  hitRate: number;
  providersFailed?: number;
}

export interface DebugMetricsSnapshot {
  timestamp: string;
  process: {
    pid: number;
    memory: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external: number;
      arrayBuffers: number;
    };
    eventLoopDelay: { meanMs: number; p99Ms: number } | null;
    listeners: Record<string, number>;
  };
  caches: Record<string, DebugCacheStats> & { aggregate: DebugCacheStats };
  frameBuffers: { sessions: number; totalFrames: number; bytesEstimated: number };
  pty: { activeSessions: number };
  sockets: {
    connectedClients: number;
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
  };
}

export class SnapshotRing {
  private values: DebugMetricsSnapshot[] = [];

  push(snapshot: DebugMetricsSnapshot): DebugMetricsSnapshot[] {
    this.values.push(snapshot);
    if (this.values.length > DEBUG_METRICS_HISTORY_LIMIT) {
      this.values.splice(0, this.values.length - DEBUG_METRICS_HISTORY_LIMIT);
    }
    return [...this.values];
  }

  clear(): void {
    this.values = [];
  }

  get size(): number {
    return this.values.length;
  }
}

async function fetchDebugMetrics(): Promise<DebugMetricsSnapshot> {
  const response = await fetch('/api/debug/metrics');
  if (!response.ok) throw new Error('Failed to fetch backend memory metrics');
  const payload: unknown = await response.json();
  if (!isDebugMetricsSnapshot(payload)) {
    throw new Error('Backend memory metrics returned an invalid snapshot');
  }
  return payload;
}

function isDebugMetricsSnapshot(value: unknown): value is DebugMetricsSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<DebugMetricsSnapshot>;
  return Boolean(
    snapshot.process?.memory &&
      snapshot.caches?.aggregate &&
      snapshot.frameBuffers &&
      snapshot.pty &&
      snapshot.sockets &&
      typeof snapshot.timestamp === 'string',
  );
}

export function useDebugMetrics() {
  const ringRef = useRef<SnapshotRing>();
  if (!ringRef.current) ringRef.current = new SnapshotRing();
  const [history, setHistory] = useState<DebugMetricsSnapshot[]>([]);

  const query = useQuery({
    queryKey: ['debug-metrics'],
    queryFn: fetchDebugMetrics,
    refetchInterval: DEBUG_METRICS_POLL_MS,
    staleTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (query.data) setHistory(ringRef.current!.push(query.data));
  }, [query.data]);

  useEffect(
    () => () => {
      ringRef.current?.clear();
    },
    [],
  );

  return { ...query, history };
}
