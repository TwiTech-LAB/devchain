import * as fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionReaderService } from '../services/session-reader.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { SessionCacheService } from '../services/session-cache.service';
import { OpenCodeSessionReaderAdapter } from '../adapters/opencode-session-reader.adapter';
import { OpencodeAdapter } from '../../providers/adapters/opencode.adapter';
import type { TranscriptPathValidator } from '../services/transcript-path-validator.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { PricingServiceInterface } from '../services/pricing.interface';
import {
  createOpencodeFixtureDb,
  appendPart,
  updatePartInPlace,
  type SeedSession,
} from '../__fixtures__/opencode-fixture-db';

/**
 * End-to-end integration tests for the OpenCode DB-backed read pipeline.
 *
 * Drives the REAL SessionReaderService → SessionCacheService →
 * OpenCodeSessionReaderAdapter → OpencodeSqliteReader against a seeded fixture
 * `opencode.db` (temp SQLite, WAL). Only the external seams that aren't part of
 * the read pipeline are mocked (sessions row lookup, agent→provider resolution,
 * path validation). Deterministic; needs no real `opencode` install.
 *
 * Covers the production failure modes: shared-container two-session isolation,
 * WAL-only updates (main `.db` size unchanged), in-place part edits / part-adds
 * with an unchanged message count, restore arg-building, and the full
 * summary → chunks → tail flow after an in-place update.
 */

function makePricing(): PricingServiceInterface {
  return {
    calculateMessageCost: jest.fn().mockReturnValue(0),
    getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
    getContextWindowSize: jest.fn().mockReturnValue(200_000),
  } as unknown as PricingServiceInterface;
}

/** Build a real SessionReaderService wired to a fixture DB; `rows` maps a DevChain session id → `ses_…`. */
function buildService(
  dbPath: string,
  rows: Record<string, string>,
): { service: SessionReaderService; cache: SessionCacheService } {
  const mockMetricsService = {
    registerCacheStatsProvider: jest.fn(),
    registerStatsProvider: jest.fn(),
  } as never;
  const cache = new SessionCacheService(mockMetricsService);
  const factory = new SessionReaderAdapterFactory();
  factory.registerAdapter(new OpenCodeSessionReaderAdapter(makePricing()));

  const sessionsService = {
    getSession: jest.fn((id: string) => {
      const providerSessionId = rows[id];
      if (!providerSessionId) return null;
      return {
        id,
        agentId: 'agent-1',
        providerNameAtLaunch: 'opencode',
        transcriptPath: dbPath,
        providerSessionId,
        status: 'running',
      };
    }),
  };
  const pathValidator = { validateForRead: jest.fn(async (p: string) => p) };

  const service = new SessionReaderService(
    factory,
    pathValidator as unknown as TranscriptPathValidator,
    cache,
    sessionsService as unknown as SessionsService,
  );
  return { service, cache };
}

/** ses_a: user → assistant(thinking + text + token step). 2 messages, ids prefixed `a_`. */
function seedSessionA(): SeedSession {
  return {
    id: 'ses_a',
    directory: '/work/proj-a',
    timeCreated: 1_000,
    timeUpdated: 2_000,
    messages: [
      {
        id: 'a_user',
        data: { role: 'user' },
        timeCreated: 1_000,
        parts: [{ id: 'a_p1_text', data: { type: 'text', text: 'add a feature' } }],
      },
      {
        id: 'a_asst',
        data: { role: 'assistant', modelID: 'glm-5.1' },
        timeCreated: 2_000,
        parts: [
          { id: 'a_p2_reason', data: { type: 'reasoning', text: 'considering the request' } },
          { id: 'a_p3_text', data: { type: 'text', text: 'sure, here you go' } },
          {
            id: 'a_p4_step',
            data: {
              type: 'step-finish',
              tokens: { input: 100, output: 50, cache: { read: 10, write: 5 } },
            },
          },
        ],
      },
    ],
  };
}

