import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  StorageError,
  ValidationError,
} from '../../../common/errors/error-types';
import type {
  Epic,
  ExternalEstimateLogIdentity,
  IntegrationConnection,
} from '../models/domain.models';
import { IntegrationCredentialCipher } from './integration-credential-cipher';
import { LocalStorageService } from './local-storage.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');

describe('LocalStorageService external estimate log states', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let secretDirectory: string;
  let epic: Epic;
  let connection: IntegrationConnection;
  let identity: ExternalEstimateLogIdentity;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-estimate-log-'));
    storage = new LocalStorageService(
      drizzle(sqlite),
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'test-host:test-user',
      }),
    );

    const project = await storage.createProject({
      name: 'Estimate checkpoint project',
      description: null,
      rootPath: '/tmp/estimate-checkpoint-project',
    });
    connection = await storage.replaceIntegrationConnection(
      {
        projectId: project.id,
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'test@example.com',
          token: 'test-token',
        },
      },
      async () => undefined,
    );
    const statuses = await storage.listStatuses(project.id);
    epic = await storage.createEpic({
      projectId: project.id,
      title: 'Imported estimate source',
      statusId: statuses.items[0]!.id,
    });
    identity = {
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'ENG-1',
    };
    await storage.createExternalTaskLink({
      epicId: epic.id,
      connectionId: connection.id,
      ...identity,
      sourceSnapshot: { title: 'Remote task' },
    });
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  const prepare = (operationId: string, expectedRevision: number, deltaMinutes = 30) =>
    storage.prepareExternalEstimateLogOperation({
      ...identity,
      operationId,
      deltaMinutes,
      estimateTotalMinutes: 120,
      startedAt: '2026-08-30T10:00:00.000Z',
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      expectedRevision,
      activityDate: null,
      aggregationTimeZone: null,
      capturedDailyTotals: [],
    });

  // Real SQLite is the cheapest layer that exercises constraints, CAS predicates,
  // TransactionRunner admission, and link-deletion behavior together.
  it('lists link and checkpoint authority candidates by provider and remote task', async () => {
    await expect(storage.listExternalTaskLinksByRemoteTask('jira', 'ENG-1')).resolves.toEqual([
      expect.objectContaining({
        connectionId: connection.id,
        remoteScopeKey: identity.remoteScopeKey,
        remoteTaskId: identity.remoteTaskId,
      }),
    ]);
    await expect(
      storage.listExternalEstimateLogStatesByRemoteTask('jira', 'ENG-1'),
    ).resolves.toEqual([]);

    await prepare('authority-operation', 0, 30);

    await expect(
      storage.listExternalEstimateLogStatesByRemoteTask('jira', 'ENG-1'),
    ).resolves.toEqual([
      expect.objectContaining({
        remoteScopeKey: identity.remoteScopeKey,
        pendingOperationId: 'authority-operation',
        pendingConnectionId: connection.id,
      }),
    ]);
    await expect(storage.listExternalTaskLinksByRemoteTask('jira', 'OTHER-1')).resolves.toEqual([]);
  });

  it('orders scope keys and isolates provider and task in one admission snapshot', async () => {
    await storage.createExternalTaskLink({
      epicId: epic.id,
      connectionId: connection.id,
      provider: 'jira',
      remoteScopeKey: 'zeta.atlassian.net',
      remoteTaskId: 'ENG-1',
      sourceSnapshot: { title: 'Remote task Z' },
    });
    await storage.createExternalTaskLink({
      epicId: epic.id,
      connectionId: connection.id,
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'ENG-9',
      sourceSnapshot: { title: 'Remote task nine' },
    });
    // Seed out of scope-key order so the ordering assertion cannot pass by
    // insertion accident. The zeta scope keeps an empty dated ledger, so its
    // missing day rows must read as a zero sum.
    await storage.setExternalEstimateLoggedMinutes({
      provider: 'jira',
      remoteScopeKey: 'zeta.atlassian.net',
      remoteTaskId: 'ENG-1',
      loggedMinutes: 40,
      expectedRevision: 0,
      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    await storage.setExternalEstimateLoggedMinutes({
      provider: 'jira',
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'ENG-9',
      loggedMinutes: 70,
      expectedRevision: 0,
      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    await storage.setExternalEstimateLoggedMinutes({
      ...identity,
      loggedMinutes: 25,
      expectedRevision: 0,
      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    sqlite
      .prepare(
        `INSERT INTO external_estimate_log_states
           (provider, remote_scope_key, remote_task_id, logged_minutes, revision,
            pending_operation_id, created_at, updated_at)
         VALUES ('clickup', 'acme.atlassian.net', 'ENG-1', 10, 1, NULL, 'created', 'updated')`,
      )
      .run();

    await expect(
      storage.listExternalEstimateLogStatesByRemoteTask('jira', 'ENG-1'),
    ).resolves.toEqual([
      expect.objectContaining({
        provider: 'jira',
        remoteScopeKey: 'acme.atlassian.net',
        remoteTaskId: 'ENG-1',
        loggedMinutes: 25,
      }),
      expect.objectContaining({
        provider: 'jira',
        remoteScopeKey: 'zeta.atlassian.net',
        remoteTaskId: 'ENG-1',
        loggedMinutes: 40,
      }),
    ]);
  });

  it('uses row absence as revision zero and sets exact logged minutes with CAS', async () => {
    await expect(storage.getExternalEstimateLogState(identity)).resolves.toBeNull();

    const initialized = await storage.setExternalEstimateLoggedMinutes({
      ...identity,
      loggedMinutes: 90,
      expectedRevision: 0,

      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    expect(initialized).toMatchObject({
      ...identity,
      loggedMinutes: 90,
      revision: 1,
      pendingOperationId: null,
    });

    await expect(
      storage.setExternalEstimateLoggedMinutes({
        ...identity,
        loggedMinutes: 100,
        expectedRevision: 0,

        aggregationTimeZone: null,
        currentDailyTotals: [],
      }),
    ).rejects.toBeInstanceOf(OptimisticLockError);
    const adjusted = await storage.setExternalEstimateLoggedMinutes({
      ...identity,
      loggedMinutes: 100,
      expectedRevision: 1,

      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    expect(adjusted).toMatchObject({ loggedMinutes: 100, revision: 2 });
  });

  it('rejects invalid deltas, stale revisions, and a second pending operation', async () => {
    await expect(prepare('zero-operation', 0, 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(prepare('over-limit-operation', 0, 10_081)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(storage.getExternalEstimateLogState(identity)).resolves.toBeNull();

    await storage.setExternalEstimateLoggedMinutes({
      ...identity,
      loggedMinutes: 90,
      expectedRevision: 0,

      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    await expect(prepare('stale-operation', 0)).rejects.toBeInstanceOf(OptimisticLockError);

    const pending = await prepare('operation-1', 1);
    expect(pending).toMatchObject({
      revision: 2,
      pendingOperationId: 'operation-1',
      pendingDeltaMinutes: 30,
      pendingPhase: 'prepared',
    });
    await expect(prepare('operation-2', 2)).rejects.toBeInstanceOf(ConflictError);
    await expect(
      storage.setExternalEstimateLoggedMinutes({
        ...identity,
        loggedMinutes: 120,
        expectedRevision: 2,

        aggregationTimeZone: null,
        currentDailyTotals: [],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('serializes competing prepares so exactly one operation wins', async () => {
    const attempts = await Promise.allSettled([
      prepare('operation-a', 0, 20),
      prepare('operation-b', 0, 25),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(await storage.getExternalEstimateLogState(identity)).toMatchObject({
      revision: 1,
      pendingOperationId: expect.stringMatching(/^operation-[ab]$/),
    });
  });

  it('confirms or clears an exact pending delta only once', async () => {
    await storage.setExternalEstimateLoggedMinutes({
      ...identity,
      loggedMinutes: 90,
      expectedRevision: 0,

      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    await prepare('operation-confirm', 1, 30);
    const confirmed = await storage.confirmExternalEstimateLogOperation({
      ...identity,
      operationId: 'operation-confirm',
      expectedRevision: 2,
    });
    expect(confirmed).toMatchObject({
      loggedMinutes: 120,
      revision: 3,
      pendingOperationId: null,
    });
    await expect(
      storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-confirm',
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({ loggedMinutes: 120, revision: 3 });

    await prepare('operation-clear', 3, 15);
    const cleared = await storage.clearExternalEstimateLogOperation({
      ...identity,
      operationId: 'operation-clear',
      expectedRevision: 4,
    });
    expect(cleared).toMatchObject({
      loggedMinutes: 120,
      revision: 5,
      pendingOperationId: null,
    });
  });

  it('lets exact terminal settlement override either conflicting stored choice', async () => {
    await prepare('operation-exact-success', 0, 30);
    await storage.storeExternalEstimateLogResolution({
      ...identity,
      operationId: 'operation-exact-success',
      resolution: 'not_logged',
      expectedRevision: 1,
    });

    await expect(
      storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-exact-success',
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({ loggedMinutes: 30, revision: 3, pendingOperationId: null });

    await prepare('operation-exact-failure', 3, 20);
    await storage.storeExternalEstimateLogResolution({
      ...identity,
      operationId: 'operation-exact-failure',
      resolution: 'logged',
      expectedRevision: 4,
    });

    await expect(
      storage.clearExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-exact-failure',
        expectedRevision: 5,
      }),
    ).resolves.toMatchObject({ loggedMinutes: 30, revision: 6, pendingOperationId: null });
  });

  it('stores and idempotently applies both manual resolution choices', async () => {
    await prepare('operation-logged', 0, 45);
    const unknown = await storage.markExternalEstimateLogOperationOutcomeUnknown({
      ...identity,
      operationId: 'operation-logged',
      expectedRevision: 1,
    });
    expect(unknown).toMatchObject({ revision: 2, pendingPhase: 'outcome_unknown' });
    const storedLogged = await storage.storeExternalEstimateLogResolution({
      ...identity,
      operationId: 'operation-logged',
      resolution: 'logged',
      expectedRevision: 2,
    });
    expect(storedLogged).toMatchObject({ revision: 3, pendingResolution: 'logged' });
    const appliedLogged = await storage.applyExternalEstimateLogResolution({
      ...identity,
      operationId: 'operation-logged',
      expectedRevision: 3,
    });
    expect(appliedLogged).toMatchObject({ loggedMinutes: 45, revision: 4 });
    await expect(
      storage.applyExternalEstimateLogResolution({
        ...identity,
        operationId: 'operation-logged',
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({ loggedMinutes: 45, revision: 4 });

    await prepare('operation-not-logged', 4, 20);
    const storedNotLogged = await storage.storeExternalEstimateLogResolution({
      ...identity,
      operationId: 'operation-not-logged',
      resolution: 'not_logged',
      expectedRevision: 5,
    });
    expect(storedNotLogged).toMatchObject({ revision: 6, pendingResolution: 'not_logged' });
    const appliedNotLogged = await storage.applyExternalEstimateLogResolution({
      ...identity,
      operationId: 'operation-not-logged',
      expectedRevision: 6,
    });
    expect(appliedNotLogged).toMatchObject({
      loggedMinutes: 45,
      revision: 7,
      pendingOperationId: null,
    });
  });

  it('preserves checkpoint state across link deletion and recreation', async () => {
    await storage.setExternalEstimateLoggedMinutes({
      ...identity,
      loggedMinutes: 30,
      expectedRevision: 0,

      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    await storage.deleteEpic(epic.id);

    await expect(storage.getExternalEstimateLogState(identity)).resolves.toMatchObject({
      loggedMinutes: 30,
      revision: 1,
    });
    await expect(
      storage.setExternalEstimateLoggedMinutes({
        ...identity,
        loggedMinutes: 45,
        expectedRevision: 1,

        aggregationTimeZone: null,
        currentDailyTotals: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const statuses = await storage.listStatuses(epic.projectId);
    const recreatedEpic = await storage.createEpic({
      projectId: epic.projectId,
      title: 'Reimported estimate source',
      statusId: statuses.items[0]!.id,
    });
    await storage.createExternalTaskLink({
      epicId: recreatedEpic.id,
      connectionId: connection.id,
      ...identity,
      sourceSnapshot: { title: 'Remote task reimported' },
    });
    await expect(
      storage.setExternalEstimateLoggedMinutes({
        ...identity,
        loggedMinutes: 45,
        expectedRevision: 1,

        aggregationTimeZone: null,
        currentDailyTotals: [],
      }),
    ).resolves.toMatchObject({ loggedMinutes: 45, revision: 2 });
  });

  it('joins an outer storage transaction and rolls back the checkpoint with it', async () => {
    await expect(
      storage.runInTransaction(async () => {
        await storage.setExternalEstimateLoggedMinutes({
          ...identity,
          loggedMinutes: 90,
          expectedRevision: 0,

          aggregationTimeZone: null,
          currentDailyTotals: [],
        });
        throw new ValidationError('force outer rollback');
      }),
    ).rejects.toThrow('force outer rollback');

    await expect(storage.getExternalEstimateLogState(identity)).resolves.toBeNull();
  });

  describe('listExternalEstimateLoggedMinutes', () => {
    const scope = 'acme.atlassian.net';

    async function seedCheckpoint(remoteTaskId: string, loggedMinutes: number): Promise<void> {
      await storage.createExternalTaskLink({
        epicId: epic.id,
        connectionId: connection.id,
        provider: 'jira',
        remoteScopeKey: scope,
        remoteTaskId,
        sourceSnapshot: {},
      });
      await storage.setExternalEstimateLoggedMinutes({
        provider: 'jira',
        remoteScopeKey: scope,
        remoteTaskId,
        loggedMinutes,
        expectedRevision: 0,

        aggregationTimeZone: null,
        currentDailyTotals: [],
      });
    }

    // Real SQLite is the cheapest layer that proves the one-statement join:
    // the 1,000-identity bound, the remote-identity index lookup, and the
    // JSON seed only behave together against the actual database.
    it('returns every requested checkpoint row for a full 1,000-identity batch', async () => {
      const identities = Array.from({ length: 1_000 }, (_, index) => ({
        remoteScopeKey: scope,
        remoteTaskId: `BATCH-${index}`,
      }));
      for (const [index, { remoteTaskId }] of identities.entries()) {
        await seedCheckpoint(remoteTaskId, index);
      }

      await expect(storage.listExternalEstimateLoggedMinutes('jira', identities)).resolves.toEqual(
        identities
          .map(({ remoteTaskId }, index) => ({
            remoteScopeKey: scope,
            remoteTaskId,
            loggedMinutes: index,
          }))
          .sort((left, right) => left.remoteTaskId.localeCompare(right.remoteTaskId)),
      );
    });

    it('omits identities without rows and rejects batches above 1,000 identities', async () => {
      await seedCheckpoint('ENG-stored', 42);

      await expect(
        storage.listExternalEstimateLoggedMinutes('jira', [
          { remoteScopeKey: scope, remoteTaskId: 'ENG-stored' },
          { remoteScopeKey: scope, remoteTaskId: 'ENG-absent' },
        ]),
      ).resolves.toEqual([
        { remoteScopeKey: scope, remoteTaskId: 'ENG-stored', loggedMinutes: 42 },
      ]);

      const oversized = Array.from({ length: 1_001 }, (_, index) => ({
        remoteScopeKey: scope,
        remoteTaskId: `ENG-${index}`,
      }));
      await expect(
        storage.listExternalEstimateLoggedMinutes('jira', oversized),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(storage.listExternalEstimateLoggedMinutes('jira', [])).resolves.toEqual([]);
    });

    it('keeps providers isolated and collapses duplicate identities', async () => {
      await seedCheckpoint('ENG-duplicate', 15);
      const clickupConnection = await storage.replaceIntegrationConnection(
        {
          projectId: epic.projectId,
          provider: 'clickup',
          credentials: { provider: 'clickup', token: 'test-token' },
        },
        async () => undefined,
      );
      await storage.createExternalTaskLink({
        epicId: epic.id,
        connectionId: clickupConnection.id,
        provider: 'clickup',
        remoteScopeKey: scope,
        remoteTaskId: 'ENG-duplicate',
        sourceSnapshot: {},
      });
      await storage.setExternalEstimateLoggedMinutes({
        provider: 'clickup',
        remoteScopeKey: scope,
        remoteTaskId: 'ENG-duplicate',
        loggedMinutes: 99,
        expectedRevision: 0,

        aggregationTimeZone: null,
        currentDailyTotals: [],
      });

      await expect(
        storage.listExternalEstimateLoggedMinutes('jira', [
          { remoteScopeKey: scope, remoteTaskId: 'ENG-duplicate' },
          { remoteScopeKey: scope, remoteTaskId: 'ENG-duplicate' },
        ]),
      ).resolves.toEqual([
        { remoteScopeKey: scope, remoteTaskId: 'ENG-duplicate', loggedMinutes: 15 },
      ]);
      await expect(
        storage.listExternalEstimateLoggedMinutes('clickup', [
          { remoteScopeKey: scope, remoteTaskId: 'ENG-duplicate' },
        ]),
      ).resolves.toEqual([
        { remoteScopeKey: scope, remoteTaskId: 'ENG-duplicate', loggedMinutes: 99 },
      ]);
    });

    it('probes the full remote-identity index once per input row', async () => {
      await seedCheckpoint('ENG-plan', 12);
      const prepareSpy = jest.spyOn(sqlite, 'prepare');
      await storage.listExternalEstimateLoggedMinutes('jira', [
        { remoteScopeKey: scope, remoteTaskId: 'ENG-plan' },
      ]);
      const statement = prepareSpy.mock.calls
        .map(([sql]) => String(sql))
        .find((sql) => sql.includes('json_each') && sql.includes('external_estimate_log_states'));
      prepareSpy.mockRestore();
      // The delegate's real statement is the plan input — a rewritten shape
      // that stops probing all three index columns must fail here.
      expect(statement).toBeDefined();
      const plan = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${statement}`)
        .all(
          JSON.stringify([{ remoteScopeKey: scope, remoteTaskId: 'ENG-plan' }]),
          'jira',
        ) as Array<{ detail: string }>;
      const detail = plan.map((row) => row.detail).join('\n');
      expect(detail).toContain('external_estimate_log_states_remote_identity_idx');
      expect(detail).toContain('provider=? AND remote_scope_key=? AND remote_task_id=?');
      // The checkpoint table must never be scanned: the reviewed defect
      // compared every provider row against every JSON input.
      expect(detail).not.toMatch(/SCAN external_estimate_log_states/);
    });
  });

  describe('daily estimate checkpoints', () => {
    const datedPrepare = async (
      operationId: string,
      expectedRevision: number,
      options: {
        deltaMinutes?: number;
        activityDate?: string | null;
        aggregationTimeZone?: string | null;
        capturedDailyTotals?: Array<{ activityDate: string; minutes: number }>;
      } = {},
    ) =>
      storage.prepareExternalEstimateLogOperation({
        ...identity,
        operationId,
        deltaMinutes: options.deltaMinutes ?? 30,
        estimateTotalMinutes: 150,
        startedAt: '2026-09-01T10:00:00.000Z',
        connectionId: connection.id,
        connectionGeneration: connection.generation,
        expectedRevision,
        activityDate: options.activityDate === undefined ? '2026-01-02' : options.activityDate,
        aggregationTimeZone:
          options.aggregationTimeZone === undefined ? 'UTC' : options.aggregationTimeZone,
        capturedDailyTotals: options.capturedDailyTotals ?? [],
      });

    const setLogged = async (
      loggedMinutes: number,
      expectedRevision: number,
      options: {
        aggregationTimeZone?: string | null;
        currentDailyTotals?: Array<{ activityDate: string; minutes: number }>;
      } = {},
    ) =>
      storage.setExternalEstimateLoggedMinutes({
        ...identity,
        loggedMinutes,
        expectedRevision,
        aggregationTimeZone:
          options.aggregationTimeZone === undefined ? null : options.aggregationTimeZone,
        currentDailyTotals: options.currentDailyTotals ?? [],
      });

    const dayRows = () =>
      sqlite
        .prepare(
          `SELECT activity_date, logged_minutes FROM external_estimate_log_days
           ORDER BY activity_date`,
        )
        .all() as Array<{ activity_date: string; logged_minutes: number }>;

    it('treats an existing scalar-only row as fully unallocated credit', async () => {
      await setLogged(90, 0);
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toEqual({
        state: expect.objectContaining({
          loggedMinutes: 90,
          revision: 1,
          aggregationTimeZone: null,
          pendingOperationId: null,
        }),
        days: [],
        unallocatedLoggedMinutes: 90,
      });
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toMatchObject({
        state: { pendingActivityDate: null },
      });
    });

    it('returns null for an absent daily checkpoint', async () => {
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toBeNull();
    });

    it('materializes scalar credit oldest-first at prepare without changing the scalar', async () => {
      await setLogged(100, 0);
      const prepared = await datedPrepare('operation-materialize', 1, {
        capturedDailyTotals: [
          { activityDate: '2026-01-02', minutes: 80 },
          { activityDate: '2026-01-01', minutes: 60 },
        ],
      });
      expect(prepared).toMatchObject({
        loggedMinutes: 100,
        revision: 2,
        aggregationTimeZone: 'UTC',
        pendingActivityDate: '2026-01-02',
      });
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toEqual({
        state: expect.objectContaining({
          loggedMinutes: 100,
          pendingOperationId: 'operation-materialize',
        }),
        days: [
          { ...identity, activityDate: '2026-01-01', loggedMinutes: 60 },
          { ...identity, activityDate: '2026-01-02', loggedMinutes: 40 },
        ],
        unallocatedLoggedMinutes: 0,
      });
    });

    it('keeps excess credit unallocated until a later prepare offers more buckets', async () => {
      await setLogged(150, 0);
      await datedPrepare('operation-excess', 1, {
        capturedDailyTotals: [
          { activityDate: '2026-01-01', minutes: 60 },
          { activityDate: '2026-01-02', minutes: 80 },
        ],
      });
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toMatchObject({
        unallocatedLoggedMinutes: 10,
      });
      await storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-excess',
        expectedRevision: 2,
      });
      await datedPrepare('operation-later', 3, {
        capturedDailyTotals: [
          { activityDate: '2026-01-01', minutes: 60 },
          { activityDate: '2026-01-02', minutes: 80 },
          { activityDate: '2026-01-03', minutes: 50 },
        ],
      });
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toMatchObject({
        unallocatedLoggedMinutes: 0,
      });
      expect(dayRows()).toEqual([
        { activity_date: '2026-01-01', logged_minutes: 60 },
        { activity_date: '2026-01-02', logged_minutes: 110 },
        { activity_date: '2026-01-03', logged_minutes: 10 },
      ]);
    });

    it('never moves or reduces persisted dated credit', async () => {
      await setLogged(100, 0);
      await datedPrepare('operation-first', 1, {
        activityDate: '2026-01-01',
        capturedDailyTotals: [{ activityDate: '2026-01-01', minutes: 60 }],
      });
      await storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-first',
        expectedRevision: 2,
      });
      // A later prepare whose captured bucket shrank below the persisted
      // day cannot pull dated minutes back off the ledger.
      await datedPrepare('operation-shrunk-capture', 3, {
        activityDate: '2026-01-02',
        capturedDailyTotals: [{ activityDate: '2026-01-01', minutes: 20 }],
      });
      expect(dayRows()).toEqual([{ activity_date: '2026-01-01', logged_minutes: 90 }]);
    });

    it('confirms a dated delta onto the day row and the scalar in one settlement', async () => {
      await setLogged(100, 0);
      await datedPrepare('operation-dated', 1, {
        capturedDailyTotals: [{ activityDate: '2026-01-02', minutes: 40 }],
      });
      const confirmed = await storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-dated',
        expectedRevision: 2,
      });
      expect(confirmed).toMatchObject({
        loggedMinutes: 130,
        revision: 3,
        pendingOperationId: null,
      });
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toEqual({
        state: expect.objectContaining({ loggedMinutes: 130, pendingActivityDate: null }),
        days: [{ ...identity, activityDate: '2026-01-02', loggedMinutes: 70 }],
        unallocatedLoggedMinutes: 60,
      });
    });

    it('settles a legacy pending operation on the scalar only', async () => {
      await setLogged(100, 0);
      await prepare('operation-legacy', 1, 30);
      const confirmed = await storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-legacy',
        expectedRevision: 2,
      });
      expect(confirmed).toMatchObject({ loggedMinutes: 130, revision: 3 });
      expect(dayRows()).toEqual([]);
    });

    // Real SQLite is the only layer where the FIFO transaction admission can
    // commit a dated settlement between two separate admission reads; the
    // interleaving below is deterministic without timers.
    it('never reports false corruption when a dated settlement commits mid-read', async () => {
      await setLogged(100, 0);
      await datedPrepare('operation-mid-read', 1, {
        capturedDailyTotals: [{ activityDate: '2026-01-02', minutes: 100 }],
      });

      // The confirm call reserves FIFO admission synchronously, so its
      // transaction body commits in a microtask queued before the listing's
      // continuation. The admission read must still resolve from one
      // snapshot: the pre-settlement scalar and day sum agree, so the
      // committed checkpoint is never misread as corruption.
      const settlement = storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-mid-read',
        expectedRevision: 2,
      });
      const states = await storage.listExternalEstimateLogStatesByRemoteTask('jira', 'ENG-1');
      await settlement;

      expect(states).toEqual([
        expect.objectContaining({
          loggedMinutes: 100,
          pendingOperationId: 'operation-mid-read',
        }),
      ]);
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toMatchObject({
        state: expect.objectContaining({ loggedMinutes: 130, pendingOperationId: null }),
        unallocatedLoggedMinutes: 0,
      });
    });

    it('applies a stored dated Mark-logged resolution to the day row and the scalar', async () => {
      await setLogged(100, 0);
      await datedPrepare('operation-mark', 1);
      await storage.storeExternalEstimateLogResolution({
        ...identity,
        operationId: 'operation-mark',
        resolution: 'logged',
        expectedRevision: 2,
      });
      const applied = await storage.applyExternalEstimateLogResolution({
        ...identity,
        operationId: 'operation-mark',
        expectedRevision: 3,
      });
      expect(applied).toMatchObject({ loggedMinutes: 130, revision: 4 });
      expect(dayRows()).toEqual([{ activity_date: '2026-01-02', logged_minutes: 30 }]);
    });

    it('clears a dated not-logged resolution without changing any totals', async () => {
      await setLogged(100, 0);
      await datedPrepare('operation-not-logged', 1, {
        capturedDailyTotals: [{ activityDate: '2026-01-01', minutes: 60 }],
      });
      await storage.storeExternalEstimateLogResolution({
        ...identity,
        operationId: 'operation-not-logged',
        resolution: 'not_logged',
        expectedRevision: 2,
      });
      const applied = await storage.applyExternalEstimateLogResolution({
        ...identity,
        operationId: 'operation-not-logged',
        expectedRevision: 3,
      });
      expect(applied).toMatchObject({ loggedMinutes: 100, revision: 4, pendingOperationId: null });
      expect(dayRows()).toEqual([{ activity_date: '2026-01-01', logged_minutes: 60 }]);
    });

    it('rebuilds the dated baseline through Set logged in one transaction', async () => {
      await setLogged(100, 0, { aggregationTimeZone: 'UTC' });
      await datedPrepare('operation-rebuild', 1, {
        capturedDailyTotals: [
          { activityDate: '2026-01-01', minutes: 60 },
          { activityDate: '2026-01-02', minutes: 40 },
        ],
      });
      await storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-rebuild',
        expectedRevision: 2,
      });

      const rebuilt = await setLogged(200, 3, {
        aggregationTimeZone: 'Europe/Berlin',
        currentDailyTotals: [
          { activityDate: '2026-01-01', minutes: 150 },
          { activityDate: '2026-01-03', minutes: 100 },
        ],
      });
      expect(rebuilt).toMatchObject({
        loggedMinutes: 200,
        revision: 4,
        aggregationTimeZone: 'Europe/Berlin',
      });
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toEqual({
        state: expect.objectContaining({
          loggedMinutes: 200,
          aggregationTimeZone: 'Europe/Berlin',
        }),
        days: [
          { ...identity, activityDate: '2026-01-01', loggedMinutes: 150 },
          { ...identity, activityDate: '2026-01-03', loggedMinutes: 50 },
        ],
        unallocatedLoggedMinutes: 0,
      });

      // A legacy Set-logged correction clears the ledger and leaves the
      // whole scalar unallocated for the next dated prepare.
      await setLogged(120, 4);
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toEqual({
        state: expect.objectContaining({
          loggedMinutes: 120,
          aggregationTimeZone: 'Europe/Berlin',
        }),
        days: [],
        unallocatedLoggedMinutes: 120,
      });
    });

    it('rebinds the canonical zone on a dated prepare', async () => {
      await setLogged(100, 0, { aggregationTimeZone: 'UTC' });
      const prepared = await datedPrepare('operation-rebind', 1, {
        aggregationTimeZone: 'America/New_York',
        capturedDailyTotals: [{ activityDate: '2026-01-01', minutes: 100 }],
      });
      expect(prepared).toMatchObject({ aggregationTimeZone: 'America/New_York' });
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toMatchObject({
        state: { aggregationTimeZone: 'America/New_York' },
      });
    });

    it('fails closed when the dated ledger exceeds the scalar checkpoint', async () => {
      await setLogged(100, 0);
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_days
            (provider, remote_scope_key, remote_task_id, activity_date,
             logged_minutes, created_at, updated_at)
           VALUES (?, ?, ?, '2026-01-01', 500, 'created', 'updated')`,
        )
        .run(identity.provider, identity.remoteScopeKey, identity.remoteTaskId);
      await expect(storage.getExternalEstimateLogState(identity)).rejects.toBeInstanceOf(
        StorageError,
      );
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).rejects.toBeInstanceOf(
        StorageError,
      );
      await expect(
        storage.listExternalEstimateLogStatesByRemoteTask('jira', 'ENG-1'),
      ).rejects.toBeInstanceOf(StorageError);
    });

    it('rejects Set logged on a corrupt ledger and leaves every field unchanged', async () => {
      await setLogged(100, 0, { aggregationTimeZone: 'UTC' });
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_days
            (provider, remote_scope_key, remote_task_id, activity_date,
             logged_minutes, created_at, updated_at)
           VALUES (?, ?, ?, '2026-01-01', 500, 'created', 'updated')`,
        )
        .run(identity.provider, identity.remoteScopeKey, identity.remoteTaskId);

      await expect(
        setLogged(200, 1, {
          aggregationTimeZone: 'Europe/Berlin',
          currentDailyTotals: [{ activityDate: '2026-01-01', minutes: 150 }],
        }),
      ).rejects.toBeInstanceOf(StorageError);

      // The failed rebuild must not repair or alter anything: scalar, zone,
      // revision, and the corrupt ledger row all keep their prior values,
      // and the corruption stays detectable on the read paths.
      const rawState = sqlite
        .prepare(
          `SELECT logged_minutes, revision, aggregation_time_zone FROM external_estimate_log_states
           WHERE provider = ? AND remote_scope_key = ? AND remote_task_id = ?`,
        )
        .get(identity.provider, identity.remoteScopeKey, identity.remoteTaskId) as {
        logged_minutes: number;
        revision: number;
        aggregation_time_zone: string | null;
      };
      expect(rawState).toEqual({
        logged_minutes: 100,
        revision: 1,
        aggregation_time_zone: 'UTC',
      });
      expect(dayRows()).toEqual([{ activity_date: '2026-01-01', logged_minutes: 500 }]);
      await expect(storage.getExternalEstimateLogState(identity)).rejects.toBeInstanceOf(
        StorageError,
      );
    });

    it('rolls prepare and confirm back whole under the same invariant', async () => {
      await setLogged(100, 0);
      const corruptLedger = () =>
        sqlite
          .prepare(
            `INSERT INTO external_estimate_log_days
              (provider, remote_scope_key, remote_task_id, activity_date,
               logged_minutes, created_at, updated_at)
             VALUES (?, ?, ?, '2026-01-01', 500, 'created', 'updated')
             ON CONFLICT(provider, remote_scope_key, remote_task_id, activity_date)
             DO UPDATE SET logged_minutes = 500`,
          )
          .run(identity.provider, identity.remoteScopeKey, identity.remoteTaskId);
      const rawState = () =>
        sqlite
          .prepare(
            `SELECT logged_minutes, revision, pending_operation_id FROM external_estimate_log_states
             WHERE provider = ? AND remote_scope_key = ? AND remote_task_id = ?`,
          )
          .get(identity.provider, identity.remoteScopeKey, identity.remoteTaskId) as {
          logged_minutes: number;
          revision: number;
          pending_operation_id: string | null;
        };

      // Prepare fails closed and writes neither pending state nor days.
      corruptLedger();
      await expect(
        datedPrepare('operation-corrupt-prepare', 1, {
          capturedDailyTotals: [{ activityDate: '2026-01-02', minutes: 40 }],
        }),
      ).rejects.toBeInstanceOf(StorageError);
      expect(rawState()).toEqual({ logged_minutes: 100, revision: 1, pending_operation_id: null });
      expect(dayRows()).toEqual([{ activity_date: '2026-01-01', logged_minutes: 500 }]);

      // Confirm of a still-pending operation rolls the whole settlement
      // back: scalar, pending row, and the corrupt ledger stay as they were.
      sqlite
        .prepare(
          `INSERT INTO external_estimate_log_days
            (provider, remote_scope_key, remote_task_id, activity_date,
             logged_minutes, created_at, updated_at)
           VALUES (?, ?, ?, '2026-01-01', 60, 'created', 'updated')
           ON CONFLICT(provider, remote_scope_key, remote_task_id, activity_date)
           DO UPDATE SET logged_minutes = 60`,
        )
        .run(identity.provider, identity.remoteScopeKey, identity.remoteTaskId);
      await datedPrepare('operation-corrupt-confirm', 1, {
        activityDate: '2026-01-02',
        capturedDailyTotals: [{ activityDate: '2026-01-01', minutes: 60 }],
      });
      corruptLedger();
      await expect(
        storage.confirmExternalEstimateLogOperation({
          ...identity,
          operationId: 'operation-corrupt-confirm',
          expectedRevision: 2,
        }),
      ).rejects.toBeInstanceOf(StorageError);
      expect(rawState()).toEqual({
        logged_minutes: 100,
        revision: 2,
        pending_operation_id: 'operation-corrupt-confirm',
      });
      expect(dayRows()).toEqual([{ activity_date: '2026-01-01', logged_minutes: 500 }]);
    });

    it('fails closed above 3,660 day rows while the scalar read keeps working', async () => {
      await setLogged(4_000, 0);
      const seed = sqlite.prepare(
        `INSERT INTO external_estimate_log_days
          (provider, remote_scope_key, remote_task_id, activity_date,
           logged_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 'created', 'updated')`,
      );
      sqlite.transaction(() => {
        for (let index = 0; index <= 3_660; index += 1) {
          const month = String(Math.floor(index / 200) + 1).padStart(2, '0');
          const day = String((index % 200) + 1).padStart(2, '0');
          seed.run(
            identity.provider,
            identity.remoteScopeKey,
            identity.remoteTaskId,
            `2026-${month}-${day}`,
          );
        }
      })();
      await expect(storage.getExternalEstimateLogState(identity)).resolves.toMatchObject({
        loggedMinutes: 4_000,
      });
      await expect(storage.getExternalEstimateLogDailyCheckpoint(identity)).rejects.toBeInstanceOf(
        StorageError,
      );
    });

    it('rejects invalid dated inputs before any write', async () => {
      const oversized = Array.from({ length: 3_661 }, (_, index) => ({
        activityDate: `2026-${String(Math.floor(index / 200) + 1).padStart(2, '0')}-${String((index % 200) + 1).padStart(2, '0')}`,
        minutes: 1,
      }));
      await expect(
        datedPrepare('operation-bounds', 0, { capturedDailyTotals: oversized }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        datedPrepare('operation-bad-date', 0, {
          capturedDailyTotals: [{ activityDate: '2026-1-5', minutes: 10 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        datedPrepare('operation-calendar', 0, { activityDate: '2026-02-30' }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        datedPrepare('operation-negative', 0, {
          capturedDailyTotals: [{ activityDate: '2026-01-01', minutes: -1 }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        datedPrepare('operation-zone', 0, { aggregationTimeZone: '' }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(setLogged(50, 0, { currentDailyTotals: oversized })).rejects.toBeInstanceOf(
        ValidationError,
      );
      await expect(storage.getExternalEstimateLogState(identity)).resolves.toBeNull();
    });
  });
});

describe('LocalStorageService external estimate log restart durability', () => {
  let workDirectory: string;
  let secretDirectory: string;
  let dbFile: string;

  beforeEach(() => {
    workDirectory = mkdtempSync(join(tmpdir(), 'devchain-estimate-restart-'));
    secretDirectory = join(workDirectory, 'secrets');
    dbFile = join(workDirectory, 'estimate-log.sqlite');
  });
  afterEach(() => rmSync(workDirectory, { recursive: true, force: true }));

  function openStorage(): { sqlite: Database.Database; storage: LocalStorageService } {
    const sqlite = new Database(dbFile);
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return {
      sqlite,
      storage: new LocalStorageService(
        db,
        new IntegrationCredentialCipher({
          secretDirectory,
          machineIdentity: 'test-host:test-user',
        }),
      ),
    };
  }

  // Layer: backend integration against a file-backed database. Restart
  // durability is a property of persisted SQLite state, so reopening the
  // file is the cheapest reliable oracle.
  it('preserves the dated ledger, zone binding, and pending date across a restart', async () => {
    const identity = {
      provider: 'jira' as const,
      remoteScopeKey: 'acme.atlassian.net',
      remoteTaskId: 'ENG-1',
    };
    const first = openStorage();
    const project = await first.storage.createProject({
      name: 'Restart project',
      description: null,
      rootPath: '/tmp/estimate-restart-project',
    });
    const connection = await first.storage.replaceIntegrationConnection(
      {
        projectId: project.id,
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'test@example.com',
          token: 'test-token',
        },
      },
      async () => undefined,
    );
    const statuses = await first.storage.listStatuses(project.id);
    const epic = await first.storage.createEpic({
      projectId: project.id,
      title: 'Restart source',
      statusId: statuses.items[0]!.id,
    });
    await first.storage.createExternalTaskLink({
      epicId: epic.id,
      connectionId: connection.id,
      ...identity,
      sourceSnapshot: {},
    });

    await first.storage.setExternalEstimateLoggedMinutes({
      ...identity,
      loggedMinutes: 100,
      expectedRevision: 0,
      aggregationTimeZone: null,
      currentDailyTotals: [],
    });
    await first.storage.prepareExternalEstimateLogOperation({
      ...identity,
      operationId: 'operation-restart',
      deltaMinutes: 30,
      estimateTotalMinutes: 150,
      startedAt: '2026-09-01T10:00:00.000Z',
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      expectedRevision: 1,
      activityDate: '2026-01-02',
      aggregationTimeZone: 'UTC',
      capturedDailyTotals: [
        { activityDate: '2026-01-01', minutes: 60 },
        { activityDate: '2026-01-02', minutes: 40 },
      ],
    });
    first.sqlite.close();

    const second = openStorage();
    try {
      await expect(second.storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toEqual(
        {
          state: expect.objectContaining({
            loggedMinutes: 100,
            revision: 2,
            aggregationTimeZone: 'UTC',
            pendingOperationId: 'operation-restart',
            pendingActivityDate: '2026-01-02',
          }),
          days: [
            { ...identity, activityDate: '2026-01-01', loggedMinutes: 60 },
            { ...identity, activityDate: '2026-01-02', loggedMinutes: 40 },
          ],
          unallocatedLoggedMinutes: 0,
        },
      );
      // The restarted process still settles the persisted pending delta
      // onto the durable day row exactly once.
      const confirmed = await second.storage.confirmExternalEstimateLogOperation({
        ...identity,
        operationId: 'operation-restart',
        expectedRevision: 2,
      });
      expect(confirmed).toMatchObject({ loggedMinutes: 130, revision: 3 });
      await expect(second.storage.getExternalEstimateLogDailyCheckpoint(identity)).resolves.toEqual(
        {
          state: expect.objectContaining({ loggedMinutes: 130, pendingOperationId: null }),
          days: [
            { ...identity, activityDate: '2026-01-01', loggedMinutes: 60 },
            { ...identity, activityDate: '2026-01-02', loggedMinutes: 70 },
          ],
          unallocatedLoggedMinutes: 0,
        },
      );
      await expect(
        second.storage.confirmExternalEstimateLogOperation({
          ...identity,
          operationId: 'operation-restart',
          expectedRevision: 2,
        }),
      ).resolves.toMatchObject({ loggedMinutes: 130, revision: 3 });
    } finally {
      second.sqlite.close();
    }
  });
});
