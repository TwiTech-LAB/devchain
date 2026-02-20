import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LazyFetchService } from '../services/lazy-fetch.service';
import { OverviewController } from './overview.controller';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('OverviewController', () => {
  let controller: OverviewController;
  let lazyFetchService: {
    fetchAllWorktreeStatuses: jest.Mock;
    listMergedEpics: jest.Mock;
    getMergedEpicHierarchy: jest.Mock;
  };

  beforeEach(async () => {
    lazyFetchService = {
      fetchAllWorktreeStatuses: jest.fn(),
      listMergedEpics: jest.fn(),
      getMergedEpicHierarchy: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OverviewController],
      providers: [{ provide: LazyFetchService, useValue: lazyFetchService }],
    }).compile();

    controller = module.get(OverviewController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns overview snapshots', async () => {
    lazyFetchService.fetchAllWorktreeStatuses.mockResolvedValue([
      {
        worktreeId: 'wt-1',
        worktreeName: 'feature-a',
        branchName: 'feature/a',
        status: 'running',
        git: { commitsAhead: 1, commitsBehind: 0 },
        fetchedAt: '2026-02-15T10:00:00.000Z',
      },
    ]);

    const result = await controller.listOverview();
    expect(result).toHaveLength(1);
    expect(result[0].worktreeId).toBe('wt-1');
    expect(lazyFetchService.fetchAllWorktreeStatuses).toHaveBeenCalledTimes(1);
  });

  it('passes optional merged-epics worktreeId filter', async () => {
    lazyFetchService.listMergedEpics.mockResolvedValue([
      {
        id: 'm-1',
        worktreeId: 'wt-1',
        devchainEpicId: 'epic-1',
        title: 'Epic',
        description: null,
        statusName: 'Done',
        statusColor: '#0f0',
        agentName: 'Coder',
        parentEpicId: null,
        tags: [],
        createdAtSource: null,
        mergedAt: '2026-02-15T10:00:00.000Z',
      },
    ]);

    const filtered = await controller.listMergedEpics('wt-1');
    expect(filtered).toHaveLength(1);
    expect(lazyFetchService.listMergedEpics).toHaveBeenCalledWith('wt-1');

    await controller.listMergedEpics(undefined);
    expect(lazyFetchService.listMergedEpics).toHaveBeenCalledWith(undefined);
  });

  it('rejects blank merged-epics worktreeId filter', async () => {
    await expect(controller.listMergedEpics('   ')).rejects.toThrow(BadRequestException);
    expect(lazyFetchService.listMergedEpics).not.toHaveBeenCalled();
  });

  it('returns merged epic hierarchy by worktreeId', async () => {
    lazyFetchService.getMergedEpicHierarchy.mockResolvedValue({
      worktreeId: 'wt-1',
      total: 1,
      roots: [
        {
          id: 'm-1',
          worktreeId: 'wt-1',
          devchainEpicId: 'epic-1',
          title: 'Epic',
          description: null,
          statusName: 'Done',
          statusColor: '#0f0',
          agentName: 'Coder',
          parentEpicId: null,
          tags: [],
          createdAtSource: null,
          mergedAt: '2026-02-15T10:00:00.000Z',
          children: [],
        },
      ],
    });

    const result = await controller.getMergedEpicHierarchy('wt-1');
    expect(result.worktreeId).toBe('wt-1');
    expect(lazyFetchService.getMergedEpicHierarchy).toHaveBeenCalledWith('wt-1');
  });
});
