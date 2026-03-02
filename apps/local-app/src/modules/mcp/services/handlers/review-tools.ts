import { NotFoundError, ValidationError } from '../../../../common/errors/error-types';
import {
  validatePathWithinRoot,
  validateResolvedPathWithinRoot,
  validateLineBounds,
} from '../../../../common/validation/path-validation';
import {
  McpResponse,
  ListReviewsParamsSchema,
  ListReviewsResponse,
  ReviewSummary,
  GetReviewParamsSchema,
  GetReviewResponse,
  ReviewCommentSummary,
  ChangedFileSummary,
  GetReviewCommentsParamsSchema,
  GetReviewCommentsResponse,
  ReplyCommentParamsSchema,
  ReplyCommentResponse,
  ResolveCommentParamsSchema,
  ResolveCommentResponse,
  ApplySuggestionParamsSchema,
  ApplySuggestionResponse,
  SessionContext,
} from '../../dtos/mcp.dto';
import type { McpToolContext } from './types';

function getActorFromContext(
  ctx: SessionContext,
): { id: string; name: string; projectId: string } | null {
  if (ctx.type === 'agent') {
    return ctx.agent;
  }
  if (ctx.type === 'guest') {
    return {
      id: ctx.guest.id,
      name: ctx.guest.name,
      projectId: ctx.guest.projectId,
    };
  }
  return null;
}

function missingSessionResolver(): McpResponse {
  return {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message:
        'Session resolution requires full app context (not available in standalone MCP mode)',
    },
  };
}

async function resolveSessionContext(ctx: McpToolContext, sessionId: string): Promise<McpResponse> {
  if (!ctx.resolveSessionContext) {
    return missingSessionResolver();
  }
  return ctx.resolveSessionContext(sessionId);
}

export async function handleListReviews(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ListReviewsParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  if (!ctx.reviewsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'ReviewsService is not available',
      },
    };
  }

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
}

export async function handleGetReview(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  const validated = GetReviewParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  if (!ctx.reviewsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'ReviewsService is not available',
      },
    };
  }

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

    const agentNameById = new Map<string, string>();
    for (const agentId of agentIds) {
      try {
        const agent = await ctx.storage.getAgent(agentId);
        agentNameById.set(agentId, agent.name);
      } catch {
        // Graceful degradation
      }
    }

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
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = GetReviewCommentsParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  if (!ctx.reviewsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'ReviewsService is not available',
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

    const agentNameById = new Map<string, string>();
    for (const agentId of agentIds) {
      try {
        const agent = await ctx.storage.getAgent(agentId);
        agentNameById.set(agentId, agent.name);
      } catch {
        // Graceful degradation
      }
    }

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
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ReplyCommentParamsSchema.parse(params);

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

  if (!ctx.reviewsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'ReviewsService is not available',
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
      comment: {
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
        authorAgentName: actor?.name,
        parentId: comment.parentId,
        version: comment.version,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      },
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
    throw error;
  }
}

