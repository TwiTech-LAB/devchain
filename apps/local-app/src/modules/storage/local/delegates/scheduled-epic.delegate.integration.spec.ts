import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from '../local-storage.service';
import { NotFoundError, ConflictError } from '../../../../common/errors/error-types';
import type {
  Project,
  Provider,
  AgentProfile,
  Agent,
  ScheduledEpic,
  CreateScheduledEpic,
} from '../../models/domain.models';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../../drizzle');

describe('ScheduledEpicStorageDelegate (integration)', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  // --- Seed helpers ---

  async function seedProject(name = 'Test Project'): Promise<Project> {
    return service.createProject({
      name,
      rootPath: `/tmp/${name.toLowerCase().replace(/\s+/g, '-')}`,
      description: null,
    });
  }

  async function seedProvider(name = 'test-provider'): Promise<Provider> {
    return service.createProvider({ name });
  }

  async function seedProfile(projectId: string, name = 'Test Profile'): Promise<AgentProfile> {
    return service.createAgentProfile({ projectId, name });
  }

  async function seedFullAgent(
    projectId: string,
    agentName = 'Agent-1',
  ): Promise<{ agent: Agent; profile: AgentProfile; provider: Provider; configId: string }> {
    const provider = await seedProvider(`provider-${agentName}`);
    const profile = await seedProfile(projectId, `profile-${agentName}`);
    const config = await service.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: `config-${agentName}`,
    });
    const agent = await service.createAgent({
      projectId,
      profileId: profile.id,
      name: agentName,
      providerConfigId: config.id,
    });
    return { agent, profile, provider, configId: config.id };
  }

  function makeScheduleInput(
    projectId: string,
    overrides: Partial<CreateScheduledEpic> = {},
  ): CreateScheduledEpic {
    return {
      projectId,
      name: 'Daily Standup Epic',
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      titleTemplate: 'Daily Standup {{date}}',
      descriptionTemplate: null,
      templateStatusId: null,
      templateParentEpicId: null,
      templateAgentId: null,
      templateTags: [],
      allowOverlap: false,
      missedRunPolicy: 'skip',
      ...overrides,
    };
  }

  // ==========================================
  // FK ENFORCEMENT VERIFICATION
  // ==========================================

  describe('FK enforcement', () => {
    it('SQLite foreign keys are enforced at runtime', () => {
      const result = sqlite.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
      expect(result[0]?.foreign_keys).toBe(1);
    });
  });

  // ==========================================
  // SCHEDULED EPIC CRUD
  // ==========================================

  describe('ScheduledEpic CRUD', () => {
    it('creates a scheduled epic with all fields', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(
        makeScheduleInput(project.id, {
          templateTags: ['tag1', 'tag2'],
          nextRunAt: '2026-06-01T09:00:00.000Z',
        }),
      );

      expect(schedule.id).toBeDefined();
      expect(schedule.projectId).toBe(project.id);
      expect(schedule.name).toBe('Daily Standup Epic');
      expect(schedule.cronExpression).toBe('0 9 * * *');
      expect(schedule.timezone).toBe('UTC');
      expect(schedule.enabled).toBe(true);
      expect(schedule.titleTemplate).toBe('Daily Standup {{date}}');
      expect(schedule.descriptionTemplate).toBeNull();
      expect(schedule.templateTags).toEqual(['tag1', 'tag2']);
      expect(schedule.allowOverlap).toBe(false);
      expect(schedule.missedRunPolicy).toBe('skip');
      expect(schedule.configVersion).toBe(1);
      expect(schedule.nextRunAt).toBe('2026-06-01T09:00:00.000Z');
      expect(schedule.lastRunAt).toBeNull();
      expect(schedule.lastRunStatus).toBeNull();
      expect(schedule.lastError).toBeNull();
      expect(schedule.createdAt).toBeDefined();
      expect(schedule.updatedAt).toBeDefined();
    });

    it('gets a scheduled epic by id', async () => {
      const project = await seedProject();
      const created = await service.createScheduledEpic(makeScheduleInput(project.id));

      const fetched = await service.getScheduledEpic(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.name).toBe(created.name);
    });

    it('throws NotFoundError for nonexistent schedule', async () => {
      await expect(service.getScheduledEpic(randomUUID())).rejects.toThrow(NotFoundError);
    });

    it('lists scheduled epics with pagination', async () => {
      const project = await seedProject();
      for (let i = 0; i < 5; i++) {
        await service.createScheduledEpic(makeScheduleInput(project.id, { name: `Schedule ${i}` }));
      }

      const page1 = await service.listScheduledEpics(project.id, { limit: 2, offset: 0 });
      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page1.limit).toBe(2);
      expect(page1.offset).toBe(0);

      const page2 = await service.listScheduledEpics(project.id, { limit: 2, offset: 2 });
      expect(page2.items).toHaveLength(2);
      expect(page2.total).toBe(5);
    });

    it('filters listed schedules by enabled flag', async () => {
      const project = await seedProject();
      await service.createScheduledEpic(
        makeScheduleInput(project.id, { name: 'Active', enabled: true }),
      );
      await service.createScheduledEpic(
        makeScheduleInput(project.id, { name: 'Disabled', enabled: false }),
      );

      const enabled = await service.listScheduledEpics(project.id, { enabled: true });
      expect(enabled.total).toBe(1);
      expect(enabled.items[0]!.name).toBe('Active');

      const disabled = await service.listScheduledEpics(project.id, { enabled: false });
      expect(disabled.total).toBe(1);
      expect(disabled.items[0]!.name).toBe('Disabled');
    });

    it('updates a scheduled epic with optimistic locking', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));

      const updated = await service.updateScheduledEpic(
        schedule.id,
        { name: 'Updated Name', cronExpression: '0 10 * * *' },
        1,
      );

      expect(updated.name).toBe('Updated Name');
      expect(updated.cronExpression).toBe('0 10 * * *');
      expect(updated.configVersion).toBe(2);
    });

    it('throws ConflictError on version mismatch', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));

      await expect(service.updateScheduledEpic(schedule.id, { name: 'Stale' }, 99)).rejects.toThrow(
        ConflictError,
      );
    });

    it('throws NotFoundError when updating nonexistent schedule', async () => {
      await expect(service.updateScheduledEpic(randomUUID(), { name: 'Ghost' }, 1)).rejects.toThrow(
        NotFoundError,
      );
    });

    it('deletes a scheduled epic', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));

      await service.deleteScheduledEpic(schedule.id);

      await expect(service.getScheduledEpic(schedule.id)).rejects.toThrow(NotFoundError);
    });
  });

  // ==========================================
  // RUNTIME STATE UPDATES
  // ==========================================

  describe('runtime state updates', () => {
    it('updates runtime state without incrementing configVersion', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));

      const updated = await service.updateScheduledEpicRuntimeState(schedule.id, {
        nextRunAt: '2026-06-02T09:00:00.000Z',
        lastRunAt: '2026-06-01T09:00:00.000Z',
        lastRunStatus: 'completed',
      });

      expect(updated.configVersion).toBe(1);
      expect(updated.nextRunAt).toBe('2026-06-02T09:00:00.000Z');
      expect(updated.lastRunAt).toBe('2026-06-01T09:00:00.000Z');
      expect(updated.lastRunStatus).toBe('completed');
      expect(updated.lastError).toBeNull();
    });

    it('updates lastError in runtime state', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));

      const updated = await service.updateScheduledEpicRuntimeState(schedule.id, {
        lastRunStatus: 'failed',
        lastError: 'Template rendering failed',
      });

      expect(updated.lastRunStatus).toBe('failed');
      expect(updated.lastError).toBe('Template rendering failed');
    });

    it('throws NotFoundError for nonexistent schedule runtime update', async () => {
      await expect(
        service.updateScheduledEpicRuntimeState(randomUUID(), { lastRunStatus: 'failed' }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // ==========================================
  // DUE SCHEDULE QUERIES
  // ==========================================

  describe('listDueScheduledEpics', () => {
    it('returns enabled schedules with nextRunAt <= before', async () => {
      const project = await seedProject();
      await service.createScheduledEpic(
        makeScheduleInput(project.id, {
          name: 'Due',
          enabled: true,
          nextRunAt: '2026-06-01T08:00:00.000Z',
        }),
      );
      await service.createScheduledEpic(
        makeScheduleInput(project.id, {
          name: 'Not Due',
          enabled: true,
          nextRunAt: '2026-06-01T12:00:00.000Z',
        }),
      );
      await service.createScheduledEpic(
        makeScheduleInput(project.id, {
          name: 'Disabled',
          enabled: false,
          nextRunAt: '2026-06-01T08:00:00.000Z',
        }),
      );

      const due = await service.listDueScheduledEpics(project.id, '2026-06-01T09:00:00.000Z');
      expect(due).toHaveLength(1);
      expect(due[0]!.name).toBe('Due');
    });

    it('returns empty array when no schedules are due', async () => {
      const project = await seedProject();
      await service.createScheduledEpic(
        makeScheduleInput(project.id, {
          enabled: true,
          nextRunAt: '2099-01-01T00:00:00.000Z',
        }),
      );

      const due = await service.listDueScheduledEpics(project.id, '2026-06-01T09:00:00.000Z');
      expect(due).toHaveLength(0);
    });
  });

  // ==========================================
  // SCHEDULED EPIC RUNS — CRUD & CLAIM
  // ==========================================

  describe('ScheduledEpicRun CRUD', () => {
    let project: Project;
    let schedule: ScheduledEpic;

    beforeEach(async () => {
      project = await seedProject();
      schedule = await service.createScheduledEpic(makeScheduleInput(project.id));
    });

    it('creates a run and claims it successfully', async () => {
      const result = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      expect(result.claimed).toBe(true);
      expect(result.run.scheduleId).toBe(schedule.id);
      expect(result.run.plannedFor).toBe('2026-06-01T09:00:00.000Z');
      expect(result.run.source).toBe('scheduler');
      expect(result.run.status).toBe('pending');
      expect(result.run.createdEpicId).toBeNull();
      expect(result.run.startedAt).toBeNull();
      expect(result.run.finishedAt).toBeNull();
      expect(result.run.errorMessage).toBeNull();
    });

    it('returns claimed=false for duplicate (scheduleId, plannedFor)', async () => {
      const firstClaim = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });
      expect(firstClaim.claimed).toBe(true);

      const secondClaim = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });
      expect(secondClaim.claimed).toBe(false);
      expect(secondClaim.run.id).toBe(firstClaim.run.id);
    });

    it('allows different plannedFor for the same schedule', async () => {
      const run1 = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });
      const run2 = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-02T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      expect(run1.claimed).toBe(true);
      expect(run2.claimed).toBe(true);
      expect(run1.run.id).not.toBe(run2.run.id);
    });

    it('gets a run by id', async () => {
      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      const fetched = await service.getScheduledEpicRun(run.id);
      expect(fetched.id).toBe(run.id);
      expect(fetched.plannedFor).toBe('2026-06-01T09:00:00.000Z');
    });

    it('throws NotFoundError for nonexistent run', async () => {
      await expect(service.getScheduledEpicRun(randomUUID())).rejects.toThrow(NotFoundError);
    });

    it('lists runs with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await service.createScheduledEpicRun({
          scheduleId: schedule.id,
          plannedFor: `2026-06-0${i + 1}T09:00:00.000Z`,
          source: 'scheduler',
          status: 'pending',
        });
      }

      const page = await service.listScheduledEpicRuns(schedule.id, { limit: 2, offset: 0 });
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(5);
    });

    it('filters runs by status', async () => {
      await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });
      const { run: runningRun } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-02T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });
      await service.updateScheduledEpicRun(runningRun.id, { status: 'running' });

      const pending = await service.listScheduledEpicRuns(schedule.id, { status: 'pending' });
      expect(pending.total).toBe(1);

      const running = await service.listScheduledEpicRuns(schedule.id, { status: 'running' });
      expect(running.total).toBe(1);
    });

    it('updates a run status and timestamps', async () => {
      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      const started = await service.updateScheduledEpicRun(run.id, {
        status: 'running',
        startedAt: '2026-06-01T09:00:01.000Z',
      });
      expect(started.status).toBe('running');
      expect(started.startedAt).toBe('2026-06-01T09:00:01.000Z');

      const completed = await service.updateScheduledEpicRun(run.id, {
        status: 'completed',
        finishedAt: '2026-06-01T09:05:00.000Z',
      });
      expect(completed.status).toBe('completed');
      expect(completed.finishedAt).toBe('2026-06-01T09:05:00.000Z');
    });

    it('updates a run with error message on failure', async () => {
      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      const failed = await service.updateScheduledEpicRun(run.id, {
        status: 'failed',
        finishedAt: '2026-06-01T09:01:00.000Z',
        errorMessage: 'Template rendering error',
      });
      expect(failed.status).toBe('failed');
      expect(failed.errorMessage).toBe('Template rendering error');
    });

    it('links a run to a created epic', async () => {
      const statuses = await service.listStatuses(project.id);
      const epic = await service.createEpic({
        projectId: project.id,
        title: 'Generated Epic',
        description: null,
        statusId: statuses.items[0]!.id,
        data: null,
        tags: [],
      });

      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      const updated = await service.updateScheduledEpicRun(run.id, {
        status: 'completed',
        createdEpicId: epic.id,
      });
      expect(updated.createdEpicId).toBe(epic.id);
    });

    it('throws NotFoundError when updating nonexistent run', async () => {
      await expect(
        service.updateScheduledEpicRun(randomUUID(), { status: 'running' }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // ==========================================
  // CASCADE & FK SET-NULL BEHAVIOR
  // ==========================================

  describe('cascade and FK set-null behavior', () => {
    it('cascade-deletes runs when schedule is deleted', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));
      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      await service.deleteScheduledEpic(schedule.id);

      await expect(service.getScheduledEpicRun(run.id)).rejects.toThrow(NotFoundError);
    });

    it('cascade-deletes schedules when project is deleted', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));

      await service.deleteProject(project.id);

      await expect(service.getScheduledEpic(schedule.id)).rejects.toThrow(NotFoundError);
    });

    it('sets createdEpicId to null when linked epic is deleted', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));
      const statuses = await service.listStatuses(project.id);
      const epic = await service.createEpic({
        projectId: project.id,
        title: 'To Be Deleted',
        description: null,
        statusId: statuses.items[0]!.id,
        data: null,
        tags: [],
      });

      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });
      await service.updateScheduledEpicRun(run.id, { createdEpicId: epic.id });

      await service.deleteEpic(epic.id);

      const afterDelete = await service.getScheduledEpicRun(run.id);
      expect(afterDelete.createdEpicId).toBeNull();
    });

    it('sets templateStatusId to null when referenced status is deleted', async () => {
      const project = await seedProject();
      const status = await service.createStatus({
        projectId: project.id,
        label: 'Temp Status',
        color: '#ff0000',
        position: 99,
      });
      const schedule = await service.createScheduledEpic(
        makeScheduleInput(project.id, { templateStatusId: status.id }),
      );
      expect(schedule.templateStatusId).toBe(status.id);

      await service.deleteStatus(status.id);

      const afterDelete = await service.getScheduledEpic(schedule.id);
      expect(afterDelete.templateStatusId).toBeNull();
    });

    it('sets templateAgentId to null when referenced agent is deleted', async () => {
      const project = await seedProject();
      const { agent } = await seedFullAgent(project.id, 'ScheduleAgent');
      const schedule = await service.createScheduledEpic(
        makeScheduleInput(project.id, { templateAgentId: agent.id }),
      );
      expect(schedule.templateAgentId).toBe(agent.id);

      await service.deleteAgent(agent.id);

      const afterDelete = await service.getScheduledEpic(schedule.id);
      expect(afterDelete.templateAgentId).toBeNull();
    });

    it('sets templateParentEpicId to null when referenced epic is deleted', async () => {
      const project = await seedProject();
      const statuses = await service.listStatuses(project.id);
      const parentEpic = await service.createEpic({
        projectId: project.id,
        title: 'Parent Epic',
        description: null,
        statusId: statuses.items[0]!.id,
        data: null,
        tags: [],
      });
      const schedule = await service.createScheduledEpic(
        makeScheduleInput(project.id, { templateParentEpicId: parentEpic.id }),
      );
      expect(schedule.templateParentEpicId).toBe(parentEpic.id);

      await service.deleteEpic(parentEpic.id);

      const afterDelete = await service.getScheduledEpic(schedule.id);
      expect(afterDelete.templateParentEpicId).toBeNull();
    });
  });

  // ==========================================
  // MIGRATION & JOURNAL VERIFICATION
  // ==========================================

  describe('migration and journal', () => {
    it('migrations apply cleanly to an empty database', () => {
      const freshSqlite = new Database(':memory:');
      const freshDb = drizzle(freshSqlite);
      expect(() => migrate(freshDb, { migrationsFolder: MIGRATIONS_FOLDER })).not.toThrow();
      freshSqlite.close();
    });

    it('scheduled_epics and scheduled_epic_runs tables exist after migration', () => {
      const tables = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('scheduled_epics', 'scheduled_epic_runs') ORDER BY name",
        )
        .all() as Array<{ name: string }>;

      expect(tables.map((t) => t.name)).toEqual(['scheduled_epic_runs', 'scheduled_epics']);
    });

    it('scheduled_epic_runs has unique index on (schedule_id, planned_for)', () => {
      const indexes = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='scheduled_epic_runs' AND name LIKE '%planned_for%'",
        )
        .all() as Array<{ name: string }>;

      expect(indexes.length).toBeGreaterThanOrEqual(1);
      expect(indexes.some((i) => i.name.includes('schedule_planned_for'))).toBe(true);
    });

    it('scheduled_epics has composite index on (project_id, enabled, next_run_at)', () => {
      const indexes = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='scheduled_epics' AND name LIKE '%enabled_next_run%'",
        )
        .all() as Array<{ name: string }>;

      expect(indexes.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================
  // DUPLICATE CLAIM SAFETY
  // ==========================================

  describe('duplicate claim safety', () => {
    it('duplicate claims cannot create two running runs for same (schedule, plannedFor)', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));
      const plannedFor = '2026-06-01T09:00:00.000Z';

      const claim1 = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor,
        source: 'scheduler',
        status: 'pending',
      });
      expect(claim1.claimed).toBe(true);

      await service.updateScheduledEpicRun(claim1.run.id, { status: 'running' });

      const claim2 = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor,
        source: 'scheduler',
        status: 'pending',
      });
      expect(claim2.claimed).toBe(false);
      expect(claim2.run.id).toBe(claim1.run.id);

      const runs = await service.listScheduledEpicRuns(schedule.id);
      const runningRuns = runs.items.filter(
        (r) => r.plannedFor === plannedFor && (r.status === 'running' || r.status === 'pending'),
      );
      expect(runningRuns).toHaveLength(1);
    });

    it('manual source can also be claimed without duplicating', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(makeScheduleInput(project.id));
      const plannedFor = '2026-06-01T09:00:00.000Z';

      const schedulerClaim = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor,
        source: 'scheduler',
        status: 'pending',
      });
      expect(schedulerClaim.claimed).toBe(true);

      const manualClaim = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor,
        source: 'manual',
        status: 'pending',
      });
      expect(manualClaim.claimed).toBe(false);
      expect(manualClaim.run.id).toBe(schedulerClaim.run.id);
    });
  });

  // ==========================================
  // ATOMIC CLAIM (claimScheduledEpicRun)
  // ==========================================

  describe('atomic claim — claimScheduledEpicRun', () => {
    let project: Project;
    let schedule: ScheduledEpic;

    beforeEach(async () => {
      project = await seedProject();
      schedule = await service.createScheduledEpic(makeScheduleInput(project.id));
    });

    it('atomically transitions pending to running and returns claimed=true', async () => {
      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      const result = await service.claimScheduledEpicRun(run.id);

      expect(result.claimed).toBe(true);
      expect(result.run.status).toBe('running');
      expect(result.run.startedAt).toBeDefined();
    });

    it('returns claimed=false when run is already running', async () => {
      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      const first = await service.claimScheduledEpicRun(run.id);
      expect(first.claimed).toBe(true);

      const second = await service.claimScheduledEpicRun(run.id);
      expect(second.claimed).toBe(false);
      expect(second.run.status).toBe('running');
    });

    it('returns claimed=false when run is completed', async () => {
      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });
      await service.claimScheduledEpicRun(run.id);
      await service.updateScheduledEpicRun(run.id, {
        status: 'completed',
        finishedAt: new Date().toISOString(),
      });

      const result = await service.claimScheduledEpicRun(run.id);
      expect(result.claimed).toBe(false);
      expect(result.run.status).toBe('completed');
    });

    it('duplicate pending row cannot be claimed by two callers (regression)', async () => {
      const { run } = await service.createScheduledEpicRun({
        scheduleId: schedule.id,
        plannedFor: '2026-06-01T09:00:00.000Z',
        source: 'scheduler',
        status: 'pending',
      });

      const claim1 = await service.claimScheduledEpicRun(run.id);
      const claim2 = await service.claimScheduledEpicRun(run.id);

      const winners = [claim1, claim2].filter((c) => c.claimed);
      expect(winners).toHaveLength(1);
    });
  });

  // ==========================================
  // TEMPLATE TAGS JSON HANDLING
  // ==========================================

  describe('templateTags JSON handling', () => {
    it('persists and retrieves template tags correctly', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(
        makeScheduleInput(project.id, { templateTags: ['urgent', 'daily', 'standup'] }),
      );

      const fetched = await service.getScheduledEpic(schedule.id);
      expect(fetched.templateTags).toEqual(['urgent', 'daily', 'standup']);
    });

    it('defaults templateTags to empty array when not set', async () => {
      const project = await seedProject();
      const schedule = await service.createScheduledEpic(
        makeScheduleInput(project.id, { templateTags: [] }),
      );

      const fetched = await service.getScheduledEpic(schedule.id);
      expect(fetched.templateTags).toEqual([]);
    });
  });
});
