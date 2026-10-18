import * as os from 'node:os';
import * as path from 'node:path';
import { OpenCodeSessionReaderAdapter } from './opencode-session-reader.adapter';
import { OpencodeSqliteV1Reader } from '../readers/opencode-sqlite.v1.reader';
import { OpencodeSqliteV2Reader } from '../readers/opencode-sqlite.v2.reader';
import { inspectOpencodeDb } from '../readers/opencode-sqlite.db';
import { ValidationError } from '../../../common/errors/error-types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import type { SessionSourceRef } from './session-reader-adapter.interface';
import type { UnifiedSession } from '../dtos/unified-session.types';

function mockReaderClass(): jest.Mock {
  return jest.fn().mockImplementation(() => ({
    findSessionCandidates: jest.fn(),
    getFreshness: jest.fn(),
    readSession: jest.fn(),
    readSummary: jest.fn(),
  }));
}
jest.mock('../readers/opencode-sqlite.v1.reader', () => ({
  OpencodeSqliteV1Reader: mockReaderClass(),
}));
jest.mock('../readers/opencode-sqlite.v2.reader', () => ({
  OpencodeSqliteV2Reader: mockReaderClass(),
}));
jest.mock('../readers/opencode-sqlite.db', () => ({ inspectOpencodeDb: jest.fn() }));

type ReaderMock = {
  findSessionCandidates: jest.Mock;
  getFreshness: jest.Mock;
  readSession: jest.Mock;
  readSummary: jest.Mock;
};
const inspectMock = inspectOpencodeDb as jest.Mock;

const DB_PATH = path.join(os.homedir(), '.local/share/opencode', 'opencode.db');

function makePricing(): jest.Mocked<PricingServiceInterface> {
  return {
    calculateMessageCost: jest.fn().mockReturnValue(0.01),
    getCatalogContextWindowSize: jest.fn().mockReturnValue(200_000),
    getContextWindowSize: jest.fn().mockReturnValue(200_000),
  };
}

function makeSession(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 'ses_abc',
    providerName: 'opencode',
    filePath: DB_PATH,
    messages: [],
    metrics: {} as UnifiedSession['metrics'],
    isOngoing: false,
    ...overrides,
  };
}

function ref(overrides: Partial<SessionSourceRef> = {}): SessionSourceRef {
  return { filePath: DB_PATH, providerName: 'opencode', kind: 'db', ...overrides };
}

