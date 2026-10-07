import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GitController } from './git.controller';
import { GitService } from '../services/git.service';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('GitController', () => {
  let controller: GitController;
  let gitService: jest.Mocked<
    Pick<GitService, 'listCommits' | 'listBranches' | 'listTags' | 'getDiff' | 'getChangedFiles'>
  >;

  const projectId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(async () => {
    gitService = {
      listCommits: jest.fn(),
      listBranches: jest.fn(),
      listTags: jest.fn(),
      getDiff: jest.fn(),
      getChangedFiles: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GitController],
      providers: [{ provide: GitService, useValue: gitService }],
    }).compile();

    controller = module.get(GitController);
  });

  describe('GET /api/git/commits', () => {
    it('returns commits for a valid project', async () => {
      const commits = [
        {
          sha: 'abc123',
          message: 'Test commit',
          author: 'Test User',
          authorEmail: 'test@example.com',
          date: '2024-01-01T00:00:00Z',
        },
      ];
      gitService.listCommits.mockResolvedValue(commits);

      const result = await controller.listCommits(projectId);

      expect(result).toEqual(commits);
      expect(gitService.listCommits).toHaveBeenCalledWith(projectId, {
        ref: undefined,
        limit: 50,
      });
    });

    it('throws BadRequestException for invalid projectId', async () => {
      await expect(controller.listCommits('not-a-uuid')).rejects.toThrow(BadRequestException);
    });

    it.each([
      {
        name: 'controller.listCommits NotFoundException',
        mock: () => gitService.listCommits,
        error: new NotFoundError('Project', projectId),
        invoke: () => controller.listCommits(projectId),
        exception: NotFoundException,
      },
      {
        name: 'controller.listCommits BadRequestException',
        mock: () => gitService.listCommits,
        error: new ValidationError('Project is not a git repository'),
        invoke: () => controller.listCommits(projectId),
        exception: BadRequestException,
      },
      {
        name: 'controller.listBranches NotFoundException',
        mock: () => gitService.listBranches,
        error: new NotFoundError('Project', projectId),
        invoke: () => controller.listBranches(projectId),
        exception: NotFoundException,
      },
      {
        name: 'controller.listTags NotFoundException',
        mock: () => gitService.listTags,
        error: new NotFoundError('Project', projectId),
        invoke: () => controller.listTags(projectId),
        exception: NotFoundException,
      },
      {
        name: 'controller.getDiff NotFoundException',
        mock: () => gitService.getDiff,
        error: new NotFoundError('Project', projectId),
        invoke: () => controller.getDiff(projectId, 'main', 'feature/test'),
        exception: NotFoundException,
      },
      {
        name: 'controller.getChangedFiles NotFoundException',
        mock: () => gitService.getChangedFiles,
        error: new NotFoundError('Project', projectId),
        invoke: () => controller.getChangedFiles(projectId, 'main', 'feature/test'),
        exception: NotFoundException,
      },
    ])('maps $name', async ({ mock, error, invoke, exception }) => {
      mock().mockRejectedValue(error);
      await expect(invoke()).rejects.toThrow(exception);
    });
  });
});
