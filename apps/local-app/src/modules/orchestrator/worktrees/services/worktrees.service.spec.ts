import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as childProcess from 'child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { resetEnvConfig } from '../../../../common/config/env.config';
import { GitWorktreeService } from '../../git/services/git-worktree.service';
import { OrchestratorDockerService } from '../../docker/services/docker.service';
import { SeedPreparationService } from '../../docker/services/seed-preparation.service';
import { WORKTREE_TASK_MERGE_REQUESTED_EVENT } from '../../sync/events/task-merge.events';
import { WORKTREE_CHANGED_EVENT } from '../events/worktree.events';
import { EventLogService } from '../../../events/services/event-log.service';
import {
  CreateWorktreeRecordInput,
  UpdateWorktreeRecordInput,
  WorktreeRecord,
  WorktreesStore,
} from '../worktrees.store';
import { WorktreesService } from './worktrees.service';

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    spawn: jest.fn(),
  };
});

class InMemoryWorktreesStore implements WorktreesStore {
  private rows = new Map<string, WorktreeRecord>();
  private seq = 0;

  async create(data: CreateWorktreeRecordInput): Promise<WorktreeRecord> {
    this.seq += 1;
    const now = new Date();
    const row: WorktreeRecord = {
      id: `wt-${this.seq}`,
      name: data.name as string,
      branchName: data.branchName as string,
      baseBranch: data.baseBranch as string,
      repoPath: data.repoPath as string,
      worktreePath: (data.worktreePath as string | null | undefined) ?? null,
      containerId: (data.containerId as string | null | undefined) ?? null,
      containerPort: (data.containerPort as number | null | undefined) ?? null,
      templateSlug: data.templateSlug as string,
      ownerProjectId: (data.ownerProjectId as string | undefined) ?? 'project-1',
      status: (data.status as string) ?? 'creating',
      description: (data.description as string | null | undefined) ?? null,
      devchainProjectId: (data.devchainProjectId as string | null | undefined) ?? null,
      mergeCommit: (data.mergeCommit as string | null | undefined) ?? null,
      mergeConflicts: (data.mergeConflicts as string | null | undefined) ?? null,
      errorMessage: (data.errorMessage as string | null | undefined) ?? null,
      runtimeType: (data.runtimeType as string | undefined) ?? 'container',
      processId: (data.processId as number | null | undefined) ?? null,
      runtimeToken: (data.runtimeToken as string | null | undefined) ?? null,
      startedAt: (data.startedAt as Date | null | undefined) ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
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
    const existing = this.rows.get(id);
    if (!existing) {
      return null;
    }
    const updated: WorktreeRecord = {
      ...existing,
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

describe('WorktreesService', () => {
  const originalFetch = global.fetch;
  const originalDevchainMode = process.env.DEVCHAIN_MODE;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalRepoRoot = process.env.REPO_ROOT;
  const originalWorktreesRoot = process.env.WORKTREES_ROOT;
  const originalWorktreesDataRoot = process.env.WORKTREES_DATA_ROOT;

  let tempRoot: string;
  let repoPath: string;
  let store: InMemoryWorktreesStore;
  let docker: jest.Mocked<Partial<OrchestratorDockerService>>;
  let git: jest.Mocked<Partial<GitWorktreeService>>;
  let seedPreparation: jest.Mocked<Partial<SeedPreparationService>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync' | 'emit'>>;
  let eventLogService: jest.Mocked<Pick<EventLogService, 'recordPublished'>>;
  let service: WorktreesService;
  let dockerEventHandler:
    | ((event: { id?: string; status?: string; Action?: string }) => void)
    | null = null;

  beforeEach(async () => {
    delete process.env.DEVCHAIN_MODE;
    delete process.env.DATABASE_URL;
    delete process.env.REPO_ROOT;
    delete process.env.WORKTREES_ROOT;
    delete process.env.WORKTREES_DATA_ROOT;
    resetEnvConfig();

    tempRoot = await mkdtemp(join(tmpdir(), 'orchestrator-worktrees-service-'));
    repoPath = join(tempRoot, 'repo');
    await mkdir(repoPath, { recursive: true });

    store = new InMemoryWorktreesStore();
    docker = {
      cleanupWorktreeProjectContainers: jest.fn().mockResolvedValue(undefined),
      removeWorktreeNetwork: jest.fn().mockResolvedValue(undefined),
      ensureWorktreeOnComposeNetwork: jest.fn().mockResolvedValue(undefined),
      createContainer: jest.fn(),
      waitForHealthy: jest.fn(),
      removeContainer: jest.fn().mockResolvedValue(undefined),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      startContainer: jest.fn().mockResolvedValue(undefined),
      getContainerHostPort: jest.fn().mockResolvedValue(41002),
      getContainerLogs: jest.fn(),
      subscribeToContainerEvents: jest.fn(async (handler) => {
        dockerEventHandler = handler;
        return () => {
          dockerEventHandler = null;
        };
      }),
    };
    git = {
      createWorktree: jest.fn(),
      removeWorktree: jest.fn().mockResolvedValue(undefined),
      deleteBranch: jest.fn().mockResolvedValue(undefined),
      getBranchStatus: jest.fn().mockResolvedValue({
        baseBranch: 'main',
        branchName: 'feature/auth',
        commitsAhead: 1,
        commitsBehind: 0,
      }),
      getBranchChangeSummary: jest.fn().mockResolvedValue({
        raw: '1 file changed, 2 insertions(+), 1 deletion(-)',
        filesChanged: 1,
        insertions: 2,
        deletions: 1,
      }),
      getWorkingTreeStatus: jest.fn().mockResolvedValue({
        clean: true,
        output: '',
      }),
      previewMerge: jest.fn().mockResolvedValue({
        mergeBase: 'abc123',
        sourceBranch: 'feature/auth',
        targetBranch: 'main',
        hasConflicts: false,
        conflicts: [],
        output: '',
      }),
      executeMerge: jest.fn().mockResolvedValue({
        sourceBranch: 'feature/auth',
        targetBranch: 'main',
        success: true,
        mergeCommit: 'abc123',
        output: 'merged',
      }),
      executeRebase: jest.fn().mockResolvedValue({
        sourceBranch: 'feature/auth',
        targetBranch: 'main',
        success: true,
        conflicts: [],
        output: 'rebased',
      }),
    };
    seedPreparation = {
      prepareSeedData: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = {
      emitAsync: jest
        .fn()
        .mockResolvedValue([{ worktreeId: 'wt-1', epicsMerged: 2, agentsMerged: 2 }]),
      emit: jest.fn().mockReturnValue(true),
    };
    eventLogService = {
      recordPublished: jest
        .fn()
        .mockResolvedValue({ id: 'event-1', publishedAt: '2026-02-18T00:00:00.000Z' }),
    };

    service = new WorktreesService(
      store,
      docker as unknown as OrchestratorDockerService,
      git as unknown as GitWorktreeService,
      seedPreparation as unknown as SeedPreparationService,
      eventEmitter as unknown as EventEmitter2,
      eventLogService as unknown as EventLogService,
    );

    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/templates')) {
        return {
          ok: true,
          json: async () => ({ templates: [{ slug: '3-agent-dev' }] }),
        } as Response;
      }
      if (url.endsWith('/api/projects/from-template')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        return {
          ok: true,
          json: async () => ({ success: true, project: { id: body.projectId ?? 'project-1' } }),
        } as Response;
      }
      return {
        ok: false,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    if (originalDevchainMode === undefined) {
      delete process.env.DEVCHAIN_MODE;
    } else {
      process.env.DEVCHAIN_MODE = originalDevchainMode;
    }
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalRepoRoot === undefined) {
      delete process.env.REPO_ROOT;
    } else {
      process.env.REPO_ROOT = originalRepoRoot;
    }
    if (originalWorktreesRoot === undefined) {
      delete process.env.WORKTREES_ROOT;
    } else {
      process.env.WORKTREES_ROOT = originalWorktreesRoot;
    }
    if (originalWorktreesDataRoot === undefined) {
      delete process.env.WORKTREES_DATA_ROOT;
    } else {
      process.env.WORKTREES_DATA_ROOT = originalWorktreesDataRoot;
    }
    resetEnvConfig();
    global.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('creates a worktree and marks it running', async () => {
    docker.createContainer?.mockResolvedValue({
      id: 'container-1',
      name: 'devchain-wt-feature-auth',
      image: 'devchain:latest',
      hostPort: 41001,
      state: 'running',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    const result = await service.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      repoPath,
    });

    expect(result.status).toBe('running');
    expect(result.ownerProjectId).toBe('project-main');
    expect(result.containerId).toBe('container-1');
    const createContainerInput = docker.createContainer?.mock.calls[0]?.[0] as {
      env?: Record<string, string>;
    };
    const containerProjectId = createContainerInput.env?.CONTAINER_PROJECT_ID;
    expect(containerProjectId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const createProjectCall = (global.fetch as jest.Mock).mock.calls.find((call) =>
      String(call[0]).endsWith('/api/projects/from-template'),
    );
    const createProjectBody = JSON.parse((createProjectCall?.[1]?.body as string) ?? '{}') as {
      projectId?: string;
    };
    expect(createProjectBody.projectId).toBe(containerProjectId);
    expect(result.devchainProjectId).toBe(containerProjectId);
    expect(git.createWorktree).toHaveBeenCalledTimes(1);
    expect(seedPreparation.prepareSeedData).toHaveBeenCalledWith(
      join(repoPath, 'worktrees-data', 'feature-auth', 'data'),
    );
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(eventLogService.recordPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orchestrator.worktree.activity',
        payload: expect.objectContaining({
          ownerProjectId: 'project-main',
          worktreeName: 'feature-auth',
          type: 'created',
          message: "Worktree 'feature-auth' created on branch feature/auth",
        }),
      }),
    );
  });

  it('uses REPO_ROOT when repoPath is omitted in main mode', async () => {
    process.env.DEVCHAIN_MODE = 'main';
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/devchain';
    process.env.REPO_ROOT = repoPath;
    resetEnvConfig();

    docker.createContainer?.mockResolvedValue({
      id: 'container-1',
      name: 'devchain-wt-feature-auth',
      image: 'devchain:latest',
      hostPort: 41001,
      state: 'running',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    await service.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
    });

    expect(git.createWorktree).toHaveBeenCalledWith({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, '.devchain', 'worktrees', 'feature-auth'),
    });
  });

  it('fails and cleans up when seed preparation fails', async () => {
    seedPreparation.prepareSeedData = jest.fn().mockRejectedValue(new Error('seed failed'));

    await expect(
      service.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
        repoPath,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(git.removeWorktree).toHaveBeenCalled();
    expect(git.deleteBranch).toHaveBeenCalledWith('feature/auth', repoPath, true);
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('rejects duplicate worktree names', async () => {
    await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: '/tmp/worktree',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
    });

    await expect(
      service.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/other',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
        repoPath,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects unsafe worktree names at service layer', async () => {
    const invalidNames = ['', '../', '.', 'has space', 'feature-ümlaut', 'a'.repeat(64)];

    for (const name of invalidNames) {
      await expect(
        service.createWorktree({
          name,
          branchName: 'feature/auth',
          baseBranch: 'main',
          templateSlug: '3-agent-dev',
          ownerProjectId: 'project-main',
          repoPath,
        }),
      ).rejects.toThrow(BadRequestException);
    }

    expect(git.createWorktree).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('rejects invalid branch names at service layer', async () => {
    await expect(
      service.createWorktree({
        name: 'feature-auth',
        branchName: 'feature .. bad',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
        repoPath,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main..bad',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
        repoPath,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(git.createWorktree).not.toHaveBeenCalled();
  });

  it('marks worktree error and cleans up when create flow fails', async () => {
    docker.createContainer?.mockResolvedValue({
      id: 'container-1',
      name: 'devchain-wt-feature-auth',
      image: 'devchain:latest',
      hostPort: 41001,
      state: 'running',
    });
    docker.waitForHealthy?.mockResolvedValue(false);

    await expect(
      service.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
        repoPath,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(docker.removeContainer).toHaveBeenCalledWith('container-1', true);
    expect(git.removeWorktree).toHaveBeenCalled();
    expect(git.deleteBranch).toHaveBeenCalledWith('feature/auth', repoPath, true);
    const [row] = await store.list();
    expect(row.status).toBe('error');
  });

  it('starts and stops worktree containers', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
      containerId: 'container-1',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    const started = await service.startWorktree(row.id);
    expect(started.status).toBe('running');
    expect(eventLogService.recordPublished).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: 'orchestrator.worktree.activity',
        payload: expect.objectContaining({
          ownerProjectId: 'project-main',
          worktreeId: row.id,
          worktreeName: 'feature-auth',
          type: 'started',
          message: "Worktree 'feature-auth' started",
        }),
      }),
    );

    const stopped = await service.stopWorktree(row.id);
    expect(stopped.status).toBe('stopped');
    expect(eventLogService.recordPublished).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: 'orchestrator.worktree.activity',
        payload: expect.objectContaining({
          ownerProjectId: 'project-main',
          worktreeId: row.id,
          worktreeName: 'feature-auth',
          type: 'stopped',
          message: "Worktree 'feature-auth' stopped",
        }),
      }),
    );
  });

  it('creates a process worktree with worktreePath registration rootPath', async () => {
    const startProcessRuntimeSpy = jest
      .spyOn(
        service as unknown as { startProcessRuntime: (...args: unknown[]) => Promise<unknown> },
        'startProcessRuntime',
      )
      .mockResolvedValue({
        processId: 4321,
        hostPort: 43123,
        runtimeToken: 'runtime-token-1',
        startedAt: new Date('2026-02-17T00:00:00.000Z'),
      });

    const result = await service.createWorktree({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      repoPath,
      runtimeType: 'process',
    });

    expect(result.runtimeType).toBe('process');
    expect(result.processId).toBe(4321);
    expect(result.containerPort).toBe(43123);
    expect(result.runtimeToken).toBe('runtime-token-1');
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(startProcessRuntimeSpy).toHaveBeenCalledTimes(1);

    const createProjectCall = (global.fetch as jest.Mock).mock.calls.find((call) =>
      String(call[0]).endsWith('/api/projects/from-template'),
    );
    const createProjectBody = JSON.parse((createProjectCall?.[1]?.body as string) ?? '{}') as {
      rootPath?: string;
      projectId?: string;
    };
    expect(createProjectBody.rootPath).toBe(join(repoPath, 'worktrees', 'feature-process'));
    expect(createProjectBody.projectId).toBe(result.devchainProjectId);
  });

  it('forwards presetName to project registration in container runtime', async () => {
    docker.createContainer?.mockResolvedValue({
      id: 'container-1',
      name: 'devchain-wt-preset-test',
      image: 'devchain:latest',
      hostPort: 41001,
      state: 'running',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    await service.createWorktree({
      name: 'preset-test',
      branchName: 'feature/preset',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      repoPath,
      presetName: 'Tier-A[opus]',
    });

    const createProjectCall = (global.fetch as jest.Mock).mock.calls.find((call) =>
      String(call[0]).endsWith('/api/projects/from-template'),
    );
    const createProjectBody = JSON.parse((createProjectCall?.[1]?.body as string) ?? '{}') as {
      presetName?: string;
    };
    expect(createProjectBody.presetName).toBe('Tier-A[opus]');
  });

  it('forwards presetName to project registration in process runtime', async () => {
    jest
      .spyOn(
        service as unknown as { startProcessRuntime: (...args: unknown[]) => Promise<unknown> },
        'startProcessRuntime',
      )
      .mockResolvedValue({
        processId: 4321,
        hostPort: 43123,
        runtimeToken: 'runtime-token-1',
        startedAt: new Date('2026-02-17T00:00:00.000Z'),
      });

    await service.createWorktree({
      name: 'preset-process',
      branchName: 'feature/preset-process',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      repoPath,
      runtimeType: 'process',
      presetName: 'Tier-B[sonnet]',
    });

    const createProjectCall = (global.fetch as jest.Mock).mock.calls.find((call) =>
      String(call[0]).endsWith('/api/projects/from-template'),
    );
    const createProjectBody = JSON.parse((createProjectCall?.[1]?.body as string) ?? '{}') as {
      presetName?: string;
    };
    expect(createProjectBody.presetName).toBe('Tier-B[sonnet]');
  });

  it('omits presetName from project registration when not provided', async () => {
    docker.createContainer?.mockResolvedValue({
      id: 'container-1',
      name: 'devchain-wt-no-preset',
      image: 'devchain:latest',
      hostPort: 41001,
      state: 'running',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    await service.createWorktree({
      name: 'no-preset',
      branchName: 'feature/no-preset',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      repoPath,
    });

    const createProjectCall = (global.fetch as jest.Mock).mock.calls.find((call) =>
      String(call[0]).endsWith('/api/projects/from-template'),
    );
    const createProjectBody = JSON.parse((createProjectCall?.[1]?.body as string) ?? '{}') as {
      presetName?: string;
    };
    expect(createProjectBody).not.toHaveProperty('presetName');
  });

  it('starts process worktree runtime and stores pid/port/token', async () => {
    const row = await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-process'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
      runtimeType: 'process',
      devchainProjectId: '11111111-1111-4111-8111-111111111111',
    });

    jest
      .spyOn(
        service as unknown as { startProcessRuntime: (...args: unknown[]) => Promise<unknown> },
        'startProcessRuntime',
      )
      .mockResolvedValue({
        processId: 5555,
        hostPort: 45555,
        runtimeToken: 'runtime-token-2',
        startedAt: new Date('2026-02-17T00:01:00.000Z'),
      });

    const started = await service.startWorktree(row.id);
    expect(started.status).toBe('running');
    expect(started.runtimeType).toBe('process');
    expect(started.processId).toBe(5555);
    expect(started.containerPort).toBe(45555);
    expect(started.runtimeToken).toBe('runtime-token-2');
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('passes --port 0 and RUNTIME_PORT_FILE when spawning process runtime', async () => {
    const dataPath = join(repoPath, 'worktrees-data', 'feature-process', 'data');
    await mkdir(dataPath, { recursive: true });

    const spawnMock = childProcess.spawn as unknown as jest.Mock;
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      unref: jest.fn(),
    } as unknown as childProcess.ChildProcess);

    jest
      .spyOn(
        service as unknown as { awaitSpawn: (...args: unknown[]) => Promise<number> },
        'awaitSpawn',
      )
      .mockResolvedValue(7777);

    const pid = await (
      service as unknown as {
        spawnProcessRuntime: (input: {
          worktreePath: string;
          dataPath: string;
          projectId: string;
          runtimeToken: string;
        }) => Promise<number>;
      }
    ).spawnProcessRuntime({
      worktreePath: repoPath,
      dataPath,
      projectId: '11111111-1111-4111-8111-111111111111',
      runtimeToken: 'runtime-token-test',
    });

    expect(pid).toBe(7777);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(expect.arrayContaining(['--worktree-runtime', 'process', '--port', '0']));

    const env = spawnMock.mock.calls[0]?.[2]?.env as Record<string, string>;
    expect(env.PORT).toBe('0');
    expect(env.RUNTIME_TOKEN).toBe('runtime-token-test');
    expect(env.RUNTIME_PORT_FILE).toContain('runtime-port.json');
  });

  it('stops process worktree runtime and clears runtime metadata', async () => {
    const row = await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-process'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      runtimeType: 'process',
      processId: 9999,
      runtimeToken: 'runtime-token-3',
      containerPort: 49999,
      startedAt: new Date('2026-02-17T00:02:00.000Z'),
    });

    const terminateSpy = jest
      .spyOn(
        service as unknown as { terminateProcess: (pid?: number | null) => Promise<void> },
        'terminateProcess',
      )
      .mockResolvedValue(undefined);

    const stopped = await service.stopWorktree(row.id);
    expect(terminateSpy).toHaveBeenCalledWith(9999);
    expect(stopped.status).toBe('stopped');
    expect(stopped.processId).toBeNull();
    expect(stopped.runtimeToken).toBeNull();
    expect(stopped.containerPort).toBeNull();
  });

  it('escalates process termination from SIGTERM to SIGKILL when needed', async () => {
    const signalSpy = jest
      .spyOn(
        service as unknown as {
          signalProcessAndAwaitExit: (
            pid: number,
            signal: NodeJS.Signals,
            timeoutMs: number,
          ) => Promise<boolean>;
        },
        'signalProcessAndAwaitExit',
      )
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await (
      service as unknown as { terminateProcess: (pid?: number | null) => Promise<void> }
    ).terminateProcess(8888);

    expect(signalSpy).toHaveBeenNthCalledWith(1, 8888, 'SIGTERM', 30000);
    expect(signalSpy).toHaveBeenNthCalledWith(2, 8888, 'SIGKILL', 5000);
  });

  it('signals detached process group with negative pid during termination', async () => {
    const killSpy = jest.spyOn(process, 'kill').mockReturnValue(true);
    const isAliveSpy = jest
      .spyOn(service as unknown as { isProcessAlive: (pid: number) => boolean }, 'isProcessAlive')
      .mockReturnValue(false);

    try {
      const stillRunning = await (
        service as unknown as {
          signalProcessAndAwaitExit: (
            pid: number,
            signal: NodeJS.Signals,
            timeoutMs: number,
          ) => Promise<boolean>;
        }
      ).signalProcessAndAwaitExit(7777, 'SIGTERM', 0);

      expect(stillRunning).toBe(false);
      const expectedSignalPid = process.platform === 'win32' ? 7777 : -7777;
      expect(killSpy).toHaveBeenCalledWith(expectedSignalPid, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
      isAliveSpy.mockRestore();
    }
  });

  it('treats ESRCH from process-group signal as already exited', async () => {
    const error = new Error('missing process') as NodeJS.ErrnoException;
    error.code = 'ESRCH';
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });
    const isAliveSpy = jest.spyOn(
      service as unknown as { isProcessAlive: (pid: number) => boolean },
      'isProcessAlive',
    );

    try {
      const stillRunning = await (
        service as unknown as {
          signalProcessAndAwaitExit: (
            pid: number,
            signal: NodeJS.Signals,
            timeoutMs: number,
          ) => Promise<boolean>;
        }
      ).signalProcessAndAwaitExit(7777, 'SIGTERM', 30000);

      expect(stillRunning).toBe(false);
      expect(isAliveSpy).not.toHaveBeenCalled();
      const expectedSignalPid = process.platform === 'win32' ? 7777 : -7777;
      expect(killSpy).toHaveBeenCalledWith(expectedSignalPid, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
      isAliveSpy.mockRestore();
    }
  });

  it('deletes process worktree and skips docker cleanup', async () => {
    const worktreePath = join(repoPath, 'worktrees', 'feature-process');
    const dataPath = join(repoPath, 'worktrees-data', 'feature-process', 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, 'placeholder.txt'), 'x');

    const row = await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath,
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      runtimeType: 'process',
      processId: 1111,
    });

    const terminateSpy = jest
      .spyOn(
        service as unknown as { terminateProcess: (pid?: number | null) => Promise<void> },
        'terminateProcess',
      )
      .mockResolvedValue(undefined);

    const result = await service.deleteWorktree(row.id);
    expect(result).toEqual({ success: true });
    expect(terminateSpy).toHaveBeenCalledWith(1111);
    expect(docker.cleanupWorktreeProjectContainers).not.toHaveBeenCalled();
    expect(docker.removeWorktreeNetwork).not.toHaveBeenCalled();
    expect(git.removeWorktree).toHaveBeenCalledWith(worktreePath, repoPath, true);
  });

  it('throws when starting worktree without container', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
    });

    await expect(service.startWorktree(row.id)).rejects.toThrow(BadRequestException);
  });

