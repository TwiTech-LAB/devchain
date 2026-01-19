import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { ReviewCommentCreatedEventPayload } from '../catalog/review.comment.created';
import type { ReviewCommentDeletedEventPayload } from '../catalog/review.comment.deleted';
import type { ReviewCommentResolvedEventPayload } from '../catalog/review.comment.resolved';
import type { ReviewCommentUpdatedEventPayload } from '../catalog/review.comment.updated';
import type { ReviewUpdatedEventPayload } from '../catalog/review.updated';

/**
 * Subscriber that broadcasts review events via WebSocket for real-time UI updates.
 * Broadcasts to:
 * - `project/{projectId}/reviews` - for project-level updates (e.g., review list)
 * - `review/{reviewId}` - for review-specific updates (e.g., comments)
 */
@Injectable()
export class ReviewBroadcasterSubscriber {
  private readonly logger = new Logger(ReviewBroadcasterSubscriber.name);

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway: TerminalGateway,
  ) {}

  @OnEvent('review.comment.created', { async: true })
  async handleCommentCreated(payload: ReviewCommentCreatedEventPayload): Promise<void> {
    try {
      // Broadcast to review-specific topic
      this.terminalGateway.broadcastEvent(`review/${payload.reviewId}`, 'comment.created', {
        commentId: payload.commentId,
        reviewId: payload.reviewId,
        filePath: payload.filePath,
        lineStart: payload.lineStart,
        lineEnd: payload.lineEnd,
        commentType: payload.commentType,
        status: payload.status,
        authorType: payload.authorType,
        authorAgentId: payload.authorAgentId,
        parentId: payload.parentId,
      });

      // Broadcast to project-level topic (for review list updates)
      this.terminalGateway.broadcastEvent(
        `project/${payload.projectId}/reviews`,
        'comment.created',
        {
          reviewId: payload.reviewId,
          commentId: payload.commentId,
        },
      );

      this.logger.debug(
        { reviewId: payload.reviewId, commentId: payload.commentId },
        'Broadcasted comment.created via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, reviewId: payload.reviewId, commentId: payload.commentId },
        'Failed to broadcast comment.created',
      );
    }
  }

  @OnEvent('review.comment.resolved', { async: true })
  async handleCommentResolved(payload: ReviewCommentResolvedEventPayload): Promise<void> {
    try {
      // Broadcast to review-specific topic
      this.terminalGateway.broadcastEvent(`review/${payload.reviewId}`, 'comment.resolved', {
        commentId: payload.commentId,
        reviewId: payload.reviewId,
        status: payload.status,
        version: payload.version,
      });

      // Broadcast to project-level topic
      this.terminalGateway.broadcastEvent(
        `project/${payload.projectId}/reviews`,
        'comment.resolved',
        {
          reviewId: payload.reviewId,
          commentId: payload.commentId,
          status: payload.status,
        },
      );

      this.logger.debug(
        { reviewId: payload.reviewId, commentId: payload.commentId, status: payload.status },
        'Broadcasted comment.resolved via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, reviewId: payload.reviewId, commentId: payload.commentId },
        'Failed to broadcast comment.resolved',
      );
    }
  }

  @OnEvent('review.updated', { async: true })
  async handleReviewUpdated(payload: ReviewUpdatedEventPayload): Promise<void> {
    try {
      // Broadcast to review-specific topic
      this.terminalGateway.broadcastEvent(`review/${payload.reviewId}`, 'review.updated', {
        reviewId: payload.reviewId,
        version: payload.version,
        title: payload.title,
        changes: payload.changes,
      });

      // Broadcast to project-level topic
      this.terminalGateway.broadcastEvent(
        `project/${payload.projectId}/reviews`,
        'review.updated',
        {
          reviewId: payload.reviewId,
          version: payload.version,
          title: payload.title,
          changes: payload.changes,
        },
      );

      this.logger.debug(
        { reviewId: payload.reviewId, version: payload.version, changes: payload.changes },
        'Broadcasted review.updated via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, reviewId: payload.reviewId },
        'Failed to broadcast review.updated',
      );
    }
  }

  @OnEvent('review.comment.updated', { async: true })
  async handleCommentUpdated(payload: ReviewCommentUpdatedEventPayload): Promise<void> {
    try {
      // Broadcast to review-specific topic
      this.terminalGateway.broadcastEvent(`review/${payload.reviewId}`, 'comment.updated', {
        commentId: payload.commentId,
        reviewId: payload.reviewId,
        content: payload.content,
        version: payload.version,
        editedAt: payload.editedAt,
        filePath: payload.filePath,
      });

      // Broadcast to project-level topic
      this.terminalGateway.broadcastEvent(
        `project/${payload.projectId}/reviews`,
        'comment.updated',
        {
          reviewId: payload.reviewId,
          commentId: payload.commentId,
        },
      );

      this.logger.debug(
        { reviewId: payload.reviewId, commentId: payload.commentId },
        'Broadcasted comment.updated via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, reviewId: payload.reviewId, commentId: payload.commentId },
        'Failed to broadcast comment.updated',
      );
    }
  }

  @OnEvent('review.comment.deleted', { async: true })
  async handleCommentDeleted(payload: ReviewCommentDeletedEventPayload): Promise<void> {
    try {
      // Broadcast to review-specific topic
      this.terminalGateway.broadcastEvent(`review/${payload.reviewId}`, 'comment.deleted', {
        commentId: payload.commentId,
        reviewId: payload.reviewId,
        filePath: payload.filePath,
        parentId: payload.parentId,
      });

      // Broadcast to project-level topic
      this.terminalGateway.broadcastEvent(
        `project/${payload.projectId}/reviews`,
        'comment.deleted',
        {
          reviewId: payload.reviewId,
          commentId: payload.commentId,
        },
      );

      this.logger.debug(
        { reviewId: payload.reviewId, commentId: payload.commentId },
        'Broadcasted comment.deleted via WebSocket',
      );
    } catch (error) {
      this.logger.error(
        { error, reviewId: payload.reviewId, commentId: payload.commentId },
        'Failed to broadcast comment.deleted',
      );
    }
  }
}
