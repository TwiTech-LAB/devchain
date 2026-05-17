import { Logger } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as fs from 'node:fs/promises';
import { CodexSessionReaderAdapter } from '../adapters/codex-session-reader.adapter';
import {
  CodexProviderSessionIdBackfillService,
  type CodexProviderSessionIdBackfillResult,
} from './codex-provider-session-id-backfill.service';
import { TranscriptPersistenceListener } from './transcript-persistence.listener';

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
}));

const mockAccess = fs.access as jest.MockedFunction<typeof fs.access>;

interface BackfillRow {
  id: string;
  transcript_path: string;
}

function createMockDb(rows: BackfillRow[]) {
  const mockAll = jest.fn().mockReturnValue(rows);
  const mockPrepare = jest.fn().mockReturnValue({ all: mockAll });
  const mockDb = {
    session: {
      client: {
        prepare: mockPrepare,
      },
    },
  } as unknown as BetterSQLite3Database;

  return { mockDb, mockAll, mockPrepare };
}

function createService(rows: BackfillRow[]) {
  const db = createMockDb(rows);
  const adapter = {
    extractProviderSessionIdFromFile: jest.fn(),
  } as unknown as jest.Mocked<Pick<CodexSessionReaderAdapter, 'extractProviderSessionIdFromFile'>>;
  const transcriptPersistence = {
    backfillProviderSessionIdForTranscriptPath: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<TranscriptPersistenceListener, 'backfillProviderSessionIdForTranscriptPath'>
  >;

  const service = new CodexProviderSessionIdBackfillService(
    db.mockDb,
    adapter as unknown as CodexSessionReaderAdapter,
    transcriptPersistence as unknown as TranscriptPersistenceListener,
  );

  return { service, db, adapter, transcriptPersistence };
}

describe('CodexProviderSessionIdBackfillService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
  });

  it('repairs valid rows, counts missing and malformed files, and emits no events', async () => {
    const rows = [
      { id: 'valid-session', transcript_path: '/tmp/valid.jsonl' },
      { id: 'missing-session', transcript_path: '/tmp/missing.jsonl' },
      { id: 'malformed-session', transcript_path: '/tmp/malformed.jsonl' },
    ];
    const { service, adapter, transcriptPersistence } = createService(rows);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    adapter.extractProviderSessionIdFromFile
      .mockResolvedValueOnce('codex-session-1')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockAccess.mockImplementation(async (filePath) => {
      if (filePath === '/tmp/missing.jsonl') {
        const error = new Error('missing') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return undefined;
    });
    transcriptPersistence.backfillProviderSessionIdForTranscriptPath.mockResolvedValue({
      kind: 'backfilledId',
      sessionId: 'valid-session',
    });

    try {
      const result = await service.runBackfill();

      expect(result).toEqual({
        status: 'completed',
        scanned: 3,
        repaired: 1,
        missingFile: 1,
        parseFailed: 1,
      });
      expect(transcriptPersistence.backfillProviderSessionIdForTranscriptPath).toHaveBeenCalledWith(
        {
          sessionId: 'valid-session',
          providerName: 'codex',
          transcriptPath: '/tmp/valid.jsonl',
          providerSessionId: 'codex-session-1',
          emitEvent: false,
        },
      );
      expect(
        transcriptPersistence.backfillProviderSessionIdForTranscriptPath,
      ).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        { transcriptPath: '/tmp/missing.jsonl' },
        'Codex transcript missing on disk for provider session id backfill',
      );
      expect(warnSpy).toHaveBeenCalledWith(
        { sessionId: 'malformed-session', transcriptPath: '/tmp/malformed.jsonl' },
        'Failed to parse Codex provider session id for backfill',
      );
      expect(logSpy).toHaveBeenCalledWith(
        { scanned: 3, repaired: 1, missingFile: 1, parseFailed: 1 },
        'Codex provider session id backfill complete',
      );
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('stays silent when there are no rows to backfill', async () => {
    const { service } = createService([]);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    try {
      await expect(service.runBackfill()).resolves.toEqual({
        status: 'completed',
        scanned: 0,
        repaired: 0,
        missingFile: 0,
        parseFailed: 0,
      });
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('is idempotent when a second invocation has no matching rows', async () => {
    const { service, db, adapter, transcriptPersistence } = createService([
      { id: 'valid-session', transcript_path: '/tmp/valid.jsonl' },
    ]);
    db.mockAll.mockReturnValueOnce([{ id: 'valid-session', transcript_path: '/tmp/valid.jsonl' }]);
    db.mockAll.mockReturnValueOnce([]);
    adapter.extractProviderSessionIdFromFile.mockResolvedValue('codex-session-1');
    transcriptPersistence.backfillProviderSessionIdForTranscriptPath.mockResolvedValue({
      kind: 'backfilledId',
      sessionId: 'valid-session',
    });

    await service.runBackfill();
    await service.runBackfill();

    expect(transcriptPersistence.backfillProviderSessionIdForTranscriptPath).toHaveBeenCalledTimes(
      1,
    );
  });

  it('uses an in-process mutex to skip overlapping runs', async () => {
    const { service, adapter, transcriptPersistence } = createService([
      { id: 'valid-session', transcript_path: '/tmp/valid.jsonl' },
    ]);
    transcriptPersistence.backfillProviderSessionIdForTranscriptPath.mockResolvedValue({
      kind: 'backfilledId',
      sessionId: 'valid-session',
    });
    let resolveExtract: (value: string) => void = () => undefined;
    adapter.extractProviderSessionIdFromFile.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveExtract = resolve;
        }),
    );

    const firstRun = service.runBackfill();
    const secondRun = await service.runBackfill();
    resolveExtract('codex-session-1');
    await firstRun;

    expect(secondRun).toEqual({
      status: 'already_running',
      scanned: 0,
      repaired: 0,
      missingFile: 0,
      parseFailed: 0,
    });
  });

  it('schedules bootstrap backfill without awaiting it', async () => {
    const { service } = createService([]);
    const result: CodexProviderSessionIdBackfillResult = {
      status: 'completed',
      scanned: 0,
      repaired: 0,
      missingFile: 0,
      parseFailed: 0,
    };
    const runSpy = jest.spyOn(service, 'runBackfill').mockResolvedValue(result);

    service.onApplicationBootstrap();
    expect(runSpy).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runSpy).toHaveBeenCalledTimes(1);
  });
});