/** ses_b: user → assistant → assistant. 3 messages, ids prefixed `b_`. */
function seedSessionB(): SeedSession {
  return {
    id: 'ses_b',
    directory: '/work/proj-b',
    timeCreated: 1_000,
    timeUpdated: 3_000,
    messages: [
      {
        id: 'b_user',
        data: { role: 'user' },
        timeCreated: 1_000,
        parts: [{ id: 'b_p1', data: { type: 'text', text: 'unrelated work' } }],
      },
      {
        id: 'b_asst1',
        data: { role: 'assistant', modelID: 'glm-5.1' },
        timeCreated: 2_000,
        parts: [{ id: 'b_p2', data: { type: 'text', text: 'first reply' } }],
      },
      {
        id: 'b_asst2',
        data: { role: 'assistant', modelID: 'glm-5.1' },
        timeCreated: 3_000,
        parts: [{ id: 'b_p3', data: { type: 'text', text: 'second reply' } }],
      },
    ],
  };
}

describe('OpenCode DB pipeline integration (seeded fixture DB)', () => {
  let tmpDir: string;
  let dbPath: string;
  const caches: SessionCacheService[] = [];

  function service(rows: Record<string, string>): SessionReaderService {
    const built = buildService(dbPath, rows);
    caches.push(built.cache);
    return built.service;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-int-'));
    dbPath = path.join(tmpDir, 'opencode.db');
  });

  afterEach(async () => {
    while (caches.length) caches.pop()?.onModuleDestroy();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('keeps native getSummary fields in contract with a full read of the same DB fixture', async () => {
    createOpencodeFixtureDb(dbPath, [seedSessionA()]);
    const adapter = new OpenCodeSessionReaderAdapter(makePricing());
    const sourceRef = {
      filePath: dbPath,
      providerName: 'opencode',
      providerSessionId: 'ses_a',
      kind: 'db' as const,
    };

    const full = await adapter.parseFullSession(dbPath, sourceRef);
    const summary = await adapter.getSummary(sourceRef);

    for (const field of summary.exactFields) {
      expect(summary.metrics[field]).toEqual(full.metrics[field]);
    }
    expect(summary.approximateFields).toEqual([
      'visibleContextTokens',
      'totalContextConsumption',
      'phaseBreakdowns',
    ]);
  });

  it('isolates two DevChain sessions sharing one opencode.db (addressed by (path, ses_))', async () => {
    createOpencodeFixtureDb(dbPath, [seedSessionA(), seedSessionB()]);
    const svc = service({ 'dc-a': 'ses_a', 'dc-b': 'ses_b' });

    const a = await svc.getTranscript('dc-a');
    const b = await svc.getTranscript('dc-b');

    expect(a.messages).toHaveLength(2);
    expect(b.messages).toHaveLength(3);
    // No cross-contamination: each session sees only its own rows.
    expect(a.messages.every((m) => m.id.startsWith('a_'))).toBe(true);
    expect(b.messages.every((m) => m.id.startsWith('b_'))).toBe(true);
    expect(a.messages[0].content).toEqual([{ type: 'text', text: 'add a feature' }]);
    expect(b.messages[0].content).toEqual([{ type: 'text', text: 'unrelated work' }]);
  });

  it('detects a WAL-only in-place update with the main .db byte size unchanged', async () => {
    createOpencodeFixtureDb(dbPath, [seedSessionA()]);
    const svc = service({ 'dc-a': 'ses_a' });
    const built = caches[caches.length - 1];

    await svc.getTranscript('dc-a'); // prime cache
    const v0 = built.getEntry('dc-a')?.sourceVersion;
    const sizeBefore = statSync(dbPath).size;

    // In-place edit: same-length data, only the revision timestamp moves → the
    // main .db page count (and thus its byte size) cannot change, even on the
    // checkpoint that runs when the writer connection closes.
    updatePartInPlace(dbPath, {
      partId: 'a_p3_text',
      data: { type: 'text', text: 'sure, here you go' },
      timeUpdated: 5_000_000,
    });
    const sizeAfter = statSync(dbPath).size;
    expect(sizeAfter).toBe(sizeBefore);

    await svc.getTranscript('dc-a'); // re-read: cache must detect the token change
    const v1 = built.getEntry('dc-a')?.sourceVersion;
    expect(v1).toBe(5_000_000); // sourceVersion = token maxUpdated, NOT the file size
    expect(v1).not.toBe(v0);
  });

  it('surfaces a part-add with an unchanged message count as an in-place tail delta', async () => {
    createOpencodeFixtureDb(dbPath, [seedSessionA()]);
    const svc = service({ 'dc-a': 'ses_a' });

    const summary = await svc.getTranscriptSummaryWithCursor('dc-a');
    expect((await svc.getTranscript('dc-a')).messages).toHaveLength(2);

    // Append a NEW part to the EXISTING assistant message → message count stays 2.
    appendPart(dbPath, {
      sessionId: 'ses_a',
      messageId: 'a_asst',
      part: {
        id: 'a_p5_text',
        data: { type: 'text', text: 'and one more thing' },
        timeUpdated: 6_000_000,
      },
    });

    const tail = await svc.getTranscriptTail('dc-a', summary.cursor);
    expect(tail).not.toBeNull();
    expect(tail?.totalMessageCount).toBe(2); // no NEW message
    expect(tail?.deltaMessages).toEqual([]);
    expect(tail?.deltaChunks.length).toBeGreaterThan(0); // in-place last-chunk replacement
    expect(tail?.replaceFromChunkId).not.toBeNull();
    expect(tail?.cursor).not.toBe(summary.cursor);

    const after = await svc.getTranscript('dc-a');
    expect(
      after.messages[1].content.some((c) => c.type === 'text' && c.text === 'and one more thing'),
    ).toBe(true);
  });

  it('builds restore args via --session ses_ and reads the restored session', async () => {
    const provider = new OpencodeAdapter();
    expect(provider.providerSessionIdRequiredForRestore).toBe(true);
    const { argv } = provider.buildLaunchArgs({
      mode: 'restore',
      providerSessionId: 'ses_a',
      profileOptionArgs: ['--model', 'glm-5.1'],
    });
    expect(argv).toEqual(['--session', 'ses_a', '--model', 'glm-5.1']);

    // A restored DevChain session row (provider_session_id = ses_a) renders end-to-end.
    createOpencodeFixtureDb(dbPath, [seedSessionA()]);
    const svc = service({ 'dc-restored': 'ses_a' });
    const restored = await svc.getTranscript('dc-restored');
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[1].role).toBe('assistant');
  });

  it('runs summary → chunks → tail and reflects an in-place chunk update', async () => {
    createOpencodeFixtureDb(dbPath, [seedSessionA()]);
    const svc = service({ 'dc-a': 'ses_a' });

    const summary = await svc.getTranscriptSummaryWithCursor('dc-a');
    expect(summary.cursor).toBeTruthy();

    const chunks = await svc.getUnifiedTranscriptChunks('dc-a');
    expect(chunks.totalCount).toBe(2);
    expect(chunks.chunks.length).toBeGreaterThan(0);

    // In-place edit of an existing part's content (e.g. streamed tool output).
    updatePartInPlace(dbPath, {
      partId: 'a_p3_text',
      data: { type: 'text', text: 'sure — here is the updated answer' },
      timeUpdated: 8_000_000,
    });

    const tail = await svc.getTranscriptTail('dc-a', summary.cursor);
    expect(tail).not.toBeNull();
    expect(tail?.totalMessageCount).toBe(2);
    expect(tail?.deltaChunks.length).toBeGreaterThan(0);
    expect(tail?.replaceFromChunkId).not.toBeNull();

    const after = await svc.getTranscript('dc-a');
    expect(
      after.messages[1].content.some(
        (c) => c.type === 'text' && c.text === 'sure — here is the updated answer',
      ),
    ).toBe(true);
  });
});
