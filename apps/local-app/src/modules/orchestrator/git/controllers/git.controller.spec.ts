import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrchestratorGitController } from './git.controller';
import { GitWorktreeService } from '../services/git-worktree.service';
import { NotFoundError } from '../../../../common/errors/error-types';
import { STORAGE_SERVICE } from '../../../storage/interfaces/storage.interface';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('OrchestratorGitController', () => {
  let controller: OrchestratorGitController;
  let gitWorktreeService: { listBranches: jest.Mock };
  let storage: { getProject: jest.Mock };
  const ownerProjectId = '550e8400-e29b-41d4-a716-446655440000';
  const rootPath = '/tmp/project-main';

  beforeEach(async () => {
    gitWorktreeService = {
      listBranches: jest.fn(),
    };
    storage = {
      getProject: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrchestratorGitController],
      providers: [
        { provide: GitWorktreeService, useValue: gitWorktreeService },
        { provide: STORAGE_SERVICE, useValue: storage },
      ],
    }).compile();

    controller = module.get(OrchestratorGitController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('returns local branches in response envelope', async () => {
    storage.getProject.mockResolvedValue({ id: ownerProjectId, rootPath });
    gitWorktreeService.listBranches.mockResolvedValue(['main', 'feature/auth']);

    await expect(controller.listBranches({ ownerProjectId })).resolves.toEqual({
      branches: ['main', 'feature/auth'],
    });
    expect(storage.getProject).toHaveBeenCalledWith(ownerProjectId);
    expect(gitWorktreeService.listBranches).toHaveBeenCalledWith(rootPath);
  });

  it('returns empty branches array when repository has no local branches', async () => {
    storage.getProject.mockResolvedValue({ id: ownerProjectId, rootPath });
    gitWorktreeService.listBranches.mockResolvedValue([]);

    await expect(controller.listBranches({ ownerProjectId })).resolves.toEqual({ branches: [] });
    expect(storage.getProject).toHaveBeenCalledWith(ownerProjectId);
    expect(gitWorktreeService.listBranches).toHaveBeenCalledWith(rootPath);
  });

  it('throws BadRequestException for invalid ownerProjectId', async () => {
    await expect(controller.listBranches({ ownerProjectId: 'not-a-uuid' })).rejects.toThrow(
      BadRequestException,
    );
    expect(storage.getProject).not.toHaveBeenCalled();
    expect(gitWorktreeService.listBranches).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when owner project does not exist', async () => {
    storage.getProject.mockRejectedValue(new NotFoundError('Project', ownerProjectId));

    await expect(controller.listBranches({ ownerProjectId })).rejects.toThrow(NotFoundException);
    expect(gitWorktreeService.listBranches).not.toHaveBeenCalled();
  });

  it('throws BadRequestException when project root is not a git repository', async () => {
    storage.getProject.mockResolvedValue({ id: ownerProjectId, rootPath });
    gitWorktreeService.listBranches.mockRejectedValue(
      new Error('fatal: not a git repository (or any of the parent directories): .git'),
    );

    await expect(controller.listBranches({ ownerProjectId })).rejects.toThrow(BadRequestException);
  });
});
