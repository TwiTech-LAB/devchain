import {
  Controller,
  Get,
  Query,
  Param,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { GitService } from '../services/git.service';
import { createLogger } from '../../../common/logging/logger';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import {
  ListCommitsQuerySchema,
  ListBranchesQuerySchema,
  ListTagsQuerySchema,
  GetDiffQuerySchema,
  GetChangedFilesQuerySchema,
  WorkingTreeQuerySchema,
  GetCommitQuerySchema,
  CommitShaParamSchema,
} from '../dtos/git.dto';
import type { WorkingTreeFilter } from '../services/git.service';

const logger = createLogger('GitController');

/**
 * Helper to parse Zod validation and throw BadRequestException on error
 */
function parseOrThrow<T>(schema: { parse: (data: unknown) => T }, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) {
      const messages = error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
      throw new BadRequestException(`Validation failed: ${messages}`);
    }
    throw error;
  }
}

@Controller('api/git')
export class GitController {
  constructor(private readonly gitService: GitService) {}

  /**
   * List commits for a project
   * GET /api/git/commits?projectId=...&ref=...&limit=50
   */
  @Get('commits')
  async listCommits(
    @Query('projectId') projectId?: string,
    @Query('ref') ref?: string,
    @Query('limit') limit?: string,
  ) {
    logger.info({ projectId, ref, limit }, 'GET /api/git/commits');

    const query = parseOrThrow(ListCommitsQuerySchema, { projectId, ref, limit });

    try {
      return await this.gitService.listCommits(query.projectId, {
        ref: query.ref,
        limit: query.limit,
      });
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`Project not found: ${query.projectId}`);
      }
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * List branches for a project
   * GET /api/git/branches?projectId=...
   */
  @Get('branches')
  async listBranches(@Query('projectId') projectId?: string) {
    logger.info({ projectId }, 'GET /api/git/branches');

    const query = parseOrThrow(ListBranchesQuerySchema, { projectId });

    try {
      return await this.gitService.listBranches(query.projectId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`Project not found: ${query.projectId}`);
      }
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * List tags for a project
   * GET /api/git/tags?projectId=...
   */
  @Get('tags')
  async listTags(@Query('projectId') projectId?: string) {
    logger.info({ projectId }, 'GET /api/git/tags');

    const query = parseOrThrow(ListTagsQuerySchema, { projectId });

    try {
      return await this.gitService.listTags(query.projectId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`Project not found: ${query.projectId}`);
      }
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * Get unified diff between two refs
   * GET /api/git/diff?projectId=...&base=...&head=...
   */
  @Get('diff')
  async getDiff(
    @Query('projectId') projectId?: string,
    @Query('base') base?: string,
    @Query('head') head?: string,
  ) {
    logger.info({ projectId, base, head }, 'GET /api/git/diff');

    const query = parseOrThrow(GetDiffQuerySchema, { projectId, base, head });

    try {
      const diff = await this.gitService.getDiff(query.projectId, query.base, query.head);
      return { diff };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`Project not found: ${query.projectId}`);
      }
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * Get list of changed files between two refs with stats
   * GET /api/git/changed-files?projectId=...&base=...&head=...
   */
  @Get('changed-files')
  async getChangedFiles(
    @Query('projectId') projectId?: string,
    @Query('base') base?: string,
    @Query('head') head?: string,
  ) {
    logger.info({ projectId, base, head }, 'GET /api/git/changed-files');

    const query = parseOrThrow(GetChangedFilesQuerySchema, { projectId, base, head });

    try {
      return await this.gitService.getChangedFiles(query.projectId, query.base, query.head);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`Project not found: ${query.projectId}`);
      }
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * Get working tree changes (staged, unstaged, untracked files)
   * GET /api/git/working-tree?projectId=...&filter=all|staged|unstaged
   */
  @Get('working-tree')
  async getWorkingTree(@Query('projectId') projectId?: string, @Query('filter') filter?: string) {
    logger.info({ projectId, filter }, 'GET /api/git/working-tree');

    const query = parseOrThrow(WorkingTreeQuerySchema, { projectId, filter });

    try {
      // Use combined method that calls git ls-files --others only once
      const result = await this.gitService.getWorkingTreeData(
        query.projectId,
        query.filter as WorkingTreeFilter,
      );
      return {
        changes: result.changes,
        diff: result.diff,
        untrackedDiffsCapped: result.untrackedDiffsCapped,
        untrackedTotal: result.untrackedTotal,
        untrackedProcessed: result.untrackedProcessed,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`Project not found: ${query.projectId}`);
      }
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /**
   * Get diff and changed files for a specific commit
   * GET /api/git/commit/:sha?projectId=...
   */
  @Get('commit/:sha')
  async getCommit(@Param('sha') sha: string, @Query('projectId') projectId?: string) {
    logger.info({ projectId, sha }, 'GET /api/git/commit/:sha');

    const query = parseOrThrow(GetCommitQuerySchema, { projectId });
    const params = parseOrThrow(CommitShaParamSchema, { sha });

    try {
      const [diff, changedFiles] = await Promise.all([
        this.gitService.getCommitDiff(query.projectId, params.sha),
        this.gitService.getCommitChangedFiles(query.projectId, params.sha),
      ]);
      return { sha: params.sha, diff, changedFiles };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new NotFoundException(`Project not found: ${query.projectId}`);
      }
      if (error instanceof ValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
