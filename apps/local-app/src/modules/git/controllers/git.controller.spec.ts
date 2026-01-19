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

    it('passes ref and limit parameters', async () => {
      gitService.listCommits.mockResolvedValue([]);

      await controller.listCommits(projectId, 'main', '100');

      expect(gitService.listCommits).toHaveBeenCalledWith(projectId, {
        ref: 'main',
        limit: 100,
      });
    });

    it('throws BadRequestException for invalid projectId', async () => {
      await expect(controller.listCommits('not-a-uuid')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for non-existent project', async () => {
      gitService.listCommits.mockRejectedValue(new NotFoundError('Project', projectId));

      await expect(controller.listCommits(projectId)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for non-git project', async () => {
      gitService.listCommits.mockRejectedValue(
        new ValidationError('Project is not a git repository'),
      );

      await expect(controller.listCommits(projectId)).rejects.toThrow(BadRequestException);
    });
  });

  describe('GET /api/git/branches', () => {
    it('returns branches for a valid project', async () => {
      const branches = [
        { name: 'main', sha: 'abc123', isCurrent: true },
        { name: 'develop', sha: 'def456', isCurrent: false },
      ];
      gitService.listBranches.mockResolvedValue(branches);

      const result = await controller.listBranches(projectId);

      expect(result).toEqual(branches);
    });

    it('throws BadRequestException for invalid projectId', async () => {
      await expect(controller.listBranches('not-a-uuid')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for non-existent project', async () => {
      gitService.listBranches.mockRejectedValue(new NotFoundError('Project', projectId));

      await expect(controller.listBranches(projectId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /api/git/tags', () => {
    it('returns tags for a valid project', async () => {
      const tags = [
        { name: 'v1.0.0', sha: 'abc123' },
        { name: 'v1.1.0', sha: 'def456' },
      ];
      gitService.listTags.mockResolvedValue(tags);

      const result = await controller.listTags(projectId);

      expect(result).toEqual(tags);
    });

    it('throws BadRequestException for invalid projectId', async () => {
      await expect(controller.listTags('not-a-uuid')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for non-existent project', async () => {
      gitService.listTags.mockRejectedValue(new NotFoundError('Project', projectId));

      await expect(controller.listTags(projectId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /api/git/diff', () => {
    it('returns diff between two refs', async () => {
      const diffContent = 'diff --git a/file.txt b/file.txt\n...';
      gitService.getDiff.mockResolvedValue(diffContent);

      const result = await controller.getDiff(projectId, 'main', 'feature/test');

      expect(result).toEqual({ diff: diffContent });
      expect(gitService.getDiff).toHaveBeenCalledWith(projectId, 'main', 'feature/test');
    });

    it('throws BadRequestException for missing base ref', async () => {
      await expect(controller.getDiff(projectId, '', 'feature/test')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for missing head ref', async () => {
      await expect(controller.getDiff(projectId, 'main', '')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for non-existent project', async () => {
      gitService.getDiff.mockRejectedValue(new NotFoundError('Project', projectId));

      await expect(controller.getDiff(projectId, 'main', 'feature/test')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('GET /api/git/changed-files', () => {
    it('returns changed files between two refs', async () => {
      const changedFiles = [
        { path: 'src/index.ts', status: 'modified', additions: 10, deletions: 5 },
        { path: 'src/new.ts', status: 'added', additions: 20, deletions: 0 },
      ];
      gitService.getChangedFiles.mockResolvedValue(changedFiles as never);

      const result = await controller.getChangedFiles(projectId, 'main', 'feature/test');

      expect(result).toEqual(changedFiles);
      expect(gitService.getChangedFiles).toHaveBeenCalledWith(projectId, 'main', 'feature/test');
    });

    it('throws BadRequestException for missing base ref', async () => {
      await expect(controller.getChangedFiles(projectId, '', 'feature/test')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException for missing head ref', async () => {
      await expect(controller.getChangedFiles(projectId, 'main', '')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException for non-existent project', async () => {
      gitService.getChangedFiles.mockRejectedValue(new NotFoundError('Project', projectId));

      await expect(controller.getChangedFiles(projectId, 'main', 'feature/test')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
