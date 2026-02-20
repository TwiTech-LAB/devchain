import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WorktreeMergePreviewDto, WorktreeResponseDto } from '../dtos/worktree.dto';
import { OrchestratorDockerService } from '../../docker/services/docker.service';
import { WorktreesService } from '../services/worktrees.service';
import { WorktreesController } from './worktrees.controller';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('WorktreesController', () => {
  let controller: WorktreesController;
  let service: {
    createWorktree: jest.Mock;
    listWorktrees: jest.Mock;
    listByOwnerProject: jest.Mock;
    listWorktreeOverviews: jest.Mock;
    getWorktree: jest.Mock;
    getWorktreeOverview: jest.Mock;
    deleteWorktree: jest.Mock;
    startWorktree: jest.Mock;
    stopWorktree: jest.Mock;
    mergeWorktree: jest.Mock;
    previewMergeWorktree: jest.Mock;
    rebaseWorktree: jest.Mock;
    getWorktreeLogs: jest.Mock;
  };
  let dockerService: {
    ping: jest.Mock;
  };

  const sampleWorktree: WorktreeResponseDto = {
    id: 'wt-1',
    name: 'feature-auth',
    branchName: 'feature/auth',
    baseBranch: 'main',
    repoPath: '/repo',
    worktreePath: '/repo/worktrees/feature-auth',
    containerId: 'container-1',
    containerPort: 40123,
    templateSlug: '3-agent-dev',
    ownerProjectId: 'project-main',
    status: 'running',
    description: null,
    devchainProjectId: 'project-1',
    mergeCommit: null,
    mergeConflicts: null,
    errorMessage: null,
    commitsAhead: 1,
    commitsBehind: 0,
    runtimeType: 'container',
    processId: null,
    runtimeToken: null,
    startedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    service = {
      createWorktree: jest.fn(),
      listWorktrees: jest.fn(),
      listByOwnerProject: jest.fn(),
      listWorktreeOverviews: jest.fn(),
      getWorktree: jest.fn(),
      getWorktreeOverview: jest.fn(),
      deleteWorktree: jest.fn(),
      startWorktree: jest.fn(),
      stopWorktree: jest.fn(),
      mergeWorktree: jest.fn(),
      previewMergeWorktree: jest.fn(),
      rebaseWorktree: jest.fn(),
      getWorktreeLogs: jest.fn(),
    };
    dockerService = {
      ping: jest.fn().mockResolvedValue(true),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WorktreesController],
      providers: [
        { provide: WorktreesService, useValue: service },
        { provide: OrchestratorDockerService, useValue: dockerService },
      ],
    }).compile();

    controller = module.get(WorktreesController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('creates a worktree for valid payload', async () => {
    service.createWorktree.mockResolvedValue(sampleWorktree);

    const result = await controller.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
    });

    expect(service.createWorktree).toHaveBeenCalledWith({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      runtimeType: 'container',
    });
    expect(result.id).toBe('wt-1');
  });

  it('requires ownerProjectId in create payload', async () => {
    await expect(
      controller.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(service.createWorktree).not.toHaveBeenCalled();
  });

  it('defaults runtimeType to process when docker is unavailable', async () => {
    dockerService.ping.mockResolvedValue(false);
    service.createWorktree.mockResolvedValue({ ...sampleWorktree, runtimeType: 'process' });

    await controller.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
    });

    expect(service.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: 'process',
      }),
    );
  });

  it('rejects runtimeType=container when docker is unavailable', async () => {
    dockerService.ping.mockResolvedValue(false);

    await expect(
      controller.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
        runtimeType: 'container',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(service.createWorktree).not.toHaveBeenCalled();
  });

  it('refreshes docker availability after TTL expiration', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      dockerService.ping.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      service.createWorktree.mockResolvedValue(sampleWorktree);

      const payload = {
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
      };

      await controller.createWorktree(payload);
      await controller.createWorktree(payload);

      expect(dockerService.ping).toHaveBeenCalledTimes(1);
      expect(service.createWorktree).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ runtimeType: 'process' }),
      );
      expect(service.createWorktree).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ runtimeType: 'process' }),
      );

      jest.setSystemTime(new Date('2026-01-01T00:01:01.000Z'));
      await controller.createWorktree(payload);

      expect(dockerService.ping).toHaveBeenCalledTimes(2);
      expect(service.createWorktree).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ runtimeType: 'container' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('deduplicates concurrent docker availability checks', async () => {
    const pingDeferred = createDeferred<boolean>();
    dockerService.ping.mockReturnValueOnce(pingDeferred.promise);
    service.createWorktree.mockResolvedValue(sampleWorktree);

    const payload = {
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
    };

    const first = controller.createWorktree(payload);
    const second = controller.createWorktree(payload);

    expect(dockerService.ping).toHaveBeenCalledTimes(1);

    pingDeferred.resolve(true);
    await Promise.all([first, second]);

    expect(dockerService.ping).toHaveBeenCalledTimes(1);
    expect(service.createWorktree).toHaveBeenCalledTimes(2);
    expect(service.createWorktree).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runtimeType: 'container' }),
    );
    expect(service.createWorktree).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runtimeType: 'container' }),
    );
  });

  it('rejects invalid create payload', async () => {
    await expect(controller.createWorktree({ name: '' })).rejects.toThrow(BadRequestException);
    expect(service.createWorktree).not.toHaveBeenCalled();
  });

  it('rejects invalid worktree names at controller validation', async () => {
    const invalidNames = ['../', '.', 'has space', 'feature-ümlaut', 'a'.repeat(64)];

    for (const name of invalidNames) {
      await expect(
        controller.createWorktree({
          name,
          branchName: 'feature/auth',
          baseBranch: 'main',
          templateSlug: '3-agent-dev',
          ownerProjectId: 'project-main',
        }),
      ).rejects.toThrow(BadRequestException);
    }

    expect(service.createWorktree).not.toHaveBeenCalled();
  });

  it('rejects invalid branch names at controller validation', async () => {
    await expect(
      controller.createWorktree({
        name: 'feature-auth',
        branchName: 'feature .. bad',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      controller.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main..bad',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(service.createWorktree).not.toHaveBeenCalled();
  });

  it('passes presetName to service when provided', async () => {
    service.createWorktree.mockResolvedValue(sampleWorktree);

    await controller.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      presetName: 'Tier-A[opus]',
    });

    expect(service.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        presetName: 'Tier-A[opus]',
      }),
    );
  });

  it('accepts omitted presetName', async () => {
    service.createWorktree.mockResolvedValue(sampleWorktree);

    await controller.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
    });

    expect(service.createWorktree).toHaveBeenCalledWith(
      expect.not.objectContaining({ presetName: expect.anything() }),
    );
  });

  it('rejects empty string presetName', async () => {
    await expect(
      controller.createWorktree({
        name: 'feature-auth',
        branchName: 'feature/auth',
        baseBranch: 'main',
        templateSlug: '3-agent-dev',
        ownerProjectId: 'project-main',
        presetName: '',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(service.createWorktree).not.toHaveBeenCalled();
  });

  it('lists worktrees', async () => {
    service.listWorktrees.mockResolvedValue([sampleWorktree]);
    const result = await controller.listWorktrees({});
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('feature-auth');
  });

  it('lists worktrees filtered by ownerProjectId when query is provided', async () => {
    service.listByOwnerProject.mockResolvedValue([sampleWorktree]);

    const result = await controller.listWorktrees({ ownerProjectId: 'project-main' });

    expect(service.listByOwnerProject).toHaveBeenCalledWith('project-main');
    expect(service.listWorktrees).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it('rejects empty ownerProjectId query when listing worktrees', async () => {
    await expect(controller.listWorktrees({ ownerProjectId: '' })).rejects.toThrow(
      BadRequestException,
    );
    expect(service.listByOwnerProject).not.toHaveBeenCalled();
  });

  it('lists worktree overviews', async () => {
    service.listWorktreeOverviews.mockResolvedValue([
      {
        worktree: sampleWorktree,
        epics: { total: 4, done: 2 },
        agents: { total: 3 },
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = await controller.listWorktreeOverviews({});
    expect(result).toHaveLength(1);
    expect(result[0].worktree.id).toBe(sampleWorktree.id);
    expect(service.listWorktreeOverviews).toHaveBeenCalledWith(undefined);
  });

  it('lists worktree overviews filtered by ownerProjectId when query is provided', async () => {
    service.listWorktreeOverviews.mockResolvedValue([
      {
        worktree: sampleWorktree,
        epics: { total: 2, done: 1 },
        agents: { total: 1 },
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const result = await controller.listWorktreeOverviews({ ownerProjectId: 'project-main' });

    expect(service.listWorktreeOverviews).toHaveBeenCalledWith('project-main');
    expect(result).toHaveLength(1);
  });

  it('rejects empty ownerProjectId query when listing worktree overviews', async () => {
    await expect(controller.listWorktreeOverviews({ ownerProjectId: '' })).rejects.toThrow(
      BadRequestException,
    );
    expect(service.listWorktreeOverviews).not.toHaveBeenCalled();
  });

  it('gets a worktree by id', async () => {
    service.getWorktree.mockResolvedValue(sampleWorktree);
    const result = await controller.getWorktree('wt-1');
    expect(service.getWorktree).toHaveBeenCalledWith('wt-1');
    expect(result.id).toBe('wt-1');
  });

  it('gets a worktree overview by id', async () => {
    service.getWorktreeOverview.mockResolvedValue({
      worktree: sampleWorktree,
      epics: { total: 5, done: 3 },
      agents: { total: 2 },
      fetchedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await controller.getWorktreeOverview('wt-1');
    expect(service.getWorktreeOverview).toHaveBeenCalledWith('wt-1');
    expect(result.worktree.id).toBe('wt-1');
  });

  it('bubbles not found from service', async () => {
    service.getWorktree.mockRejectedValue(new NotFoundException('missing'));
    await expect(controller.getWorktree('missing')).rejects.toThrow(NotFoundException);
  });

  it('deletes a worktree', async () => {
    service.deleteWorktree.mockResolvedValue({ success: true });
    const result = await controller.deleteWorktree('wt-1', {});
    expect(result).toEqual({ success: true });
    expect(service.deleteWorktree).toHaveBeenCalledWith('wt-1', { deleteBranch: true });
  });

  it('passes deleteBranch=false for delete requests when query disables branch cleanup', async () => {
    service.deleteWorktree.mockResolvedValue({ success: true });

    await controller.deleteWorktree('wt-1', { deleteBranch: 'false' });

    expect(service.deleteWorktree).toHaveBeenCalledWith('wt-1', { deleteBranch: false });
  });

  it('rejects invalid deleteBranch query values', async () => {
    await expect(controller.deleteWorktree('wt-1', { deleteBranch: 'nope' })).rejects.toThrow(
      BadRequestException,
    );
    expect(service.deleteWorktree).not.toHaveBeenCalled();
  });

  it('starts and stops a worktree', async () => {
    service.startWorktree.mockResolvedValue(sampleWorktree);
    service.stopWorktree.mockResolvedValue({ ...sampleWorktree, status: 'stopped' });
    service.mergeWorktree.mockResolvedValue({
      ...sampleWorktree,
      status: 'merged',
      mergeCommit: 'abc123',
    });

    const started = await controller.startWorktree('wt-1');
    const stopped = await controller.stopWorktree('wt-1');
    const merged = await controller.mergeWorktree('wt-1');

    expect(started.status).toBe('running');
    expect(stopped.status).toBe('stopped');
    expect(merged.status).toBe('merged');
  });

  it('returns merge preview and can rebase a worktree', async () => {
    const preview: WorktreeMergePreviewDto = {
      canMerge: false,
      commitsAhead: 3,
      commitsBehind: 1,
      filesChanged: 5,
      insertions: 120,
      deletions: 42,
      conflicts: [{ file: 'src/main.ts', type: 'merge' }],
    };

    service.previewMergeWorktree.mockResolvedValue(preview);
    service.rebaseWorktree.mockResolvedValue({ ...sampleWorktree, status: 'running' });

    const previewResult = await controller.previewMergeWorktree('wt-1');
    const rebased = await controller.rebaseWorktree('wt-1');

    expect(service.previewMergeWorktree).toHaveBeenCalledWith('wt-1');
    expect(previewResult.canMerge).toBe(false);
    expect(previewResult.conflicts[0]?.file).toBe('src/main.ts');
    expect(service.rebaseWorktree).toHaveBeenCalledWith('wt-1');
    expect(rebased.status).toBe('running');
  });

  it('returns logs with default tail', async () => {
    service.getWorktreeLogs.mockResolvedValue({ logs: 'line1\nline2\n' });
    const result = await controller.getWorktreeLogs('wt-1', {});
    expect(service.getWorktreeLogs).toHaveBeenCalledWith('wt-1', { tail: 200 });
    expect(result.logs).toContain('line1');
  });

  it('rejects invalid logs query', async () => {
    await expect(controller.getWorktreeLogs('wt-1', { tail: '0' })).rejects.toThrow(
      BadRequestException,
    );
  });
});
