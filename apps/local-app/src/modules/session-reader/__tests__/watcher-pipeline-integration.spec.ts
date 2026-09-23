import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { TranscriptWatcherService } from '../services/transcript-watcher.service';
import { SessionCacheService } from '../services/session-cache.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { ClaudeSessionReaderAdapter } from '../adapters/claude-session-reader.adapter';
import type { EventsService } from '../../events/services/events.service';
import type { PricingServiceInterface } from '../services/pricing.interface';

/**
 * Pipeline integration test: watcher → cache → parser → event broadcast.
 *
 * Uses real SessionCacheService and ClaudeSessionReaderAdapter with
 * real temp JSONL files. Only EventsService, PricingService, and fs.watch
 * are mocked. fs.watch is forced to fail so we exercise the stat-poll
 * path exclusively (more deterministic in CI).
 */

// Partially mock node:fs — keep real implementations except fs.watch
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return {
    ...actual,
    watch: jest.fn(() => {
      throw new Error('fs.watch disabled for test');
    }),
  };
});

const mockPricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.001),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
};

const mockEvents = {
  publish: jest.fn().mockResolvedValue('event-id'),
} as unknown as jest.Mocked<EventsService>;

function userLine(uuid: string, parentUuid: string | null, ts: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp: ts,
    message: { role: 'user', content: text },
  });
}

function assistantLine(
  uuid: string,
  parentUuid: string,
  ts: string,
  text: string,
  tokens: { input: number; output: number } = { input: 100, output: 50 },
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid,
    isSidechain: false,
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: tokens.input,
        output_tokens: tokens.output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

const realSetTimeout = globalThis.setTimeout;

/**
 * Flush real I/O microtasks by yielding to the event loop repeatedly.
 * Combines setImmediate (not faked) with a small real delay to ensure
 * libuv I/O callbacks complete even under heavy load.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  for (let i = 0; i < 50; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Advance through a full stat-poll + debounce cycle using sync timer
 * advancement + real I/O flushing. Runs two full poll+debounce rounds
 * to ensure all async work completes even under heavy load.
 */
async function advancePollCycle(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    jest.advanceTimersByTime(3000);
    await flush();
    jest.advanceTimersByTime(200);
    await flush();
  }
}

