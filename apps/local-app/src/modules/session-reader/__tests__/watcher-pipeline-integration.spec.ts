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
    cacheService = new SessionCacheService();

    const adapterFactory = new SessionReaderAdapterFactory();
    const adapter = new ClaudeSessionReaderAdapter(mockPricing);
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

  it('should detect file growth and publish transcript.updated with parsed metrics', async () => {
    await service.startWatching('test-session', filePath, 'claude');
    expect(service.activeWatcherCount).toBe(1);

    // Append new messages to the file
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
        sessionId: 'test-session',
        transcriptPath: filePath,
        newMessageCount: 2,
        metrics: expect.objectContaining({
          messageCount: 4,
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
        }),
        cursor: expect.any(String),
        prevCursor: expect.any(String),
        deltaChunks: expect.any(Array),
        deltaMessages: expect.any(Array),
      }),
    );
  }, 15_000);

  it('should process multiple file changes over successive poll cycles', async () => {
    await service.startWatching('test-session', filePath, 'claude');

    // Append ALL new messages in one go (both user + assistant)
    const newContent =
      [
        userLine('u-002', 'a-001', '2026-01-15T10:00:30.000Z', 'First append'),
        assistantLine('a-002', 'u-002', '2026-01-15T10:00:35.000Z', 'Second response'),
        userLine('u-003', 'a-002', '2026-01-15T10:01:00.000Z', 'Third message'),
      ].join('\n') + '\n';
    await fsp.appendFile(filePath, newContent, 'utf8');

    await advancePollCycle();

    // Should publish transcript.updated with delta message count (3 appended) and full metrics (5 total)
    expect(mockEvents.publish).toHaveBeenCalledWith(
      'session.transcript.updated',
      expect.objectContaining({
        sessionId: 'test-session',
        newMessageCount: 3,
        metrics: expect.objectContaining({ messageCount: 5 }),
        cursor: expect.any(String),
        prevCursor: expect.any(String),
        deltaChunks: expect.any(Array),
        deltaMessages: expect.any(Array),
      }),
    );

    // Verify cache was populated (subsequent parse should use cache)
    expect(cacheService.size).toBe(1);
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
  });

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
});
