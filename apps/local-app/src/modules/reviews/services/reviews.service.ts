import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  STORAGE_SERVICE,
  type StorageService,
  type ListResult,
} from '../../storage/interfaces/storage.interface';
import type {
  Review,
  ReviewComment,
  ReviewCommentTarget,
  ReviewStatus,
  ReviewCommentStatus,
  ReviewMode,
} from '../../storage/models/domain.models';
import { EventsService } from '../../events/services/events.service';
import { GitService } from '../../git/services/git.service';
import { ValidationError, NotFoundError, ForbiddenError } from '../../../common/errors/error-types';

export interface CreateReviewInput {
  projectId: string;
  epicId?: string | null;
  title: string;
  description?: string | null;
  status?: ReviewStatus;
  /** Review mode - 'working_tree' for uncommitted changes, 'commit' for specific commits */
  mode?: ReviewMode;
  baseRef: string;
  headRef: string;
  /** Pre-resolved base SHA. Only used for commit mode. */
  baseSha?: string | null;
  /** Pre-resolved head SHA. Only used for commit mode. */
  headSha?: string | null;
  createdBy?: 'user' | 'agent';
  createdByAgentId?: string | null;
}

export interface UpdateReviewInput {
  title?: string;
  description?: string | null;
  status?: ReviewStatus;
  headSha?: string;
}

export interface CreateCommentInput {
  filePath?: string | null;
  parentId?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  side?: 'left' | 'right' | null;
  content: string;
  commentType?: 'comment' | 'suggestion' | 'issue' | 'approval';
  status?: ReviewCommentStatus;
  authorType?: 'user' | 'agent';
  authorAgentId?: string | null;
  targetAgentIds?: string[];
}

export interface ListReviewsOptions {
  status?: ReviewStatus;
  epicId?: string;
  limit?: number;
  offset?: number;
}

export interface ListCommentsOptions {
  status?: ReviewCommentStatus;
  filePath?: string;
  parentId?: string | null;
  limit?: number;
  offset?: number;
}

/** Mode for auto-creating a review (uses hyphens for API/UI compatibility) */
export type ServiceReviewMode = 'working-tree' | 'commit';

/** Options for getOrCreateActiveReview */
export interface GetOrCreateActiveReviewOptions {
  /** For commit mode: the commit SHA to review */
  commitSha?: string;
  /** Base ref (default: 'HEAD' for working-tree, 'HEAD^' for commit) */
  baseRef?: string;
  /** Head ref (default: 'HEAD' for working-tree, commit SHA for commit) */
  headRef?: string;
}