describe('Watcher → Parser → Broadcast pipeline integration', () => {
  let tmpDir: string;
  let filePath: string;
  let service: TranscriptWatcherService;
  let cacheService: SessionCacheService;
  let adapter: ClaudeSessionReaderAdapter;

  beforeEach(async () => {
    jest.useFakeTimers({ advanceTimers: false, doNotFake: ['setImmediate'] });
    jest.clearAllMocks();

    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pipeline-test-'));
    filePath = path.join(tmpDir, 'test-session.jsonl');

    // Write initial JSONL content
    const initialContent =
      [
        userLine('u-001', null, '2026-01-15T10:00:00.000Z', 'Hello'),
        assistantLine('a-001', 'u-001', '2026-01-15T10:00:05.000Z', 'Hi there!'),
      ].join('\n') + '\n';
    await fsp.writeFile(filePath, initialContent, 'utf8');

    // Wire real services together
    cacheService = new SessionCacheService({
      registerCacheStatsProvider: jest.fn(),
      registerStatsProvider: jest.fn(),
    } as never);

    const adapterFactory = new SessionReaderAdapterFactory();
    adapter = new ClaudeSessionReaderAdapter(mockPricing);
    adapterFactory.registerAdapter(adapter);

    service = new TranscriptWatcherService(cacheService, adapterFactory, mockEvents);
  });

  afterEach(async () => {
    service.onModuleDestroy();
    cacheService.onModuleDestroy();
    jest.useRealTimers();

    // Cleanup temp files
    try {
      await fsp.rm(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('lane: file growth publishes full-refetch-required and never populates the cache', async () => {
    // Unviewed Claude session (no reader created an entry): the watcher runs the metrics-only
    // lane. It signals the change with the existing full-refetch-required kind and advances its
    // O(1) summary WITHOUT retaining bodies or creating a cache entry.
    await service.startWatching('test-session', filePath, 'claude');
    expect(service.activeWatcherCount).toBe(1);

    const newContent =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'List files please'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Here are the files'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, newContent, 'utf8');

    await advancePollCycle();

    expect(mockEvents.publish).toHaveBeenCalledWith(
      'session.transcript.updated',
      expect.objectContaining({
        kind: 'full-refetch-required',
        sessionId: 'test-session',
        transcriptPath: filePath,
        sourceChangeKind: 'unknown-full-parse',
      }),
    );
    // No cache entry, no retained bytes.
    expect(cacheService.size).toBe(0);
    expect(cacheService.getCacheStats().budgetUsedBytes).toBe(0);
    // Lane summary reflects the appended content (initial 2 + appended 2 = 4).
    expect(service.getLastKnownMessageCount('test-session')).toBe(4);
    expect(service.getLastKnownSummaryMetrics('test-session')?.messageCount).toBe(4);
  }, 15_000);

  it('lane: successive appends advance the lane summary with the cache empty', async () => {
    await service.startWatching('test-session', filePath, 'claude');

    const newContent =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'First append'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Second response'),
        userLine('u-003', 'a-002', '2026-01-15T10:01:00.000Z', 'Third message'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, newContent, 'utf8');

    await advancePollCycle();

    expect(mockEvents.publish).toHaveBeenCalledWith(
      'session.transcript.updated',
      expect.objectContaining({
        kind: 'full-refetch-required',
        sessionId: 'test-session',
        sourceChangeKind: 'unknown-full-parse',
      }),
    );
    // The lane never populates the cache (initial 2 + appended 3 = 5 messages tracked in O(1)).
    expect(cacheService.size).toBe(0);
    expect(service.getLastKnownMessageCount('test-session')).toBe(5);
  }, 15_000);

  it('should emit transcript.ended with final metrics on stopWatching', async () => {
    await service.startWatching('test-session', filePath, 'claude');

    await service.stopWatching('test-session', 'session.stopped');

    expect(service.activeWatcherCount).toBe(0);
    expect(mockEvents.publish).toHaveBeenCalledWith(
      'session.transcript.ended',
      expect.objectContaining({
        sessionId: 'test-session',
        transcriptPath: filePath,
        endReason: 'session.stopped',
        finalMetrics: expect.objectContaining({
          messageCount: expect.any(Number),
          totalTokens: expect.any(Number),
          costUsd: expect.any(Number),
        }),
      }),
    );
    // A lane session ends without ever creating a 2x-size cache entry.
    expect(cacheService.size).toBe(0);
  });

  it('lane→body switch: a reader that creates an entry gets a delta, not a full-refetch', async () => {
    // Unviewed session starts in the lane.
    await service.startWatching('test-session', filePath, 'claude');
    await flush();
    expect(cacheService.size).toBe(0);

    // A reader opens the session, creating a cache entry (the body path from here on).
    await cacheService.getOrParseWithMeta('test-session', filePath, adapter);
    expect(cacheService.size).toBe(1);

    // The agent appends: the watcher finds the entry and switches to the body path, publishing a
    // normal delta (never full-refetch-required, which would force a second canonical load).
    const newContent =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'More please'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Sure'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, newContent, 'utf8');
    await advancePollCycle();

    const updates = mockEvents.publish.mock.calls.filter(
      ([name]) => name === 'session.transcript.updated',
    );
    const kinds = updates.map(([, payload]) => (payload as { kind: string }).kind);
    expect(kinds).toContain('delta');
    expect(kinds).not.toContain('full-refetch-required');
  }, 15_000);

  it('lane→body switch: sharing a reader full-parse successor never forces a second canonical load', async () => {
    // Unviewed session starts in the lane.
    await service.startWatching('test-session', filePath, 'claude');
    await flush();
    expect(cacheService.size).toBe(0);

    // Hold reader full parse A AFTER it has read the initial file, and count overlap.
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let active = 0;
    let maxActive = 0;
    let fullCalls = 0;
    const realParseFull = adapter.parseFullSession.bind(adapter);
    jest.spyOn(adapter, 'parseFullSession').mockImplementation(async (fp) => {
      fullCalls += 1;
      const isA = fullCalls === 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const session = await realParseFull(fp);
        if (isA) await gateA;
        return session;
      } finally {
        active -= 1;
      }
    });

    const readerA = cacheService.getOrParseWithMeta('test-session', filePath, adapter);
    await flush();
    expect(active).toBe(1);

    // B: a second reader joins behind A. C: the watcher's refreshIfPresent pass for the append.
    const readerB = cacheService.getOrParseWithMeta('test-session', filePath, adapter);
    const appended =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'More please'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Sure'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, appended, 'utf8');
    jest.advanceTimersByTime(3000);
    await flush();
    jest.advanceTimersByTime(200);
    await flush();

    // The file grew while A ran, so A stores no proof and B's successor is a full parse
    // classified same-file-rewrite. C shares that successor instead of racing it.
    releaseA();
    await readerA;
    const resultB = await readerB;
    await flush();

    expect(maxActive).toBe(1);
    expect(fullCalls).toBe(2);
    expect(resultB.sourceChangeKind).toBe('same-file-rewrite');
    expect(resultB.session.metrics.messageCount).toBe(4);

    // The reader already holds B's generation: the watcher adopts it and publishes no refetch.
    const kinds = mockEvents.publish.mock.calls
      .filter(([name]) => name === 'session.transcript.updated')
      .map(([, payload]) => (payload as { kind: string }).kind);
    expect(kinds).not.toContain('full-refetch-required');
    expect(service.getLastKnownMessageCount('test-session')).toBe(4);
  }, 15_000);

  it('should not publish when file size has not changed between polls', async () => {
    await service.startWatching('test-session', filePath, 'claude');

    // Advance one poll cycle without changing the file
    await advancePollCycle();

    // No transcript.updated events should be published
    expect(mockEvents.publish).not.toHaveBeenCalledWith(
      'session.transcript.updated',
      expect.anything(),
    );
  }, 15_000);

  it('should handle file deletion gracefully mid-pipeline', async () => {
    await service.startWatching('test-session', filePath, 'claude');

    // Delete the file
    await fsp.unlink(filePath);

    await advancePollCycle();

    expect(service.activeWatcherCount).toBe(0);
    expect(mockEvents.publish).toHaveBeenCalledWith(
      'session.transcript.ended',
      expect.objectContaining({
        sessionId: 'test-session',
        endReason: 'file.deleted',
      }),
    );
  }, 15_000);

  interface FinalMetrics {
    messageCount: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }

  function endedFinalMetrics(): FinalMetrics {
    const ended = mockEvents.publish.mock.calls.find(
      ([name]) => name === 'session.transcript.ended',
    );
    expect(ended).toBeDefined();
    return (ended![1] as { finalMetrics: FinalMetrics }).finalMetrics;
  }

  it('stop before the debounce fires: ended metrics count the pending append, cache stays empty', async () => {
    await service.startWatching('test-session', filePath, 'claude');
    // The lane seeded from the initial two messages; the append below is not yet observed.
    expect(service.getLastKnownMessageCount('test-session')).toBe(2);

    const appended =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'List files please'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Here are the files'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, appended, 'utf8');

    // Stop WITHOUT advancing timers: the debounce/poll never fired, so no live pass saw the append.
    await service.stopWatching('test-session', 'session.stopped');

    const full = await adapter.parseFullSession(filePath);
    const finalMetrics = endedFinalMetrics();
    expect(finalMetrics.messageCount).toBe(4);
    expect(finalMetrics.messageCount).toBe(full.metrics.messageCount);
    expect(finalMetrics.totalTokens).toBe(full.metrics.totalTokens);
    expect(finalMetrics.inputTokens).toBe(full.metrics.inputTokens);
    expect(finalMetrics.outputTokens).toBe(full.metrics.outputTokens);
    expect(finalMetrics.costUsd).toBe(full.metrics.costUsd);
    // No cache entry created for the ending unviewed session.
    expect(cacheService.size).toBe(0);
    expect(cacheService.getCacheStats().budgetUsedBytes).toBe(0);
  }, 15_000);

  it('stop inside the costly-refresh cooldown: ended metrics still count the latest append', async () => {
    await service.startWatching('test-session', filePath, 'claude');

    const first =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'First'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Reply one'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, first, 'utf8');
    await advancePollCycle();
    expect(service.getLastKnownMessageCount('test-session')).toBe(4);

    // Represent the 2 s cooldown window: the next eligible refresh is in the future.
    const watched = (
      service as unknown as { watchers: Map<string, { nextEligibleAt: number }> }
    ).watchers.get('test-session')!;
    watched.nextEligibleAt = performance.now() + 5_000;

    const second =
      [
        userLine('u-003', 'a-002', '2026-01-15T10:00:40.000Z', 'Second'),
        assistantLine('a-003', 'u-003', '2026-01-15T10:00:45.000Z', 'Reply two'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, second, 'utf8');
    // Stop immediately: still inside the cooldown, before any new pass observed the second append.
    await service.stopWatching('test-session', 'session.stopped');

    const full = await adapter.parseFullSession(filePath);
    const finalMetrics = endedFinalMetrics();
    expect(finalMetrics.messageCount).toBe(6);
    expect(finalMetrics.messageCount).toBe(full.metrics.messageCount);
    expect(finalMetrics.totalTokens).toBe(full.metrics.totalTokens);
    expect(cacheService.size).toBe(0);
  }, 15_000);

  it('stop while a lane pass is active: one ended event, correct totals, no overlap, no late update', async () => {
    await service.startWatching('test-session', filePath, 'claude');

    const appended =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'List files'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Here'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, appended, 'utf8');

    // Gate parseIncremental so the triggered lane pass is still in flight when we stop.
    let releaseParse: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseParse = resolve;
    });
    let concurrent = 0;
    let maxConcurrent = 0;
    const realParseIncremental = adapter.parseIncremental.bind(adapter);
    jest.spyOn(adapter, 'parseIncremental').mockImplementation(async (fp, options) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        await gate;
        return await realParseIncremental(fp, options);
      } finally {
        concurrent -= 1;
      }
    });

    // Fire poll → debounce → lane pass; it blocks inside parseIncremental.
    jest.advanceTimersByTime(3000);
    await flush();
    jest.advanceTimersByTime(200);
    await flush();
    expect(concurrent).toBe(1);

    // Stop while that pass runs: stopWatching waits for it instead of racing a second pass.
    const stopPromise = service.stopWatching('test-session', 'session.stopped');
    await flush();
    releaseParse();
    await stopPromise;
    await flush();

    expect(maxConcurrent).toBe(1); // never two lane passes on the same state at once

    const endedCalls = mockEvents.publish.mock.calls.filter(
      ([name]) => name === 'session.transcript.ended',
    );
    expect(endedCalls).toHaveLength(1);
    const full = await adapter.parseFullSession(filePath);
    const finalMetrics = (endedCalls[0][1] as { finalMetrics: FinalMetrics }).finalMetrics;
    expect(finalMetrics.messageCount).toBe(full.metrics.messageCount);
    expect(finalMetrics.totalTokens).toBe(full.metrics.totalTokens);

    // The stop superseded the append's own live update: no transcript.updated after the stop.
    const updateCalls = mockEvents.publish.mock.calls.filter(
      ([name]) => name === 'session.transcript.updated',
    );
    expect(updateCalls).toHaveLength(0);
    expect(cacheService.size).toBe(0);
  }, 15_000);

  it('stop then immediate restart: the stale final pass never touches the new watcher', async () => {
    await service.startWatching('test-session', filePath, 'claude');

    const appended =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'List'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Here'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, appended, 'utf8');

    // Keep the triggered pass in flight across the restart.
    let releaseParse: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseParse = resolve;
    });
    const realParseIncremental = adapter.parseIncremental.bind(adapter);
    jest.spyOn(adapter, 'parseIncremental').mockImplementation(async (fp, options) => {
      await gate;
      return realParseIncremental(fp, options);
    });

    jest.advanceTimersByTime(3000);
    await flush();
    jest.advanceTimersByTime(200);
    await flush();

    // Stop waits on the in-flight pass; a new watcher for the same session starts meanwhile.
    const stopPromise = service.stopWatching('test-session', 'session.stopped');
    await flush();
    await service.startWatching('test-session', filePath, 'claude');
    expect(service.activeWatcherCount).toBe(1);

    releaseParse();
    await stopPromise;
    await flush();

    // The new watcher owns the session and reports the full file; the stale stop changed nothing
    // and published no ended event (the restart revoked its ownership).
    expect(service.activeWatcherCount).toBe(1);
    expect(service.getLastKnownMessageCount('test-session')).toBe(4);
    const endedCalls = mockEvents.publish.mock.calls.filter(
      ([name]) => name === 'session.transcript.ended',
    );
    expect(endedCalls).toHaveLength(0);
  }, 15_000);

  it('final lane pass failure: logs a warning and reports the last known metrics', async () => {
    await service.startWatching('test-session', filePath, 'claude');
    expect(service.getLastKnownMessageCount('test-session')).toBe(2);

    const appended =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'List'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Here'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, appended, 'utf8');

    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => {});
    // Both the append-proof path and the metrics-only rescan fall back to failing.
    jest.spyOn(adapter, 'parseIncremental').mockRejectedValue(new Error('boom'));
    jest.spyOn(adapter, 'getSummary').mockRejectedValue(new Error('boom'));

    await expect(service.stopWatching('test-session', 'session.stopped')).resolves.not.toThrow();

    const finalMetrics = endedFinalMetrics();
    // Reports the last known lane metrics (the seed of two messages); never throws.
    expect(finalMetrics.messageCount).toBe(2);
    expect(warnSpy).toHaveBeenCalled();
    expect(cacheService.size).toBe(0);
  }, 15_000);

  it('same-length in-place rewrite with a changed mtime refreshes the lane to match a full parse', async () => {
    await service.startWatching('test-session', filePath, 'claude');
    expect(service.getLastKnownSummaryMetrics('test-session')?.inputTokens).toBe(100);

    // Rewrite a-001 in place, input_tokens 100 -> 900: three digits either way, so the byte length
    // (and file size) is identical. This is a same-length rewrite, outside the accepted middle-
    // overwrite-plus-growth limit; the lane must refresh, not treat it as a redundant signal.
    const rewritten =
      [
        userLine('u-001', null, '2026-01-15T10:00:00.000Z', 'Hello'),
        assistantLine('a-001', 'u-001', '2026-01-15T10:00:05.000Z', 'Hi there!', {
          input: 900,
          output: 50,
        }),
      ].join('\n') + '\n';
    const sizeBefore = (await fsp.stat(filePath)).size;
    await fsp.writeFile(filePath, rewritten, 'utf8');
    expect((await fsp.stat(filePath)).size).toBe(sizeBefore); // genuinely same-length
    // Force a distinct mtime (filesystem granularity could otherwise coincide with the seed's).
    const bump = new Date(Date.now() + 2000);
    await fsp.utimes(filePath, bump, bump);

    // Run the normal file-change handler (as fs.watch would fire it for an in-place rewrite).
    const state = (service as unknown as { watchers: Map<string, unknown> }).watchers.get(
      'test-session',
    );
    await (
      service as unknown as { runRefresh: (s: unknown, poll: boolean) => Promise<void> }
    ).runRefresh(state, false);
    await flush();

    const full = await adapter.parseFullSession(filePath);
    const refreshed = service.getLastKnownSummaryMetrics('test-session');
    expect(refreshed?.inputTokens).toBe(900);
    expect(refreshed?.inputTokens).toBe(full.metrics.inputTokens);
    expect(mockEvents.publish).toHaveBeenCalledWith(
      'session.transcript.updated',
      expect.objectContaining({
        kind: 'full-refetch-required',
        sourceChangeKind: 'unknown-full-parse',
      }),
    );
    expect(cacheService.size).toBe(0);
  }, 15_000);

  it('a redundant signal (same identity, size and revision) stays a no-op: no rescan, no event, running metrics unchanged', async () => {
    await service.startWatching('test-session', filePath, 'claude');
    const appended =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'More'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Reply'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, appended, 'utf8');
    await advancePollCycle(); // consume the append; the lane is now fully current

    const updatesBefore = mockEvents.publish.mock.calls.filter(
      ([name]) => name === 'session.transcript.updated',
    ).length;
    const before = { ...service.getLastKnownSummaryMetrics('test-session')! };
    const getSummarySpy = jest.spyOn(adapter, 'getSummary');

    // Re-fire the change handler with no file change: a redundant signal for bytes already proved.
    const state = (service as unknown as { watchers: Map<string, unknown> }).watchers.get(
      'test-session',
    );
    await (
      service as unknown as { runRefresh: (s: unknown, poll: boolean) => Promise<void> }
    ).runRefresh(state, false);
    await flush();

    expect(getSummarySpy).not.toHaveBeenCalled(); // no rescan
    const updatesAfter = mockEvents.publish.mock.calls.filter(
      ([name]) => name === 'session.transcript.updated',
    ).length;
    expect(updatesAfter).toBe(updatesBefore); // no new event
    const after = service.getLastKnownSummaryMetrics('test-session')!;
    expect(after.durationMs).toBe(before.durationMs); // merge-derived running metrics preserved
    expect(after.costUsd).toBe(before.costUsd);
    expect(after.inputTokens).toBe(before.inputTokens);
    getSummarySpy.mockRestore();
  }, 15_000);
});
