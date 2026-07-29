import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { AntigravitySessionReaderAdapter } from './antigravity-session-reader.adapter';
import { AntigravityTranscriptReader } from '../readers/antigravity-transcript.reader';
import { AntigravityMetricsReader } from '../readers/antigravity-metrics.reader';
import { ValidationError } from '../../../common/errors/error-types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import type { SessionSourceRef } from './session-reader-adapter.interface';
import type { UnifiedMetrics, UnifiedSession } from '../dtos/unified-session.types';
import type { AgyTokenMetrics } from '../readers/antigravity-metrics.reader';

jest.mock('../readers/antigravity-transcript.reader', () => ({
  AntigravityTranscriptReader: jest.fn().mockImplementation(() => ({
    getFreshness: jest.fn(),
    readSession: jest.fn(),
    resolveJsonlPath: jest.fn(),
  })),
}));

function emptyTokenMetrics(): AgyTokenMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    generationCount: 0,
    lastContextTokens: 0,
    warnings: [],
  };
}

jest.mock('../readers/antigravity-metrics.reader', () => ({
  AntigravityMetricsReader: jest.fn().mockImplementation(() => ({
    decode: jest.fn().mockReturnValue({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      generationCount: 0,
      lastContextTokens: 0,
      warnings: [],
    }),
  })),
}));

// os.homedir() is non-configurable and cannot be spied; mock the module so the
// adapter resolves its root under a per-test temp home.
let mockHome = '';
jest.mock('node:os', () => {
  const actual = jest.requireActual('node:os');
  return { ...actual, homedir: () => mockHome };
});

function makePricing(): jest.Mocked<PricingServiceInterface> {
  return {
    calculateMessageCost: jest.fn().mockReturnValue(0.01),
    getCatalogContextWindowSize: jest.fn().mockReturnValue(1_000_000),
    getContextWindowSize: jest.fn().mockReturnValue(1_000_000),
  };
}

function makeMetrics(): UnifiedMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    totalContextConsumption: 0,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 0,
    totalContextTokens: 0,
    contextWindowTokens: 1_000_000,
    costUsd: 0,
    primaryModel: '',
    durationMs: 0,
    messageCount: 0,
    isOngoing: false,
  };
}

function makeSession(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 'conv-1',
    providerName: 'agy',
    filePath: '/db',
    messages: [],
    metrics: makeMetrics(),
    isOngoing: false,
    ...overrides,
  };
}

