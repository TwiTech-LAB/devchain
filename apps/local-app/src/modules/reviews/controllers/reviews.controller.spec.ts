import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from '../services/reviews.service';
import type {
  Review,
  ReviewComment,
  ReviewCommentTarget,
} from '../../storage/models/domain.models';
import {
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '../../../common/errors/error-types';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('ReviewsController', () => {
  let controller: ReviewsController;
  let reviewsService: jest.Mocked<
    Pick<
      ReviewsService,
      | 'createReview'
      | 'getReview'
      | 'updateReview'
      | 'deleteReview'
      | 'listReviews'
      | 'createComment'
      | 'getComment'
      | 'updateComment'
      | 'resolveComment'
      | 'listComments'
      | 'getCommentTargets'
    >
  >;

  const projectId = '550e8400-e29b-41d4-a716-446655440000';
  const reviewId = '550e8400-e29b-41d4-a716-446655440001';
  const commentId = '550e8400-e29b-41d4-a716-446655440002';

  beforeEach(async () => {
    reviewsService = {
      createReview: jest.fn(),
      getReview: jest.fn(),
      updateReview: jest.fn(),
      deleteReview: jest.fn(),
      listReviews: jest.fn(),
      createComment: jest.fn(),
      getComment: jest.fn(),
      updateComment: jest.fn(),
      resolveComment: jest.fn(),
      listComments: jest.fn(),
      getCommentTargets: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [
        {
          provide: ReviewsService,
          useValue: reviewsService,
        },
      ],
    }).compile();

    controller = module.get(ReviewsController);
  });

  function makeReview(overrides: Partial<Review> = {}): Review {
    const now = new Date().toISOString();
    return {
      id: overrides.id ?? reviewId,
      projectId: overrides.projectId ?? projectId,
      epicId: overrides.epicId ?? null,
      title: overrides.title ?? 'Test Review',
      description: overrides.description ?? null,
      status: overrides.status ?? 'draft',
      baseRef: overrides.baseRef ?? 'main',
      headRef: overrides.headRef ?? 'feature/test',
      baseSha: overrides.baseSha ?? 'abc123',
      headSha: overrides.headSha ?? 'def456',
      createdBy: overrides.createdBy ?? 'user',
      createdByAgentId: overrides.createdByAgentId ?? null,
      version: overrides.version ?? 1,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
    const now = new Date().toISOString();
    return {
      id: overrides.id ?? commentId,
      reviewId: overrides.reviewId ?? reviewId,
      filePath: overrides.filePath ?? null,
      parentId: overrides.parentId ?? null,
      lineStart: overrides.lineStart ?? null,
      lineEnd: overrides.lineEnd ?? null,
      side: overrides.side ?? null,
      content: overrides.content ?? 'Test comment',
      commentType: overrides.commentType ?? 'comment',
      status: overrides.status ?? 'open',
      authorType: overrides.authorType ?? 'user',
      authorAgentId: overrides.authorAgentId ?? null,
      version: overrides.version ?? 1,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  describe('GET /api/reviews (list)', () => {
    it('returns reviews for a valid project', async () => {
      const reviews = [makeReview()];
      reviewsService.listReviews.mockResolvedValue({
        items: reviews,
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listReviews(projectId);

      expect(result?.items).toHaveLength(1);
      expect(reviewsService.listReviews).toHaveBeenCalledWith(projectId, expect.any(Object));
    });

    it('throws NotFoundException for non-existent project', async () => {
      reviewsService.listReviews.mockRejectedValue(new NotFoundError('Project', projectId));

      await expect(controller.listReviews(projectId)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid projectId', async () => {
      await expect(controller.listReviews('not-a-uuid')).rejects.toThrow(BadRequestException);
    });

    it('filters by status', async () => {
      reviewsService.listReviews.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      await controller.listReviews(projectId, 'pending');

      expect(reviewsService.listReviews).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({ status: 'pending' }),
      );
    });
  });

  describe('POST /api/reviews', () => {
    it('creates a review with valid data', async () => {
      const review = makeReview();
      reviewsService.createReview.mockResolvedValue(review);

      const result = await controller.createReview({
        projectId,
        title: 'Test Review',
        baseRef: 'main',
        headRef: 'feature/test',
        baseSha: 'abc123',
        headSha: 'def456',
      });

      expect(result?.id).toBe(reviewId);
      expect(reviewsService.createReview).toHaveBeenCalled();
    });

    it('throws NotFoundException for non-existent project', async () => {
      reviewsService.createReview.mockRejectedValue(new NotFoundError('Project', projectId));

      await expect(
        controller.createReview({
          projectId,
          title: 'Test Review',
          baseRef: 'main',
          headRef: 'feature/test',
          baseSha: 'abc123',
          headSha: 'def456',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for missing required fields', async () => {
      await expect(
        controller.createReview({
          projectId,
          title: '',
          baseRef: 'main',
          headRef: 'feature/test',
          baseSha: 'abc123',
          headSha: 'def456',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for validation errors from service', async () => {
      reviewsService.createReview.mockRejectedValue(
        new ValidationError('Failed to resolve git refs'),
      );

      await expect(
        controller.createReview({
          projectId,
          title: 'Test Review',
          baseRef: 'invalid-ref',
          headRef: 'feature/test',
          baseSha: 'abc123',
          headSha: 'def456',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('GET /api/reviews/:id', () => {
    it('returns a review by id', async () => {
      const review = makeReview();
      reviewsService.getReview.mockResolvedValue(review);

      const result = await controller.getReview(reviewId);

      expect(result?.id).toBe(reviewId);
    });

    it('throws NotFoundException for non-existent review', async () => {
      reviewsService.getReview.mockRejectedValue(new NotFoundError('Review', reviewId));

      await expect(controller.getReview(reviewId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('PUT /api/reviews/:id', () => {
    it('updates a review with valid data', async () => {
      const review = makeReview({ title: 'Updated Title', version: 2 });
      reviewsService.updateReview.mockResolvedValue(review);

      const result = await controller.updateReview(reviewId, {
        title: 'Updated Title',
        version: 1,
      });

      expect(result?.title).toBe('Updated Title');
    });

    it('throws NotFoundException for non-existent review', async () => {
      reviewsService.updateReview.mockRejectedValue(new NotFoundError('Review', reviewId));

      await expect(
        controller.updateReview(reviewId, {
          title: 'Updated Title',
          version: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for version conflict', async () => {
      reviewsService.updateReview.mockRejectedValue(
        new OptimisticLockError('Review', reviewId, 1, 2),
      );

      await expect(
        controller.updateReview(reviewId, {
          title: 'Updated Title',
          version: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('DELETE /api/reviews/:id', () => {
    it('deletes a review', async () => {
      reviewsService.deleteReview.mockResolvedValue();

      await controller.deleteReview(reviewId);

      expect(reviewsService.deleteReview).toHaveBeenCalledWith(reviewId);
    });

    it('throws NotFoundException for non-existent review', async () => {
      reviewsService.deleteReview.mockRejectedValue(new NotFoundError('Review', reviewId));

      await expect(controller.deleteReview(reviewId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /api/reviews/:id/comments', () => {
    it('returns comments for a review', async () => {
      const comments = [makeComment()];
      reviewsService.listComments.mockResolvedValue({
        items: comments,
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listComments(reviewId);

      expect(result?.items).toHaveLength(1);
    });

    it('throws NotFoundException for non-existent review', async () => {
      reviewsService.listComments.mockRejectedValue(new NotFoundError('Review', reviewId));

      await expect(controller.listComments(reviewId)).rejects.toThrow(NotFoundException);
    });

    it('filters by status', async () => {
      reviewsService.listComments.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      await controller.listComments(reviewId, 'resolved');

      expect(reviewsService.listComments).toHaveBeenCalledWith(
        reviewId,
        expect.objectContaining({ status: 'resolved' }),
      );
    });
  });

  describe('POST /api/reviews/:id/comments', () => {
    it('creates a comment with valid data', async () => {
      const comment = makeComment();
      reviewsService.createComment.mockResolvedValue(comment);

      const result = await controller.createComment(reviewId, {
        content: 'Test comment',
      });

      expect(result?.id).toBe(commentId);
    });

    it('throws NotFoundException for non-existent review', async () => {
      reviewsService.createComment.mockRejectedValue(new NotFoundError('Review', reviewId));

      await expect(
        controller.createComment(reviewId, {
          content: 'Test comment',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for missing content', async () => {
      await expect(
        controller.createComment(reviewId, {
          content: '',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('PUT /api/reviews/:id/comments/:commentId', () => {
    it('updates a comment with valid data', async () => {
      const comment = makeComment({ content: 'Updated content', version: 2 });
      reviewsService.updateComment.mockResolvedValue(comment);

      const result = await controller.updateComment(reviewId, commentId, {
        content: 'Updated content',
        version: 1,
      });

      expect(result?.content).toBe('Updated content');
    });

    it('throws NotFoundException for non-existent comment', async () => {
      reviewsService.updateComment.mockRejectedValue(new NotFoundError('Comment', commentId));

      await expect(
        controller.updateComment(reviewId, commentId, {
          content: 'Updated content',
          version: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for version conflict', async () => {
      reviewsService.updateComment.mockRejectedValue(
        new OptimisticLockError('Comment', commentId, 1, 2),
      );

      await expect(
        controller.updateComment(reviewId, commentId, {
          content: 'Updated content',
          version: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    // SECURITY: IDOR protection test (service handles verification)
    it('throws NotFoundException when comment belongs to different review (IDOR protection)', async () => {
      // Service throws NotFoundError for IDOR violations
      reviewsService.updateComment.mockRejectedValue(new NotFoundError('ReviewComment', commentId));

      await expect(
        controller.updateComment(reviewId, commentId, {
          content: 'Updated content',
          version: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('POST /api/reviews/:id/comments/:commentId/resolve', () => {
    it('resolves a comment', async () => {
      const comment = makeComment({ status: 'resolved', version: 2 });
      reviewsService.resolveComment.mockResolvedValue(comment);

      const result = await controller.resolveComment(reviewId, commentId, {
        status: 'resolved',
        version: 1,
      });

      expect(result?.status).toBe('resolved');
    });

    it('marks comment as wont_fix', async () => {
      const comment = makeComment({ status: 'wont_fix', version: 2 });
      reviewsService.resolveComment.mockResolvedValue(comment);

      const result = await controller.resolveComment(reviewId, commentId, {
        status: 'wont_fix',
        version: 1,
      });

      expect(result?.status).toBe('wont_fix');
    });

    it('throws NotFoundException for non-existent comment', async () => {
      reviewsService.resolveComment.mockRejectedValue(new NotFoundError('Comment', commentId));

      await expect(
        controller.resolveComment(reviewId, commentId, {
          status: 'resolved',
          version: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid status', async () => {
      await expect(
        controller.resolveComment(reviewId, commentId, {
          status: 'open' as 'resolved',
          version: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    // SECURITY: IDOR protection test (service handles verification)
    it('throws NotFoundException when comment belongs to different review (IDOR protection)', async () => {
      // Service throws NotFoundError for IDOR violations
      reviewsService.resolveComment.mockRejectedValue(
        new NotFoundError('ReviewComment', commentId),
      );

      await expect(
        controller.resolveComment(reviewId, commentId, {
          status: 'resolved',
          version: 1,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /api/reviews/:id/comments/:commentId/targets', () => {
    it('returns comment targets', async () => {
      const targets: ReviewCommentTarget[] = [
        {
          id: '550e8400-e29b-41d4-a716-446655440003',
          commentId,
          agentId: '550e8400-e29b-41d4-a716-446655440004',
          createdAt: new Date().toISOString(),
        },
      ];
      reviewsService.getCommentTargets.mockResolvedValue(targets);

      const result = await controller.getCommentTargets(reviewId, commentId);

      expect(result).toHaveLength(1);
    });

    it('throws NotFoundException for non-existent comment', async () => {
      reviewsService.getCommentTargets.mockRejectedValue(new NotFoundError('Comment', commentId));

      await expect(controller.getCommentTargets(reviewId, commentId)).rejects.toThrow(
        NotFoundException,
      );
    });

    // SECURITY: IDOR protection test (service handles verification)
    it('throws NotFoundException when comment belongs to different review (IDOR protection)', async () => {
      // Service throws NotFoundError for IDOR violations
      reviewsService.getCommentTargets.mockRejectedValue(
        new NotFoundError('ReviewComment', commentId),
      );

      await expect(controller.getCommentTargets(reviewId, commentId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
