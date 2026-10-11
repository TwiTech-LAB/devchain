import { Test, type TestingModule } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { DB_CONNECTION } from '../db/db.provider';
import { SessionRowStore } from './session-row.store';
import { SessionRowsModule } from './session-rows.module';
import type { TranscriptBackfillInput } from './session-transcript.types';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const UPDATED_AT = '2026-01-01T00:01:00.000Z';
const TRANSCRIPT_PATH = '/tmp/transcripts/session.jsonl';
const input = {
  sessionId: 'session',
  transcriptPath: TRANSCRIPT_PATH,
  providerSessionId: 'native-id',
  updatedAt: UPDATED_AT,
};
const repairInput: TranscriptBackfillInput = {
  ...input,
  providerName: 'codex',
  normalizedTranscriptPath: TRANSCRIPT_PATH,
};

// Real SQLite verifies conditional updates, container identity and rollback without SQL mocks.
describe('SessionRowStore transcript operations', () => {
  let sqlite: Database.Database;
  let module: TestingModule;
  let store: SessionRowStore;

  function seed(
    id = 'session',
    transcriptPath: string | null = null,
    providerSessionId: string | null = null,
    providerName: string | null = 'codex',
  ): void {
    sqlite
      .prepare(
        `INSERT INTO sessions
           (id, status, started_at, transcript_path, provider_session_id,
            provider_name_at_launch, created_at, updated_at)
         VALUES (?, 'running', ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, CREATED_AT, transcriptPath, providerSessionId, providerName, CREATED_AT, CREATED_AT);
  }

  function read(id = 'session') {
    return sqlite
      .prepare('SELECT transcript_path, provider_session_id, updated_at FROM sessions WHERE id = ?')
      .get(id);
  }

  beforeEach(async () => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    module = await Test.createTestingModule({ imports: [SessionRowsModule] })
      .overrideProvider(DB_CONNECTION)
      .useValue(database.db)
      .compile();
    store = module.get(SessionRowStore);
  });

  afterEach(async () => {
    await module.close();
    sqlite.close();
  });

  it('reads only transcript metadata and returns undefined for a missing session', () => {
    seed('session', TRANSCRIPT_PATH, 'native-id');
    expect(store.getTranscriptMetadata('session')).toStrictEqual({
      transcript_path: TRANSCRIPT_PATH,
      provider_session_id: 'native-id',
    });
    expect(store.getTranscriptMetadata('missing')).toBeUndefined();
  });

  it.each([true, false])('keeps hook binding one synchronous statement (existing=%s)', (exists) => {
    seed('untouched', '/tmp/untouched', 'other-id');
    if (exists) seed('session', '/tmp/previous', 'previous-id');
    const untouched = read('untouched');
    const exec = jest.spyOn(sqlite, 'exec');
    const changes = store.bindTranscriptFromHook(input);
    expect(changes).toBe(exists ? 1 : 0);
    expect(read()).toStrictEqual(
      exists
        ? {
            transcript_path: TRANSCRIPT_PATH,
            provider_session_id: 'native-id',
            updated_at: UPDATED_AT,
          }
        : undefined,
    );
    expect(read('untouched')).toStrictEqual(untouched);
    expect(exec).not.toHaveBeenCalled();
    exec.mockRestore();
  });

  it.each(['native-id', null])(
    'binds a new path with provider id %s',
    async (providerSessionId) => {
      seed();
      expect(await store.bindDiscoveredTranscript({ ...input, providerSessionId })).toStrictEqual({
        kind: 'bound',
      });
      expect(read()).toStrictEqual({
        transcript_path: TRANSCRIPT_PATH,
        provider_session_id: providerSessionId,
        updated_at: UPDATED_AT,
      });
      expect(sqlite.inTransaction).toBe(false);
    },
  );

  it('does not create a missing session while binding', async () => {
    expect(await store.bindDiscoveredTranscript(input)).toStrictEqual({ kind: 'sessionNotFound' });
    expect(read()).toBeUndefined();
  });

  it.each([TRANSCRIPT_PATH, '/tmp/different.jsonl'])(
    'defers an existing path %s to backfill',
    async (storedPath) => {
      seed('session', storedPath);
      const before = read();
      expect(await store.bindDiscoveredTranscript(input)).toStrictEqual({ kind: 'needsBackfill' });
      expect(read()).toStrictEqual(before);
    },
  );

  it.each([
    { otherPath: TRANSCRIPT_PATH, otherId: 'native-id', blocked: true },
    { otherPath: TRANSCRIPT_PATH, otherId: 'different-id', blocked: false },
    { otherPath: '/tmp/another-container.db', otherId: 'native-id', blocked: false },
  ])(
    'checks container and provider identity together ($otherPath, $otherId)',
    async ({ otherPath, otherId, blocked }) => {
      seed();
      seed('other', otherPath, otherId);
      const otherBefore = read('other');
      expect(await store.bindDiscoveredTranscript(input)).toStrictEqual(
        blocked
          ? { kind: 'providerSessionIdTaken', conflictingSessionId: 'other' }
          : { kind: 'bound' },
      );
      expect(read()).toStrictEqual({
        transcript_path: blocked ? null : TRANSCRIPT_PATH,
        provider_session_id: blocked ? null : 'native-id',
        updated_at: blocked ? CREATED_AT : UPDATED_AT,
      });
      expect(read('other')).toStrictEqual(otherBefore);
    },
  );

  it.each(['codex', 'CODEX', null])(
    'repairs a null provider id for launch provider %s',
    async (providerName) => {
      seed('session', '/tmp/transcripts/../transcripts/session.jsonl', null, providerName);
      expect(await store.backfillTranscriptProviderSessionId(repairInput)).toStrictEqual({
        kind: 'backfilledId',
        sessionId: 'session',
      });
      expect(read()).toStrictEqual({
        transcript_path: '/tmp/transcripts/../transcripts/session.jsonl',
        provider_session_id: 'native-id',
        updated_at: UPDATED_AT,
      });
    },
  );

  it.each([
    {
      name: 'missing row',
      exists: false,
      path: null,
      id: null,
      provider: 'codex',
      incomingId: 'native-id',
      outcome: { kind: 'skipped', sessionId: 'session', reason: 'sessionNotFound' },
    },
    {
      name: 'no path',
      exists: true,
      path: null,
      id: null,
      provider: 'codex',
      incomingId: 'native-id',
      outcome: { kind: 'skipped', sessionId: 'session', reason: 'noTranscriptPath' },
    },
    {
      name: 'different path',
      exists: true,
      path: '/tmp/different',
      id: null,
      provider: 'codex',
      incomingId: 'native-id',
      outcome: {
        kind: 'pathMismatch',
        sessionId: 'session',
        existing: '/tmp/different',
        incoming: TRANSCRIPT_PATH,
      },
    },
    {
      name: 'complete metadata',
      exists: true,
      path: TRANSCRIPT_PATH,
      id: 'existing-id',
      provider: 'codex',
      incomingId: 'native-id',
      outcome: { kind: 'alreadyComplete', sessionId: 'session' },
    },
    {
      name: 'no id available',
      exists: true,
      path: TRANSCRIPT_PATH,
      id: null,
      provider: 'codex',
      incomingId: null,
      outcome: { kind: 'noIdAvailable' },
    },
    {
      name: 'provider mismatch',
      exists: true,
      path: TRANSCRIPT_PATH,
      id: null,
      provider: 'claude',
      incomingId: 'native-id',
      outcome: { kind: 'skipped', sessionId: 'session', reason: 'providerMismatch' },
    },
    {
      name: 'non-null empty id',
      exists: true,
      path: TRANSCRIPT_PATH,
      id: '',
      provider: 'codex',
      incomingId: 'native-id',
      outcome: { kind: 'alreadyComplete', sessionId: 'session' },
    },
  ])('leaves metadata unchanged on backfill: $name', async (testCase) => {
    if (testCase.exists) seed('session', testCase.path, testCase.id, testCase.provider);
    const before = read();
    expect(
      await store.backfillTranscriptProviderSessionId({
        ...repairInput,
        providerSessionId: testCase.incomingId,
      }),
    ).toStrictEqual(testCase.outcome);
    expect(read()).toStrictEqual(before);
    expect(sqlite.inTransaction).toBe(false);
  });

  it.each(['bind', 'backfill'])(
    'rolls back all writes after a failing %s statement',
    async (operation) => {
      seed('session', operation === 'backfill' ? TRANSCRIPT_PATH : null);
      seed('other');
      const before = [read(), read('other')];
      // RAISE(FAIL) leaves statement changes in place; the runner must roll the transaction back.
      sqlite.exec(`CREATE TRIGGER fail_transcript_update AFTER UPDATE ON sessions
      WHEN NEW.id = 'session'
      BEGIN
        UPDATE sessions SET provider_session_id = 'partial-side-effect' WHERE id = 'other';
        SELECT RAISE(FAIL, 'injected transcript failure');
      END`);
      const mutation =
        operation === 'bind'
          ? store.bindDiscoveredTranscript(input)
          : store.backfillTranscriptProviderSessionId(repairInput);
      await expect(mutation).rejects.toThrow('injected transcript failure');
      expect([read(), read('other')]).toStrictEqual(before);
      expect(sqlite.inTransaction).toBe(false);
    },
  );
});