describe('AntigravitySessionReaderAdapter', () => {
  let home: string;
  let root: string;
  let adapter: AntigravitySessionReaderAdapter;
  let reader: { getFreshness: jest.Mock; readSession: jest.Mock; resolveJsonlPath: jest.Mock };
  let metricsReader: { decode: jest.Mock };
  let pricing: jest.Mocked<PricingServiceInterface>;

  const WORKSPACE = '/home/u/proj';

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-home-'));
    mockHome = home;
    root = path.join(home, '.gemini/antigravity-cli');
    await fs.mkdir(path.join(root, 'conversations'), { recursive: true });
    await fs.mkdir(path.join(root, 'cache'), { recursive: true });

    (AntigravityTranscriptReader as unknown as jest.Mock).mockClear();
    (AntigravityMetricsReader as unknown as jest.Mock).mockClear();
    pricing = makePricing();
    adapter = new AntigravitySessionReaderAdapter(pricing);
    reader = (AntigravityTranscriptReader as unknown as jest.Mock).mock.results[0].value;
    metricsReader = (AntigravityMetricsReader as unknown as jest.Mock).mock.results[0].value;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  function ref(overrides: Partial<SessionSourceRef> = {}): SessionSourceRef {
    return { filePath: '/db', providerName: 'agy', kind: 'db', ...overrides };
  }

  async function writeConversationDb(convId: string): Promise<string> {
    const dbPath = path.join(root, 'conversations', `${convId}.db`);
    await fs.writeFile(dbPath, 'sqlite', 'utf8');
    return dbPath;
  }

  async function writeHistory(lines: Record<string, unknown>[]): Promise<void> {
    await fs.writeFile(
      path.join(root, 'history.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );
  }

  it('declares DB-backed snapshot identity', () => {
    expect(adapter.providerName).toBe('agy');
    expect(adapter.incrementalMode).toBe('snapshot');
    expect(adapter.sourceKind).toBe('db');
    expect(adapter.allowedRoots).toEqual([root]);
  });

  describe('discoverSessionFile', () => {
    it('resolves the workspace conversation id from history.jsonl within the launch window', async () => {
      const convId = '146794e4-0429-4e81-8fe2-e7fad9db2342';
      const dbPath = await writeConversationDb(convId);
      await writeHistory([
        { display: '/model', timestamp: 1000, workspace: WORKSPACE, type: 'slash_command' },
        { display: 'hi', timestamp: 5000, workspace: WORKSPACE, conversationId: convId },
        { display: 'other', timestamp: 5000, workspace: '/elsewhere', conversationId: 'nope' },
      ]);

      const result = await adapter.discoverSessionFile({
        projectRoot: WORKSPACE,
        sessionStartedAt: new Date(5200),
      });

      expect(result).toEqual([
        expect.objectContaining({
          filePath: dbPath,
          providerName: 'agy',
          providerSessionId: convId,
        }),
      ]);
    });

    it('filters out conversations outside the discovery window', async () => {
      const convId = 'aaaaaaaa-0000-0000-0000-000000000000';
      await writeConversationDb(convId);
      await writeHistory([{ timestamp: 1000, workspace: WORKSPACE, conversationId: convId }]);

      const result = await adapter.discoverSessionFile({
        projectRoot: WORKSPACE,
        sessionStartedAt: new Date(1000 + 5 * 60_000), // 5 min away > 2 min window
      });
      expect(result).toEqual([]);
    });

    it('falls back to last_conversations.json when history has no match', async () => {
      const convId = 'bbbbbbbb-0000-0000-0000-000000000000';
      const dbPath = await writeConversationDb(convId);
      await writeHistory([{ timestamp: 1, workspace: '/elsewhere', conversationId: 'other' }]);
      await fs.writeFile(
        path.join(root, 'cache/last_conversations.json'),
        JSON.stringify({ [WORKSPACE]: convId }),
        'utf8',
      );

      const result = await adapter.discoverSessionFile({ projectRoot: WORKSPACE });
      expect(result).toEqual([
        expect.objectContaining({ filePath: dbPath, providerSessionId: convId }),
      ]);
    });

    it('skips candidate ids whose .db does not exist', async () => {
      await writeHistory([{ timestamp: 1, workspace: WORKSPACE, conversationId: 'ghost' }]);
      const result = await adapter.discoverSessionFile({ projectRoot: WORKSPACE });
      expect(result).toEqual([]);
    });

    it('returns [] when no discovery sources exist', async () => {
      const result = await adapter.discoverSessionFile({ projectRoot: WORKSPACE });
      expect(result).toEqual([]);
    });
  });

  describe('getFreshnessToken', () => {
    it('delegates to the reader with the conversation id', async () => {
      const token = { maxUpdated: 9, jsonl: { mtimeMs: 9, size: 1 }, db: { mtimeMs: 5, size: 2 } };
      reader.getFreshness.mockResolvedValue(token);
      const result = await adapter.getFreshnessToken(
        ref({ filePath: '/db/x.db', providerSessionId: 'conv-1' }),
      );
      expect(result).toBe(token);
      expect(reader.getFreshness).toHaveBeenCalledWith('/db/x.db', 'conv-1');
    });

    it('throws when providerSessionId is absent', async () => {
      await expect(adapter.getFreshnessToken(ref())).rejects.toThrow(ValidationError);
    });
  });

  describe('parseFullSession', () => {
    it('reads the session located by sourceRef.providerSessionId', async () => {
      const session = makeSession();
      reader.readSession.mockResolvedValue({
        session,
        sizeBytes: 10,
        freshness: { maxUpdated: 1, jsonl: { mtimeMs: 1, size: 1 }, db: { mtimeMs: 1, size: 1 } },
      });
      const result = await adapter.parseFullSession(
        '/db/x.db',
        ref({ filePath: '/db/x.db', providerSessionId: 'conv-1' }),
      );
      expect(result).toBe(session);
      expect(reader.readSession).toHaveBeenCalledWith('/db/x.db', 'conv-1');
    });

    it('throws when sourceRef lacks providerSessionId', async () => {
      await expect(adapter.parseFullSession('/db/x.db')).rejects.toThrow(ValidationError);
    });

    it('module-unit: summary metrics match the DB-backed full read', async () => {
      reader.readSession.mockImplementation(async () => ({
        session: makeSession(),
        sizeBytes: 10,
        freshness: {},
      }));
      metricsReader.decode.mockReturnValue({
        ...emptyTokenMetrics(),
        inputTokens: 20,
        outputTokens: 5,
        lastContextTokens: 25,
        modelId: 'gemini-3-flash-a',
      });
      const sourceRef = ref({ filePath: '/db/x.db', providerSessionId: 'conv-1' });

      const full = await adapter.parseFullSession('/db/x.db', sourceRef);
      const summary = await adapter.getSummary(sourceRef);

      for (const field of summary.exactFields) {
        expect(summary.metrics[field]).toEqual(full.metrics[field]);
      }
      expect(reader.readSession).toHaveBeenCalledTimes(1);
      expect(summary.approximateFields).toContain('messageCount');
    });
  });

  describe('parseIncremental', () => {
    it('snapshot mode: returns the full session as entries', async () => {
      const session = makeSession({
        messages: [{ id: 'm1' } as never, { id: 'm2' } as never],
        warnings: ['w'],
      });
      reader.readSession.mockResolvedValue({
        session,
        sizeBytes: 42,
        freshness: { maxUpdated: 1, jsonl: { mtimeMs: 1, size: 1 }, db: { mtimeMs: 1, size: 1 } },
      });

      const result = await adapter.parseIncremental(
        '/db/x.db',
        { byteOffset: 0 },
        ref({ filePath: '/db/x.db', providerSessionId: 'conv-1' }),
      );

      expect(result.hasMore).toBe(false);
      expect(result.nextByteOffset).toBe(42);
      expect(result.messageCount).toBe(2);
      expect(result.entries).toBe(session.messages);
      expect(result.warnings).toEqual(['w']);
    });
  });

  describe('token metrics fold (applyTokenMetrics)', () => {
    function readsSession(): UnifiedSession {
      const session = makeSession();
      reader.readSession.mockResolvedValue({
        session,
        sizeBytes: 1,
        freshness: { maxUpdated: 1, jsonl: { mtimeMs: 1, size: 1 }, db: { mtimeMs: 1, size: 1 } },
      });
      return session;
    }

    it('folds decoded tokens + paid cost + context window into the session metrics', async () => {
      readsSession();
      metricsReader.decode.mockReturnValue({
        ...emptyTokenMetrics(),
        inputTokens: 1000,
        outputTokens: 100,
        generationCount: 2,
        lastContextTokens: 550,
        modelId: 'gemini-3-flash-a',
        displayName: 'Gemini 3.5 Flash (High)',
      });

      const result = await adapter.parseFullSession(
        '/ignored',
        ref({ providerSessionId: 'conv-1' }),
      );

      // resolveDbPath prefers the source-ref's persisted transcript_path (= '/db').
      expect(metricsReader.decode).toHaveBeenCalledWith('/db', 'conv-1');
      expect(result.metrics.inputTokens).toBe(1000);
      expect(result.metrics.outputTokens).toBe(100);
      expect(result.metrics.totalTokens).toBe(1100);
      expect(result.metrics.totalContextTokens).toBe(550);
      expect(result.metrics.primaryModel).toBe('gemini-3-flash-a');
      expect(pricing.calculateMessageCost).toHaveBeenCalledWith(
        'gemini-3.5-flash',
        1000,
        100,
        0,
        0,
      );
      expect(result.metrics.costUsd).toBeCloseTo(0.01);
      expect(pricing.getContextWindowSize).toHaveBeenCalledWith('gemini-3.5-flash');
      expect(result.metrics.contextWindowTokens).toBe(1_000_000);
      expect(result.warnings ?? []).toEqual([]);
    });

    it('treats GPT-OSS 120B as free ($0, 131072 window) and never calls pricing', async () => {
      readsSession();
      metricsReader.decode.mockReturnValue({
        ...emptyTokenMetrics(),
        inputTokens: 15005,
        outputTokens: 27,
        modelId: 'gpt-oss-120b-medium',
        displayName: 'GPT-OSS 120B (Medium)',
      });

      const result = await adapter.parseFullSession(
        '/db/conv-1.db',
        ref({ providerSessionId: 'conv-1' }),
      );

      expect(result.metrics.inputTokens).toBe(15005);
      expect(result.metrics.costUsd).toBe(0);
      expect(result.metrics.contextWindowTokens).toBe(131_072);
      expect(pricing.calculateMessageCost).not.toHaveBeenCalled();
    });

    it('folds fail-loud warnings into session.warnings (never a silent zero)', async () => {
      readsSession();
      metricsReader.decode.mockReturnValue({
        ...emptyTokenMetrics(),
        warnings: ['agy metrics: .db conversation id mismatch — token usage NOT trusted'],
      });

      const result = await adapter.parseFullSession(
        '/db/conv-1.db',
        ref({ providerSessionId: 'conv-1' }),
      );
      expect(result.metrics.costUsd).toBe(0);
      expect(result.warnings).toEqual([
        'agy metrics: .db conversation id mismatch — token usage NOT trusted',
      ]);
    });

    it('warns when a model decodes but has no pricing mapping (not a silent $0)', async () => {
      readsSession();
      metricsReader.decode.mockReturnValue({
        ...emptyTokenMetrics(),
        inputTokens: 10,
        outputTokens: 2,
        displayName: 'Some Future Model',
      });

      const result = await adapter.parseFullSession(
        '/db/conv-1.db',
        ref({ providerSessionId: 'conv-1' }),
      );
      expect(result.metrics.costUsd).toBe(0);
      expect(pricing.calculateMessageCost).not.toHaveBeenCalled();
      expect((result.warnings ?? []).join(' ')).toMatch(/no pricing mapping/i);
    });
  });

  it('parseSessionFile is unsupported (DB needs a providerSessionId)', async () => {
    await expect(adapter.parseSessionFile('/db/x.db')).rejects.toThrow(ValidationError);
  });

  it('getWatchPaths returns the conversations directory', () => {
    expect(adapter.getWatchPaths('/proj')).toEqual([path.join(root, 'conversations')]);
  });

  describe('calculateCost', () => {
    it('sums token-only cost over entries with usage', () => {
      const pricing = makePricing();
      (AntigravityTranscriptReader as unknown as jest.Mock).mockClear();
      const a = new AntigravitySessionReaderAdapter(pricing);
      const cost = a.calculateCost(
        [
          { usage: { input: 10, output: 5, cacheRead: 1, cacheCreation: 0 } },
          {}, // no usage → skipped
        ],
        'gpt-oss-120b',
      );
      expect(pricing.calculateMessageCost).toHaveBeenCalledTimes(1);
      expect(cost).toBeCloseTo(0.01);
    });
  });
});
