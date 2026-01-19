import { Test, TestingModule } from '@nestjs/testing';
import { ReviewBroadcasterSubscriber } from './review-broadcaster.subscriber';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { ReviewCommentCreatedEventPayload } from '../catalog/review.comment.created';
import type { ReviewCommentDeletedEventPayload } from '../catalog/review.comment.deleted';
import type { ReviewCommentResolvedEventPayload } from '../catalog/review.comment.resolved';
import type { ReviewCommentUpdatedEventPayload } from '../catalog/review.comment.updated';
import type { ReviewUpdatedEventPayload } from '../catalog/review.updated';

describe('ReviewBroadcasterSubscriber', () => {
  let subscriber: ReviewBroadcasterSubscriber;
  let mockTerminalGateway: { broadcastEvent: jest.Mock };

  beforeEach(async () => {
    mockTerminalGateway = {
      broadcastEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewBroadcasterSubscriber,
        {
          provide: TerminalGateway,
          useValue: mockTerminalGateway,
        },
      ],
    }).compile();

    subscriber = module.get<ReviewBroadcasterSubscriber>(ReviewBroadcasterSubscriber);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleCommentCreated', () => {
    const payload: ReviewCommentCreatedEventPayload = {
      commentId: 'comment-123',
      reviewId: 'review-456',
      projectId: 'project-789',
      content: 'Test comment content',
      commentType: 'issue',
      status: 'open',
      authorType: 'user',
      authorAgentId: null,
      filePath: 'src/test.ts',
      lineStart: 10,
      lineEnd: 15,
      parentId: null,
      targetAgentIds: ['agent-1'],
    };

    it('broadcasts to review-specific topic', async () => {
      await subscriber.handleCommentCreated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'comment.created',
        expect.objectContaining({
          commentId: 'comment-123',
          reviewId: 'review-456',
          filePath: 'src/test.ts',
          lineStart: 10,
          lineEnd: 15,
          commentType: 'issue',
          status: 'open',
        }),
      );
    });

    it('broadcasts to project-level topic', async () => {
      await subscriber.handleCommentCreated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'project/project-789/reviews',
        'comment.created',
        {
          reviewId: 'review-456',
          commentId: 'comment-123',
        },
      );
    });

    it('broadcasts to both topics', async () => {
      await subscriber.handleCommentCreated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledTimes(2);
    });

    it('handles errors gracefully', async () => {
      mockTerminalGateway.broadcastEvent.mockImplementation(() => {
        throw new Error('Broadcast failed');
      });

      // Should not throw
      await expect(subscriber.handleCommentCreated(payload)).resolves.not.toThrow();
    });
  });

  describe('handleCommentResolved', () => {
    const payload: ReviewCommentResolvedEventPayload = {
      commentId: 'comment-123',
      reviewId: 'review-456',
      projectId: 'project-789',
      status: 'resolved',
      version: 2,
    };

    it('broadcasts to review-specific topic', async () => {
      await subscriber.handleCommentResolved(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'comment.resolved',
        {
          commentId: 'comment-123',
          reviewId: 'review-456',
          status: 'resolved',
          version: 2,
        },
      );
    });

    it('broadcasts to project-level topic', async () => {
      await subscriber.handleCommentResolved(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'project/project-789/reviews',
        'comment.resolved',
        {
          reviewId: 'review-456',
          commentId: 'comment-123',
          status: 'resolved',
        },
      );
    });

    it('broadcasts wont_fix status', async () => {
      const wontFixPayload = { ...payload, status: 'wont_fix' as const };

      await subscriber.handleCommentResolved(wontFixPayload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'comment.resolved',
        expect.objectContaining({ status: 'wont_fix' }),
      );
    });
  });

  describe('handleReviewUpdated', () => {
    const payload: ReviewUpdatedEventPayload = {
      reviewId: 'review-456',
      projectId: 'project-789',
      version: 3,
      title: 'Updated Review Title',
      changes: {
        status: {
          previous: 'pending',
          current: 'approved',
        },
      },
    };

    it('broadcasts to review-specific topic', async () => {
      await subscriber.handleReviewUpdated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'review.updated',
        {
          reviewId: 'review-456',
          version: 3,
          title: 'Updated Review Title',
          changes: payload.changes,
        },
      );
    });

    it('broadcasts to project-level topic', async () => {
      await subscriber.handleReviewUpdated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'project/project-789/reviews',
        'review.updated',
        {
          reviewId: 'review-456',
          version: 3,
          title: 'Updated Review Title',
          changes: payload.changes,
        },
      );
    });

    it('handles title change', async () => {
      const titleChangePayload: ReviewUpdatedEventPayload = {
        ...payload,
        changes: {
          title: {
            previous: 'Old Title',
            current: 'New Title',
          },
        },
      };

      await subscriber.handleReviewUpdated(titleChangePayload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'review.updated',
        expect.objectContaining({
          changes: {
            title: {
              previous: 'Old Title',
              current: 'New Title',
            },
          },
        }),
      );
    });

    it('handles headSha change', async () => {
      const headShaChangePayload: ReviewUpdatedEventPayload = {
        ...payload,
        changes: {
          headSha: {
            previous: 'abc123',
            current: 'def456',
          },
        },
      };

      await subscriber.handleReviewUpdated(headShaChangePayload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'review.updated',
        expect.objectContaining({
          changes: {
            headSha: {
              previous: 'abc123',
              current: 'def456',
            },
          },
        }),
      );
    });
  });

  describe('handleCommentUpdated', () => {
    const payload: ReviewCommentUpdatedEventPayload = {
      commentId: 'comment-123',
      reviewId: 'review-456',
      projectId: 'project-789',
      content: 'Updated comment content',
      previousContent: 'Original content',
      version: 2,
      editedAt: '2026-01-10T22:00:00.000Z',
      filePath: 'src/test.ts',
    };

    it('broadcasts to review-specific topic', async () => {
      await subscriber.handleCommentUpdated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'comment.updated',
        {
          commentId: 'comment-123',
          reviewId: 'review-456',
          content: 'Updated comment content',
          version: 2,
          editedAt: '2026-01-10T22:00:00.000Z',
          filePath: 'src/test.ts',
        },
      );
    });

    it('broadcasts to project-level topic', async () => {
      await subscriber.handleCommentUpdated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'project/project-789/reviews',
        'comment.updated',
        {
          reviewId: 'review-456',
          commentId: 'comment-123',
        },
      );
    });

    it('broadcasts to both topics', async () => {
      await subscriber.handleCommentUpdated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledTimes(2);
    });

    it('handles errors gracefully', async () => {
      mockTerminalGateway.broadcastEvent.mockImplementation(() => {
        throw new Error('Broadcast failed');
      });

      await expect(subscriber.handleCommentUpdated(payload)).resolves.not.toThrow();
    });
  });

  describe('handleCommentDeleted', () => {
    const payload: ReviewCommentDeletedEventPayload = {
      commentId: 'comment-123',
      reviewId: 'review-456',
      projectId: 'project-789',
      filePath: 'src/test.ts',
      parentId: null,
    };

    it('broadcasts to review-specific topic', async () => {
      await subscriber.handleCommentDeleted(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'comment.deleted',
        {
          commentId: 'comment-123',
          reviewId: 'review-456',
          filePath: 'src/test.ts',
          parentId: null,
        },
      );
    });

    it('broadcasts to project-level topic', async () => {
      await subscriber.handleCommentDeleted(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'project/project-789/reviews',
        'comment.deleted',
        {
          reviewId: 'review-456',
          commentId: 'comment-123',
        },
      );
    });

    it('broadcasts to both topics', async () => {
      await subscriber.handleCommentDeleted(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledTimes(2);
    });

    it('handles reply deletion (with parentId)', async () => {
      const replyPayload = { ...payload, parentId: 'parent-comment-999' };

      await subscriber.handleCommentDeleted(replyPayload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'review/review-456',
        'comment.deleted',
        expect.objectContaining({ parentId: 'parent-comment-999' }),
      );
    });

    it('handles errors gracefully', async () => {
      mockTerminalGateway.broadcastEvent.mockImplementation(() => {
        throw new Error('Broadcast failed');
      });

      await expect(subscriber.handleCommentDeleted(payload)).resolves.not.toThrow();
    });
  });
});
