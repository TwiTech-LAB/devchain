import type {
  ReviewStorage,
  ListResult,
  ListReviewCommentsOptions,
  ListReviewsOptions,
} from '../../interfaces/storage.interface';
import type { SQL } from 'drizzle-orm';
import { and as andSync, count as countSync, eq as eqSync } from 'drizzle-orm';
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
import { NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { reviewComments as reviewCommentsTable, reviews as reviewsTable } from '../../db/schema';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ReviewStorageDelegate');

export class ReviewStorageDelegate extends BaseStorageDelegate implements ReviewStorage {
  constructor(context: StorageDelegateContext) {
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
    return this.getReviewSync(id);
  }

  private getReviewSync(id: string): Review {
    const row = this.db
      .select()
      .from(reviewsTable)
      .where(eqSync(reviewsTable.id, id))
      .limit(1)
      .get();
    if (!row) {
      throw new NotFoundError('Review', id);
    }

    const countResult = this.db
      .select({ count: countSync() })
      .from(reviewCommentsTable)
      .where(eqSync(reviewCommentsTable.reviewId, id))
      .get();

    return {
      ...row,
      commentCount: countResult?.count ?? 0,
    } as Review;
  }

  async updateReview(id: string, data: UpdateReview, expectedVersion: number): Promise<Review> {
    const result = await this.versionedMutationExecutor.execute({
      resource: 'Review',
      id,
      expectedVersion,
      loadCurrent: () => this.getReviewSync(id),
      versionOf: (current) => current.version,
      prepare: () => {
        const updateData: Record<string, unknown> = {};
        if (data.title !== undefined) updateData.title = data.title;
        if (data.description !== undefined) updateData.description = data.description;
        if (data.status !== undefined) updateData.status = data.status;
        if (data.headSha !== undefined) updateData.headSha = data.headSha;
        return {
          kind: 'write' as const,
          state: { updateData, now: new Date().toISOString() },
        };
      },
      write: (context, state) =>
        this.db
          .update(reviewsTable)
          .set({ ...state.updateData, version: context.nextVersion, updatedAt: state.now })
          .where(
            andSync(
              eqSync(reviewsTable.id, id),
              eqSync(reviewsTable.version, context.actualVersion),
            ),
          )
          .run().changes,
      loadResult: () => this.getReviewSync(id),
    });

    logger.info({ reviewId: id }, 'Updated review');
    return result;
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

    await this.txRunner.runImmediateAsync(async () => {
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
    });

    logger.info(
      { commentId: comment.id, reviewId: comment.reviewId, targets: targetAgentIds?.length ?? 0 },
      'Created review comment',
    );
    return comment;
  }

  async getReviewComment(id: string): Promise<ReviewComment> {
    return this.getReviewCommentSync(id);
  }

  private getReviewCommentSync(id: string): ReviewComment {
    const row = this.db
      .select()
      .from(reviewCommentsTable)
      .where(eqSync(reviewCommentsTable.id, id))
      .limit(1)
      .get();
    if (!row) {
      throw new NotFoundError('ReviewComment', id);
    }

    return row as ReviewComment;
  }

  async updateReviewComment(
    id: string,
    data: UpdateReviewComment,
    expectedVersion: number,
  ): Promise<ReviewComment> {
    const result = await this.versionedMutationExecutor.execute({
      resource: 'ReviewComment',
      id,
      expectedVersion,
      loadCurrent: () => this.getReviewCommentSync(id),
      versionOf: (current) => current.version,
      prepare: (context) => {
        const now = new Date().toISOString();
        const updateData: Record<string, unknown> = {};
        if (data.content !== undefined && data.content !== context.current.content) {
          updateData.content = data.content;
          updateData.editedAt = now;
        }
        if (data.status !== undefined && data.status !== context.current.status) {
          updateData.status = data.status;
        }

        if (Object.keys(updateData).length === 0) {
          return { kind: 'no_change' as const, result: context.current };
        }
        return { kind: 'write' as const, state: { updateData, now } };
      },
      write: (context, state) =>
        this.db
          .update(reviewCommentsTable)
          .set({ ...state.updateData, version: context.nextVersion, updatedAt: state.now })
          .where(
            andSync(
              eqSync(reviewCommentsTable.id, id),
              eqSync(reviewCommentsTable.version, context.actualVersion),
            ),
          )
          .run().changes,
      loadResult: () => this.getReviewCommentSync(id),
    });

    if (result.version === expectedVersion) {
      logger.info({ commentId: id }, 'Skipped review comment update (no changes)');
    } else {
      logger.info({ commentId: id }, 'Updated review comment');
    }
    return result;
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
    this.getReviewCommentSync(commentId);

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
}
