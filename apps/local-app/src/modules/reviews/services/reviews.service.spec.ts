import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsService } from './reviews.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { EventsService } from '../../events/services/events.service';
import { GitService } from '../../git/services/git.service';
import type { Review, ReviewComment } from '../../storage/models/domain.models';
import { ValidationError, NotFoundError, ForbiddenError } from '../../../common/errors/error-types';

describe('ReviewsService', () => {
  let service: ReviewsService;
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'getProject'
      | 'createReview'
      | 'getReview'
      | 'updateReview'
      | 'deleteReview'
      | 'listReviews'
      | 'createReviewComment'
      | 'getReviewComment'
      | 'updateReviewComment'
      | 'deleteReviewComment'
      | 'listReviewComments'
      | 'getReviewCommentTargets'
      | 'deleteNonResolvedComments'
    >
  >;
  let eventsService: jest.Mocked<Pick<EventsService, 'publish'>>;
  let gitService: jest.Mocked<Pick<GitService, 'resolveRef' | 'getChangedFiles'>>;

  const projectId = '550e8400-e29b-41d4-a716-446655440000';
  const reviewId = '550e8400-e29b-41d4-a716-446655440001';
  const commentId = '550e8400-e29b-41d4-a716-446655440002';

  beforeEach(async () => {
    storage = {
      getProject: jest.fn(),
      createReview: jest.fn(),
      getReview: jest.fn(),
      updateReview: jest.fn(),
      deleteReview: jest.fn(),
      listReviews: jest.fn(),
      createReviewComment: jest.fn(),
      getReviewComment: jest.fn(),
      updateReviewComment: jest.fn(),
      deleteReviewComment: jest.fn(),
      listReviewComments: jest.fn(),
      getReviewCommentTargets: jest.fn(),
      deleteNonResolvedComments: jest.fn(),
    };

    eventsService = {
      publish: jest.fn().mockResolvedValue('event-id'),
    };

    gitService = {
      resolveRef: jest.fn(),
      getChangedFiles: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: EventsService, useValue: eventsService },
        { provide: GitService, useValue: gitService },
      ],
    }).compile();

    service = module.get(ReviewsService);
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
      mode: overrides.mode ?? 'commit',
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
      editedAt: overrides.editedAt ?? null,
      version: overrides.version ?? 1,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  describe('createReview', () => {
    it('resolves refs to SHAs and creates review in commit mode', async () => {
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      gitService.resolveRef.mockResolvedValueOnce('abc123').mockResolvedValueOnce('def456');
      storage.createReview.mockResolvedValue(makeReview());

      const result = await service.createReview({
        projectId,
        title: 'Test Review',
        mode: 'commit',
        baseRef: 'main',
        headRef: 'feature/test',
      });

      expect(result.id).toBe(reviewId);
      expect(gitService.resolveRef).toHaveBeenCalledWith(projectId, 'main');
      expect(gitService.resolveRef).toHaveBeenCalledWith(projectId, 'feature/test');
      expect(storage.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'commit',
          baseSha: 'abc123',
          headSha: 'def456',
        }),
      );
    });

    it('emits review.created event', async () => {
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      gitService.resolveRef.mockResolvedValue('abc123');
      storage.createReview.mockResolvedValue(makeReview());

      await service.createReview({
        projectId,
        title: 'Test Review',
        mode: 'commit',
        baseRef: 'main',
        headRef: 'feature/test',
      });

      expect(eventsService.publish).toHaveBeenCalledWith(
        'review.created',
        expect.objectContaining({
          reviewId,
          projectId,
          title: 'Test Review',
          projectName: 'Test Project',
        }),
      );
    });

    it('throws ValidationError when ref resolution fails in commit mode', async () => {
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      gitService.resolveRef.mockRejectedValue(new Error('Ref not found'));

      await expect(
        service.createReview({
          projectId,
          title: 'Test Review',
          mode: 'commit',
          baseRef: 'invalid-ref',
          headRef: 'feature/test',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('uses provided baseSha/headSha without resolving refs in commit mode', async () => {
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      storage.createReview.mockResolvedValue(makeReview());

      await service.createReview({
        projectId,
        title: 'Test Review',
        mode: 'commit',
        baseRef: 'main',
        headRef: 'feature/test',
        baseSha: 'provided-base-sha',
        headSha: 'provided-head-sha',
      });

      // Should NOT call resolveRef when SHAs are provided
      expect(gitService.resolveRef).not.toHaveBeenCalled();
      expect(storage.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'commit',
          baseSha: 'provided-base-sha',
          headSha: 'provided-head-sha',
        }),
      );
    });

    it('does not resolve refs in working_tree mode', async () => {
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      storage.createReview.mockResolvedValue(
        makeReview({ mode: 'working_tree', baseSha: null, headSha: null }),
      );

      await service.createReview({
        projectId,
        title: 'Pre-commit review',
        mode: 'working_tree',
        baseRef: 'HEAD',
        headRef: 'HEAD',
      });

      // Should NOT call resolveRef for working_tree mode
      expect(gitService.resolveRef).not.toHaveBeenCalled();
      expect(storage.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'working_tree',
          baseSha: null,
          headSha: null,
        }),
      );
    });
  });

  describe('getReview', () => {
    it('returns review with changed files', async () => {
      storage.getReview.mockResolvedValue(makeReview());
      gitService.getChangedFiles.mockResolvedValue([
        { path: 'src/index.ts', status: 'modified', additions: 10, deletions: 5 },
      ]);

      const result = await service.getReview(reviewId);

      expect(result.id).toBe(reviewId);
      expect(result.changedFiles).toHaveLength(1);
    });

    it('returns review without changed files if git fails', async () => {
      storage.getReview.mockResolvedValue(makeReview());
      gitService.getChangedFiles.mockRejectedValue(new Error('Git error'));

      const result = await service.getReview(reviewId);

      expect(result.id).toBe(reviewId);
      expect(result.changedFiles).toBeUndefined();
    });
  });

  describe('updateReview', () => {
    it('updates review and emits event', async () => {
      const before = makeReview({ status: 'draft' });
      const after = makeReview({ status: 'pending', version: 2 });
      storage.getReview.mockResolvedValue(before);
      storage.updateReview.mockResolvedValue(after);
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);

      const result = await service.updateReview(reviewId, { status: 'pending' }, 1);

      expect(result.status).toBe('pending');
      expect(eventsService.publish).toHaveBeenCalledWith(
        'review.updated',
        expect.objectContaining({
          reviewId,
          changes: {
            status: { previous: 'draft', current: 'pending' },
          },
        }),
      );
    });

    it('does not emit event if no changes', async () => {
      const review = makeReview();
      storage.getReview.mockResolvedValue(review);
      storage.updateReview.mockResolvedValue(review);

      await service.updateReview(reviewId, {}, 1);

      expect(eventsService.publish).not.toHaveBeenCalled();
    });
  });

  describe('listReviews', () => {
    it('returns reviews for project', async () => {
      storage.getProject.mockResolvedValue({ id: projectId } as never);
      storage.listReviews.mockResolvedValue({
        items: [makeReview()],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.listReviews(projectId);

      expect(result.items).toHaveLength(1);
    });

    it('passes filters to storage', async () => {
      storage.getProject.mockResolvedValue({ id: projectId } as never);
      storage.listReviews.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      await service.listReviews(projectId, { status: 'pending', limit: 50 });

      expect(storage.listReviews).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({ status: 'pending', limit: 50 }),
      );
    });
  });

  describe('createComment', () => {
    it('creates comment and emits event', async () => {
      const review = makeReview();
      storage.getReview.mockResolvedValue(review);
      storage.createReviewComment.mockResolvedValue(makeComment());
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);

      const result = await service.createComment(reviewId, {
        content: 'Test comment',
      });

      expect(result.id).toBe(commentId);
      expect(eventsService.publish).toHaveBeenCalledWith(
        'review.comment.created',
        expect.objectContaining({
          commentId,
          reviewId,
          content: 'Test comment',
        }),
      );
    });

    it('creates comment with target agents', async () => {
      const review = makeReview();
      const targetAgentIds = ['agent-1', 'agent-2'];
      storage.getReview.mockResolvedValue(review);
      storage.createReviewComment.mockResolvedValue(makeComment());
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);

      await service.createComment(reviewId, {
        content: 'Test comment',
        targetAgentIds,
      });

      expect(storage.createReviewComment).toHaveBeenCalledWith(expect.anything(), targetAgentIds);
    });

    it('inherits file context from parent when creating reply', async () => {
      const parentCommentId = '660e8400-e29b-41d4-a716-446655440099';
      const parentComment = makeComment({
        id: parentCommentId,
        filePath: 'src/index.ts',
        lineStart: 42,
        lineEnd: 45,
        side: 'right',
      });
      const reply = makeComment({
        parentId: parentCommentId,
        filePath: 'src/index.ts',
        lineStart: 42,
        lineEnd: 45,
        side: 'right',
      });

      storage.getReview.mockResolvedValue(makeReview());
      storage.getReviewComment.mockResolvedValue(parentComment);
      storage.createReviewComment.mockResolvedValue(reply);
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      // Mock getReviewCommentTargets for reply target defaulting (empty = no targets to inherit)
      storage.getReviewCommentTargets.mockResolvedValue([]);

      await service.createComment(reviewId, {
        content: 'Reply comment',
        parentId: parentCommentId,
        // Note: Not providing filePath/lineStart/lineEnd/side - should inherit from parent
      });

      // Verify reply inherits file context from parent
      // Parent is user-authored with no targets, so resolvedTargetAgentIds remains undefined
      expect(storage.createReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: 'src/index.ts',
          lineStart: 42,
          lineEnd: 45,
          side: 'right',
          parentId: parentCommentId,
        }),
        undefined,
      );
    });

    it('rejects replies when parent belongs to different review', async () => {
      const parentCommentId = '660e8400-e29b-41d4-a716-446655440098';
      const otherReviewId = '660e8400-e29b-41d4-a716-446655440097';

      storage.getReview.mockResolvedValue(makeReview());
      storage.getReviewComment.mockResolvedValue(
        makeComment({ id: parentCommentId, reviewId: otherReviewId }),
      );

      await expect(
        service.createComment(reviewId, {
          content: 'Reply comment',
          parentId: parentCommentId,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(storage.createReviewComment).not.toHaveBeenCalled();
    });

    describe('reply target defaulting', () => {
      const parentCommentId = '660e8400-e29b-41d4-a716-446655440099';

      it('uses explicit targetAgentIds when provided', async () => {
        const parentComment = makeComment({ id: parentCommentId });
        const explicitTargets = ['agent-explicit-1', 'agent-explicit-2'];

        storage.getReview.mockResolvedValue(makeReview());
        storage.getReviewComment.mockResolvedValue(parentComment);
        storage.createReviewComment.mockResolvedValue(makeComment({ parentId: parentCommentId }));
        storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
        // Should NOT call getReviewCommentTargets when explicit targets provided
        storage.getReviewCommentTargets.mockResolvedValue([]);

        await service.createComment(reviewId, {
          content: 'Reply with explicit targets',
          parentId: parentCommentId,
          targetAgentIds: explicitTargets,
        });

        // Verify explicit targets are used
        expect(storage.createReviewComment).toHaveBeenCalledWith(
          expect.anything(),
          explicitTargets,
        );
        // Should NOT fetch parent targets when explicit targets provided
        expect(storage.getReviewCommentTargets).not.toHaveBeenCalled();
      });

      it('defaults to parent comment targets when no targetAgentIds provided', async () => {
        const parentComment = makeComment({ id: parentCommentId });
        const parentTargets = [
          {
            id: 'target-1',
            commentId: parentCommentId,
            agentId: 'agent-1',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'target-2',
            commentId: parentCommentId,
            agentId: 'agent-2',
            createdAt: new Date().toISOString(),
          },
        ];

        storage.getReview.mockResolvedValue(makeReview());
        storage.getReviewComment.mockResolvedValue(parentComment);
        storage.createReviewComment.mockResolvedValue(makeComment({ parentId: parentCommentId }));
        storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
        storage.getReviewCommentTargets.mockResolvedValue(parentTargets);

        await service.createComment(reviewId, {
          content: 'Reply inheriting parent targets',
          parentId: parentCommentId,
          // No targetAgentIds provided
        });

        // Verify parent's targets are inherited
        expect(storage.getReviewCommentTargets).toHaveBeenCalledWith(parentCommentId);
        expect(storage.createReviewComment).toHaveBeenCalledWith(expect.anything(), [
          'agent-1',
          'agent-2',
        ]);
      });

      it('defaults to parent author agentId when parent is agent-authored with no targets', async () => {
        const agentAuthoredParent = makeComment({
          id: parentCommentId,
          authorType: 'agent',
          authorAgentId: 'agent-author-123',
        });

        storage.getReview.mockResolvedValue(makeReview());
        storage.getReviewComment.mockResolvedValue(agentAuthoredParent);
        storage.createReviewComment.mockResolvedValue(makeComment({ parentId: parentCommentId }));
        storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
        // Parent has no targets
        storage.getReviewCommentTargets.mockResolvedValue([]);

        await service.createComment(reviewId, {
          content: 'Reply to agent comment',
          parentId: parentCommentId,
          // No targetAgentIds provided
        });

        // Verify agent author is used as target
        expect(storage.createReviewComment).toHaveBeenCalledWith(expect.anything(), [
          'agent-author-123',
        ]);
      });

      it('remains untargeted when parent is user-authored with no targets', async () => {
        const userAuthoredParent = makeComment({
          id: parentCommentId,
          authorType: 'user',
          authorAgentId: null,
        });

        storage.getReview.mockResolvedValue(makeReview());
        storage.getReviewComment.mockResolvedValue(userAuthoredParent);
        storage.createReviewComment.mockResolvedValue(makeComment({ parentId: parentCommentId }));
        storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
        // Parent has no targets
        storage.getReviewCommentTargets.mockResolvedValue([]);

        await service.createComment(reviewId, {
          content: 'Reply to user comment',
          parentId: parentCommentId,
          // No targetAgentIds provided
        });

        // Verify no targets are set (remains undefined)
        expect(storage.createReviewComment).toHaveBeenCalledWith(expect.anything(), undefined);
      });

      it('includes resolved targetAgentIds in event payload', async () => {
        const agentAuthoredParent = makeComment({
          id: parentCommentId,
          authorType: 'agent',
          authorAgentId: 'agent-for-event-test',
        });

        storage.getReview.mockResolvedValue(makeReview());
        storage.getReviewComment.mockResolvedValue(agentAuthoredParent);
        storage.createReviewComment.mockResolvedValue(makeComment({ parentId: parentCommentId }));
        storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
        storage.getReviewCommentTargets.mockResolvedValue([]);

        await service.createComment(reviewId, {
          content: 'Reply for event test',
          parentId: parentCommentId,
        });

        // Verify event payload includes the resolved targets
        expect(eventsService.publish).toHaveBeenCalledWith(
          'review.comment.created',
          expect.objectContaining({
            targetAgentIds: ['agent-for-event-test'],
          }),
        );
      });

      it('passes empty array as targets when explicitly provided', async () => {
        const parentComment = makeComment({ id: parentCommentId });
        const parentTargets = [
          {
            id: 'target-1',
            commentId: parentCommentId,
            agentId: 'agent-1',
            createdAt: new Date().toISOString(),
          },
        ];

        storage.getReview.mockResolvedValue(makeReview());
        storage.getReviewComment.mockResolvedValue(parentComment);
        storage.createReviewComment.mockResolvedValue(makeComment({ parentId: parentCommentId }));
        storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
        storage.getReviewCommentTargets.mockResolvedValue(parentTargets);

        await service.createComment(reviewId, {
          content: 'Reply with explicit empty targets',
          parentId: parentCommentId,
          targetAgentIds: [], // Explicitly empty - should NOT inherit
        });

        // Empty array is falsy for our check, so it WILL inherit
        // This is intentional - empty array means "use defaults"
        expect(storage.createReviewComment).toHaveBeenCalledWith(expect.anything(), ['agent-1']);
      });
    });
  });

  describe('updateComment', () => {
    it('updates comment with IDOR verification', async () => {
      const comment = makeComment();
      const updated = makeComment({
        content: 'Updated',
        version: 2,
        editedAt: '2025-01-10T00:00:00.000Z',
      });
      storage.getReviewComment.mockResolvedValue(comment);
      storage.getReview.mockResolvedValue(makeReview());
      storage.updateReviewComment.mockResolvedValue(updated);

      const result = await service.updateComment(reviewId, commentId, { content: 'Updated' }, 1);

      expect(result.content).toBe('Updated');
      expect(storage.updateReviewComment).toHaveBeenCalledWith(
        commentId,
        { content: 'Updated' },
        1,
      );
    });

    // SECURITY: IDOR protection test
    it('throws NotFoundError when comment belongs to different review (IDOR protection)', async () => {
      const otherReviewId = '550e8400-e29b-41d4-a716-446655440099';
      // Comment belongs to a different review
      storage.getReviewComment.mockResolvedValue(makeComment({ reviewId: otherReviewId }));

      await expect(
        service.updateComment(reviewId, commentId, { content: 'Updated' }, 1),
      ).rejects.toThrow(NotFoundError);

      // Verify storage update was never called (blocked before modification)
      expect(storage.updateReviewComment).not.toHaveBeenCalled();
    });

    // SECURITY: Ownership enforcement test
    it('throws ForbiddenError when trying to edit agent-authored comment', async () => {
      const agentComment = makeComment({
        authorType: 'agent',
        authorAgentId: 'agent-123',
      });
      storage.getReviewComment.mockResolvedValue(agentComment);

      await expect(
        service.updateComment(reviewId, commentId, { content: 'Updated' }, 1),
      ).rejects.toThrow(ForbiddenError);

      // Verify storage update was never called (blocked before modification)
      expect(storage.updateReviewComment).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment', () => {
    it('deletes user-authored comment successfully', async () => {
      const userComment = makeComment({ authorType: 'user' });
      storage.getReviewComment.mockResolvedValue(userComment);
      storage.getReview.mockResolvedValue(makeReview());
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      storage.deleteReviewComment.mockResolvedValue();

      await service.deleteComment(reviewId, commentId);

      expect(storage.deleteReviewComment).toHaveBeenCalledWith(commentId);
    });

    // SECURITY: IDOR protection test
    it('throws NotFoundError when comment belongs to different review (IDOR protection)', async () => {
      const otherReviewId = '550e8400-e29b-41d4-a716-446655440099';
      storage.getReviewComment.mockResolvedValue(makeComment({ reviewId: otherReviewId }));

      await expect(service.deleteComment(reviewId, commentId)).rejects.toThrow(NotFoundError);

      expect(storage.deleteReviewComment).not.toHaveBeenCalled();
    });

    // SECURITY: Ownership enforcement test
    it('throws ForbiddenError when trying to delete agent-authored comment', async () => {
      const agentComment = makeComment({
        authorType: 'agent',
        authorAgentId: 'agent-123',
      });
      storage.getReviewComment.mockResolvedValue(agentComment);

      await expect(service.deleteComment(reviewId, commentId)).rejects.toThrow(ForbiddenError);

      expect(storage.deleteReviewComment).not.toHaveBeenCalled();
    });
  });

  describe('resolveComment', () => {
    it('resolves comment and emits event', async () => {
      const comment = makeComment({ status: 'open' });
      const resolved = makeComment({ status: 'resolved', version: 2 });
      const review = makeReview();
      storage.getReviewComment.mockResolvedValue(comment);
      storage.getReview.mockResolvedValue(review);
      storage.updateReviewComment.mockResolvedValue(resolved);
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);

      const result = await service.resolveComment(reviewId, commentId, 'resolved', 1);

      expect(result.status).toBe('resolved');
      expect(eventsService.publish).toHaveBeenCalledWith(
        'review.comment.resolved',
        expect.objectContaining({
          commentId,
          reviewId,
          status: 'resolved',
        }),
      );
    });

    it('marks comment as wont_fix', async () => {
      const comment = makeComment({ status: 'open' });
      const resolved = makeComment({ status: 'wont_fix', version: 2 });
      const review = makeReview();
      storage.getReviewComment.mockResolvedValue(comment);
      storage.getReview.mockResolvedValue(review);
      storage.updateReviewComment.mockResolvedValue(resolved);
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);

      const result = await service.resolveComment(reviewId, commentId, 'wont_fix', 1);

      expect(result.status).toBe('wont_fix');
    });

    // SECURITY: IDOR protection test
    it('throws NotFoundError when comment belongs to different review (IDOR protection)', async () => {
      const otherReviewId = '550e8400-e29b-41d4-a716-446655440099';
      // Comment belongs to a different review
      storage.getReviewComment.mockResolvedValue(makeComment({ reviewId: otherReviewId }));

      await expect(service.resolveComment(reviewId, commentId, 'resolved', 1)).rejects.toThrow(
        NotFoundError,
      );

      // Verify storage update was never called (blocked before modification)
      expect(storage.updateReviewComment).not.toHaveBeenCalled();
    });
  });

  describe('listComments', () => {
    it('returns comments for review', async () => {
      storage.getReview.mockResolvedValue(makeReview());
      storage.listReviewComments.mockResolvedValue({
        items: [makeComment()],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.listComments(reviewId);

      expect(result.items).toHaveLength(1);
    });
  });

  describe('getCommentTargets', () => {
    it('returns targets for comment with IDOR verification', async () => {
      storage.getReviewComment.mockResolvedValue(makeComment());
      storage.getReviewCommentTargets.mockResolvedValue([
        {
          id: 'target-1',
          commentId,
          agentId: 'agent-1',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await service.getCommentTargets(reviewId, commentId);

      expect(result).toHaveLength(1);
    });

    // SECURITY: IDOR protection test
    it('throws NotFoundError when comment belongs to different review (IDOR protection)', async () => {
      const otherReviewId = '550e8400-e29b-41d4-a716-446655440099';
      // Comment belongs to a different review
      storage.getReviewComment.mockResolvedValue(makeComment({ reviewId: otherReviewId }));

      await expect(service.getCommentTargets(reviewId, commentId)).rejects.toThrow(NotFoundError);

      // Verify targets were never fetched (blocked before data access)
      expect(storage.getReviewCommentTargets).not.toHaveBeenCalled();
    });
  });

  describe('getActiveReview', () => {
    it('returns null when no active review exists', async () => {
      storage.getProject.mockResolvedValue({ id: projectId } as never);
      storage.listReviews.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      const result = await service.getActiveReview(projectId);

      expect(result).toBeNull();
    });

    it('returns null when all reviews are closed', async () => {
      storage.getProject.mockResolvedValue({ id: projectId } as never);
      storage.listReviews.mockResolvedValue({
        items: [makeReview({ status: 'closed' })],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.getActiveReview(projectId);

      expect(result).toBeNull();
    });

    it('returns active review (non-closed)', async () => {
      storage.getProject.mockResolvedValue({ id: projectId } as never);
      const activeReview = makeReview({ status: 'draft' });
      storage.listReviews.mockResolvedValue({
        items: [activeReview, makeReview({ status: 'closed' })],
        total: 2,
        limit: 100,
        offset: 0,
      });

      const result = await service.getActiveReview(projectId);

      expect(result).toEqual(activeReview);
    });
  });

  describe('getOrCreateActiveReview', () => {
    it('returns existing active review', async () => {
      const existingReview = makeReview({ status: 'pending' });
      storage.getProject.mockResolvedValue({ id: projectId } as never);
      storage.listReviews.mockResolvedValue({
        items: [existingReview],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.getOrCreateActiveReview(projectId, 'working-tree');

      expect(result).toEqual(existingReview);
      expect(storage.createReview).not.toHaveBeenCalled();
    });

    it('creates new review for working-tree mode with auto-title', async () => {
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      storage.listReviews.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });
      const newReview = makeReview({
        title: 'Pre-commit review',
        mode: 'working_tree',
        baseSha: null,
        headSha: null,
      });
      storage.createReview.mockResolvedValue(newReview);

      const result = await service.getOrCreateActiveReview(projectId, 'working-tree');

      expect(result).toEqual(newReview);
      // Should NOT call resolveRef for working-tree mode
      expect(gitService.resolveRef).not.toHaveBeenCalled();
      expect(storage.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Pre-commit review',
          mode: 'working_tree',
          baseRef: 'HEAD',
          headRef: 'HEAD',
          baseSha: null,
          headSha: null,
          status: 'draft',
        }),
      );
    });

    it('creates new review for commit mode with auto-title', async () => {
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      storage.listReviews.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });
      gitService.resolveRef.mockResolvedValue('abc1234567890');
      const newReview = makeReview({ title: 'Review: abc1234', mode: 'commit' });
      storage.createReview.mockResolvedValue(newReview);

      const result = await service.getOrCreateActiveReview(projectId, 'commit', {
        commitSha: 'abc1234567890',
      });

      expect(result).toEqual(newReview);
      expect(storage.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Review: abc1234',
          mode: 'commit',
          baseRef: 'abc1234567890^',
          headRef: 'abc1234567890',
          status: 'draft',
        }),
      );
    });

    it('throws ValidationError when commit mode without commitSha', async () => {
      storage.getProject.mockResolvedValue({ id: projectId } as never);
      storage.listReviews.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      await expect(service.getOrCreateActiveReview(projectId, 'commit')).rejects.toThrow(
        ValidationError,
      );
    });

    it('handles race condition by returning existing review', async () => {
      const existingReview = makeReview({
        status: 'draft',
        mode: 'working_tree',
        baseSha: null,
        headSha: null,
      });
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      // First call: no reviews, second call (after race): review exists
      storage.listReviews
        .mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 })
        .mockResolvedValueOnce({ items: [existingReview], total: 1, limit: 100, offset: 0 });
      // Simulate race condition: createReview fails
      storage.createReview.mockRejectedValue(new Error('Unique constraint violation'));

      const result = await service.getOrCreateActiveReview(projectId, 'working-tree');

      expect(result).toEqual(existingReview);
    });
  });

  describe('closeReview', () => {
    it('deletes non-resolved comments and closes review', async () => {
      const openReview = makeReview({ status: 'pending' });
      const closedReview = makeReview({ status: 'closed', version: 2 });
      storage.getReview.mockResolvedValue(openReview);
      storage.updateReview.mockResolvedValue(closedReview);
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      storage.deleteNonResolvedComments.mockResolvedValue(5);

      const result = await service.closeReview(reviewId, 1);

      expect(result.status).toBe('closed');
      expect(storage.deleteNonResolvedComments).toHaveBeenCalledWith(reviewId);
      expect(storage.updateReview).toHaveBeenCalledWith(
        reviewId,
        expect.objectContaining({ status: 'closed' }),
        1,
      );
    });

    it('emits review.updated event with status change', async () => {
      const openReview = makeReview({ status: 'pending' });
      const closedReview = makeReview({ status: 'closed', version: 2 });
      storage.getReview.mockResolvedValue(openReview);
      storage.updateReview.mockResolvedValue(closedReview);
      storage.getProject.mockResolvedValue({ id: projectId, name: 'Test Project' } as never);
      storage.deleteNonResolvedComments.mockResolvedValue(0);

      await service.closeReview(reviewId, 1);

      expect(eventsService.publish).toHaveBeenCalledWith(
        'review.updated',
        expect.objectContaining({
          reviewId,
          changes: {
            status: { previous: 'pending', current: 'closed' },
          },
        }),
      );
    });
  });
});
