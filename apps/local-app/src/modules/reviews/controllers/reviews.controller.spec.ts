import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from '../services/reviews.service';
import type { ReviewComment } from '../../storage/models/domain.models';
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
      editedAt: overrides.editedAt ?? null,
      version: overrides.version ?? 1,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  describe('GET /api/reviews (list)', () => {
    it('throws NotFoundException for non-existent project', async () => {
      reviewsService.listReviews.mockRejectedValue(new NotFoundError('Project', projectId));

      await expect(controller.listReviews(projectId)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid projectId', async () => {
      await expect(controller.listReviews('not-a-uuid')).rejects.toThrow(BadRequestException);
    });
  });

  describe('POST /api/reviews', () => {
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

  describe('PUT /api/reviews/:id', () => {
    it('throws BadRequestException for version conflict', async () => {
      reviewsService.updateReview.mockRejectedValue(
        new OptimisticLockError('Review', reviewId, { expectedVersion: 1, actualVersion: 2 }),
      );

      await expect(
        controller.updateReview(reviewId, {
          title: 'Updated Title',
          version: 1,
        }),
      ).rejects.toThrow(BadRequestException);
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
  });
});
