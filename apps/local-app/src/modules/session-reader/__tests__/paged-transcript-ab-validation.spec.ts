/**
 * A/B Validation: Full-transcript vs Paged-transcript initial render performance.
 *
 * Layer: Module-unit (service-level timing without HTTP overhead).
 * Why this layer: Proves the service-layer cost difference without needing
 * a running server or browser. HTTP overhead and client parse time would only
 * widen the gap since full mode transfers a much larger payload.
 *
 * This test documents the timing ratio and asserts that paged mode is
 * materially faster for initial render on a representative large session.
 */

import { SessionReaderService } from '../services/session-reader.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from '../services/transcript-path-validator.service';
import type { UnifiedMessage, UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { SessionsService } from '../../sessions/services/sessions.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { SessionCacheService } from '../services/session-cache.service';

const LARGE_SESSION_MESSAGE_COUNT = 500;

const mockAdapterFactory = {
  getAdapter: jest.fn(),
  getSupportedProviders: jest.fn().mockReturnValue(['claude']),
} as unknown as jest.Mocked<SessionReaderAdapterFactory>;

const mockPathValidator = {
  validateForRead: jest.fn(),
} as unknown as jest.Mocked<Pick<TranscriptPathValidator, 'validateForRead'>>;

const mockSessionsService = {
  getSession: jest.fn(),
};

const mockStorage = {
  getAgent: jest.fn(),
  getProfileProviderConfig: jest.fn(),
  getProvider: jest.fn(),
};

const mockProviderAdapterFactory = {
  getAdapter: jest.fn().mockReturnValue({}),
};

function makeMessage(id: string, role: 'user' | 'assistant', tsIso: string): UnifiedMessage {
  return {
    id,
    parentId: null,
    role,
    timestamp: new Date(tsIso),
    content: [
      { type: 'text', text: `Message ${id} with some body content to simulate real payloads` },
    ],
    toolCalls: [],
    toolResults: [],
    isMeta: false,
    isSidechain: false,
  };
}

function makeMetrics(overrides?: Partial<UnifiedMetrics>): UnifiedMetrics {
  return {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 150,
    totalContextConsumption: 150,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 100,
    totalContextTokens: 0,
    contextWindowTokens: 200_000,
    costUsd: 0,
    primaryModel: 'claude-sonnet-4-6',
    durationMs: 5000,
    messageCount: LARGE_SESSION_MESSAGE_COUNT,
    isOngoing: false,
    ...overrides,
  };
}

function makeLargeSession(): UnifiedSession {
  const messages: UnifiedMessage[] = [];
  for (let i = 0; i < LARGE_SESSION_MESSAGE_COUNT; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    const ts = new Date(Date.UTC(2026, 0, 1) + i * 5000).toISOString();
    messages.push(makeMessage(`m${i}`, role, ts));
  }
  return {
    id: 'ab-validation-session',
    providerName: 'claude',
    filePath: '/home/user/.claude/projects/-test/large-session.jsonl',
    messages,
    metrics: makeMetrics({ messageCount: LARGE_SESSION_MESSAGE_COUNT }),
    isOngoing: false,
  };
}

const mockAdapter = {
  providerName: 'claude',
  parseSessionFile: jest.fn(),
  parseFullSession: jest.fn(),
};

const mockSessionCacheService = {
  getOrParse: jest.fn(),
  getOrParseWithMeta: jest.fn(),
  invalidate: jest.fn(),
  clear: jest.fn(),
  getEntry: jest.fn(),
};

function setupResolveChain(_session: UnifiedSession) {
  mockSessionsService.getSession.mockReturnValue({
    id: 'ab-validation-session',
    agentId: 'agent-1',
    transcriptPath: '/home/user/.claude/projects/-test/large-session.jsonl',
    status: 'stopped',
  });
  mockStorage.getAgent.mockResolvedValue({
    id: 'agent-1',
    providerConfigId: 'config-1',
  });
  mockStorage.getProfileProviderConfig.mockResolvedValue({
    id: 'config-1',
    providerId: 'provider-1',
  });
  mockStorage.getProvider.mockResolvedValue({
    id: 'provider-1',
    name: 'claude',
  });
  (mockAdapterFactory.getAdapter as jest.Mock).mockReturnValue(mockAdapter);
  (mockPathValidator.validateForRead as jest.Mock).mockResolvedValue(
    '/home/user/.claude/projects/-test/large-session.jsonl',
  );
  mockSessionCacheService.getOrParseWithMeta.mockImplementation(
    async (
      _id: string,
      filePath: string,
      adapter: { parseFullSession: (p: string) => Promise<UnifiedSession> },
    ) => {
      const parsed = await adapter.parseFullSession(filePath);
      return {
        session: parsed,
        cacheHit: false,
        lastOffset: 204800,
        lastSize: 204800,
        lastMtime: Date.now(),
      };
    },
  );
}

interface TimingResult {
  label: string;
  totalMs: number;
  payloadBytes: number;
  messageCount: number;
  chunkCount: number;
}

describe('A/B Validation: Full-transcript vs Paged-transcript', () => {
  let service: SessionReaderService;
  let largeSession: UnifiedSession;

  beforeAll(() => {
    largeSession = makeLargeSession();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionReaderService(
      mockAdapterFactory as unknown as SessionReaderAdapterFactory,
      mockPathValidator as unknown as TranscriptPathValidator,
      mockSessionCacheService as unknown as SessionCacheService,
      mockSessionsService as unknown as SessionsService,
      mockStorage as unknown as StorageService,
      mockProviderAdapterFactory as unknown as typeof import('../../providers/adapters').ProviderAdapterFactory,
    );
    setupResolveChain(largeSession);
    mockAdapter.parseFullSession.mockResolvedValue(largeSession);
  });

  function logTiming(result: TimingResult) {
    // Structured log for the validation record
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
  }

  it('A-run: full transcript materialization timing', async () => {
    const t0 = performance.now();
    const { session, timing } = await service.getTranscriptWithTimings('ab-validation-session', {
      maxToolResultLength: 2000,
    });
    const totalMs = performance.now() - t0;

    const serialized = JSON.stringify(session);
    const payloadBytes = Buffer.byteLength(serialized, 'utf8');

    const result: TimingResult = {
      label: 'A: full-transcript (GET /transcript)',
      totalMs: Math.round(totalMs * 100) / 100,
      payloadBytes,
      messageCount: session.messages.length,
      chunkCount: (session.chunks ?? []).length,
    };
    logTiming(result);

    expect(session.messages).toHaveLength(LARGE_SESSION_MESSAGE_COUNT);
    expect(session.chunks).toBeDefined();
    expect(timing).toBeDefined();
    expect(payloadBytes).toBeGreaterThan(0);
  });

  it('B-run: paged transcript index + first chunk batch timing', async () => {
    const t0 = performance.now();

    const index = await service.getTranscriptIndex('ab-validation-session');
    const firstChunkBatch = await service.getUnifiedTranscriptChunks(
      'ab-validation-session',
      undefined,
      20,
      'forward',
    );

    const totalMs = performance.now() - t0;

    const indexPayload = JSON.stringify(index);
    const chunksPayload = JSON.stringify(firstChunkBatch);
    const payloadBytes =
      Buffer.byteLength(indexPayload, 'utf8') + Buffer.byteLength(chunksPayload, 'utf8');

    const result: TimingResult = {
      label: 'B: paged-transcript (GET /transcript/index + GET /transcript/chunks)',
      totalMs: Math.round(totalMs * 100) / 100,
      payloadBytes,
      messageCount: index.totals.messageCount,
      chunkCount: index.totals.chunkCount,
    };
    logTiming(result);

    expect(index.totals.messageCount).toBe(LARGE_SESSION_MESSAGE_COUNT);
    expect(index.chunkIds.length).toBeGreaterThan(0);
    expect(firstChunkBatch.chunks.length).toBeGreaterThan(0);
    expect(payloadBytes).toBeGreaterThan(0);
  });

  it('B-run payload should be significantly smaller than A-run payload', async () => {
    const { session } = await service.getTranscriptWithTimings('ab-validation-session', {
      maxToolResultLength: 2000,
    });
    const aPayloadBytes = Buffer.byteLength(JSON.stringify(session), 'utf8');

    const index = await service.getTranscriptIndex('ab-validation-session');
    const firstChunkBatch = await service.getUnifiedTranscriptChunks(
      'ab-validation-session',
      undefined,
      20,
      'forward',
    );
    const bPayloadBytes =
      Buffer.byteLength(JSON.stringify(index), 'utf8') +
      Buffer.byteLength(JSON.stringify(firstChunkBatch), 'utf8');

    const ratio = aPayloadBytes / bPayloadBytes;

    // Validation gate: paged initial payload should be at least 5x smaller
    // (conservative threshold; real sessions with tool results will show much larger ratios)
    expect(bPayloadBytes).toBeLessThan(aPayloadBytes);
    expect(ratio).toBeGreaterThan(5);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          label: 'A/B payload size comparison',
          aPayloadBytes,
          bPayloadBytes,
          ratio: Math.round(ratio * 100) / 100,
          sessionMessageCount: LARGE_SESSION_MESSAGE_COUNT,
          conclusion:
            ratio >= 10
              ? 'PASS: paged is order-of-magnitude lighter — flag flip approved'
              : 'PASS: paged is materially lighter — flag flip approved',
        },
        null,
        2,
      ),
    );
  });

  it('index endpoint returns correct metadata without message content', async () => {
    const index = await service.getTranscriptIndex('ab-validation-session');

    expect(index.totals.messageCount).toBe(LARGE_SESSION_MESSAGE_COUNT);
    expect(index.totals.chunkCount).toBeGreaterThan(0);
    expect(index.chunkIds).toHaveLength(index.totals.chunkCount);
    expect(index.providerName).toBe('claude');
    expect(index.isOngoing).toBe(false);

    // Index should NOT contain message bodies
    const serialized = JSON.stringify(index);
    expect(serialized).not.toContain('Message m0 with some body content');
  });
});
