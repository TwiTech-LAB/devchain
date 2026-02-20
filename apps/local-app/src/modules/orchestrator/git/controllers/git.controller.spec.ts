import { Test, TestingModule } from '@nestjs/testing';
import { OrchestratorGitController } from './git.controller';
import { GitWorktreeService } from '../services/git-worktree.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('OrchestratorGitController', () => {
  let controller: OrchestratorGitController;
  let gitWorktreeService: { listBranches: jest.Mock };

  beforeEach(async () => {
    gitWorktreeService = {
      listBranches: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrchestratorGitController],
      providers: [{ provide: GitWorktreeService, useValue: gitWorktreeService }],
    }).compile();

    controller = module.get(OrchestratorGitController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns local branches in response envelope', async () => {
    gitWorktreeService.listBranches.mockResolvedValue(['main', 'feature/auth']);

    await expect(controller.listBranches()).resolves.toEqual({
      branches: ['main', 'feature/auth'],
    });
    expect(gitWorktreeService.listBranches).toHaveBeenCalledTimes(1);
  });

  it('returns empty branches array when repository has no local branches', async () => {
    gitWorktreeService.listBranches.mockResolvedValue([]);

    await expect(controller.listBranches()).resolves.toEqual({ branches: [] });
    expect(gitWorktreeService.listBranches).toHaveBeenCalledTimes(1);
  });
});