describe('OpenCodeSessionReaderAdapter', () => {
  let adapter: OpenCodeSessionReaderAdapter;
  let v1: ReaderMock;
  let reader: ReaderMock;

  beforeEach(() => {
    (OpencodeSqliteV1Reader as unknown as jest.Mock).mockClear();
    (OpencodeSqliteV2Reader as unknown as jest.Mock).mockClear();
    inspectMock.mockReset();
    inspectMock.mockReturnValue({ layouts: new Set(['v2']), holder: 'v2' });
    adapter = new OpenCodeSessionReaderAdapter(makePricing());
    v1 = (OpencodeSqliteV1Reader as unknown as jest.Mock).mock.results[0].value;
    reader = (OpencodeSqliteV2Reader as unknown as jest.Mock).mock.results[0].value;
  });

  it('declares DB-backed snapshot identity', () => {
    expect(adapter.providerName).toBe('opencode');
    expect(adapter.incrementalMode).toBe('snapshot');
    expect(adapter.sourceKind).toBe('db');
    expect(adapter.reportsContextWindow).toBe(true);
    expect(adapter.allowedRoots).toEqual([path.join(os.homedir(), '.local/share/opencode')]);
  });

  describe('discoverSessionFile', () => {
    it('merges candidates of both layouts into one SessionFileInfo per ses_, closest launch first', async () => {
      inspectMock.mockReturnValue({ layouts: new Set(['v1', 'v2']), holder: null });
      v1.findSessionCandidates.mockReturnValue([
        {
          providerSessionId: 'ses_migrated',
          directory: '/proj',
          timeCreated: 100,
          timeUpdated: 900,
        },
        { providerSessionId: 'ses_legacy', directory: '/proj', timeCreated: 50, timeUpdated: 60 },
      ]);
      reader.findSessionCandidates.mockReturnValue([
        {
          providerSessionId: 'ses_migrated',
          directory: '/proj',
          timeCreated: 100,
          timeUpdated: 300,
        },
        { providerSessionId: 'ses_new', directory: '/proj', timeCreated: 125, timeUpdated: 250 },
      ]);

      const result = await adapter.discoverSessionFile({
        projectRoot: '/proj',
        sessionStartedAt: new Date(120),
        sessionId: 'dc-1',
      });

      const query = { directory: path.resolve('/proj'), startedAtMs: 120, windowMs: 120_000 };
      expect(v1.findSessionCandidates).toHaveBeenCalledWith(DB_PATH, query);
      expect(reader.findSessionCandidates).toHaveBeenCalledWith(DB_PATH, query);
      expect(result).toEqual([
        {
          filePath: DB_PATH,
          providerName: 'opencode',
          providerSessionId: 'ses_new',
          sizeBytes: 0,
          lastModified: new Date(250).toISOString(),
        },
        expect.objectContaining({
          providerSessionId: 'ses_migrated',
          lastModified: new Date(900).toISOString(),
        }),
        expect.objectContaining({ providerSessionId: 'ses_legacy' }),
      ]);
    });

    it('returns [] when sessionStartedAt is missing (cannot window-match)', async () => {
      const result = await adapter.discoverSessionFile({ projectRoot: '/proj' });
      expect(result).toEqual([]);
      expect(reader.findSessionCandidates).not.toHaveBeenCalled();
    });

    it('returns [] (retryable) when the container cannot be opened (e.g. DB absent)', async () => {
      inspectMock.mockImplementation(() => {
        throw new Error('SQLITE_CANTOPEN');
      });
      const result = await adapter.discoverSessionFile({
        projectRoot: '/proj',
        sessionStartedAt: new Date(1),
      });
      expect(result).toEqual([]);
    });
  });

  describe('getFreshnessToken', () => {
    it('throws when providerSessionId is absent', async () => {
      await expect(adapter.getFreshnessToken(ref())).rejects.toThrow(ValidationError);
    });
  });

  describe('parseFullSession', () => {
    it('throws when sourceRef lacks providerSessionId', async () => {
      await expect(adapter.parseFullSession(DB_PATH)).rejects.toThrow(ValidationError);
    });

    it('module-unit: summary metrics match the DB-backed full read', async () => {
      const session = makeSession({ metrics: { messageCount: 7 } as never });
      reader.readSession.mockReturnValue({ session, sizeBytes: 10, freshness: {} });
      reader.readSummary.mockReturnValue({ metrics: session.metrics });
      const sourceRef = ref({ providerSessionId: 'ses_1' });

      const full = await adapter.parseFullSession(DB_PATH, sourceRef);
      const summary = await adapter.getSummary(sourceRef);

      expect(summary?.metrics).toEqual(full.metrics);
      expect(reader.readSummary).toHaveBeenCalledWith(DB_PATH, 'ses_1');
      expect(reader.readSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('parseIncremental', () => {
    it('snapshot mode: returns the full session as entries', async () => {
      const session = makeSession({
        messages: [{ id: 'm1' } as never, { id: 'm2' } as never],
        warnings: ['w'],
      });
      reader.readSession.mockReturnValue({
        session,
        sizeBytes: 42,
        freshness: { count: 2, maxUpdated: 5 },
      });

      const result = await adapter.parseIncremental(
        DB_PATH,
        { byteOffset: 0 },
        ref({ providerSessionId: 'ses_1' }),
      );

      expect(result.hasMore).toBe(false);
      expect(result.nextByteOffset).toBe(42);
      expect(result.messageCount).toBe(2);
      expect(result.entries).toBe(session.messages);
      expect(result.metrics).toBe(session.metrics);
      expect(result.warnings).toEqual(['w']);
    });
  });

  it('parseSessionFile is unsupported (DB needs a providerSessionId)', async () => {
    await expect(adapter.parseSessionFile(DB_PATH)).rejects.toThrow(ValidationError);
  });

  it('getWatchPaths returns the WAL sidecar as a wake hint', () => {
    expect(adapter.getWatchPaths('/proj')).toEqual([`${DB_PATH}-wal`]);
  });

  describe('calculateCost', () => {
    it('sums token-only cost over entries with usage', () => {
      const pricing = makePricing();
      const a = new OpenCodeSessionReaderAdapter(pricing);
      const entries = [
        { usage: { input: 10, output: 5, cacheRead: 1, cacheCreation: 0 } },
        { usage: { input: 20, output: 8, cacheRead: 2, cacheCreation: 1 } },
        {}, // no usage → skipped
      ];
      const cost = a.calculateCost(entries, 'glm-5.1');
      expect(pricing.calculateMessageCost).toHaveBeenCalledTimes(2);
      expect(pricing.calculateMessageCost).toHaveBeenNthCalledWith(1, 'glm-5.1', 10, 5, 1, 0);
      expect(cost).toBeCloseTo(0.02);
    });
  });
});
