import { NotFoundError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  ListReviewsResponse,
  ReviewSummary,
  GetReviewResponse,
  ReviewCommentSummary,
  ChangedFileSummary,
  GetReviewCommentsResponse,
  ReplyCommentResponse,
  ResolveCommentResponse,
  ApplySuggestionResponse,
  SessionContext,
  type ListReviewsParams,
  type GetReviewParams,
  type GetReviewCommentsParams,
  type ReplyCommentParams,
  type ResolveCommentParams,
  type ApplySuggestionParams,
} from '../../dtos/mcp.dto';
import type { ReviewToolContext } from './review-context';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import { resolveSessionContext, getActorFromContext } from '../utils/session-context-helpers';
import { resolveAgentNames } from '../utils/agent-name-resolver';
import { requireProject } from '../utils/require-project';
import { SuggestionApplicationError } from '../../../reviews/services/review-suggestion-applier.service';

export async function handleListReviews(
  ctx: ReviewToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ListReviewsParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  try {
    const result = await ctx.reviewsService.listReviews(project.id, {
      status: validated.status,
      epicId: validated.epicId,
      limit: validated.limit ?? 100,
      offset: validated.offset ?? 0,
    });

    const reviews: ReviewSummary[] = result.items.map((review) => ({
      id: review.id,
      title: review.title,
      description: review.description,
      status: review.status,
      baseRef: review.baseRef,
      headRef: review.headRef,
      baseSha: review.baseSha,
      headSha: review.headSha,
      epicId: review.epicId,
      createdBy: review.createdBy,
      createdByAgentId: review.createdByAgentId,
      version: review.version,
      commentCount: review.commentCount,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    }));

    const response: ListReviewsResponse = {
      reviews,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }
    throw error;
  }
}

export async function handleGetReview(
  ctx: ReviewToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as GetReviewParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  try {
    const reviewWithFiles = await ctx.reviewsService.getReview(validated.reviewId);

    if (reviewWithFiles.projectId !== project.id) {
      return {
        success: false,
        error: {
          code: 'REVIEW_NOT_FOUND',
          message: `Review ${validated.reviewId} does not belong to this project`,
        },
      };
    }

    const commentsResult = await ctx.reviewsService.listComments(validated.reviewId, {
      limit: 500,
    });

    const agentIds = new Set<string>();
    for (const comment of commentsResult.items) {
      if (comment.authorAgentId) agentIds.add(comment.authorAgentId);
    }

    const agentNameById = await resolveAgentNames(ctx.storage, agentIds);

    const comments: ReviewCommentSummary[] = commentsResult.items.map((comment) => ({
      id: comment.id,
      filePath: comment.filePath,
      lineStart: comment.lineStart,
      lineEnd: comment.lineEnd,
      side: comment.side,
      content: comment.content,
      commentType: comment.commentType,
      status: comment.status,
      authorType: comment.authorType,
      authorAgentId: comment.authorAgentId,
      authorAgentName: comment.authorAgentId ? agentNameById.get(comment.authorAgentId) : undefined,
      parentId: comment.parentId,
      version: comment.version,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }));

    const changedFiles: ChangedFileSummary[] = (reviewWithFiles.changedFiles ?? []).map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      oldPath: file.oldPath,
    }));

    const response: GetReviewResponse = {
      review: {
        id: reviewWithFiles.id,
        title: reviewWithFiles.title,
        description: reviewWithFiles.description,
        status: reviewWithFiles.status,
        baseRef: reviewWithFiles.baseRef,
        headRef: reviewWithFiles.headRef,
        baseSha: reviewWithFiles.baseSha,
        headSha: reviewWithFiles.headSha,
        epicId: reviewWithFiles.epicId,
        createdBy: reviewWithFiles.createdBy,
        createdByAgentId: reviewWithFiles.createdByAgentId,
        version: reviewWithFiles.version,
        createdAt: reviewWithFiles.createdAt,
        updatedAt: reviewWithFiles.updatedAt,
      },
      changedFiles,
      comments,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'REVIEW_NOT_FOUND',
          message: `Review ${validated.reviewId} was not found`,
        },
      };
    }
    throw error;
  }
}

