import { NotFoundException } from '@nestjs/common';
import { GitWorktreeService } from '../../git/services/git-worktree.service';
import { OrchestratorDatabase } from '../../orchestrator-storage/db/orchestrator.provider';
import { mergedAgents, mergedEpics } from '../../../storage/db/schema';
import {
  CreateWorktreeRecordInput,
  UpdateWorktreeRecordInput,
  WorktreeRecord,
  WorktreesStore,
} from '../../worktrees/worktrees.store';
import { LazyFetchService } from './lazy-fetch.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

class InMemoryWorktreesStore implements WorktreesStore {
  private rows = new Map<string, WorktreeRecord>();

  constructor(initialRows: WorktreeRecord[]) {
    for (const row of initialRows) {
      this.rows.set(row.id, row);
    }
  }

  async create(data: CreateWorktreeRecordInput): Promise<WorktreeRecord> {
    const id = String(data.id ?? `wt-${this.rows.size + 1}`);
    const now = new Date();
    const created: WorktreeRecord = {
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
    this.rows.set(created.id, created);
    return created;
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

describe('LazyFetchService', () => {
  const originalFetch = global.fetch;

  let store: InMemoryWorktreesStore;
  let gitService: jest.Mocked<Pick<GitWorktreeService, 'getBranchStatus'>>;
  let service: LazyFetchService;
  let mergedEpicRows: Array<typeof mergedEpics.$inferSelect>;
  let mergedAgentRows: Array<typeof mergedAgents.$inferSelect>;
  let dbSelectMock: jest.Mock;
  let mergedEpicWhereArgs: unknown[];

  function createRow(
    input: Partial<WorktreeRecord> & Pick<WorktreeRecord, 'id' | 'name' | 'repoPath'>,
  ): WorktreeRecord {
    const now = new Date('2026-02-15T10:00:00.000Z');
    return {
      id: input.id,
      name: input.name,
      branchName: input.branchName ?? 'feature/test',
      baseBranch: input.baseBranch ?? 'main',
      repoPath: input.repoPath,
      worktreePath: input.worktreePath ?? null,
      containerId: input.containerId ?? null,
      containerPort: input.containerPort ?? null,
      templateSlug: input.templateSlug ?? '3-agent-dev',
      ownerProjectId: input.ownerProjectId ?? 'project-1',
      status: input.status ?? 'running',
      description: input.description ?? null,
      devchainProjectId: input.devchainProjectId ?? null,
      mergeCommit: input.mergeCommit ?? null,
      mergeConflicts: input.mergeConflicts ?? null,
      errorMessage: input.errorMessage ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
  }

  beforeEach(() => {
    mergedEpicRows = [];
    mergedAgentRows = [];
    mergedEpicWhereArgs = [];
    store = new InMemoryWorktreesStore([]);
    gitService = {
      getBranchStatus: jest.fn(),
    };

    const summarizeByWorktree = (
      rows: Array<{ worktreeId: string; mergedAt: Date }>,
    ): Array<{ worktreeId: string; rowCount: number; mergedAt: Date }> => {
      const grouped = new Map<string, { rowCount: number; mergedAt: Date }>();
      for (const row of rows) {
        const current = grouped.get(row.worktreeId);
        if (!current) {
          grouped.set(row.worktreeId, { rowCount: 1, mergedAt: row.mergedAt });
          continue;
        }
        current.rowCount += 1;
        if (row.mergedAt.getTime() > current.mergedAt.getTime()) {
          current.mergedAt = row.mergedAt;
        }
      }
      return [...grouped.entries()].map(([worktreeId, entry]) => ({
        worktreeId,
        rowCount: entry.rowCount,
        mergedAt: entry.mergedAt,
      }));
    };

    dbSelectMock = jest.fn((selection?: Record<string, unknown>) => {
      const isAggregate = Boolean(
        selection && typeof selection === 'object' && 'rowCount' in selection,
      );
      return {
        from: jest.fn((table: unknown) => {
          const sourceRows =
            table === mergedEpics ? mergedEpicRows : table === mergedAgents ? mergedAgentRows : [];

          if (isAggregate) {
            return {
              where: jest.fn(() => ({
                groupBy: jest.fn(async () =>
                  summarizeByWorktree(sourceRows as Array<{ worktreeId: string; mergedAt: Date }>),
                ),
              })),
            };
          }

          return {
            where: jest.fn(async (condition: unknown) => {
              if (table === mergedEpics) {
                mergedEpicWhereArgs.push(condition);
              }
              return sourceRows;
            }),
          };
        }),
      };
    });

    const db = {
      select: dbSelectMock,
    } as unknown as OrchestratorDatabase;

    service = new LazyFetchService(store, gitService as unknown as GitWorktreeService, db);
  });

  afterEach(() => {
    jest.clearAllMocks();
    global.fetch = originalFetch;
  });

  it('fetches combined overview snapshots and reuses 30s cache', async () => {
    const runningWorktree = createRow({
      id: 'wt-running',
      name: 'feature-auth',
      repoPath: '/repo',
      status: 'running',
      containerPort: 41001,
      devchainProjectId: 'project-running',
    });
    const mergedWorktree = createRow({
      id: 'wt-merged',
      name: 'done-feature',
      repoPath: '/repo',
      status: 'merged',
      mergeCommit: 'abc123',
    });
    await store.create(runningWorktree);
    await store.create(mergedWorktree);

    mergedEpicRows.push({
      id: 'mepic-1',
      worktreeId: 'wt-merged',
      devchainEpicId: 'epic-a',
      title: 'Merged epic',
      description: null,
      statusName: 'Done',
      statusColor: '#0f0',
      agentName: 'Coder',
      parentEpicId: null,
      tags: [],
      createdAtSource: null,
      mergedAt: '2026-02-15T09:58:00.000Z',
    });
    mergedAgentRows.push({
      id: 'magent-1',
      worktreeId: 'wt-merged',
      devchainAgentId: 'agent-1',
      name: 'Coder',
      profileName: 'coder',
      epicsCompleted: 1,
      mergedAt: '2026-02-15T09:59:00.000Z',
    });

    gitService.getBranchStatus
      .mockResolvedValueOnce({
        baseBranch: 'main',
        branchName: 'feature/auth',
        commitsAhead: 3,
        commitsBehind: 1,
      })
      .mockResolvedValueOnce({
        baseBranch: 'main',
        branchName: 'done-feature',
        commitsAhead: 0,
        commitsBehind: 0,
      });

    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/api/epics')) {
        return {
          ok: true,
          json: async () => ({
            total: 2,
            items: [{ statusId: 'done' }, { statusId: 'todo' }],
          }),
        } as Response;
      }
      if (url.includes('/api/agents')) {
        return {
          ok: true,
          json: async () => ({
            total: 2,
            items: [{ status: 'active' }, { status: 'idle' }],
          }),
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    const first = await service.fetchAllWorktreeStatuses();
    const second = await service.fetchAllWorktreeStatuses();

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(dbSelectMock).toHaveBeenCalledTimes(2);
    expect(gitService.getBranchStatus).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    const runningSnapshot = first.find((snapshot) => snapshot.worktreeId === 'wt-running');
    expect(runningSnapshot?.live?.epics.total).toBe(2);
    expect(runningSnapshot?.live?.epics.byStatus.done).toBe(1);
    expect(runningSnapshot?.live?.agents.total).toBe(2);
    expect(runningSnapshot?.git.commitsAhead).toBe(3);

    const mergedSnapshot = first.find((snapshot) => snapshot.worktreeId === 'wt-merged');
    expect(mergedSnapshot?.merged?.epicCount).toBe(1);
    expect(mergedSnapshot?.merged?.agentCount).toBe(1);
    expect(mergedSnapshot?.merged?.mergeCommit).toBe('abc123');
  });

  it('marks live data error when container requests fail', async () => {
    const runningWorktree = createRow({
      id: 'wt-running',
      name: 'feature-auth',
      repoPath: '/repo',
      status: 'running',
      containerPort: 41001,
      devchainProjectId: 'project-running',
    });
    await store.create(runningWorktree);

    gitService.getBranchStatus.mockResolvedValue({
      baseBranch: 'main',
      branchName: 'feature/auth',
      commitsAhead: 1,
      commitsBehind: 0,
    });

    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const snapshot = await service.fetchWorktreeStatus('wt-running');
    expect(snapshot.live?.error).toContain('ECONNREFUSED');
    expect(snapshot.live?.epics.total).toBe(0);
    expect(snapshot.git.commitsAhead).toBe(1);
  });

  it('returns merged epics list and hierarchy for a worktree', async () => {
    const mergedWorktree = createRow({
      id: 'wt-merged',
      name: 'done-feature',
      repoPath: '/repo',
      status: 'merged',
    });
    await store.create(mergedWorktree);

    mergedEpicRows.push(
      {
        id: 'mepic-root',
        worktreeId: 'wt-merged',
        devchainEpicId: 'epic-root',
        title: 'Root',
        description: null,
        statusName: 'Done',
        statusColor: '#0f0',
        agentName: 'Coder',
        parentEpicId: null,
        tags: ['phase:4'],
        createdAtSource: null,
        mergedAt: '2026-02-15T08:00:00.000Z',
      },
      {
        id: 'mepic-child',
        worktreeId: 'wt-merged',
        devchainEpicId: 'epic-child',
        title: 'Child',
        description: null,
        statusName: 'Done',
        statusColor: '#0f0',
        agentName: 'Coder',
        parentEpicId: 'epic-root',
        tags: [],
        createdAtSource: null,
        mergedAt: '2026-02-15T08:01:00.000Z',
      },
    );

    const flat = await service.listMergedEpics('wt-merged');
    const hierarchy = await service.getMergedEpicHierarchy('wt-merged');

    expect(flat).toHaveLength(2);
    expect(mergedEpicWhereArgs).toHaveLength(2);
    expect(hierarchy.total).toBe(2);
    expect(hierarchy.roots).toHaveLength(1);
    expect(hierarchy.roots[0].devchainEpicId).toBe('epic-root');
    expect(hierarchy.roots[0].children).toHaveLength(1);
    expect(hierarchy.roots[0].children[0].devchainEpicId).toBe('epic-child');
  });

  it('throws not found for unknown worktree ids', async () => {
    await expect(service.fetchWorktreeStatus('missing')).rejects.toThrow(NotFoundException);
    await expect(service.getMergedEpicHierarchy('missing')).rejects.toThrow(NotFoundException);
  });
});