  it('reads logs from process runtime log file', async () => {
    const dataPath = join(repoPath, 'worktrees-data', 'feature-process', 'data');
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, 'devchain.log'), 'line-1\nline-2\nline-3\n', 'utf8');

    const row = await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-process'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      runtimeType: 'process',
    });

    const result = await service.getWorktreeLogs(row.id, { tail: 2 });
    expect(result.logs).toBe('line-2\nline-3\n');
  });

  it('returns logs for worktree container', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });
    docker.getContainerLogs?.mockResolvedValue('line1\nline2\n');

    const result = await service.getWorktreeLogs(row.id, { tail: 50 });
    expect(result.logs).toContain('line1');
    expect(docker.getContainerLogs).toHaveBeenCalledWith('container-1', 50);
  });

  it('returns merge preview for a worktree', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
    });

    git.previewMerge?.mockResolvedValue({
      mergeBase: 'base123',
      sourceBranch: 'feature/auth',
      targetBranch: 'main',
      hasConflicts: true,
      conflicts: ['src/conflict.ts'],
      output: 'CONFLICT',
    });

    const preview = await service.previewMergeWorktree(row.id);
    expect(preview.canMerge).toBe(false);
    expect(preview.filesChanged).toBe(1);
    expect(preview.conflicts).toEqual([{ file: 'src/conflict.ts', type: 'merge' }]);
  });

  it('clears persisted mergeConflicts when preview reports clean merge state', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'error',
      mergeConflicts: 'src/conflict.ts',
    });

    git.previewMerge?.mockResolvedValue({
      mergeBase: 'base123',
      sourceBranch: 'feature/auth',
      targetBranch: 'main',
      hasConflicts: false,
      conflicts: [],
      output: '',
    });

    const preview = await service.previewMergeWorktree(row.id);
    expect(preview.canMerge).toBe(true);
    const updated = await store.getById(row.id);
    expect(updated?.mergeConflicts).toBeNull();
  });

  it('allows merge retry after conflict is resolved and clean preview clears conflict state', async () => {
    docker.waitForHealthy?.mockResolvedValue(true);

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'error',
      containerId: 'container-1',
      mergeConflicts: 'src/conflict.ts',
    });

    git.previewMerge?.mockResolvedValue({
      mergeBase: 'base123',
      sourceBranch: 'feature/auth',
      targetBranch: 'main',
      hasConflicts: false,
      conflicts: [],
      output: '',
    });

    const preview = await service.previewMergeWorktree(row.id);
    expect(preview.canMerge).toBe(true);

    const merged = await service.mergeWorktree(row.id);
    expect(merged.status).toBe('merged');
    expect(merged.mergeCommit).toBe('abc123');
  });

  it('merges worktree branch and marks it merged', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });

    const merged = await service.mergeWorktree(row.id);

    expect(eventEmitter.emitAsync).toHaveBeenCalledWith(WORKTREE_TASK_MERGE_REQUESTED_EVENT, {
      worktreeId: row.id,
    });
    expect(git.executeMerge!).toHaveBeenCalledWith(
      repoPath,
      'feature/auth',
      'main',
      expect.objectContaining({ message: 'Merge feature/auth' }),
    );
    expect(docker.stopContainer).toHaveBeenCalledWith('container-1');
    expect(merged.status).toBe('merged');
    expect(merged.mergeCommit).toBe('abc123');
    expect(eventLogService.recordPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orchestrator.worktree.activity',
        payload: expect.objectContaining({
          ownerProjectId: 'project-main',
          worktreeId: row.id,
          worktreeName: 'feature-auth',
          type: 'merged',
          message: "Worktree 'feature-auth' merged into main",
        }),
      }),
    );
  });

  it('auto-starts a stopped worktree container before merge-time task extraction', async () => {
    docker.waitForHealthy?.mockResolvedValue(true);
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
      containerId: 'container-1',
    });

    const merged = await service.mergeWorktree(row.id);

    expect(docker.startContainer).toHaveBeenCalledWith('container-1');
    expect(docker.waitForHealthy).toHaveBeenCalledWith('container-1', 60000);
    expect(eventEmitter.emitAsync).toHaveBeenCalledWith(WORKTREE_TASK_MERGE_REQUESTED_EVENT, {
      worktreeId: row.id,
    });
    expect(merged.status).toBe('merged');
  });

  it('recovers from initial extraction failure by restarting container and retrying once', async () => {
    docker.waitForHealthy?.mockResolvedValue(true);
    eventEmitter.emitAsync
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce([{ worktreeId: 'wt-1', epicsMerged: 2, agentsMerged: 2 }]);

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });

    const merged = await service.mergeWorktree(row.id);

    expect(docker.startContainer).toHaveBeenCalledWith('container-1');
    expect(eventEmitter.emitAsync).toHaveBeenCalledTimes(2);
    expect(merged.status).toBe('merged');
  });

  it('fails merge with actionable error when stopped container cannot be recovered', async () => {
    docker.waitForHealthy?.mockResolvedValue(false);

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
      containerId: 'container-1',
    });

    await expect(service.mergeWorktree(row.id)).rejects.toThrow(
      'Merge blocked: unable to start worktree container for task extraction',
    );
    expect(git.executeMerge).not.toHaveBeenCalled();
  });

  it('records merge conflicts and throws when merge fails', async () => {
    git.executeMerge!.mockResolvedValue({
      sourceBranch: 'feature/auth',
      targetBranch: 'main',
      success: false,
      conflicts: ['src/main.ts'],
      output: 'conflict in src/main.ts',
    });

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });

    await expect(service.mergeWorktree(row.id)).rejects.toThrow(ConflictException);

    expect(eventEmitter.emitAsync).toHaveBeenCalledWith(WORKTREE_TASK_MERGE_REQUESTED_EVENT, {
      worktreeId: row.id,
    });
    const updated = await store.getById(row.id);
    expect(updated?.status).toBe('error');
    expect(updated?.mergeConflicts).toContain('src/main.ts');
  });

  it('fails merge when task extraction fails and does not execute git merge', async () => {
    eventEmitter.emitAsync.mockRejectedValue(new Error('task extraction failed'));

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });

    await expect(service.mergeWorktree(row.id)).rejects.toThrow(BadRequestException);
    expect(git.executeMerge).not.toHaveBeenCalled();
    expect(docker.stopContainer).not.toHaveBeenCalled();

    const updated = await store.getById(row.id);
    expect(updated?.status).toBe('error');
    expect(updated?.errorMessage).toContain('Task extraction failed before merge');
  });

  it('stores non-conflict merge failures in errorMessage only and allows future retry', async () => {
    docker.waitForHealthy?.mockResolvedValue(true);
    git
      .executeMerge!.mockResolvedValueOnce({
        sourceBranch: 'feature/auth',
        targetBranch: 'main',
        success: false,
        output: 'fatal: remote unavailable',
      })
      .mockResolvedValueOnce({
        sourceBranch: 'feature/auth',
        targetBranch: 'main',
        success: true,
        mergeCommit: 'def456',
        output: 'merged',
      });

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });

    await expect(service.mergeWorktree(row.id)).rejects.toThrow(BadRequestException);

    const afterFailure = await store.getById(row.id);
    expect(afterFailure?.status).toBe('error');
    expect(afterFailure?.mergeConflicts).toBeNull();
    expect(afterFailure?.errorMessage).toContain('fatal: remote unavailable');

    const merged = await service.mergeWorktree(row.id);
    expect(merged.status).toBe('merged');
    expect(merged.mergeCommit).toBe('def456');
  });

  it('rebases a running worktree and restarts container', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    const rebased = await service.rebaseWorktree(row.id);

    expect(docker.stopContainer).toHaveBeenCalledWith('container-1');
    expect(git.executeRebase).toHaveBeenCalledWith(
      join(repoPath, 'worktrees', 'feature-auth'),
      'feature/auth',
      'main',
    );
    expect(docker.startContainer).toHaveBeenCalledWith('container-1');
    expect(rebased.status).toBe('running');
    expect(eventLogService.recordPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orchestrator.worktree.activity',
        payload: expect.objectContaining({
          ownerProjectId: 'project-main',
          worktreeId: row.id,
          worktreeName: 'feature-auth',
          type: 'rebased',
          message: "Worktree 'feature-auth' rebased onto main",
        }),
      }),
    );
  });

  it('returns 409 with conflict details when rebase has conflicts', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });
    git.executeRebase?.mockResolvedValue({
      sourceBranch: 'feature/auth',
      targetBranch: 'main',
      success: false,
      conflicts: ['src/rebase-conflict.ts'],
      output: 'CONFLICT (content): Merge conflict in src/rebase-conflict.ts',
    });

    await expect(service.rebaseWorktree(row.id)).rejects.toThrow(ConflictException);
    const updated = await store.getById(row.id);
    expect(updated?.status).toBe('error');
    expect(updated?.mergeConflicts).toContain('src/rebase-conflict.ts');
  });

  it('deletes worktree and removes resources', async () => {
    const worktreePath = join(repoPath, 'worktrees', 'feature-auth');
    const dataPath = join(repoPath, 'worktrees-data', 'feature-auth', 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, 'placeholder.txt'), 'x');

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath,
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });

    const result = await service.deleteWorktree(row.id);
    expect(result).toEqual({ success: true });
    expect(docker.cleanupWorktreeProjectContainers).toHaveBeenCalledWith(
      'feature-auth',
      'container-1',
    );
    expect(docker.stopContainer).toHaveBeenCalledWith('container-1');
    expect(docker.removeContainer).toHaveBeenCalledWith('container-1', true);
    expect(docker.removeWorktreeNetwork).toHaveBeenCalledWith('feature-auth');
    expect(git.removeWorktree).toHaveBeenCalledWith(worktreePath, repoPath, true);
    expect(git.deleteBranch).toHaveBeenCalledWith('feature/auth', repoPath, true);
    const removeWorktreeCallOrder = (git.removeWorktree as jest.Mock).mock.invocationCallOrder[0];
    const deleteBranchCallOrder = (git.deleteBranch as jest.Mock).mock.invocationCallOrder[0];
    expect(removeWorktreeCallOrder).toBeLessThan(deleteBranchCallOrder);
    expect(await store.getById(row.id)).toBeNull();
    expect(eventLogService.recordPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orchestrator.worktree.activity',
        payload: expect.objectContaining({
          ownerProjectId: 'project-main',
          worktreeId: row.id,
          worktreeName: 'feature-auth',
          type: 'deleted',
          message: "Worktree 'feature-auth' deleted",
        }),
      }),
    );
  });

  it('continues cleanup when branch deletion fails during worktree delete', async () => {
    const worktreePath = join(repoPath, 'worktrees', 'feature-auth');
    const dataPath = join(repoPath, 'worktrees-data', 'feature-auth', 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });
    await writeFile(join(dataPath, 'placeholder.txt'), 'x');

    git.deleteBranch?.mockRejectedValueOnce(new Error('failed to delete branch'));

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath,
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });

    await expect(service.deleteWorktree(row.id)).resolves.toEqual({ success: true });

    expect(git.removeWorktree).toHaveBeenCalledWith(worktreePath, repoPath, true);
    expect(git.deleteBranch).toHaveBeenCalledWith('feature/auth', repoPath, true);
    expect(docker.removeWorktreeNetwork).toHaveBeenCalledWith('feature-auth');
    expect(await store.getById(row.id)).toBeNull();
  });

  it('skips branch deletion when deleting a worktree on its base branch', async () => {
    const worktreePath = join(repoPath, 'worktrees', 'main-worktree');
    await mkdir(worktreePath, { recursive: true });

    const row = await store.create({
      name: 'main-worktree',
      branchName: 'main',
      baseBranch: 'main',
      repoPath,
      worktreePath,
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
    });

    await service.deleteWorktree(row.id);

    expect(git.removeWorktree).toHaveBeenCalledWith(worktreePath, repoPath, true);
    expect(git.deleteBranch).not.toHaveBeenCalled();
    expect(await store.getById(row.id)).toBeNull();
  });

  it('skips branch deletion when deleteBranch option is false', async () => {
    const worktreePath = join(repoPath, 'worktrees', 'feature-auth');
    await mkdir(worktreePath, { recursive: true });

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath,
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
    });

    await service.deleteWorktree(row.id, { deleteBranch: false });

    expect(git.removeWorktree).toHaveBeenCalledWith(worktreePath, repoPath, true);
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('rejects delete when stored worktree path escapes configured root', async () => {
    process.env.WORKTREES_ROOT = join(tempRoot, 'worktrees-root');
    resetEnvConfig();

    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: '/etc/passwd',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
    });

    await expect(service.deleteWorktree(row.id)).rejects.toThrow(BadRequestException);
    expect(git.removeWorktree).not.toHaveBeenCalled();
  });

  it('monitors readiness and marks worktree error after 3 failures', async () => {
    await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });
    docker.waitForHealthy?.mockResolvedValue(false);

    await service['monitorRunningWorktrees']();
    await service['monitorRunningWorktrees']();
    await service['monitorRunningWorktrees']();

    const [row] = await store.list();
    expect(row.status).toBe('error');
    expect(row.errorMessage).toContain('Readiness probe failed');
    expect(eventLogService.recordPublished).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'orchestrator.worktree.activity',
        payload: expect.objectContaining({
          ownerProjectId: 'project-main',
          worktreeName: 'feature-auth',
          type: 'error',
          message: expect.stringContaining("Worktree 'feature-auth' encountered an error:"),
        }),
      }),
    );
  });

  it('marks process worktree stopped when pid is no longer alive', async () => {
    const row = await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-process'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      runtimeType: 'process',
      processId: 3333,
      containerPort: 43333,
      runtimeToken: 'runtime-token',
      startedAt: new Date('2026-02-17T00:04:00.000Z'),
    });

    jest
      .spyOn(service as unknown as { isProcessAlive: (pid: number) => boolean }, 'isProcessAlive')
      .mockReturnValue(false);

    await service['monitorRunningWorktrees']();

    const updated = await store.getById(row.id);
    expect(updated?.status).toBe('stopped');
    expect(updated?.processId).toBeNull();
    expect(updated?.runtimeToken).toBeNull();
    expect(updated?.containerPort).toBeNull();
  });

  it('marks process worktree error after 3 readiness failures with live pid', async () => {
    await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-process'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      runtimeType: 'process',
      processId: 4444,
      containerPort: 44444,
      runtimeToken: 'runtime-token',
      startedAt: new Date('2026-02-17T00:05:00.000Z'),
    });

    jest
      .spyOn(service as unknown as { isProcessAlive: (pid: number) => boolean }, 'isProcessAlive')
      .mockReturnValue(true);
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/health/ready')) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await service['monitorRunningWorktrees']();
    await service['monitorRunningWorktrees']();
    await service['monitorRunningWorktrees']();

    const [row] = await store.list();
    expect(row.status).toBe('error');
    expect(row.errorMessage).toContain('Readiness probe failed');
  });

  it('restores process worktree from error to running when pid, readiness, and token are valid', async () => {
    const row = await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-process'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'error',
      runtimeType: 'process',
      processId: 5555,
      containerPort: 45555,
      runtimeToken: 'runtime-token-ok',
      errorMessage: 'Readiness probe failed 3 consecutive times',
      startedAt: new Date('2026-02-17T00:06:00.000Z'),
    });

    jest
      .spyOn(service as unknown as { isProcessAlive: (pid: number) => boolean }, 'isProcessAlive')
      .mockReturnValue(true);
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/health/ready')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.endsWith('/api/runtime')) {
        return { ok: true, json: async () => ({ runtimeToken: 'runtime-token-ok' }) } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await service['monitorRunningWorktrees']();

    const updated = await store.getById(row.id);
    expect(updated?.status).toBe('running');
    expect(updated?.errorMessage).toBeNull();
  });

  it('marks process worktree stopped when runtime token mismatches during monitor', async () => {
    const row = await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-process'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      runtimeType: 'process',
      processId: 6666,
      containerPort: 46666,
      runtimeToken: 'runtime-token-expected',
      startedAt: new Date('2026-02-17T00:07:00.000Z'),
    });

    jest
      .spyOn(service as unknown as { isProcessAlive: (pid: number) => boolean }, 'isProcessAlive')
      .mockReturnValue(true);
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/health/ready')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.endsWith('/api/runtime')) {
        return {
          ok: true,
          json: async () => ({ runtimeToken: 'runtime-token-other' }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    await service['monitorRunningWorktrees']();

    const updated = await store.getById(row.id);
    expect(updated?.status).toBe('stopped');
    expect(updated?.processId).toBeNull();
    expect(updated?.runtimeToken).toBeNull();
    expect(updated?.containerPort).toBeNull();
  });

  it('marks process runtime stale on startup when runtime token mismatches', async () => {
    const row = await store.create({
      name: 'feature-process',
      branchName: 'feature/process',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-process'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      runtimeType: 'process',
      processId: 2222,
      containerPort: 42222,
      runtimeToken: 'expected-token',
      startedAt: new Date('2026-02-17T00:03:00.000Z'),
    });

    jest
      .spyOn(service as unknown as { isProcessAlive: (pid: number) => boolean }, 'isProcessAlive')
      .mockReturnValue(true);
    global.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/api/runtime')) {
        return {
          ok: true,
          json: async () => ({ runtimeToken: 'different-token' }),
        } as Response;
      }
      return {
        ok: false,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;

    await (
      service as unknown as { reconcileProcessOrphans: () => Promise<void> }
    ).reconcileProcessOrphans();

    const updated = await store.getById(row.id);
    expect(updated?.status).toBe('stopped');
    expect(updated?.processId).toBeNull();
    expect(updated?.runtimeToken).toBeNull();
    expect(updated?.containerPort).toBeNull();
  });

  it('subscribes to docker events and marks running worktree stopped on die', async () => {
    const row = await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-1',
    });

    await service.onModuleInit();
    expect(docker.subscribeToContainerEvents).toHaveBeenCalledTimes(1);
    expect(dockerEventHandler).toBeTruthy();

    dockerEventHandler?.({ id: 'container-1', status: 'die' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const updated = await store.getById(row.id);
    expect(updated?.status).toBe('stopped');

    service.onModuleDestroy();
  });

  it('throws NotFound for unknown worktree', async () => {
    await expect(service.getWorktree('unknown')).rejects.toThrow(NotFoundException);
  });

  it('lists worktrees by owner project', async () => {
    await store.create({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-auth'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
    });
    await store.create({
      name: 'feature-billing',
      branchName: 'feature/billing',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-billing'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
    });
    await store.create({
      name: 'feature-other',
      branchName: 'feature/other',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-other'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-other',
      status: 'running',
    });

    const listByOwnerProjectSpy = jest.spyOn(store, 'listByOwnerProject');
    const results = await service.listByOwnerProject('project-main');

    expect(listByOwnerProjectSpy).toHaveBeenCalledWith('project-main');
    expect(results).toHaveLength(2);
    expect(results.map((row) => row.name).sort()).toEqual(['feature-auth', 'feature-billing']);
    expect(results.every((row) => row.ownerProjectId === 'project-main')).toBe(true);
  });

  it('lists worktree overviews by owner project', async () => {
    await store.create({
      name: 'feature-main-a',
      branchName: 'feature/main-a',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-main-a'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      devchainProjectId: null,
    });
    await store.create({
      name: 'feature-main-b',
      branchName: 'feature/main-b',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-main-b'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
      devchainProjectId: null,
    });
    await store.create({
      name: 'feature-other',
      branchName: 'feature/other',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-other'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-other',
      status: 'running',
      devchainProjectId: null,
    });

    const results = await service.listWorktreeOverviews('project-main');

    expect(results).toHaveLength(2);
    expect(results.map((row) => row.worktree.name).sort()).toEqual([
      'feature-main-a',
      'feature-main-b',
    ]);
    expect(results.every((row) => row.worktree.ownerProjectId === 'project-main')).toBe(true);
  });

  it('emits WORKTREE_CHANGED_EVENT after successful createWorktree', async () => {
    docker.createContainer?.mockResolvedValue({
      id: 'container-1',
      name: 'devchain-wt-feature-auth',
      image: 'devchain:latest',
      hostPort: 41001,
      state: 'running',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    await service.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      repoPath,
    });

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      WORKTREE_CHANGED_EVENT,
      expect.objectContaining({ worktreeId: expect.any(String) }),
    );
  });

  it('emits WORKTREE_CHANGED_EVENT after successful deleteWorktree', async () => {
    const worktreePath = join(repoPath, 'worktrees', 'feature-del');
    const dataPath = join(repoPath, 'worktrees-data', 'feature-del', 'data');
    await mkdir(worktreePath, { recursive: true });
    await mkdir(dataPath, { recursive: true });

    const row = await store.create({
      name: 'feature-del',
      branchName: 'feature/del',
      baseBranch: 'main',
      repoPath,
      worktreePath,
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-del',
    });

    await service.deleteWorktree(row.id);

    expect(eventEmitter.emit).toHaveBeenCalledWith(WORKTREE_CHANGED_EVENT, {
      worktreeId: row.id,
    });
  });

  it('emits WORKTREE_CHANGED_EVENT on status transition via start/stop', async () => {
    const row = await store.create({
      name: 'feature-evt',
      branchName: 'feature/evt',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-evt'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'stopped',
      containerId: 'container-evt',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    await service.startWorktree(row.id);

    expect(eventEmitter.emit).toHaveBeenCalledWith(WORKTREE_CHANGED_EVENT, {
      worktreeId: row.id,
    });

    eventEmitter.emit.mockClear();

    await service.stopWorktree(row.id);

    expect(eventEmitter.emit).toHaveBeenCalledWith(WORKTREE_CHANGED_EVENT, {
      worktreeId: row.id,
    });
  });

  it('does not emit WORKTREE_CHANGED_EVENT when status is unchanged', async () => {
    await store.create({
      name: 'feature-same',
      branchName: 'feature/same',
      baseBranch: 'main',
      repoPath,
      worktreePath: join(repoPath, 'worktrees', 'feature-same'),
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      status: 'running',
      containerId: 'container-same',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    await service.onModuleInit();
    expect(dockerEventHandler).toBeTruthy();

    // Trigger a docker "start" event which calls tryUpdateStatus(id, 'running')
    // Status is already 'running', so no change event should be emitted
    dockerEventHandler?.({ id: 'container-same', status: 'start' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The event should not be emitted because status was already 'running'
    expect(eventEmitter.emit).not.toHaveBeenCalledWith(WORKTREE_CHANGED_EVENT, expect.anything());
    expect(eventLogService.recordPublished).not.toHaveBeenCalled();

    service.onModuleDestroy();
  });

  it('continues worktree operations when event recording fails (fire-and-forget)', async () => {
    eventLogService.recordPublished.mockRejectedValueOnce(new Error('event sink unavailable'));
    docker.createContainer?.mockResolvedValue({
      id: 'container-1',
      name: 'devchain-wt-feature-auth',
      image: 'devchain:latest',
      hostPort: 41001,
      state: 'running',
    });
    docker.waitForHealthy?.mockResolvedValue(true);

    const result = await service.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      repoPath,
    });

    expect(result.status).toBe('running');
  });

  describe('port file discovery and token verification', () => {
    let spawnProcessRuntimeSpy: jest.SpyInstance;
    let waitForRuntimePortFileSpy: jest.SpyInstance;
    let waitForRuntimeHealthySpy: jest.SpyInstance;
    let terminateProcessSpy: jest.SpyInstance;

    beforeEach(() => {
      spawnProcessRuntimeSpy = jest.spyOn(
        service as unknown as {
          spawnProcessRuntime: (input: {
            worktreePath: string;
            dataPath: string;
            projectId: string;
            runtimeToken: string;
          }) => Promise<number>;
        },
        'spawnProcessRuntime',
      );

      waitForRuntimePortFileSpy = jest.spyOn(
        service as unknown as {
          waitForRuntimePortFile: (
            filePath: string,
            timeoutMs: number,
            pid?: number,
          ) => Promise<{ port: number; runtimeToken: string | null } | null>;
        },
        'waitForRuntimePortFile',
      );

      waitForRuntimeHealthySpy = jest.spyOn(
        service as unknown as {
          waitForRuntimeHealthy: (
            hostPort: number,
            timeoutMs: number,
            pid?: number,
          ) => Promise<boolean>;
        },
        'waitForRuntimeHealthy',
      );

      terminateProcessSpy = jest
        .spyOn(
          service as unknown as { terminateProcess: (pid?: number | null) => Promise<void> },
          'terminateProcess',
        )
        .mockResolvedValue(undefined);
    });

    it('proceeds when port file token matches and health check passes', async () => {
      spawnProcessRuntimeSpy.mockImplementation(async (input: { runtimeToken: string }) => {
        // Simulate child writing port file with matching token
        waitForRuntimePortFileSpy.mockResolvedValue({
          port: 43000,
          runtimeToken: input.runtimeToken,
        });
        return 8888;
      });
      waitForRuntimeHealthySpy.mockResolvedValue(true);

      const result = await (
        service as unknown as {
          startProcessRuntime: (input: {
            worktreePath: string;
            dataPath: string;
            projectId: string;
          }) => Promise<{
            processId: number;
            hostPort: number;
            runtimeToken: string;
            startedAt: Date;
          }>;
        }
      ).startProcessRuntime({
        worktreePath: repoPath,
        dataPath: join(repoPath, 'data'),
        projectId: 'project-1',
      });

      expect(result.processId).toBe(8888);
      expect(result.hostPort).toBe(43000);
      expect(result.runtimeToken).toBeDefined();
      expect(terminateProcessSpy).not.toHaveBeenCalled();
      expect(waitForRuntimeHealthySpy).toHaveBeenCalledWith(43000, expect.any(Number), 8888);
    });

    it('terminates PID and throws on port file token mismatch', async () => {
      spawnProcessRuntimeSpy.mockResolvedValue(8888);
      waitForRuntimePortFileSpy.mockResolvedValue({
        port: 43000,
        runtimeToken: 'wrong-token',
      });

      await expect(
        (
          service as unknown as {
            startProcessRuntime: (input: {
              worktreePath: string;
              dataPath: string;
              projectId: string;
            }) => Promise<unknown>;
          }
        ).startProcessRuntime({
          worktreePath: repoPath,
          dataPath: join(repoPath, 'data'),
          projectId: 'project-1',
        }),
      ).rejects.toThrow(/Runtime port file token mismatch/);

      expect(terminateProcessSpy).toHaveBeenCalledTimes(1);
      expect(terminateProcessSpy).toHaveBeenCalledWith(8888);
      expect(spawnProcessRuntimeSpy).toHaveBeenCalledTimes(1);
    });

    it('terminates PID and throws when port file is not written before timeout', async () => {
      spawnProcessRuntimeSpy.mockResolvedValue(8888);
      waitForRuntimePortFileSpy.mockResolvedValue(null);

      await expect(
        (
          service as unknown as {
            startProcessRuntime: (input: {
              worktreePath: string;
              dataPath: string;
              projectId: string;
            }) => Promise<unknown>;
          }
        ).startProcessRuntime({
          worktreePath: repoPath,
          dataPath: join(repoPath, 'data'),
          projectId: 'project-1',
        }),
      ).rejects.toThrow(/Process runtime did not report its port before timeout/);

      expect(terminateProcessSpy).toHaveBeenCalledTimes(1);
      expect(terminateProcessSpy).toHaveBeenCalledWith(8888);
    });

    it('fails fast when child process exits during health polling (PID dead)', async () => {
      const checkRuntimeReadySpy = jest
        .spyOn(
          service as unknown as {
            checkRuntimeReady: (hostPort: number) => Promise<boolean>;
          },
          'checkRuntimeReady',
        )
        .mockResolvedValue(false);

      const isProcessAliveSpy = jest
        .spyOn(service as unknown as { isProcessAlive: (pid: number) => boolean }, 'isProcessAlive')
        .mockReturnValue(false);

      // Restore the real waitForRuntimeHealthy so PID-alive check runs
      waitForRuntimeHealthySpy.mockRestore();

      const result = await (
        service as unknown as {
          waitForRuntimeHealthy: (
            hostPort: number,
            timeoutMs: number,
            pid?: number,
          ) => Promise<boolean>;
        }
      ).waitForRuntimeHealthy(43000, 60_000, 8888);

      expect(result).toBe(false);
      // Should return immediately — health check should NOT have been called
      // because PID-alive check fails first in the loop
      expect(checkRuntimeReadySpy).not.toHaveBeenCalled();
      expect(isProcessAliveSpy).toHaveBeenCalledWith(8888);

      checkRuntimeReadySpy.mockRestore();
      isProcessAliveSpy.mockRestore();
    });
  });
});
