import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import {
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '../../../common/errors/error-types';
import { ReviewsService } from '../services/reviews.service';
import {
  CreateReviewSchema,
  UpdateReviewSchema,
  ListReviewsQuerySchema,
  CreateCommentSchema,
  UpdateCommentSchema,
  ResolveCommentSchema,
  ListCommentsQuerySchema,
  ActiveReviewQuerySchema,
  CloseReviewSchema,
  mapSideToStorage,
  mapSideFromStorage,
} from '../dtos/review.dto';
import type { ReviewComment } from '../../storage/models/domain.models';

const logger = createLogger('ReviewsController');

/**
 * Transform comment to use API side convention ('old'/'new' instead of 'left'/'right')
 */
function transformCommentForApi<T extends ReviewComment>(comment: T): T {
  return {
    ...comment,
    side: mapSideFromStorage(comment.side),
  };
}

/**
 * Transform paginated comment list to use API side convention
 */
function transformCommentsForApi<T extends ReviewComment>(result: {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}): { items: T[]; total: number; limit: number; offset: number } {
  return {
    ...result,
    items: result.items.map(transformCommentForApi),
  };
}

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

/**
 * Helper to translate domain errors to HTTP exceptions
 */
function handleDomainError(error: unknown, resourceType: string, resourceId: string): never {
  if (error instanceof NotFoundError) {
    throw new NotFoundException(`${resourceType} not found: ${resourceId}`);
  }
  if (error instanceof OptimisticLockError) {
    throw new BadRequestException(
      `Version conflict: ${resourceType.toLowerCase()} has been modified`,
    );
  }
  if (error instanceof ValidationError) {
    throw new BadRequestException(error.message);
  }
  throw error;
}

/**
 * Reviews REST API Controller.
 * Handles HTTP concerns (request/response, DTO validation, error translation).
 * All business logic is delegated to ReviewsService.
 */
@Controller('api/reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /**
   * List reviews for a project
   * GET /api/reviews?projectId=xxx&status=xxx&limit=xxx&offset=xxx
   */
  @Get()
  async listReviews(
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
    @Query('epicId') epicId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    logger.info({ projectId, status, limit, offset }, 'GET /api/reviews');

    const query = parseOrThrow(ListReviewsQuerySchema, {
      projectId,
      status,
      epicId,
      limit,
      offset,
    });

    try {
      return await this.reviewsService.listReviews(query.projectId, {
        status: query.status,
        epicId: query.epicId,
        limit: query.limit,
        offset: query.offset,
      });
    } catch (error) {
      handleDomainError(error, 'Project', query.projectId);
    }
  }

  /**
   * Create a new review
   * POST /api/reviews
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createReview(@Body() body: unknown) {
    logger.info({ body }, 'POST /api/reviews');

    const data = parseOrThrow(CreateReviewSchema, body);

    try {
      return await this.reviewsService.createReview({
        projectId: data.projectId,
        epicId: data.epicId,
        title: data.title,
        description: data.description,
        status: data.status,
        mode: data.mode,
        baseRef: data.baseRef,
        headRef: data.headRef,
        baseSha: data.baseSha,
        headSha: data.headSha,
        createdBy: data.createdBy,
        createdByAgentId: data.createdByAgentId,
      });
    } catch (error) {
      handleDomainError(error, 'Project', data.projectId);
    }
  }

  /**
   * Get the most recent active (non-closed) review for a project.
   * IMPORTANT: This route MUST be defined BEFORE /:id to avoid being matched as an ID.
   * GET /api/reviews/active?projectId=...
   */
  @Get('active')
  async getActiveReview(@Query('projectId') projectId?: string) {
    logger.info({ projectId }, 'GET /api/reviews/active');

    const query = parseOrThrow(ActiveReviewQuerySchema, { projectId });

    try {
      const review = await this.reviewsService.getActiveReview(query.projectId);
      return { review };
    } catch (error) {
      handleDomainError(error, 'Project', query.projectId);
    }
  }

  /**
   * Get a review by ID
   * GET /api/reviews/:id
   */
  @Get(':id')
  async getReview(@Param('id') id: string) {
    logger.info({ id }, 'GET /api/reviews/:id');

    try {
      return await this.reviewsService.getReview(id);
    } catch (error) {
      handleDomainError(error, 'Review', id);
    }
  }

  /**
   * Update a review
   * PUT /api/reviews/:id
   */
  @Put(':id')
  async updateReview(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ id, body }, 'PUT /api/reviews/:id');

    const data = parseOrThrow(UpdateReviewSchema, body);

    try {
      return await this.reviewsService.updateReview(
        id,
        {
          title: data.title,
          description: data.description,
          status: data.status,
          headSha: data.headSha,
        },
        data.version,
      );
    } catch (error) {
      handleDomainError(error, 'Review', id);
    }
  }

  /**
   * Delete a review
   * DELETE /api/reviews/:id
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteReview(@Param('id') id: string) {
    logger.info({ id }, 'DELETE /api/reviews/:id');

    try {
      await this.reviewsService.deleteReview(id);
    } catch (error) {
      handleDomainError(error, 'Review', id);
    }
  }

  /**
   * Close a review (set status to 'closed')
   * POST /api/reviews/:id/close
   */
  @Post(':id/close')
  async closeReview(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ id, body }, 'POST /api/reviews/:id/close');

    const data = parseOrThrow(CloseReviewSchema, body);

    try {
      return await this.reviewsService.closeReview(id, data.version);
    } catch (error) {
      handleDomainError(error, 'Review', id);
    }
  }

  /**
   * List comments for a review
   * GET /api/reviews/:id/comments
   */
  @Get(':id/comments')
  async listComments(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('filePath') filePath?: string,
    @Query('parentId') parentId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    logger.info({ reviewId: id, status, filePath, limit, offset }, 'GET /api/reviews/:id/comments');

    const query = parseOrThrow(ListCommentsQuerySchema, {
      status,
      filePath,
      parentId: parentId === 'null' ? null : parentId,
      limit,
      offset,
    });

    try {
      const result = await this.reviewsService.listComments(id, {
        status: query.status,
        filePath: query.filePath,
        parentId: query.parentId,
        limit: query.limit,
        offset: query.offset,
      });
      // Transform side from storage convention (left/right) to API convention (old/new)
      return transformCommentsForApi(result);
    } catch (error) {
      handleDomainError(error, 'Review', id);
    }
  }

  /**
   * Create a comment on a review
   * POST /api/reviews/:id/comments
   */
  @Post(':id/comments')
  @HttpCode(HttpStatus.CREATED)
  async createComment(@Param('id') id: string, @Body() body: unknown) {
    logger.info({ reviewId: id, body }, 'POST /api/reviews/:id/comments');

    const data = parseOrThrow(CreateCommentSchema, body);

    try {
      const comment = await this.reviewsService.createComment(id, {
        filePath: data.filePath,
        parentId: data.parentId,
        lineStart: data.lineStart,
        lineEnd: data.lineEnd,
        // Map side from API convention (old/new) to storage convention (left/right)
        side: mapSideToStorage(data.side ?? null),
        content: data.content,
        commentType: data.commentType,
        status: data.status,
        authorType: data.authorType,
        authorAgentId: data.authorAgentId,
        targetAgentIds: data.targetAgentIds,
      });
      // Transform side back to API convention for response
      return transformCommentForApi(comment);
    } catch (error) {
      handleDomainError(error, 'Review', id);
    }
  }

  /**
   * Update a comment
   * PUT /api/reviews/:id/comments/:commentId
   */
  @Put(':id/comments/:commentId')
  async updateComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
  ) {
    logger.info({ reviewId: id, commentId, body }, 'PUT /api/reviews/:id/comments/:commentId');

    const data = parseOrThrow(UpdateCommentSchema, body);

    try {
      // Service handles IDOR protection via reviewId verification
      const comment = await this.reviewsService.updateComment(
        id,
        commentId,
        {
          content: data.content,
          status: data.status,
        },
        data.version,
      );
      return transformCommentForApi(comment);
    } catch (error) {
      handleDomainError(error, 'Comment', commentId);
    }
  }

  /**
   * Delete a comment
   * DELETE /api/reviews/:id/comments/:commentId
   */
  @Delete(':id/comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteComment(@Param('id') id: string, @Param('commentId') commentId: string) {
    logger.info({ reviewId: id, commentId }, 'DELETE /api/reviews/:id/comments/:commentId');

    try {
      // Service handles IDOR protection via reviewId verification
      await this.reviewsService.deleteComment(id, commentId);
    } catch (error) {
      handleDomainError(error, 'Comment', commentId);
    }
  }

  /**
   * Resolve a comment
   * PATCH /api/reviews/:id/comments/:commentId/resolve
   */
  @Patch(':id/comments/:commentId/resolve')
  async resolveComment(
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
  ) {
    logger.info(
      { reviewId: id, commentId, body },
      'PATCH /api/reviews/:id/comments/:commentId/resolve',
    );

    const data = parseOrThrow(ResolveCommentSchema, body);

    try {
      // Service handles IDOR protection via reviewId verification
      const comment = await this.reviewsService.resolveComment(
        id,
        commentId,
        data.status,
        data.version,
      );
      return transformCommentForApi(comment);
    } catch (error) {
      handleDomainError(error, 'Comment', commentId);
    }
  }

  /**
   * Get comment targets (assigned agents)
   * GET /api/reviews/:id/comments/:commentId/targets
   */
  @Get(':id/comments/:commentId/targets')
  async getCommentTargets(@Param('id') id: string, @Param('commentId') commentId: string) {
    logger.info({ reviewId: id, commentId }, 'GET /api/reviews/:id/comments/:commentId/targets');

    try {
      // Service handles IDOR protection via reviewId verification
      return await this.reviewsService.getCommentTargets(id, commentId);
    } catch (error) {
      handleDomainError(error, 'Comment', commentId);
    }
  }
}