export async function handleResolveComment(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ResolveCommentParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  if (!ctx.reviewsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'ReviewsService is not available',
      },
    };
  }

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

    let authorAgentName: string | undefined;
    if (updatedComment.authorAgentId) {
      try {
        const agent = await ctx.storage.getAgent(updatedComment.authorAgentId);
        authorAgentName = agent.name;
      } catch {
        // Graceful degradation
      }
    }

    const response: ResolveCommentResponse = {
      comment: {
        id: updatedComment.id,
        filePath: updatedComment.filePath,
        lineStart: updatedComment.lineStart,
        lineEnd: updatedComment.lineEnd,
        side: updatedComment.side,
        content: updatedComment.content,
        commentType: updatedComment.commentType,
        status: updatedComment.status,
        authorType: updatedComment.authorType,
        authorAgentId: updatedComment.authorAgentId,
        authorAgentName,
        parentId: updatedComment.parentId,
        version: updatedComment.version,
        createdAt: updatedComment.createdAt,
        updatedAt: updatedComment.updatedAt,
      },
    };

    return { success: true, data: response };
  } catch (error) {
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
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ApplySuggestionParamsSchema.parse(params);

  const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
  if (!sessionCtxResult.success) return sessionCtxResult;
  const { project } = sessionCtxResult.data as SessionContext;

  if (!project) {
    return {
      success: false,
      error: {
        code: 'PROJECT_NOT_FOUND',
        message: 'No project associated with this session',
      },
    };
  }

  if (!ctx.reviewsService) {
    return {
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'ReviewsService is not available',
      },
    };
  }

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

    if (!comment.filePath || comment.lineStart === null) {
      return {
        success: false,
        error: {
          code: 'INVALID_SUGGESTION',
          message: 'Comment does not have file path or line information',
        },
      };
    }

    const suggestionMatch = comment.content.match(/```suggestion\s*\n([\s\S]*?)```/);
    if (!suggestionMatch) {
      return {
        success: false,
        error: {
          code: 'NO_SUGGESTION',
          message: 'Comment does not contain a suggestion block',
        },
      };
    }

    const suggestedCode = suggestionMatch[1].trimEnd();
    const lineStart = comment.lineStart;
    const lineEnd = comment.lineEnd ?? comment.lineStart;

    let validatedPath;
    try {
      validatedPath = validatePathWithinRoot(project.rootPath, comment.filePath, {
        errorPrefix: 'Invalid file path in comment',
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        return {
          success: false,
          error: {
            code: 'PATH_TRAVERSAL_BLOCKED',
            message: error.message,
            data: error.details,
          },
        };
      }
      throw error;
    }

    let realFilePath: string;
    try {
      realFilePath = await validateResolvedPathWithinRoot(
        validatedPath.absolutePath,
        project.rootPath,
        {
          errorPrefix: 'Symlink validation failed',
        },
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        return {
          success: false,
          error: {
            code: 'SYMLINK_ESCAPE_BLOCKED',
            message: error.message,
            data: error.details,
          },
        };
      }
      throw error;
    }

    const fs = await import('fs/promises');
    const filePath = realFilePath;

    const fileContent = await fs.readFile(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    try {
      validateLineBounds(lineStart, lineEnd, lines.length);
    } catch (error) {
      if (error instanceof ValidationError) {
        return {
          success: false,
          error: {
            code: 'INVALID_LINE_BOUNDS',
            message: error.message,
            data: error.details,
          },
        };
      }
      throw error;
    }

    const suggestedLines = suggestedCode.split('\n');
    lines.splice(lineStart - 1, lineEnd - lineStart + 1, ...suggestedLines);

    await fs.writeFile(filePath, lines.join('\n'), 'utf-8');

    const updatedComment = await ctx.reviewsService.resolveComment(
      comment.reviewId,
      validated.commentId,
      'resolved',
      validated.version,
    );

    let authorAgentName: string | undefined;
    if (updatedComment.authorAgentId) {
      try {
        const agent = await ctx.storage.getAgent(updatedComment.authorAgentId);
        authorAgentName = agent.name;
      } catch {
        // Graceful degradation
      }
    }

    const response: ApplySuggestionResponse = {
      comment: {
        id: updatedComment.id,
        filePath: updatedComment.filePath,
        lineStart: updatedComment.lineStart,
        lineEnd: updatedComment.lineEnd,
        side: updatedComment.side,
        content: updatedComment.content,
        commentType: updatedComment.commentType,
        status: updatedComment.status,
        authorType: updatedComment.authorType,
        authorAgentId: updatedComment.authorAgentId,
        authorAgentName,
        parentId: updatedComment.parentId,
        version: updatedComment.version,
        createdAt: updatedComment.createdAt,
        updatedAt: updatedComment.updatedAt,
      },
      applied: {
        filePath: comment.filePath,
        lineStart,
        lineEnd,
        suggestedCode,
      },
    };

    return { success: true, data: response };
  } catch (error) {
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
