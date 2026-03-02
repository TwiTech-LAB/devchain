import type { SQL } from 'drizzle-orm';
import type {
  ListResult,
  ListReviewCommentsOptions,
  ListReviewsOptions,
} from '../../interfaces/storage.interface';
import type {
  CreateReview,
  CreateReviewComment,
  Review,
  ReviewComment,
  ReviewCommentEnriched,
  ReviewCommentTarget,
  ReviewCommentTargetAgent,
  UpdateReview,
  UpdateReviewComment,
} from '../../models/domain.models';
import {
  NotFoundError,
  OptimisticLockError,
  StorageError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ReviewStorageDelegate');

export interface ReviewStorageDelegateDependencies {
  getReview: (id: string) => Promise<Review>;
  getReviewComment: (id: string) => Promise<ReviewComment>;
}

export class ReviewStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly dependencies: ReviewStorageDelegateDependencies,
  ) {
    super(context);
  }

  async createReview(data: CreateReview): Promise<Review> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { reviews } = await import('../../db/schema');

    const review: Review = {
      id: randomUUID(),
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
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(reviews).values({
      id: review.id,
      projectId: review.projectId,
      epicId: review.epicId,
      title: review.title,
      description: review.description,
      status: review.status,
      mode: review.mode,
      baseRef: review.baseRef,
      headRef: review.headRef,
      baseSha: review.baseSha,
      headSha: review.headSha,
      createdBy: review.createdBy,
      createdByAgentId: review.createdByAgentId,
      version: review.version,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    });

    logger.info({ reviewId: review.id, projectId: review.projectId }, 'Created review');
    return review;
  }

  async getReview(id: string): Promise<Review> {
    const { reviews, reviewComments } = await import('../../db/schema');
    const { eq, count } = await import('drizzle-orm');

    const result = await this.db.select().from(reviews).where(eq(reviews.id, id)).limit(1);
    if (!result[0]) {
      throw new NotFoundError('Review', id);
    }

    // Get comment count
    const countResult = await this.db
      .select({ count: count() })
      .from(reviewComments)
      .where(eq(reviewComments.reviewId, id));

    return {
      ...result[0],
      commentCount: countResult[0]?.count ?? 0,
    } as Review;
  }

  async updateReview(id: string, data: UpdateReview, expectedVersion: number): Promise<Review> {
    const { reviews } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.dependencies.getReview(id);
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError('Review', id, {
        expectedVersion,
        actualVersion: current.version,
      });
    }

    const updateData: Record<string, unknown> = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.status !== undefined) updateData.status = data.status;
    if (data.headSha !== undefined) updateData.headSha = data.headSha;

    await this.db
      .update(reviews)
      .set({ ...updateData, version: expectedVersion + 1, updatedAt: now })
      .where(eq(reviews.id, id));

    logger.info({ reviewId: id }, 'Updated review');
    return this.dependencies.getReview(id);
  }

  async deleteReview(id: string): Promise<void> {
    const { reviews } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    // Cascade delete of comments handled by FK constraint
    await this.db.delete(reviews).where(eq(reviews.id, id));
    logger.info({ reviewId: id }, 'Deleted review');
  }

  async listReviews(
    projectId: string,
    options: ListReviewsOptions = {},
  ): Promise<ListResult<Review>> {
    const { reviews, reviewComments } = await import('../../db/schema');
    const { eq, and, count, desc } = await import('drizzle-orm');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const conditions: SQL<unknown>[] = [eq(reviews.projectId, projectId)];
    if (options.status) {
      conditions.push(eq(reviews.status, options.status));
    }
    if (options.epicId) {
      conditions.push(eq(reviews.epicId, options.epicId));
    }

    const rows = await this.db
      .select()
      .from(reviews)
      .where(and(...conditions))
      .orderBy(desc(reviews.createdAt))
      .limit(limit)
      .offset(offset);

    // Get comment counts for all reviews in a single query (avoids N+1)
    const reviewIds = rows.map((r) => r.id);
    let commentCountMap: Map<string, number> = new Map();

    if (reviewIds.length > 0) {
      const { inArray } = await import('drizzle-orm');
      const countRows = await this.db
        .select({
          reviewId: reviewComments.reviewId,
          count: count(),
        })
        .from(reviewComments)
        .where(inArray(reviewComments.reviewId, reviewIds))
        .groupBy(reviewComments.reviewId);

      commentCountMap = new Map(countRows.map((r) => [r.reviewId, r.count]));
    }

    const items = rows.map(
      (row) =>
        ({
          ...row,
          commentCount: commentCountMap.get(row.id) ?? 0,
        }) as Review,
    );

    return {
      items,
      total: items.length,
      limit,
      offset,
    };
  }

  async createReviewComment(
    data: CreateReviewComment,
    targetAgentIds?: string[],
  ): Promise<ReviewComment> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { reviewComments, reviewCommentTargets } = await import('../../db/schema');

    const sqlite = this.rawClient;
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client');
    }

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');

    try {
      const comment: ReviewComment = {
        id: randomUUID(),
        reviewId: data.reviewId,
        filePath: data.filePath,
        parentId: data.parentId,
        lineStart: data.lineStart,
        lineEnd: data.lineEnd,
        side: data.side,
        content: data.content,
        commentType: data.commentType,
        status: data.status,
        authorType: data.authorType,
        authorAgentId: data.authorAgentId,
        version: 1,
        editedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      await this.db.insert(reviewComments).values({
        id: comment.id,
        reviewId: comment.reviewId,
        filePath: comment.filePath,
        parentId: comment.parentId,
        lineStart: comment.lineStart,
        lineEnd: comment.lineEnd,
        side: comment.side,
        content: comment.content,
        commentType: comment.commentType,
        status: comment.status,
        authorType: comment.authorType,
        authorAgentId: comment.authorAgentId,
        version: comment.version,
        editedAt: comment.editedAt,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      });

      // Add targets if provided
      if (targetAgentIds && targetAgentIds.length > 0) {
        for (const agentId of targetAgentIds) {
          await this.db.insert(reviewCommentTargets).values({
            id: randomUUID(),
            commentId: comment.id,
            agentId,
            createdAt: now,
          });
        }
      }

      sqlite.exec('COMMIT');
      logger.info(
        { commentId: comment.id, reviewId: comment.reviewId, targets: targetAgentIds?.length ?? 0 },
        'Created review comment',
      );
      return comment;
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
        logger.info('Transaction rolled back successfully');
      } catch (rollbackError) {
        logger.error({ rollbackError }, 'Failed to rollback transaction');
      }
      throw error;
    }
  }

  async getReviewComment(id: string): Promise<ReviewComment> {
    const { reviewComments } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, id))
      .limit(1);
    if (!result[0]) {
      throw new NotFoundError('ReviewComment', id);
    }

    return result[0] as ReviewComment;
  }

  async updateReviewComment(
    id: string,
    data: UpdateReviewComment,
    expectedVersion: number,
  ): Promise<ReviewComment> {
    const { reviewComments } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const current = await this.dependencies.getReviewComment(id);
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError('ReviewComment', id, {
        expectedVersion,
        actualVersion: current.version,
      });
    }

    const updateData: Record<string, unknown> = {};
    if (data.content !== undefined && data.content !== current.content) {
      updateData.content = data.content;
      updateData.editedAt = now;
    }
    if (data.status !== undefined && data.status !== current.status) {
      updateData.status = data.status;
    }

    // No-op update: avoid bumping version/updatedAt when nothing changed.
    if (Object.keys(updateData).length === 0) {
      logger.info({ commentId: id }, 'Skipped review comment update (no changes)');
      return current;
    }

    await this.db
      .update(reviewComments)
      .set({ ...updateData, version: expectedVersion + 1, updatedAt: now })
      .where(eq(reviewComments.id, id));

    logger.info({ commentId: id }, 'Updated review comment');
    return this.dependencies.getReviewComment(id);
  }

  async listReviewComments(
    reviewId: string,
    options: ListReviewCommentsOptions = {},
  ): Promise<ListResult<ReviewCommentEnriched>> {
    const { reviewComments, agents, reviewCommentTargets } = await import('../../db/schema');
    const { eq, and, isNull, desc, inArray } = await import('drizzle-orm');
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const conditions: SQL<unknown>[] = [eq(reviewComments.reviewId, reviewId)];
    if (options.status) {
      conditions.push(eq(reviewComments.status, options.status));
    }
    if (options.filePath) {
      conditions.push(eq(reviewComments.filePath, options.filePath));
    }
    if (options.parentId === null) {
      conditions.push(isNull(reviewComments.parentId));
    } else if (options.parentId !== undefined) {
      conditions.push(eq(reviewComments.parentId, options.parentId));
    }

    // Query 1: Get comments (preserves pagination)
    const rows = await this.db
      .select()
      .from(reviewComments)
      .where(and(...conditions))
      .orderBy(desc(reviewComments.createdAt))
      .limit(limit)
      .offset(offset);

    if (rows.length === 0) {
      return { items: [], total: 0, limit, offset };
    }

    // Query 2: Batch fetch author agent names for agent-authored comments
    const authorAgentIds = [
      ...new Set(
        rows.map((r) => r.authorAgentId).filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const agentNameMap = new Map<string, string>();
    if (authorAgentIds.length > 0) {
      const authorAgents = await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, authorAgentIds));
      authorAgents.forEach((a) => agentNameMap.set(a.id, a.name));
    }

    // Query 3: Batch fetch targets with agent names
    const commentIds = rows.map((r) => r.id);
    const targetsWithNames = await this.db
      .select({
        commentId: reviewCommentTargets.commentId,
        agentId: reviewCommentTargets.agentId,
        agentName: agents.name,
      })
      .from(reviewCommentTargets)
      .leftJoin(agents, eq(reviewCommentTargets.agentId, agents.id))
      .where(inArray(reviewCommentTargets.commentId, commentIds));

    // Group targets by commentId for efficient lookup
    const targetsByCommentId = new Map<string, ReviewCommentTargetAgent[]>();
    targetsWithNames.forEach((t) => {
      const list = targetsByCommentId.get(t.commentId) ?? [];
      list.push({ agentId: t.agentId, name: t.agentName ?? 'Unknown' });
      targetsByCommentId.set(t.commentId, list);
    });

    // Enrich comments with author names and targets
    const enrichedItems: ReviewCommentEnriched[] = rows.map((row) => ({
      ...(row as ReviewComment),
      authorAgentName: row.authorAgentId ? (agentNameMap.get(row.authorAgentId) ?? null) : null,
      targetAgents: targetsByCommentId.get(row.id) ?? [],
    }));

    return {
      items: enrichedItems,
      total: rows.length,
      limit,
      offset,
    };
  }

  async addReviewCommentTargets(
    commentId: string,
    agentIds: string[],
  ): Promise<ReviewCommentTarget[]> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { reviewCommentTargets } = await import('../../db/schema');

    // Verify comment exists
    await this.dependencies.getReviewComment(commentId);

    const targets: ReviewCommentTarget[] = [];
    for (const agentId of agentIds) {
      const target: ReviewCommentTarget = {
        id: randomUUID(),
        commentId,
        agentId,
        createdAt: now,
      };
      await this.db.insert(reviewCommentTargets).values(target);
      targets.push(target);
    }

    logger.info({ commentId, count: targets.length }, 'Added review comment targets');
    return targets;
  }

  async getReviewCommentTargets(commentId: string): Promise<ReviewCommentTarget[]> {
    const { reviewCommentTargets } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(reviewCommentTargets)
      .where(eq(reviewCommentTargets.commentId, commentId));

    return rows as ReviewCommentTarget[];
  }

  async deleteReviewComment(id: string): Promise<void> {
    const { reviewComments } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    // Note: Cascade delete on parentId foreign key handles replies automatically
    await this.db.delete(reviewComments).where(eq(reviewComments.id, id));
  }

  async deleteNonResolvedComments(reviewId: string): Promise<number> {
    const { reviewComments } = await import('../../db/schema');
    const { eq, and, notInArray } = await import('drizzle-orm');

    // Delete all comments that are not resolved or wont_fix (keep those with conversation value)
    const result = await this.db
      .delete(reviewComments)
      .where(
        and(
          eq(reviewComments.reviewId, reviewId),
          notInArray(reviewComments.status, ['resolved', 'wont_fix']),
        ),
      );

    // Drizzle returns { changes: number } for SQLite
    return (result as unknown as { changes: number }).changes ?? 0;
  }

  async markMessageAsRead(messageId: string, agentId: string, readAt: string): Promise<void> {
    const { chatMessageReads } = await import('../../db/schema');
    const { eq, and } = await import('drizzle-orm');

    // Check if already exists
    const existing = await this.db
      .select()
      .from(chatMessageReads)
      .where(and(eq(chatMessageReads.messageId, messageId), eq(chatMessageReads.agentId, agentId)))
      .limit(1);

    if (!existing[0]) {
      // Insert new read record
      await this.db.insert(chatMessageReads).values({
        messageId,
        agentId,
        readAt,
      });
      logger.info({ messageId, agentId }, 'Marked message as read');
    } else {
      logger.debug({ messageId, agentId }, 'Message already marked as read');
    }
  }
}
