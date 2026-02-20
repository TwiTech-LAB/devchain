import { EventEmitter2 } from '@nestjs/event-emitter';
import { GitWorktreeService } from '../../git/services/git-worktree.service';
import { OrchestratorDatabase } from '../../orchestrator-storage/db/orchestrator.provider';
import { mergedAgents, mergedEpics } from '../../../storage/db/schema';
import { OrchestratorDockerService } from '../../docker/services/docker.service';
import { SeedPreparationService } from '../../docker/services/seed-preparation.service';
import {
  CreateWorktreeRecordInput,
  UpdateWorktreeRecordInput,
  WorktreeRecord,
  WorktreesStore,
} from '../../worktrees/worktrees.store';
import { WorktreesService } from '../../worktrees/services/worktrees.service';
import { EventLogService } from '../../../events/services/event-log.service';
import {
  WORKTREE_TASK_MERGE_REQUESTED_EVENT,
  WorktreeTaskMergeRequestedEvent,
} from '../events/task-merge.events';
import { TaskMergeService } from './task-merge.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

class IntegrationStore implements WorktreesStore {
  private rows = new Map<string, WorktreeRecord>();

  constructor(initialRows: WorktreeRecord[]) {
    for (const row of initialRows) {
      this.rows.set(row.id, row);
    }
  }

  async create(data: CreateWorktreeRecordInput): Promise<WorktreeRecord> {
    const now = new Date();
    const id = String(data.id ?? `wt-${this.rows.size + 1}`);
    const row: WorktreeRecord = {
      id,
      name: String(data.name),
      branchName: String(data.branchName),
      baseBranch: String(data.baseBranch),
      repoPath: String(data.repoPath),
      worktreePath: (data.worktreePath as string | undefined) ?? null,
      containerId: (data.containerId as string | undefined) ?? null,
      containerPort: (data.containerPort as number | undefined) ?? null,
      templateSlug: String(data.templateSlug),
      ownerProjectId: String(data.ownerProjectId ?? 'project-1'),
      status: String(data.status ?? 'creating'),
      description: (data.description as string | undefined) ?? null,
      devchainProjectId: (data.devchainProjectId as string | undefined) ?? null,
      mergeCommit: (data.mergeCommit as string | undefined) ?? null,
      mergeConflicts: (data.mergeConflicts as string | undefined) ?? null,
      errorMessage: (data.errorMessage as string | undefined) ?? null,
      createdAt: (data.createdAt as Date | undefined) ?? now,
      updatedAt: (data.updatedAt as Date | undefined) ?? now,
    };
    this.rows.set(id, row);
    return row;
  }

  async list(): Promise<WorktreeRecord[]> {
    return [...this.rows.values()];
  }

  async listByOwnerProject(ownerProjectId: string): Promise<WorktreeRecord[]> {
    return [...this.rows.values()].filter((row) => row.ownerProjectId === ownerProjectId);
  }

  async getById(id: string): Promise<WorktreeRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async getByName(name: string): Promise<WorktreeRecord | null> {
    return [...this.rows.values()].find((row) => row.name === name) ?? null;
  }

  async getByContainerId(containerId: string): Promise<WorktreeRecord | null> {
    return [...this.rows.values()].find((row) => row.containerId === containerId) ?? null;
  }

  async listMonitored(): Promise<WorktreeRecord[]> {
    return [...this.rows.values()].filter(
      (row) => row.status === 'running' || row.status === 'error',
    );
  }

