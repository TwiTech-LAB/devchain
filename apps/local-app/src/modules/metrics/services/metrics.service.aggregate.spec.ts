/**
 * Layer: module unit. A real MetricsService instance proves provider registration,
 * aggregation, and perf-hook lifecycle without application boot or external I/O.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BYTE_ACCOUNTING_CONSTANTS as C,
  estimateObjectBytes,
} from '../helpers/byte-accounting.helper';
import { MetricsService } from './metrics.service';

describe('MetricsService aggregate and event-loop contracts', () => {
  const previousLogInterval = process.env.METRICS_LOG_INTERVAL_MS;

  beforeEach(() => {
    process.env.METRICS_LOG_INTERVAL_MS = '0';
  });

  afterAll(() => {
    if (previousLogInterval === undefined) {
      delete process.env.METRICS_LOG_INTERVAL_MS;
    } else {
      process.env.METRICS_LOG_INTERVAL_MS = previousLogInterval;
    }
  });

  async function createModule(): Promise<{ module: TestingModule; service: MetricsService }> {
    const module = await Test.createTestingModule({ providers: [MetricsService] }).compile();
    return { module, service: module.get(MetricsService) };
  }

  async function waitForEventLoopSample(service: MetricsService) {
    const maxAttempts = 50;
    const pollIntervalMs = 20;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const sample = service.getMetrics().process.eventLoopDelay;
      if (sample !== null) return sample;
    }

    throw new Error(
      `event-loop histogram did not produce a sample after ${maxAttempts} polling attempts`,
    );
  }

  it('instantiates through Nest DI and aggregates registered cache providers', async () => {
    const { module, service } = await createModule();
    service.registerCacheStatsProvider('parsed', () => ({
      entries: 2,
      bytesEstimated: 100,
      hits: 7,
      misses: 3,
      hitRate: 0.7,
    }));
    service.registerCacheStatsProvider('chunks', () => ({
      entries: 4,
      bytesEstimated: 300,
      hits: 1,
      misses: 9,
      hitRate: 0.1,
    }));

    const snapshot = service.getMetrics();

    expect(snapshot.caches.parsed).toEqual(
      expect.objectContaining({ entries: 2, hits: 7, misses: 3 }),
    );
    expect(snapshot.caches.chunks).toEqual(
      expect.objectContaining({ entries: 4, hits: 1, misses: 9 }),
    );
    expect(snapshot.caches.aggregate).toEqual({
      entries: 6,
      bytesEstimated: 400,
      hits: 8,
      misses: 12,
      hitRate: 0.4,
      providersFailed: 0,
    });
    await module.close();
  });

  it('excludes failed providers from aggregates and surfaces their count', async () => {
    const { module, service } = await createModule();
    service.registerCacheStatsProvider('parsed', () => ({
      entries: 3,
      bytesEstimated: 120,
      hits: 0,
      misses: 0,
      hitRate: 0,
    }));
    service.registerCacheStatsProvider('broken', () => {
      throw new Error('provider unavailable');
    });

    const snapshot = service.getMetrics();

    expect(snapshot.caches.broken).toEqual({
      entries: 0,
      bytesEstimated: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
    });
    expect(snapshot.caches.aggregate).toEqual({
      entries: 3,
      bytesEstimated: 120,
      hits: 0,
      misses: 0,
      hitRate: 0,
      providersFailed: 1,
    });
    await module.close();
  });

  it('counts the current parsed-session and chunks-cache sharing shape once', async () => {
    const { module, service } = await createModule();
    const chunks = [{ id: 'chunk-0', messages: [{ text: 'shared' }] }];
    const parsedSession = { id: 'session-1', chunks };

    service.registerCacheStatsProvider(
      'parsed',
      () => ({ entries: 1, bytesEstimated: 124, hits: 0, misses: 0, hitRate: 0 }),
      () => [parsedSession],
    );
    service.registerCacheStatsProvider(
      'chunks',
      () => ({ entries: 1, bytesEstimated: 91, hits: 0, misses: 0, hitRate: 0 }),
      () => [chunks],
    );

    const snapshot = service.getMetrics();

    expect(snapshot.caches.aggregate.bytesEstimated).toBe(124);
    expect(snapshot.caches.aggregate.bytesEstimated).toBeLessThan(
      snapshot.caches.parsed.bytesEstimated + snapshot.caches.chunks.bytesEstimated,
    );
    expect(snapshot.accounting.perCacheViews).toContain('do not sum');
    await module.close();
  });

  it('counts a future composite wrapper graph once without relying on mutation', async () => {
    const { module, service } = await createModule();
    const parsedSession = { id: 'session-1' };
    const chunks = [{ id: 'chunk-0', messages: [{ text: 'shared' }] }];
    const composite = { session: parsedSession, chunks };

    service.registerCacheStatsProvider(
      'parsed',
      () => ({ entries: 1, bytesEstimated: 27, hits: 0, misses: 0, hitRate: 0 }),
      () => [parsedSession],
    );
    service.registerCacheStatsProvider(
      'composite',
      () => ({ entries: 1, bytesEstimated: 147, hits: 0, misses: 0, hitRate: 0 }),
      () => [composite],
    );

    expect(service.getMetrics().caches.aggregate.bytesEstimated).toBe(147);
    await module.close();
  });

  it('returns null before the event-loop histogram has sampled', async () => {
    const { module, service } = await createModule();

    expect(service.getMetrics().process.eventLoopDelay).toBeNull();
    await module.close();
  });

  it('returns finite millisecond values after lifecycle sampling', async () => {
    const { module, service } = await createModule();
    await module.init();

    try {
      const eventLoopDelay = await waitForEventLoopSample(service);
      for (const value of Object.values(eventLoopDelay)) {
        expect(Number.isFinite(value)).toBe(true);
      }
    } finally {
      await module.close();
    }
  });

  it('registers generic stat providers on a real service instance', async () => {
    const { module, service } = await createModule();
    service.registerStatsProvider('sockets', () => ({ connectedClients: 5 }));
    service.registerStatsProvider('pty', () => ({ activeSessions: 2 }));

    const snapshot = service.getMetrics();

    expect(snapshot.sockets.connectedClients).toBe(5);
    expect(snapshot.pty.activeSessions).toBe(2);
    await module.close();
  });

  it('failure isolation: retainedRoots throw → snapshot succeeds, provider excluded entirely', async () => {
    const { module, service } = await createModule();
    const goodRoots = [{ id: 'ok', data: 'x'.repeat(100) }];
    service.registerCacheStatsProvider(
      'good',
      () => ({
        entries: 1,
        bytesEstimated: 0,
        hits: 0,
        misses: 0,
        hitRate: 0,
        bytesMethod: 'deferred-to-aggregate' as const,
      }),
      () => goodRoots,
    );
    service.registerCacheStatsProvider(
      'broken-roots',
      () => ({ entries: 1, bytesEstimated: 50, hits: 0, misses: 0, hitRate: 0 }),
      () => {
        throw new Error('roots failed');
      },
    );

    const snapshot = service.getMetrics();

    expect(snapshot.caches['broken-roots'].entries).toBe(0);
    expect(snapshot.caches['broken-roots'].bytesEstimated).toBe(0);
    expect(snapshot.caches.aggregate.providersFailed).toBe(1);
    expect(snapshot.caches.aggregate.bytesEstimated).toBe(snapshot.caches.good.bytesEstimated);
    expect(snapshot.caches.good.entries).toBe(1);
    await module.close();
  });

  it('failure isolation: stats throw with valid roots → zero bytes from that provider in aggregate', async () => {
    const { module, service } = await createModule();
    const sharedObj = { id: 'shared', data: 'x'.repeat(100) };
    service.registerCacheStatsProvider(
      'good',
      () => ({
        entries: 1,
        bytesEstimated: 0,
        hits: 0,
        misses: 0,
        hitRate: 0,
        bytesMethod: 'deferred-to-aggregate' as const,
      }),
      () => [sharedObj],
    );
    service.registerCacheStatsProvider(
      'broken-stats',
      () => {
        throw new Error('stats failed');
      },
      () => [sharedObj],
    );

    const snapshot = service.getMetrics();

    expect(snapshot.caches['broken-stats'].entries).toBe(0);
    expect(snapshot.caches['broken-stats'].bytesEstimated).toBe(0);
    expect(snapshot.caches.aggregate.providersFailed).toBe(1);
    // Only good provider's bytes in aggregate — no leak from broken-stats
    expect(snapshot.caches.aggregate.bytesEstimated).toBe(snapshot.caches.good.bytesEstimated);
    await module.close();
  });

  it('rolls back identities from a failed walk before counting a later healthy provider', async () => {
    const { module, service } = await createModule();
    const shared = { payload: 'healthy' };
    const failedRoot: Record<string, unknown> = { shared };
    Object.defineProperty(failedRoot, 'explode', {
      enumerable: true,
      get: () => {
        throw new Error('mid-walk failure');
      },
    });

    service.registerCacheStatsProvider(
      'failed-first',
      () => ({
        entries: 1,
        bytesEstimated: 0,
        hits: 0,
        misses: 0,
        hitRate: 0,
        bytesMethod: 'deferred-to-aggregate' as const,
      }),
      () => [failedRoot],
    );
    service.registerCacheStatsProvider(
      'healthy-second',
      () => ({
        entries: 1,
        bytesEstimated: 0,
        hits: 0,
        misses: 0,
        hitRate: 0,
        bytesMethod: 'deferred-to-aggregate' as const,
      }),
      () => [shared],
    );

    const snapshot = service.getMetrics();
    const sharedBytes = estimateObjectBytes(shared);

    expect(snapshot.caches['failed-first'].bytesEstimated).toBe(0);
    expect(snapshot.caches['healthy-second'].bytesEstimated).toBe(sharedBytes);
    expect(snapshot.caches.aggregate).toEqual(
      expect.objectContaining({
        entries: 1,
        bytesEstimated: sharedBytes,
        providersFailed: 1,
      }),
    );
    await module.close();
  });

  it('counts shared special-object roots once across successful providers', async () => {
    const { module, service } = await createModule();
    const date = new Date('2026-07-12T00:00:00Z');
    const buffer = Buffer.alloc(1024);
    const regexp = /shared\d+/;
    const error = new Error('shared failure');
    const roots = [date, buffer, regexp, error];
    const expectedBytes =
      C.SIZE_DATE +
      1024 +
      C.SIZE_OBJECT_OVERHEAD +
      Buffer.byteLength(regexp.source, 'utf8') +
      C.SIZE_OBJECT_OVERHEAD +
      Buffer.byteLength(error.message, 'utf8');

    for (const name of ['first', 'second']) {
      service.registerCacheStatsProvider(
        name,
        () => ({
          entries: 1,
          bytesEstimated: 0,
          hits: 0,
          misses: 0,
          hitRate: 0,
          bytesMethod: 'deferred-to-aggregate' as const,
        }),
        () => roots,
      );
    }

    const snapshot = service.getMetrics();

    expect(snapshot.caches.first.bytesEstimated).toBe(expectedBytes);
    expect(snapshot.caches.second.bytesEstimated).toBe(0);
    expect(snapshot.caches.aggregate.bytesEstimated).toBe(expectedBytes);
    await module.close();
  });

  it('preserves failed-provider attribution on cache hits and re-includes it after expiry', async () => {
    const { module, service } = await createModule();
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let shouldFail = true;
    const stats = jest.fn(() => ({
      entries: 1,
      bytesEstimated: 0,
      hits: 0,
      misses: 0,
      hitRate: 0,
      bytesMethod: 'deferred-to-aggregate' as const,
    }));
    const retainedRoots = jest.fn(() => {
      if (shouldFail) throw new Error('temporarily unavailable');
      return [{ id: 'healed' }];
    });
    service.registerCacheStatsProvider('healing', stats, retainedRoots);

    const snap1 = service.getMetrics();
    expect(snap1.caches.healing.entries).toBe(0);
    expect(snap1.caches.aggregate.providersFailed).toBe(1);
    expect(snap1.caches.aggregate.bytesEstimated).toBe(0);

    shouldFail = false;
    now += 9_999;

    const snap2 = service.getMetrics();
    expect(snap2.caches.healing.entries).toBe(0);
    expect(snap2.caches.aggregate.providersFailed).toBe(1);
    expect(stats).toHaveBeenCalledTimes(1);
    expect(retainedRoots).toHaveBeenCalledTimes(1);

    now += 1;
    const snap3 = service.getMetrics();
    expect(snap3.caches.healing.entries).toBe(1);
    expect(snap3.caches.healing.bytesEstimated).toBeGreaterThan(0);
    expect(snap3.caches.aggregate.providersFailed).toBe(0);
    expect(snap3.caches.aggregate.bytesEstimated).toBe(snap3.caches.healing.bytesEstimated);
    expect(stats).toHaveBeenCalledTimes(2);
    expect(retainedRoots).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
    await module.close();
  });

  it('invalidates the cached provider snapshot when a provider is registered again', async () => {
    const { module, service } = await createModule();
    service.registerCacheStatsProvider('parsed', () => ({
      entries: 1,
      bytesEstimated: 10,
      hits: 0,
      misses: 0,
      hitRate: 0,
    }));
    expect(service.getMetrics().caches.aggregate.bytesEstimated).toBe(10);

    service.registerCacheStatsProvider('parsed', () => ({
      entries: 2,
      bytesEstimated: 20,
      hits: 0,
      misses: 0,
      hitRate: 0,
    }));

    expect(service.getMetrics().caches.aggregate).toEqual(
      expect.objectContaining({ entries: 2, bytesEstimated: 20 }),
    );
    await module.close();
  });
});