export async function handleGetReviewComments(
  ctx: ReviewToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as GetReviewCommentsParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  try {
    const review = await ctx.storage.getReview(validated.reviewId);
    if (review.projectId !== project.id) {
      return {
        success: false,
        error: {
          code: 'REVIEW_NOT_FOUND',
          message: `Review ${validated.reviewId} does not belong to this project`,
        },
      };
    }

    const result = await ctx.reviewsService.listComments(validated.reviewId, {
      status: validated.status,
      filePath: validated.filePath,
      limit: validated.limit ?? 100,
      offset: validated.offset ?? 0,
    });

    const agentIds = new Set<string>();
    for (const comment of result.items) {
      if (comment.authorAgentId) agentIds.add(comment.authorAgentId);
    }

    const agentNameById = await resolveAgentNames(ctx.storage, agentIds);

    const comments: ReviewCommentSummary[] = result.items.map((comment) => ({
      id: comment.id,
      filePath: comment.filePath,
      lineStart: comment.lineStart,
      lineEnd: comment.lineEnd,
      side: comment.side,
      content: comment.content,
      commentType: comment.commentType,
      status: comment.status,
      authorType: comment.authorType,
      authorAgentId: comment.authorAgentId,
      authorAgentName: comment.authorAgentId ? agentNameById.get(comment.authorAgentId) : undefined,
      parentId: comment.parentId,
      version: comment.version,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }));

    const response: GetReviewCommentsResponse = {
      comments,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'REVIEW_NOT_FOUND',
          message: `Review ${validated.reviewId} was not found`,
        },
      };
    }
    throw error;
  }
}

export async function handleReplyComment(
  ctx: ReviewToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ReplyCommentParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionCtx = sessionCtxResult.data as SessionContext;
  const { project } = sessionCtx;
  const actor = getActorFromContext(sessionCtx);

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  try {
    const review = await ctx.storage.getReview(validated.reviewId);
    if (review.projectId !== project.id) {
      return {
        success: false,
        error: {
          code: 'REVIEW_NOT_FOUND',
          message: `Review ${validated.reviewId} does not belong to this project`,
        },
      };
    }

    const comment = await ctx.reviewsService.createComment(validated.reviewId, {
      parentId: validated.parentCommentId,
      content: validated.content,
      filePath: validated.filePath,
      lineStart: validated.lineStart,
      lineEnd: validated.lineEnd,
      commentType: validated.commentType ?? 'comment',
      authorType: 'agent',
      authorAgentId: actor?.id,
      targetAgentIds: validated.targetAgentIds,
    });

    const response: ReplyCommentResponse = {
      id: comment.id,
      version: comment.version,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'REVIEW_NOT_FOUND',
          message: `Review ${validated.reviewId} was not found`,
        },
      };
    }
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }
    throw error;
  }
}

export async function handleResolveComment(
  ctx: ReviewToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ResolveCommentParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  try {
    const comment = await ctx.storage.getReviewComment(validated.commentId);
    const review = await ctx.storage.getReview(comment.reviewId);
    if (review.projectId !== project.id) {
      return {
        success: false,
        error: {
          code: 'COMMENT_NOT_FOUND',
          message: `Comment ${validated.commentId} does not belong to this project`,
        },
      };
    }

    const updatedComment = await ctx.reviewsService.resolveComment(
      comment.reviewId,
      validated.commentId,
      validated.resolution,
      validated.version,
    );

    const response: ResolveCommentResponse = {
      id: updatedComment.id,
      version: updatedComment.version,
      status: updatedComment.status,
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewsService is not available',
        },
      };
    }
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'COMMENT_NOT_FOUND',
          message: `Comment ${validated.commentId} was not found`,
        },
      };
    }
    throw error;
  }
}

export async function handleApplySuggestion(
  ctx: ReviewToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ApplySuggestionParams;

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  const projectResult = requireProject(sessionCtxResult);
  if (!('project' in projectResult)) return projectResult;
  const { project } = projectResult;

  try {
    const result = await ctx.reviewSuggestionApplier.apply({
      commentId: validated.commentId,
      projectId: project.id,
      projectRootPath: project.rootPath,
      version: validated.version,
    });

    const response: ApplySuggestionResponse = {
      commentId: result.updatedComment.id,
      version: result.updatedComment.version,
      applied: {
        filePath: result.filePath,
        lineStart: result.lineStart,
        lineEnd: result.lineEnd,
      },
    };

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'ReviewSuggestionApplier is not available',
        },
      };
    }
    if (error instanceof SuggestionApplicationError) {
      return {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details && { data: error.details }),
        },
      };
    }
    if (error instanceof NotFoundError) {
      return {
        success: false,
        error: {
          code: 'COMMENT_NOT_FOUND',
          message: `Comment ${validated.commentId} was not found`,
        },
      };
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        success: false,
        error: {
          code: 'FILE_NOT_FOUND',
          message: 'File not found at path',
        },
      };
    }
    throw error;
  }
}