  async update(id: string, patch: UpdateWorktreeRecordInput): Promise<WorktreeRecord | null> {
    const current = this.rows.get(id);
    if (!current) {
      return null;
    }
    const updated: WorktreeRecord = {
      ...current,
      ...(patch as Partial<WorktreeRecord>),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

describe('Task merge workflow integration', () => {
  const originalFetch = global.fetch;

  let store: IntegrationStore;
  let eventEmitter: EventEmitter2;
  let insertedEpics: Array<typeof mergedEpics.$inferInsert>;
  let insertedAgents: Array<typeof mergedAgents.$inferInsert>;
  let worktreesService: WorktreesService;
  let taskMergeService: TaskMergeService;
  let eventLogService: jest.Mocked<Pick<EventLogService, 'recordPublished'>>;

  beforeEach(() => {
    insertedEpics = [];
    insertedAgents = [];

    const now = new Date('2026-02-15T10:00:00.000Z');
    store = new IntegrationStore([
      {
        id: 'wt-1',
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main',
        repoPath: '/repo',
        worktreePath: '/repo/worktrees/feature-auth',
        containerId: 'container-1',
        containerPort: 41001,
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-1',
        status: 'running',
        description: null,
        devchainProjectId: 'project-1',
        mergeCommit: null,
        mergeConflicts: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const tx = {
      insert: jest.fn((table: unknown) => ({
        values: jest.fn((values: unknown) => ({
          onConflictDoNothing: jest.fn(async () => {
            const rows = Array.isArray(values) ? values : [values];
            if (table === mergedEpics) {
              insertedEpics.push(...(rows as Array<typeof mergedEpics.$inferInsert>));
            } else if (table === mergedAgents) {
              insertedAgents.push(...(rows as Array<typeof mergedAgents.$inferInsert>));
            }
          }),
        })),
      })),
    };

    const db = {
      transaction: jest.fn(async (callback: (trx: typeof tx) => Promise<void>) => callback(tx)),
    } as unknown as OrchestratorDatabase;

    eventEmitter = new EventEmitter2({ wildcard: true, delimiter: '.' });

    taskMergeService = new TaskMergeService(store, db);
    eventEmitter.on(
      WORKTREE_TASK_MERGE_REQUESTED_EVENT,
      async (payload: WorktreeTaskMergeRequestedEvent) =>
        taskMergeService.handleTaskMergeRequested(payload),
    );

    const docker = {
      stopContainer: jest.fn().mockResolvedValue(undefined),
      removeContainer: jest.fn().mockResolvedValue(undefined),
      waitForHealthy: jest.fn().mockResolvedValue(true),
      createContainer: jest.fn(),
      startContainer: jest.fn(),
      getContainerLogs: jest.fn(),
      subscribeToContainerEvents: jest.fn(async () => () => undefined),
    } as unknown as OrchestratorDockerService;

    const git = {
      executeMerge: jest.fn().mockResolvedValue({
        sourceBranch: 'feature/auth',
        targetBranch: 'main',
        success: true,
        mergeCommit: 'abc123',
        output: 'merged',
      }),
      getWorkingTreeStatus: jest.fn().mockResolvedValue({
        clean: true,
        output: '',
      }),
      getBranchStatus: jest.fn().mockResolvedValue({
        baseBranch: 'main',
        branchName: 'feature/auth',
        commitsAhead: 0,
        commitsBehind: 0,
      }),
    } as unknown as GitWorktreeService;

    const seed = {
      prepareSeedData: jest.fn(),
    } as unknown as SeedPreparationService;

    eventLogService = {
      recordPublished: jest
        .fn()
        .mockResolvedValue({ id: 'event-1', publishedAt: '2026-02-18T00:00:00.000Z' }),
    };

    worktreesService = new WorktreesService(
      store,
      docker,
      git,
      seed,
      eventEmitter,
      eventLogService as unknown as EventLogService,
    );

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'epic-root',
                title: 'Root',
                statusId: 'done-status',
                parentId: null,
                agentId: 'agent-1',
                tags: ['phase:4'],
              },
              {
                id: 'epic-child',
                title: 'Child',
                statusId: 'todo-status',
                parentId: 'epic-root',
                agentId: 'agent-2',
                tags: [],
              },
            ],
          }),
        } as Response;
      }

      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'agent-1', name: 'Coder', profileId: 'coder-profile', epicsCompleted: 4 },
              { id: 'agent-2', name: 'Reviewer', profileId: 'reviewer-profile' },
            ],
          }),
        } as Response;
      }

      if (url.includes('/api/statuses')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'done-status', label: 'Done', color: '#28a745' },
              { id: 'todo-status', label: 'To Do', color: '#6c757d' },
            ],
          }),
        } as Response;
      }

      if (url.includes('/api/agent-profiles')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'coder-profile', name: 'Architect/Planner' },
              { id: 'reviewer-profile', name: 'Reviewer' },
            ],
          }),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
    eventEmitter.removeAllListeners();
  });

  it('merge workflow triggers task extraction and populates merged tables', async () => {
    const merged = await worktreesService.mergeWorktree('wt-1');

    expect(merged.status).toBe('merged');
    expect(merged.mergeCommit).toBe('abc123');
    expect(insertedEpics).toHaveLength(2);
    expect(insertedAgents).toHaveLength(2);

    const child = insertedEpics.find((row) => row.devchainEpicId === 'epic-child');
    expect(child?.parentEpicId).toBe('epic-root');
    expect(child?.statusName).toBe('To Do');
    expect(child?.statusColor).toBe('#6c757d');

    const agent = insertedAgents.find((row) => row.devchainAgentId === 'agent-1');
    expect(agent?.name).toBe('Coder');
    expect(agent?.profileName).toBe('Architect/Planner');
    expect(agent?.epicsCompleted).toBe(4);
  });
});
