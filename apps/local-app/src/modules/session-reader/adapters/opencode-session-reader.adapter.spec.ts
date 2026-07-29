import * as os from 'node:os';
import * as path from 'node:path';
import { OpenCodeSessionReaderAdapter } from './opencode-session-reader.adapter';
import { OpencodeSqliteReader } from '../readers/opencode-sqlite.reader';
import { ValidationError } from '../../../common/errors/error-types';
import type { PricingServiceInterface } from '../services/pricing.interface';
import type { SessionSourceRef } from './session-reader-adapter.interface';
import type { UnifiedSession } from '../dtos/unified-session.types';

jest.mock('../readers/opencode-sqlite.reader', () => ({
  OpencodeSqliteReader: jest.fn().mockImplementation(() => ({
    findSessionCandidates: jest.fn(),
    getFreshness: jest.fn(),
    readSession: jest.fn(),
    readSummary: jest.fn(),
  })),
}));

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
  let reader: {
    findSessionCandidates: jest.Mock;
    getFreshness: jest.Mock;
    readSession: jest.Mock;
    readSummary: jest.Mock;
  };

  beforeEach(() => {
    (OpencodeSqliteReader as unknown as jest.Mock).mockClear();
    adapter = new OpenCodeSessionReaderAdapter(makePricing());
    reader = (OpencodeSqliteReader as unknown as jest.Mock).mock.results[0].value;
  });

  it('declares DB-backed snapshot identity', () => {
    expect(adapter.providerName).toBe('opencode');
    expect(adapter.incrementalMode).toBe('snapshot');
    expect(adapter.sourceKind).toBe('db');
    expect(adapter.allowedRoots).toEqual([path.join(os.homedir(), '.local/share/opencode')]);
  });

  describe('discoverSessionFile', () => {
    it('SQL-matches candidates and maps them to SessionFileInfo (one per ses_)', async () => {
      reader.findSessionCandidates.mockReturnValue([
        { providerSessionId: 'ses_1', directory: '/proj', timeCreated: 100, timeUpdated: 200 },
        { providerSessionId: 'ses_2', directory: '/proj', timeCreated: 150, timeUpdated: 250 },
      ]);

      const result = await adapter.discoverSessionFile({
        projectRoot: '/proj',
        sessionStartedAt: new Date(120),
        sessionId: 'dc-1',
      });

      expect(reader.findSessionCandidates).toHaveBeenCalledWith(DB_PATH, {
        directory: path.resolve('/proj'),
        startedAtMs: 120,
        windowMs: 120_000,
      });
      expect(result).toEqual([
        expect.objectContaining({
          filePath: DB_PATH,
          providerName: 'opencode',
          providerSessionId: 'ses_1',
        }),
        expect.objectContaining({ providerSessionId: 'ses_2' }),
      ]);
    });

    it('returns [] when sessionStartedAt is missing (cannot window-match)', async () => {
      const result = await adapter.discoverSessionFile({ projectRoot: '/proj' });
      expect(result).toEqual([]);
      expect(reader.findSessionCandidates).not.toHaveBeenCalled();
    });

    it('returns [] (retryable) when the candidate query throws (e.g. DB absent)', async () => {
      reader.findSessionCandidates.mockImplementation(() => {
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
    it('returns the reader freshness for the providerSessionId', async () => {
      reader.getFreshness.mockReturnValue({ count: 5, maxUpdated: 999 });
      const token = await adapter.getFreshnessToken(ref({ providerSessionId: 'ses_1' }));
      expect(token).toEqual({ count: 5, maxUpdated: 999 });
      expect(reader.getFreshness).toHaveBeenCalledWith(DB_PATH, 'ses_1');
    });

    it('throws when providerSessionId is absent', async () => {
      await expect(adapter.getFreshnessToken(ref())).rejects.toThrow(ValidationError);
    });
  });

  describe('parseFullSession', () => {
    it('reads the session located by sourceRef.providerSessionId', async () => {
      const session = makeSession();
      reader.readSession.mockReturnValue({
        session,
        sizeBytes: 10,
        freshness: { count: 1, maxUpdated: 1 },
      });

      const result = await adapter.parseFullSession(DB_PATH, ref({ providerSessionId: 'ses_1' }));

      expect(result).toBe(session);
      expect(reader.readSession).toHaveBeenCalledWith(DB_PATH, 'ses_1');
    });

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
      (OpencodeSqliteReader as unknown as jest.Mock).mockClear();
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
