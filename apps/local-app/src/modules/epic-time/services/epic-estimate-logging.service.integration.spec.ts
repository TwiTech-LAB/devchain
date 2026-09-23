import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictError } from '../../../common/errors/error-types';
import { IntegrationCredentialCipher } from '../../storage/local/integration-credential-cipher';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE } from '../models/epic-time.models';
import { timeEntryNoteFingerprint } from '../../external-integrations/sessions/external-time-mutation.store';
import type { EpicTimeService } from './epic-time.service';
import { EpicEstimateLoggingService } from './epic-estimate-logging.service';
import type { ExternalTimeMutationService } from '../../external-integrations/my-work/external-time-mutation.service';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const LEGACY_UNASSIGNED = '00000000-0000-0000-0000-000000000000';

interface ProjectContext {
  projectId: string;
  connectionId: string;
  connectionGeneration: number;
  epicId: string;
}

describe('EpicEstimateLoggingService project contributions and legacy recovery', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let secretDirectory: string;
  let service: EpicEstimateLoggingService;
  let epicTime: { getDailyProjection: jest.Mock };
  let timeMutations: {
    inspectOperation: jest.Mock;
    createEstimateTimeEntry: jest.Mock;
    verifyOperation: jest.Mock;
    acknowledgeOperation: jest.Mock;
  };
  let contextA: ProjectContext;
  let contextB: ProjectContext;

  const REMOTE = {
    provider: 'jira' as const,
    remoteScopeKey: 'acme.atlassian.net',
    remoteTaskId: 'ENG-1',
  };

  /** Builds the matching succeeded receipt straight from the durable pending row. */
  const inspectionFromPendingRow = (operationId: string) => {
    const row = sqlite
      .prepare(
        `SELECT provider, remote_task_id, pending_connection_id, pending_connection_generation,
                pending_started_at, pending_delta_minutes
         FROM external_estimate_log_states WHERE pending_operation_id = ?`,
      )
      .get(operationId) as
      | {
          provider: string;
          remote_task_id: string;
          pending_connection_id: string;
          pending_connection_generation: number;
          pending_started_at: string;
          pending_delta_minutes: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      operationId,
      kind: 'create' as const,
      phase: 'succeeded' as const,
      canVerify: true,
      expiresAt: '2026-09-30T00:00:00.000Z',
      tuple: {
        provider: row.provider,
        connectionId: row.pending_connection_id,
        connectionGeneration: row.pending_connection_generation,
        remoteTaskId: row.remote_task_id,
        remoteEntryId: null,
        effectiveStartedAt: row.pending_started_at,
        durationMs: row.pending_delta_minutes * 60_000,
        noteFingerprint: timeEntryNoteFingerprint(EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE),
      },
    };
  };

  const seedProject = async (name: string, rootPath: string): Promise<ProjectContext> => {
    const project = await storage.createProject({ name, description: null, rootPath });
    const connection = await storage.replaceIntegrationConnection(
      {
        projectId: project.id,
        provider: 'jira',
        credentials: {
          provider: 'jira',
          siteUrl: 'https://acme.atlassian.net',
          email: `${name.toLowerCase()}@example.com`,
          token: `${name.toLowerCase()}-token`,
        },
      },
      async () => undefined,
    );
    const statuses = await storage.listStatuses(project.id);
    const epic = await storage.createEpic({
      projectId: project.id,
      title: `${name} imported task`,
      statusId: statuses.items[0]!.id,
    });
    await storage.createExternalTaskLink({
      epicId: epic.id,
      connectionId: connection.id,
      ...REMOTE,
      sourceSnapshot: { title: `${name} snapshot` },
    });
    return {
      projectId: project.id,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
      epicId: epic.id,
    };
  };

  const taskContext = (context: ProjectContext) => ({
    projectId: context.projectId,
    ...REMOTE,
    expectedEpoch: context.connectionGeneration,
  });

  const projectProjection = (epicId: string, date: string, minutes: number) => {
    epicTime.getDailyProjection.mockImplementation(() => ({
      canonicalTimeZone: 'UTC',
      totalMinutes: minutes,
      currentByDate: [{ activityDate: date, minutes }],
    }));
    void epicId;
  };

  const seedLegacyState = (options: { pending?: boolean } = {}) => {
    sqlite
      .prepare(
        `INSERT INTO external_estimate_log_states
          (project_id, provider, remote_scope_key, remote_task_id, logged_minutes, revision,
           pending_operation_id, pending_delta_minutes, pending_estimate_total_minutes,
           pending_started_at, pending_connection_id, pending_connection_generation,
           pending_phase, pending_resolution, aggregation_time_zone, pending_activity_date,
           created_at, updated_at)
         VALUES (?, 'jira', 'acme.atlassian.net', 'ENG-1', 90, 4, ?, ?, ?, ?, ?, ?, ?, NULL,
           'Europe/Berlin', ?, 'created', 'updated')`,
      )
      .run(
        LEGACY_UNASSIGNED,
        options.pending ? 'legacy-operation' : null,
        options.pending ? 30 : null,
        options.pending ? 120 : null,
        options.pending ? '2026-09-01T10:00:00.000Z' : null,
        options.pending ? contextA.connectionId : null,
        options.pending ? contextA.connectionGeneration : null,
        options.pending ? 'prepared' : null,
        options.pending ? '2026-09-01' : null,
      );
    sqlite
      .prepare(
        `INSERT INTO external_estimate_log_days
          (project_id, provider, remote_scope_key, remote_task_id, activity_date,
           logged_minutes, created_at, updated_at)
         VALUES (?, 'jira', 'acme.atlassian.net', 'ENG-1', '2026-08-30', 50,
           'created', 'updated')`,
      )
      .run(LEGACY_UNASSIGNED);
  };

  const scalarRow = (projectId: string) =>
    sqlite
      .prepare(
        `SELECT project_id, logged_minutes, revision FROM external_estimate_log_states
         WHERE project_id = ? AND provider = 'jira'
           AND remote_scope_key = 'acme.atlassian.net' AND remote_task_id = 'ENG-1'`,
      )
      .get(projectId) as
      | { project_id: string; logged_minutes: number; revision: number }
      | undefined;

  const dayRows = (projectId: string) =>
    sqlite
      .prepare(
        `SELECT activity_date, logged_minutes FROM external_estimate_log_days
         WHERE project_id = ? ORDER BY activity_date`,
      )
      .all(projectId) as Array<{ activity_date: string; logged_minutes: number }>;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    secretDirectory = mkdtempSync(join(tmpdir(), 'devchain-estimate-service-'));
    storage = new LocalStorageService(
      drizzle(sqlite),
      new IntegrationCredentialCipher({
        secretDirectory,
        machineIdentity: 'test-host:test-user',
      }),
    );
    epicTime = { getDailyProjection: jest.fn() };
    timeMutations = {
      inspectOperation: jest.fn().mockImplementation(inspectionFromPendingRow),
      createEstimateTimeEntry: jest.fn().mockResolvedValue({ outcome: 'created' }),
      verifyOperation: jest.fn(),
      acknowledgeOperation: jest.fn(),
    };
    service = new EpicEstimateLoggingService(
      storage,
      epicTime as unknown as EpicTimeService,
      timeMutations as unknown as ExternalTimeMutationService,
    );
    contextA = await seedProject('Project A', '/tmp/estimate-service-a');
    contextB = await seedProject('Project B', '/tmp/estimate-service-b');
  });

  afterEach(() => {
    sqlite.close();
    rmSync(secretDirectory, { recursive: true, force: true });
  });

  it('exports independent 30 and 20 minute contributions for one remote identity', async () => {
    projectProjection(contextA.epicId, '2026-08-30', 30);
    const exportedA = await service.createTimeEntry({
      ...taskContext(contextA),
      requestKey: '11111111-1111-4111-8111-111111111111',
      timeZone: 'UTC',
      estimateTotalMinutes: 30,
      expectedRevision: 0,
      dailySnapshot: [{ activityDate: '2026-08-30', minutes: 30 }],
    });
    expect(exportedA).toMatchObject({
      outcome: 'logged',
      entriesLogged: 1,
      minutesLogged: 30,
      stoppedReason: 'completed',
    });

    projectProjection(contextB.epicId, '2026-08-30', 20);
    const exportedB = await service.createTimeEntry({
      ...taskContext(contextB),
      requestKey: '22222222-2222-4222-8222-222222222222',
      timeZone: 'UTC',
      estimateTotalMinutes: 20,
      expectedRevision: 0,
      dailySnapshot: [{ activityDate: '2026-08-30', minutes: 20 }],
    });
    expect(exportedB).toMatchObject({
      outcome: 'logged',
      entriesLogged: 1,
      minutesLogged: 20,
      stoppedReason: 'completed',
    });

    // Both contributions reached the provider with their own durations.
    expect(timeMutations.createEstimateTimeEntry).toHaveBeenCalledTimes(2);
    const durations = timeMutations.createEstimateTimeEntry.mock.calls.map(
      (call) => (call[3] as { durationMs: number }).durationMs,
    );
    expect(durations).toEqual([30 * 60_000, 20 * 60_000]);

    // The scalar and dated ledgers stay fully independent per project.
    expect(scalarRow(contextA.projectId)).toEqual({
      project_id: contextA.projectId,
      logged_minutes: 30,
      revision: 2,
    });
    expect(dayRows(contextA.projectId)).toEqual([
      { activity_date: '2026-08-30', logged_minutes: 30 },
    ]);
    expect(scalarRow(contextB.projectId)).toEqual({
      project_id: contextB.projectId,
      logged_minutes: 20,
      revision: 2,
    });
    expect(dayRows(contextB.projectId)).toEqual([
      { activity_date: '2026-08-30', logged_minutes: 20 },
    ]);
  });

  it('keeps a deleted project as its historical owner while B logs independently', async () => {
    projectProjection(contextA.epicId, '2026-08-30', 30);
    await service.setLoggedMinutes({
      ...taskContext(contextA),
      loggedMinutes: 30,
      expectedRevision: 0,
      timeZone: 'UTC',
    });
    expect(scalarRow(contextA.projectId)).toMatchObject({ logged_minutes: 30 });

    // Project deletion requires disconnecting its integration first; the
    // checkpoint history has no project foreign key either way.
    await storage.disconnectIntegrationConnection({
      projectId: contextA.projectId,
      provider: 'jira',
    });
    await storage.deleteProject(contextA.projectId);

    // Deleting the project erased neither its checkpoint nor its owner UUID;
    // the history is never relabeled as unassigned legacy state.
    expect(scalarRow(contextA.projectId)).toEqual({
      project_id: contextA.projectId,
      logged_minutes: 30,
      revision: 1,
    });
    expect(dayRows(contextA.projectId)).toEqual([
      { activity_date: '2026-08-30', logged_minutes: 30 },
    ]);

    projectProjection(contextB.epicId, '2026-08-30', 20);
    const exportedB = await service.createTimeEntry({
      ...taskContext(contextB),
      requestKey: '33333333-3333-4333-8333-333333333333',
      timeZone: 'UTC',
      estimateTotalMinutes: 20,
      expectedRevision: 0,
      dailySnapshot: [{ activityDate: '2026-08-30', minutes: 20 }],
    });
    expect(exportedB).toMatchObject({ outcome: 'logged', minutesLogged: 20 });
    expect(scalarRow(contextB.projectId)).toMatchObject({ logged_minutes: 20 });
    expect(
      sqlite
        .prepare(`SELECT COUNT(*) AS count FROM external_estimate_log_states WHERE project_id = ?`)
        .get(LEGACY_UNASSIGNED),
    ).toEqual({ count: 0 });
  });

  it('recovers unassigned legacy ownership end to end through the service gates', async () => {
    seedLegacyState({ pending: true });

    // The read surfaces the signal without claiming the history.
    const gated = await service.getState(taskContext(contextA));
    expect(gated).toMatchObject({
      initialized: false,
      loggedMinutes: 0,
      legacyCheckpoint: { revision: 4, loggedMinutes: 90, hasPendingOperation: true },
    });
    await expect(service.getState(taskContext(contextB))).resolves.toMatchObject({
      legacyCheckpoint: { revision: 4, loggedMinutes: 90, hasPendingOperation: true },
    });

    // Estimate dispatch and ordinary Set logged stay closed; no provider
    // request and no silent zero checkpoint.
    projectProjection(contextA.epicId, '2026-08-30', 30);
    await expect(
      service.createTimeEntry({
        ...taskContext(contextA),
        requestKey: '44444444-4444-4444-8444-444444444444',
        timeZone: 'UTC',
        estimateTotalMinutes: 30,
        expectedRevision: 0,
        dailySnapshot: [{ activityDate: '2026-08-30', minutes: 30 }],
      }),
    ).rejects.toMatchObject<ConflictError>({
      details: { reason: 'legacy_ownership_unresolved' },
    });
    await expect(
      service.setLoggedMinutes({
        ...taskContext(contextA),
        loggedMinutes: 0,
        expectedRevision: 0,
        timeZone: 'UTC',
      }),
    ).rejects.toMatchObject<ConflictError>({
      details: { reason: 'legacy_ownership_unresolved' },
    });
    expect(timeMutations.createEstimateTimeEntry).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM external_estimate_log_states
           WHERE project_id = ? AND provider = 'jira'`,
        )
        .get(contextA.projectId),
    ).toEqual({ count: 0 });

    // A stale epoch cannot claim: the caller must reload first.
    await expect(
      service.assignLegacyCheckpoint({
        ...taskContext(contextA),
        expectedEpoch: contextA.connectionGeneration + 1,
        expectedLegacyRevision: 4,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const assigned = await service.assignLegacyCheckpoint({
      ...taskContext(contextA),
      expectedLegacyRevision: 4,
    });
    expect(assigned).toMatchObject({
      initialized: true,
      loggedMinutes: 90,
      revision: 4,
      legacyCheckpoint: null,
      days: [{ activityDate: '2026-08-30', loggedMinutes: 50 }],
      unallocatedLoggedMinutes: 40,
    });

    // The preserved pending outcome resolves through the ordinary Mark-logged
    // action after assignment.
    const resolved = await service.resolveOperation({
      ...taskContext(contextA),
      operationId: 'legacy-operation',
      action: 'logged',
      expectedRevision: 4,
    });
    expect(resolved.outcome).toBe('logged');
    expect(scalarRow(contextA.projectId)).toMatchObject({
      logged_minutes: 120,
      revision: 5,
    });
    expect(dayRows(contextA.projectId)).toEqual([
      { activity_date: '2026-08-30', logged_minutes: 50 },
      { activity_date: '2026-09-01', logged_minutes: 30 },
    ]);

    // Project B keeps its clean scope and can now export its own work.
    await expect(service.getState(taskContext(contextB))).resolves.toMatchObject({
      initialized: false,
      legacyCheckpoint: null,
    });
    projectProjection(contextB.epicId, '2026-08-30', 20);
    const exportedB = await service.createTimeEntry({
      ...taskContext(contextB),
      requestKey: '55555555-5555-4555-8555-555555555555',
      timeZone: 'UTC',
      estimateTotalMinutes: 20,
      expectedRevision: 0,
      dailySnapshot: [{ activityDate: '2026-08-30', minutes: 20 }],
    });
    expect(exportedB).toMatchObject({ outcome: 'logged', minutesLogged: 20 });
    expect(scalarRow(contextB.projectId)).toMatchObject({ logged_minutes: 20 });
  });
});
