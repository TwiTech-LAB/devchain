import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { createMockAgent, createMockProject, createMockProvider } from '../../../../test/factories';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import { SessionRowStore } from '../../storage/sessions/session-row.store';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { EventsService } from '../../events/services/events.service';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { TranscriptPersistenceListener } from './transcript-persistence.listener';

const SESSION_ID = 'session-contention';
const TRANSCRIPT_PATH = '/tmp/transcript-contention/opencode.db';
const PROVIDER_SESSION_ID = 'ses_contention';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// Real SQLite is required to catch competing BEGIN statements; a fake client cannot reproduce it.
describe('TranscriptPersistenceListener transaction contention', () => {
  let sqlite: Database.Database;
  let module: TestingModule;
  let listener: TranscriptPersistenceListener;
  let publish: jest.Mock;
  let publishedInTransaction: boolean[];

  const agent = createMockAgent();
  const project = createMockProject({ id: agent.projectId });
  const provider = createMockProvider({ name: 'opencode' });

  beforeEach(async () => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    publishedInTransaction = [];
    publish = jest.fn().mockImplementation(async () => {
      publishedInTransaction.push(sqlite.inTransaction);
      return 'event-id';
    });

    module = await Test.createTestingModule({
      providers: [
        SessionRowStore,
        TranscriptPersistenceListener,
        { provide: DB_CONNECTION, useValue: database.db },
        {
          provide: TranscriptPathValidator,
          useValue: { validateShape: jest.fn().mockReturnValue(TRANSCRIPT_PATH) },
        },
        { provide: EventsService, useValue: { publish } },
        {
          provide: SessionReaderAdapterFactory,
          useValue: {
            getAdapter: jest.fn().mockReturnValue({
              sourceKind: 'db',
              discoverSessionFile: jest.fn().mockResolvedValue([
                {
                  filePath: TRANSCRIPT_PATH,
                  providerName: provider.name,
                  providerSessionId: PROVIDER_SESSION_ID,
                  sizeBytes: 0,
                  lastModified: CREATED_AT,
                },
              ]),
            }),
          },
        },
        {
          provide: STORAGE_SERVICE,
          useValue: {
            getAgent: jest.fn().mockResolvedValue(agent),
            getProject: jest.fn().mockResolvedValue(project),
            getProvider: jest.fn().mockResolvedValue(provider),
            getProfileProviderConfig: jest.fn().mockResolvedValue({
              id: agent.providerConfigId,
              providerId: provider.id,
            }),
          },
        },
        { provide: ProviderAdapterFactory, useValue: { getAdapter: jest.fn() } },
      ],
    }).compile();
    listener = module.get(TranscriptPersistenceListener);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await module.close();
    sqlite.close();
  });

  it.each([
    {
      operation: 'bind',
      initialTranscriptPath: null,
      eventName: 'session.transcript.discovered',
      logMessage: 'Auto-discovered and persisted transcript path',
    },
    {
      operation: 'backfill',
      initialTranscriptPath: TRANSCRIPT_PATH,
      eventName: 'session.providerSessionId.discovered',
      logMessage: 'Backfilled provider session id for discovered transcript',
    },
    {
      operation: 'bindBackfill',
      initialTranscriptPath: TRANSCRIPT_PATH,
      eventName: 'session.providerSessionId.discovered',
      logMessage: 'Backfilled provider session id for discovered transcript',
    },
  ])(
    'waits for an unrelated async transaction before committing a $operation',
    async (testCase) => {
      sqlite
        .prepare(
          `INSERT INTO sessions
           (id, status, started_at, transcript_path, provider_name_at_launch, created_at, updated_at)
         VALUES (?, 'running', ?, ?, ?, ?, ?)`,
        )
        .run(
          SESSION_ID,
          CREATED_AT,
          testCase.initialTranscriptPath,
          provider.name,
          CREATED_AT,
          CREATED_AT,
        );
      const readSession = () =>
        sqlite
          .prepare('SELECT transcript_path, provider_session_id FROM sessions WHERE id = ?')
          .get(SESSION_ID);
      const exec = jest.spyOn(sqlite, 'exec');
      const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const successLog = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const started = deferred();
      const release = deferred();
      const holder = new TransactionRunner(sqlite);
      const held = holder.runImmediateAsync(async () => {
        started.resolve();
        await release.promise;
      });
      await started.promise;

      // Start outside the holder's callback so the listener owns a sibling async context.
      const mutation =
        testCase.operation !== 'backfill'
          ? listener.handleSessionStarted({
              sessionId: SESSION_ID,
              agentId: agent.id,
              projectId: project.id,
              epicId: null,
              tmuxSessionName: 'contention-session',
            })
          : listener.backfillProviderSessionIdForTranscriptPath({
              sessionId: SESSION_ID,
              providerName: provider.name,
              transcriptPath: TRANSCRIPT_PATH,
              providerSessionId: PROVIDER_SESSION_ID,
            });
      let settled = false;
      let failure: unknown;
      const completion = mutation.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          failure = error;
          settled = true;
        },
      );

      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sqlite.inTransaction).toBe(true);
        expect(settled).toBe(false);
        expect(readSession()).toEqual({
          transcript_path: testCase.initialTranscriptPath,
          provider_session_id: null,
        });
        expect(publish).not.toHaveBeenCalled();
        expect(successLog).not.toHaveBeenCalled();
        expect(errorLog).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.all([held, completion]);
      }

      expect(failure).toBeUndefined();
      expect(sqlite.inTransaction).toBe(false);
      expect(readSession()).toEqual({
        transcript_path: TRANSCRIPT_PATH,
        provider_session_id: PROVIDER_SESSION_ID,
      });
      expect(exec.mock.calls).toEqual([
        ['BEGIN IMMEDIATE'],
        ['COMMIT'],
        ['BEGIN IMMEDIATE'],
        ['COMMIT'],
        ...(testCase.operation === 'bindBackfill' ? [['BEGIN IMMEDIATE'], ['COMMIT']] : []),
      ]);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith(
        testCase.eventName,
        expect.objectContaining({
          sessionId: SESSION_ID,
          providerName: provider.name,
          providerSessionId: PROVIDER_SESSION_ID,
        }),
      );
      expect(publishedInTransaction).toEqual([false]);
      expect(successLog).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION_ID }),
        testCase.logMessage,
      );
      expect(successLog.mock.invocationCallOrder[0]).toBeGreaterThan(
        exec.mock.invocationCallOrder.at(-1)!,
      );
      expect(errorLog).not.toHaveBeenCalled();
    },
  );
});