/** Convert service mode (hyphenated) to storage mode (underscored) */
function toStorageMode(mode: ServiceReviewMode): ReviewMode {
  return mode === 'working-tree' ? 'working_tree' : 'commit';
}

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly eventsService: EventsService,
    private readonly gitService: GitService,
  ) {}

  /**
   * Create a new review, optionally resolving refs to SHAs via GitService.
   * For working_tree mode, SHAs are not used (changes are uncommitted).
   * For commit mode, SHAs are resolved from refs if not provided.
   */
  async createReview(input: CreateReviewInput): Promise<Review> {
    // Validate project exists
    const project = await this.storage.getProject(input.projectId);

    const mode = input.mode ?? 'working_tree';

    // For working_tree mode, SHAs are null (changes are uncommitted)
    // For commit mode, resolve refs to SHAs if not provided
    let baseSha: string | null = null;
    let headSha: string | null = null;

    if (mode === 'commit') {
      baseSha = input.baseSha ?? null;
      headSha = input.headSha ?? null;

      if (!baseSha || !headSha) {
        try {
          const [resolvedBase, resolvedHead] = await Promise.all([
            baseSha
              ? Promise.resolve(baseSha)
              : this.gitService.resolveRef(input.projectId, input.baseRef),
            headSha
              ? Promise.resolve(headSha)
              : this.gitService.resolveRef(input.projectId, input.headRef),
          ]);
          baseSha = resolvedBase;
          headSha = resolvedHead;
        } catch (error) {
          throw new ValidationError('Failed to resolve git refs', {
            baseRef: input.baseRef,
            headRef: input.headRef,
            error: (error as Error).message,
          });
        }
      }
    }

    const review = await this.storage.createReview({
      projectId: input.projectId,
      epicId: input.epicId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'draft',
      mode,
      baseRef: input.baseRef,
      headRef: input.headRef,
      baseSha,
      headSha,
      createdBy: input.createdBy ?? 'user',
      createdByAgentId: input.createdByAgentId ?? null,
    });

    // Publish review.created event (best-effort)
    try {
      if (review.mode === 'commit') {
        if (!review.baseSha || !review.headSha) {
          throw new Error('Commit-mode review created without SHAs');
        }

        await this.eventsService.publish('review.created', {
          reviewId: review.id,
          projectId: review.projectId,
          epicId: review.epicId,
          title: review.title,
          status: review.status,
          mode: 'commit',
          baseRef: review.baseRef,
          headRef: review.headRef,
          baseSha: review.baseSha,
          headSha: review.headSha,
          createdBy: review.createdBy,
          createdByAgentId: review.createdByAgentId,
          projectName: project.name,
        });
      } else {
        await this.eventsService.publish('review.created', {
          reviewId: review.id,
          projectId: review.projectId,
          epicId: review.epicId,
          title: review.title,
          status: review.status,
          mode: 'working_tree',
          baseRef: review.baseRef,
          headRef: review.headRef,
          baseSha: null,
          headSha: null,
          createdBy: review.createdBy,
          createdByAgentId: review.createdByAgentId,
          projectName: project.name,
        });
      }
    } catch (error) {
      this.logger.error(
        { reviewId: review.id, projectId: review.projectId, error },
        'Failed to publish review.created event',
      );
    }

    return review;
  }

  /**
   * Get a review by ID with computed file stats.
   * For working_tree mode, changedFiles are not computed (fetched separately via working-tree endpoint).
   */
  async getReview(
    reviewId: string,
  ): Promise<Review & { changedFiles?: Awaited<ReturnType<GitService['getChangedFiles']>> }> {
    const review = await this.storage.getReview(reviewId);

    // For working_tree mode or if SHAs are null, skip computing changed files
    // (working tree changes are fetched via the working-tree endpoint)
    if (review.mode === 'working_tree' || !review.baseSha || !review.headSha) {
      return review;
    }

    // For commit mode, compute file stats
    let changedFiles: Awaited<ReturnType<GitService['getChangedFiles']>> | undefined;
    try {
      changedFiles = await this.gitService.getChangedFiles(
        review.projectId,
        review.baseSha,
        review.headSha,
      );
    } catch (error) {
      this.logger.warn(
        { reviewId, projectId: review.projectId, error },
        'Failed to compute changed files for review',
      );
    }

    return { ...review, changedFiles };
  }

  /**
   * Update a review with optimistic locking.
   */
  async updateReview(
    reviewId: string,
    input: UpdateReviewInput,
    expectedVersion: number,
  ): Promise<Review> {
    const before = await this.storage.getReview(reviewId);

    const updated = await this.storage.updateReview(
      reviewId,
      {
        title: input.title,
        description: input.description,
        status: input.status,
        headSha: input.headSha,
      },
      expectedVersion,
    );

    // Publish review.updated event (best-effort)
    try {
      const changes = this.buildReviewChanges(before, updated);
      if (Object.keys(changes).length > 0) {
        let projectName: string | undefined;
        try {
          const project = await this.storage.getProject(updated.projectId);
          projectName = project.name;
        } catch {
          // Graceful degradation
        }

        await this.eventsService.publish('review.updated', {
          reviewId: updated.id,
          projectId: updated.projectId,
          version: updated.version,
          title: updated.title,
          projectName,
          changes,
        });
      }
    } catch (error) {
      this.logger.error(
        { reviewId: updated.id, projectId: updated.projectId, error },
        'Failed to publish review.updated event',
      );
    }

    return updated;
  }

  /**
   * List reviews for a project with filters.
   */
  async listReviews(projectId: string, options?: ListReviewsOptions): Promise<ListResult<Review>> {
    // Validate project exists
    await this.storage.getProject(projectId);

    return this.storage.listReviews(projectId, {
      status: options?.status,
      epicId: options?.epicId,
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  /**
   * Get the most recent active (non-closed) review for a project.
   * Returns null if no active review exists.
   */
  async getActiveReview(projectId: string): Promise<Review | null> {
    // Validate project exists
    await this.storage.getProject(projectId);

    // Get all reviews and filter for non-closed (most recent first)
    // Note: listReviews orders by createdAt DESC by default
    const result = await this.storage.listReviews(projectId, {
      limit: 100,
      offset: 0,
    });

    // Find first non-closed review
    const activeReview = result.items.find((r) => r.status !== 'closed');
    return activeReview ?? null;
  }

  /**
   * Get the active review for a project, or create one if none exists.
   * Enforces single-active-review constraint at service level.
   *
   * @param projectId - Project ID
   * @param mode - 'working-tree' for uncommitted changes, 'commit' for specific commit
   * @param options - Additional options (commitSha for commit mode)
   * @returns The active or newly created review
   */
  async getOrCreateActiveReview(
    projectId: string,
    mode: ServiceReviewMode,
    options: GetOrCreateActiveReviewOptions = {},
  ): Promise<Review> {
    // Check for existing active review
    const existing = await this.getActiveReview(projectId);
    if (existing) {
      return existing;
    }

    // Determine title and refs based on mode
    let title: string;
    let baseRef: string;
    let headRef: string;

    if (mode === 'commit') {
      if (!options.commitSha) {
        throw new ValidationError('commitSha is required for commit mode', { mode });
      }
      const shortSha = options.commitSha.substring(0, 7);
      title = `Review: ${shortSha}`;
      baseRef = options.baseRef ?? `${options.commitSha}^`;
      headRef = options.headRef ?? options.commitSha;
    } else {
      // working-tree mode
      title = 'Pre-commit review';
      baseRef = options.baseRef ?? 'HEAD';
      headRef = options.headRef ?? 'HEAD';
    }

    // Create the review
    // Note: Race condition is minimized but not eliminated.
    // If two requests arrive simultaneously, one will create and the other will
    // get the existing review on the next getActiveReview call.
    try {
      const review = await this.createReview({
        projectId,
        title,
        mode: toStorageMode(mode),
        baseRef,
        headRef,
        status: 'draft',
      });

      this.logger.log({ projectId, reviewId: review.id, mode, title }, 'Created new active review');

      return review;
    } catch (error) {
      // If creation failed, check if another review was created concurrently
      const retryExisting = await this.getActiveReview(projectId);
      if (retryExisting) {
        this.logger.log(
          { projectId, reviewId: retryExisting.id },
          'Found concurrently created review',
        );
        return retryExisting;
      }
      throw error;
    }
  }

  /**
   * Close a review (set status to 'closed') and delete non-resolved comments.
   * Keeps resolved and wont_fix comments as they have conversation value.
   *
   * @param reviewId - Review ID
   * @param expectedVersion - Version for optimistic locking
   * @returns The closed review
   */
  async closeReview(reviewId: string, expectedVersion: number): Promise<Review> {
    // Close the review first to honor optimistic locking; deletion is best-effort.
    const closed = await this.updateReview(reviewId, { status: 'closed' }, expectedVersion);

    try {
      const deletedCount = await this.storage.deleteNonResolvedComments(reviewId);
      this.logger.log({ reviewId, deletedCount }, 'Deleted non-resolved comments on review close');
    } catch (error) {
      this.logger.warn(
        { reviewId, error },
        'Failed to delete non-resolved comments on review close',
      );
    }

    return closed;
  }

  /**
   * Delete a review.
   */
  async deleteReview(reviewId: string): Promise<void> {
    await this.storage.getReview(reviewId);
    await this.storage.deleteReview(reviewId);
  }

  /**
   * Create a comment on a review with optional agent targeting.
   * For replies (parentId set), inherits filePath/lineStart/lineEnd/side from parent
   * to maintain file association in file-scoped views.
   *
   * When parentId is set and targetAgentIds is not provided:
   * - First tries to use parent comment's targets
   * - Falls back to parent author's agentId if parent is agent-authored
   * This ensures replies reach the intended agents without requiring UI changes.
   */
  async createComment(reviewId: string, input: CreateCommentInput): Promise<ReviewComment> {
    const review = await this.storage.getReview(reviewId);

    // For replies, inherit file context from parent to maintain file association
    let filePath = input.filePath ?? null;
    let lineStart = input.lineStart ?? null;
    let lineEnd = input.lineEnd ?? null;
    let side = input.side ?? null;

    // Resolved target agent IDs (may be defaulted for replies)
    let resolvedTargetAgentIds = input.targetAgentIds;

    if (input.parentId) {
      const parentComment = await this.verifyCommentOwnership(input.parentId, reviewId);
      // Inherit file context from parent comment
      filePath = parentComment.filePath;
      lineStart = parentComment.lineStart;
      lineEnd = parentComment.lineEnd;
      side = parentComment.side;

      // Default targets for replies when not explicitly provided
      if (!resolvedTargetAgentIds || resolvedTargetAgentIds.length === 0) {
        // First try: use parent comment's targets
        const parentTargets = await this.storage.getReviewCommentTargets(input.parentId);
        if (parentTargets.length > 0) {
          resolvedTargetAgentIds = parentTargets.map((t) => t.agentId);
        } else if (parentComment.authorType === 'agent' && parentComment.authorAgentId) {
          // Fallback: use parent author's agentId if agent-authored
          resolvedTargetAgentIds = [parentComment.authorAgentId];
        }
      }
    }

    const comment = await this.storage.createReviewComment(
      {
        reviewId,
        filePath,
        parentId: input.parentId ?? null,
        lineStart,
        lineEnd,
        side,
        content: input.content,
        commentType: input.commentType ?? 'comment',
        status: input.status ?? 'open',
        authorType: input.authorType ?? 'user',
        authorAgentId: input.authorAgentId ?? null,
      },
      resolvedTargetAgentIds,
    );

    // Publish review.comment.created event (best-effort)
    try {
      let projectName: string | undefined;
      try {
        const project = await this.storage.getProject(review.projectId);
        projectName = project.name;
      } catch {
        // Graceful degradation
      }

      await this.eventsService.publish('review.comment.created', {
        commentId: comment.id,
        reviewId: comment.reviewId,
        projectId: review.projectId,
        content: comment.content,
        commentType: comment.commentType,
        status: comment.status,
        authorType: comment.authorType,
        authorAgentId: comment.authorAgentId,
        filePath: comment.filePath,
        lineStart: comment.lineStart,
        lineEnd: comment.lineEnd,
        parentId: comment.parentId,
        targetAgentIds: resolvedTargetAgentIds,
        projectName,
        reviewTitle: review.title,
        // Review context for agents to locate the code
        reviewMode: review.mode,
        baseRef: review.baseRef,
        headRef: review.headRef,
        baseSha: review.baseSha,
        headSha: review.headSha,
      });
    } catch (error) {
      this.logger.error(
        { commentId: comment.id, reviewId, projectId: review.projectId, error },
        'Failed to publish review.comment.created event',
      );
    }

    return comment;
  }

  /**
   * SECURITY: Verify that a comment belongs to the specified review.
   * This prevents IDOR attacks where an attacker tries to manipulate
   * comments from a different review by guessing comment IDs.
   *
   * @param commentId - The comment ID to verify
   * @param reviewId - The review ID from the route parameter
   * @returns The comment if ownership is verified
   * @throws NotFoundError if comment doesn't exist or doesn't belong to review
   */
  private async verifyCommentOwnership(
    commentId: string,
    reviewId: string,
  ): Promise<ReviewComment> {
    const comment = await this.storage.getReviewComment(commentId);

    // SECURITY: Verify the comment belongs to the specified review
    // Return NotFoundError (not forbidden) to avoid leaking existence of comments in other reviews
    if (comment.reviewId !== reviewId) {
      this.logger.warn(
        { commentId, expectedReviewId: reviewId, actualReviewId: comment.reviewId },
        'IDOR attempt blocked: comment does not belong to review',
      );
      throw new NotFoundError('ReviewComment', commentId);
    }

    return comment;
  }

  /**
   * Get a comment by ID, optionally verifying it belongs to a specific review.
   * @param commentId - The comment ID
   * @param reviewId - If provided, verifies the comment belongs to this review (IDOR protection)
   */
  async getComment(commentId: string, reviewId?: string): Promise<ReviewComment> {
    if (reviewId) {
      return this.verifyCommentOwnership(commentId, reviewId);
    }
    return this.storage.getReviewComment(commentId);
  }

  /**
   * SECURITY: Verify that a comment was authored by a user (not an agent).
   * This prevents users from editing/deleting agent-authored comments via the UI.
   * Agents manage their own comments via MCP tools.
   *
   * @param comment - The comment to check
   * @throws ForbiddenError if comment is agent-authored
   */
  private verifyUserAuthored(comment: ReviewComment): void {
    if (comment.authorType !== 'user') {
      this.logger.warn(
        {
          commentId: comment.id,
          authorType: comment.authorType,
          authorAgentId: comment.authorAgentId,
        },
        'Blocked attempt to modify agent-authored comment via user endpoint',
      );
      throw new ForbiddenError('Cannot modify agent-authored comments', {
        commentId: comment.id,
        authorType: comment.authorType,
      });
    }
  }

  /**
   * Update a comment with optimistic locking.
   * @param reviewId - The review ID (required for IDOR protection)
   * @param commentId - The comment ID
   * @param input - Fields to update
   * @param expectedVersion - Version for optimistic locking
   */
  async updateComment(
    reviewId: string,
    commentId: string,
    input: { content?: string; status?: ReviewCommentStatus },
    expectedVersion: number,
  ): Promise<ReviewComment> {
    // SECURITY: Verify comment belongs to review before update
    const before = await this.verifyCommentOwnership(commentId, reviewId);

    // SECURITY: Only allow editing user-authored comments
    this.verifyUserAuthored(before);

    const review = await this.storage.getReview(reviewId);

    const updated = await this.storage.updateReviewComment(commentId, input, expectedVersion);

    // Publish review.comment.updated event if content changed (best-effort)
    if (input.content !== undefined && input.content !== before.content) {
      try {
        let projectName: string | undefined;
        try {
          const project = await this.storage.getProject(review.projectId);
          projectName = project.name;
        } catch {
          // Graceful degradation
        }

        await this.eventsService.publish('review.comment.updated', {
          commentId: updated.id,
          reviewId: updated.reviewId,
          projectId: review.projectId,
          content: updated.content,
          previousContent: before.content,
          version: updated.version,
          editedAt: updated.editedAt,
          filePath: updated.filePath,
          projectName,
          reviewTitle: review.title,
        });
      } catch (error) {
        this.logger.error(
          { commentId: updated.id, reviewId, projectId: review.projectId, error },
          'Failed to publish review.comment.updated event',
        );
      }
    }

    return updated;
  }

  /**
   * Resolve a comment (set status to resolved or wont_fix).
   * @param reviewId - The review ID (required for IDOR protection)
   * @param commentId - The comment ID
   * @param status - New status (resolved or wont_fix)
   * @param expectedVersion - Version for optimistic locking
   */
  async resolveComment(
    reviewId: string,
    commentId: string,
    status: 'resolved' | 'wont_fix',
    expectedVersion: number,
  ): Promise<ReviewComment> {
    // SECURITY: Verify comment belongs to review before resolve
    const comment = await this.verifyCommentOwnership(commentId, reviewId);
    const review = await this.storage.getReview(comment.reviewId);

    const updated = await this.storage.updateReviewComment(commentId, { status }, expectedVersion);

    // Publish review.comment.resolved event (best-effort)
    try {
      let projectName: string | undefined;
      try {
        const project = await this.storage.getProject(review.projectId);
        projectName = project.name;
      } catch {
        // Graceful degradation
      }

      await this.eventsService.publish('review.comment.resolved', {
        commentId: updated.id,
        reviewId: updated.reviewId,
        projectId: review.projectId,
        status: updated.status as 'resolved' | 'wont_fix',
        version: updated.version,
        projectName,
        reviewTitle: review.title,
      });
    } catch (error) {
      this.logger.error(
        { commentId: updated.id, reviewId: updated.reviewId, projectId: review.projectId, error },
        'Failed to publish review.comment.resolved event',
      );
    }

    return updated;
  }

  /**
   * Delete a comment.
   * @param reviewId - The review ID (required for IDOR protection)
   * @param commentId - The comment ID
   */
  async deleteComment(reviewId: string, commentId: string): Promise<void> {
    // SECURITY: Verify comment belongs to review before delete
    const comment = await this.verifyCommentOwnership(commentId, reviewId);

    // SECURITY: Only allow deleting user-authored comments
    this.verifyUserAuthored(comment);

    const review = await this.storage.getReview(reviewId);

    await this.storage.deleteReviewComment(commentId);

    // Publish review.comment.deleted event (best-effort)
    try {
      let projectName: string | undefined;
      try {
        const project = await this.storage.getProject(review.projectId);
        projectName = project.name;
      } catch {
        // Graceful degradation
      }

      await this.eventsService.publish('review.comment.deleted', {
        commentId: comment.id,
        reviewId: comment.reviewId,
        projectId: review.projectId,
        filePath: comment.filePath,
        parentId: comment.parentId,
        projectName,
        reviewTitle: review.title,
      });
    } catch (error) {
      this.logger.error(
        { commentId, reviewId, projectId: review.projectId, error },
        'Failed to publish review.comment.deleted event',
      );
    }
  }

  /**
   * List comments for a review with filters.
   */
  async listComments(
    reviewId: string,
    options?: ListCommentsOptions,
  ): Promise<ListResult<ReviewComment>> {
    await this.storage.getReview(reviewId);

    return this.storage.listReviewComments(reviewId, {
      status: options?.status,
      filePath: options?.filePath,
      parentId: options?.parentId,
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  /**
   * Get comment targets (assigned agents).
   * @param reviewId - The review ID (required for IDOR protection)
   * @param commentId - The comment ID
   */
  async getCommentTargets(reviewId: string, commentId: string): Promise<ReviewCommentTarget[]> {
    // SECURITY: Verify comment belongs to review before accessing targets
    await this.verifyCommentOwnership(commentId, reviewId);
    return this.storage.getReviewCommentTargets(commentId);
  }

  /**
   * Build changes object for review.updated event.
   */
  private buildReviewChanges(
    before: Review,
    after: Review,
  ): {
    title?: { previous: string; current: string };
    status?: { previous: ReviewStatus; current: ReviewStatus };
    headSha?: { previous: string | null; current: string | null };
  } {
    const changes: {
      title?: { previous: string; current: string };
      status?: { previous: ReviewStatus; current: ReviewStatus };
      headSha?: { previous: string | null; current: string | null };
    } = {};

    if (before.title !== after.title) {
      changes.title = { previous: before.title, current: after.title };
    }
    if (before.status !== after.status) {
      changes.status = { previous: before.status, current: after.status };
    }
    if (before.headSha !== after.headSha) {
      changes.headSha = { previous: before.headSha, current: after.headSha };
    }

    return changes;
  }
}
