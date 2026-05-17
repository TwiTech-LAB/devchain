import {
  handleListReviews,
  handleGetReview,
  handleGetReviewComments,
  handleReplyComment,
  handleResolveComment,
  handleApplySuggestion,
} from './review-tools';
import type { ReviewToolContext } from './review-context';
import type { AgentSessionContext, GuestSessionContext } from '../../dtos/mcp.dto';
import { SuggestionApplicationError } from '../../../reviews/services/review-suggestion-applier.service';
import { createNullAdapter } from './null-adapter';
import type { ReviewsService } from '../../../reviews/services/reviews.service';
import type { ReviewSuggestionApplier } from '../../../reviews/services/review-suggestion-applier.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

import { NotFoundError } from '../../../../common/errors/error-types';

const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const REVIEW_ID = '00000000-0000-0000-0000-000000000002';
const COMMENT_ID = '00000000-0000-0000-0000-000000000003';
const AGENT_ID = '00000000-0000-0000-0000-000000000004';
const AGENT_NAME = 'Agent-A';
const SESSION_ID = '00000000-0000-0000-0000-000000000005';

function makeAgentCtx(): AgentSessionContext {
  return {
    type: 'agent',
    session: {
      id: SESSION_ID,
      agentId: AGENT_ID,
      status: 'active',
      startedAt: '2024-01-01T00:00:00Z',
    },
    agent: { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test-project' },
  };
}

function makeGuestCtx(): GuestSessionContext {
  return {
    type: 'guest',
    guest: {
      id: '00000000-0000-0000-0000-000000000006',
      name: 'Guest-A',
      projectId: PROJECT_ID,
      tmuxSessionId: 'tmux-001',
    },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test-project' },
  };
}

function makeReview(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    projectId: PROJECT_ID,
    title: 'Test Review',
    description: 'A test review',
    status: 'open',
    baseRef: 'main',
    headRef: 'feature',
    baseSha: 'abc123',
    headSha: 'def456',
    epicId: null,
    createdBy: 'Agent-A',
    createdByAgentId: AGENT_ID,
    version: 1,
    commentCount: 0,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    changedFiles: [],
    ...overrides,
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMENT_ID,
    reviewId: REVIEW_ID,
    filePath: 'src/index.ts',
    lineStart: 10,
    lineEnd: 15,
    side: 'right',
    content: 'Please fix this',
    commentType: 'comment',
    status: 'open',
    authorType: 'agent',
    authorAgentId: AGENT_ID,
    parentId: null,
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeCtx(
  sessionCtx: AgentSessionContext | GuestSessionContext | null = null,
): ReviewToolContext {
  return {
    storage: {
      getAgent: jest.fn().mockImplementation(async (id: string) => {
        if (id === AGENT_ID) return { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID };
        throw new NotFoundError('Agent', id);
      }),
      getReview: jest.fn().mockResolvedValue(makeReview()),
      getReviewComment: jest.fn().mockResolvedValue(makeComment()),
    } as never,
    reviewsService: {
      listReviews: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
      getReview: jest.fn().mockResolvedValue(makeReview()),
      listComments: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
      createComment: jest.fn().mockResolvedValue(makeComment()),
      resolveComment: jest.fn().mockResolvedValue(makeComment({ status: 'resolved' })),
    } as never,
    reviewSuggestionApplier: {
      apply: jest.fn().mockResolvedValue({
        updatedComment: makeComment({ status: 'resolved' }),
        filePath: 'src/index.ts',
        suggestedCode: 'const x = 1;',
        lineStart: 1,
        lineEnd: 1,
      }),
    } as never,
    resolveSessionContext: jest.fn().mockResolvedValue({
      success: true,
      data: sessionCtx ?? makeAgentCtx(),
    }),
  };
}

describe('review-tools handlers', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleListReviews', () => {
    it('returns error when session resolution fails', async () => {
      const ctx = makeCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' },
      });

      const result = await handleListReviews(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_NOT_FOUND');
    });

    it('returns error when no project associated', async () => {
      const sessionCtx = makeAgentCtx();
      (sessionCtx as Record<string, unknown>).project = null;
      const ctx = makeCtx(sessionCtx);

      const result = await handleListReviews(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });

    it('returns error when reviewsService unavailable', async () => {
      const ctx: ReviewToolContext = {
        storage: {
          getAgent: jest
            .fn()
            .mockResolvedValue({ id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID }),
        } as never,
        reviewsService: createNullAdapter<ReviewsService>('ReviewsService'),
        reviewSuggestionApplier:
          createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: makeAgentCtx(),
        }),
      };

      const result = await handleListReviews(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('returns reviews list on success', async () => {
      const ctx = makeCtx();
      const review = makeReview();
      (ctx.reviewsService.listReviews as jest.Mock).mockResolvedValue({
        items: [review],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await handleListReviews(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(true);
      expect(result.data.reviews).toHaveLength(1);
      expect(result.data.reviews[0].id).toBe(REVIEW_ID);
      expect(result.data.total).toBe(1);
    });

    it('passes status and pagination params to service', async () => {
      const ctx = makeCtx();
      await handleListReviews(ctx, {
        sessionId: SESSION_ID,
        status: 'pending',
        limit: 50,
        offset: 10,
      });
      expect(ctx.reviewsService.listReviews).toHaveBeenCalledWith(PROJECT_ID, {
        status: 'pending',
        limit: 50,
        offset: 10,
        epicId: undefined,
      });
    });
  });

  describe('handleGetReview', () => {
    it('returns error when review not found', async () => {
      const ctx = makeCtx();
      (ctx.reviewsService.getReview as jest.Mock).mockRejectedValue(
        new NotFoundError('Review', REVIEW_ID),
      );

      const result = await handleGetReview(ctx, { sessionId: SESSION_ID, reviewId: REVIEW_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('REVIEW_NOT_FOUND');
    });

    it('returns error when review belongs to different project', async () => {
      const ctx = makeCtx();
      (ctx.reviewsService.getReview as jest.Mock).mockResolvedValue(
        makeReview({ projectId: 'other-project' }),
      );

      const result = await handleGetReview(ctx, { sessionId: SESSION_ID, reviewId: REVIEW_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('REVIEW_NOT_FOUND');
      expect(result.error?.message).toContain('does not belong to this project');
    });

    it('returns review with comments and changed files', async () => {
      const ctx = makeCtx();
      (ctx.reviewsService.getReview as jest.Mock).mockResolvedValue(
        makeReview({
          changedFiles: [{ path: 'src/a.ts', status: 'modified', additions: 5, deletions: 2 }],
        }),
      );
      (ctx.reviewsService.listComments as jest.Mock).mockResolvedValue({
        items: [makeComment()],
        total: 1,
        limit: 500,
        offset: 0,
      });

      const result = await handleGetReview(ctx, { sessionId: SESSION_ID, reviewId: REVIEW_ID });
      expect(result.success).toBe(true);
      expect(result.data.changedFiles).toHaveLength(1);
      expect(result.data.comments).toHaveLength(1);
      expect(result.data.comments[0].authorAgentName).toBe(AGENT_NAME);
    });

    it('gracefully handles agent name resolution failure', async () => {
      const ctx = makeCtx();
      (ctx.storage.getAgent as jest.Mock).mockRejectedValue(new Error('not found'));
      (ctx.reviewsService.listComments as jest.Mock).mockResolvedValue({
        items: [makeComment({ authorAgentId: 'unknown-agent' })],
        total: 1,
        limit: 500,
        offset: 0,
      });

      const result = await handleGetReview(ctx, { sessionId: SESSION_ID, reviewId: REVIEW_ID });
      expect(result.success).toBe(true);
      expect(result.data.comments[0].authorAgentName).toBeUndefined();
    });
  });

  describe('handleGetReviewComments', () => {
    it('returns error when review belongs to different project', async () => {
      const ctx = makeCtx();
      (ctx.storage.getReview as jest.Mock).mockResolvedValue(
        makeReview({ projectId: 'other-project' }),
      );

      const result = await handleGetReviewComments(ctx, {
        sessionId: SESSION_ID,
        reviewId: REVIEW_ID,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('REVIEW_NOT_FOUND');
    });

    it('returns error when review not found', async () => {
      const ctx = makeCtx();
      (ctx.storage.getReview as jest.Mock).mockRejectedValue(
        new NotFoundError('Review', REVIEW_ID),
      );

      const result = await handleGetReviewComments(ctx, {
        sessionId: SESSION_ID,
        reviewId: REVIEW_ID,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('REVIEW_NOT_FOUND');
    });

    it('returns comments with agent names resolved', async () => {
      const ctx = makeCtx();
      (ctx.reviewsService.listComments as jest.Mock).mockResolvedValue({
        items: [makeComment()],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await handleGetReviewComments(ctx, {
        sessionId: SESSION_ID,
        reviewId: REVIEW_ID,
      });
      expect(result.success).toBe(true);
      expect(result.data.comments).toHaveLength(1);
      expect(result.data.comments[0].authorAgentName).toBe(AGENT_NAME);
    });

    it('passes filter params to service', async () => {
      const ctx = makeCtx();
      await handleGetReviewComments(ctx, {
        sessionId: SESSION_ID,
        reviewId: REVIEW_ID,
        status: 'open',
        filePath: 'src/index.ts',
        limit: 50,
        offset: 5,
      });
      expect(ctx.reviewsService.listComments).toHaveBeenCalledWith(REVIEW_ID, {
        status: 'open',
        filePath: 'src/index.ts',
        limit: 50,
        offset: 5,
      });
    });
  });

  describe('handleReplyComment', () => {
    it('creates comment with agent actor context', async () => {
      const ctx = makeCtx();
      const result = await handleReplyComment(ctx, {
        sessionId: SESSION_ID,
        reviewId: REVIEW_ID,
        parentCommentId: COMMENT_ID,
        content: 'Agreed, will fix',
      });
      expect(result.success).toBe(true);
      expect(ctx.reviewsService.createComment).toHaveBeenCalledWith(
        REVIEW_ID,
        expect.objectContaining({
          parentId: COMMENT_ID,
          content: 'Agreed, will fix',
          authorType: 'agent',
          authorAgentId: AGENT_ID,
        }),
      );
    });

    it('creates comment with guest actor context', async () => {
      const guestCtx = makeGuestCtx();
      const ctx = makeCtx(guestCtx);
      const result = await handleReplyComment(ctx, {
        sessionId: SESSION_ID,
        reviewId: REVIEW_ID,
        content: 'Guest feedback',
      });
      expect(result.success).toBe(true);
      expect(ctx.reviewsService.createComment).toHaveBeenCalledWith(
        REVIEW_ID,
        expect.objectContaining({
          authorAgentId: '00000000-0000-0000-0000-000000000006',
        }),
      );
    });

    it('returns error when review belongs to different project', async () => {
      const ctx = makeCtx();
      (ctx.storage.getReview as jest.Mock).mockResolvedValue(
        makeReview({ projectId: 'other-project' }),
      );

      const result = await handleReplyComment(ctx, {
        sessionId: SESSION_ID,
        reviewId: REVIEW_ID,
        content: 'test',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('REVIEW_NOT_FOUND');
    });

    it('defaults commentType to comment', async () => {
      const ctx = makeCtx();
      await handleReplyComment(ctx, {
        sessionId: SESSION_ID,
        reviewId: REVIEW_ID,
        content: 'test',
      });
      expect(ctx.reviewsService.createComment).toHaveBeenCalledWith(
        REVIEW_ID,
        expect.objectContaining({ commentType: 'comment' }),
      );
    });
  });

  describe('handleResolveComment', () => {
    it('resolves comment with resolution and version', async () => {
      const ctx = makeCtx();
      const result = await handleResolveComment(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        resolution: 'resolved',
        version: 1,
      });
      expect(result.success).toBe(true);
      expect(ctx.reviewsService.resolveComment).toHaveBeenCalledWith(
        REVIEW_ID,
        COMMENT_ID,
        'resolved',
        1,
      );
    });

    it('returns error when comment not found', async () => {
      const ctx = makeCtx();
      (ctx.storage.getReviewComment as jest.Mock).mockRejectedValue(
        new NotFoundError('Comment', COMMENT_ID),
      );

      const result = await handleResolveComment(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        resolution: 'resolved',
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMMENT_NOT_FOUND');
    });

    it('returns error when comment belongs to different project', async () => {
      const ctx = makeCtx();
      (ctx.storage.getReview as jest.Mock).mockResolvedValue(
        makeReview({ projectId: 'other-project' }),
      );

      const result = await handleResolveComment(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        resolution: 'resolved',
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMMENT_NOT_FOUND');
    });

    it('returns minimal resolved comment metadata on success', async () => {
      const ctx = makeCtx();
      const result = await handleResolveComment(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        resolution: 'resolved',
        version: 1,
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: COMMENT_ID, version: 1, status: 'resolved' });
    });
  });

  describe('handleApplySuggestion', () => {
    it('returns success with applied response on happy path', async () => {
      const ctx = makeCtx();

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(true);
      expect(result.data.applied.filePath).toBe('src/index.ts');
      expect(result.data.applied).toEqual({
        filePath: 'src/index.ts',
        lineStart: 1,
        lineEnd: 1,
      });
      expect(result.data.commentId).toBe(COMMENT_ID);
      expect(result.data.version).toBe(1);
    });

    it('returns SERVICE_UNAVAILABLE when applier is null adapter', async () => {
      const ctx: ReviewToolContext = {
        storage: {
          getAgent: jest
            .fn()
            .mockResolvedValue({ id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID }),
        } as never,
        reviewsService: createNullAdapter<ReviewsService>('ReviewsService'),
        reviewSuggestionApplier:
          createNullAdapter<ReviewSuggestionApplier>('ReviewSuggestionApplier'),
        resolveSessionContext: jest.fn().mockResolvedValue({
          success: true,
          data: makeAgentCtx(),
        }),
      };

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SERVICE_UNAVAILABLE');
    });

    it('maps INVALID_SUGGESTION error from applier', async () => {
      const ctx = makeCtx();
      (ctx.reviewSuggestionApplier.apply as jest.Mock).mockRejectedValue(
        new SuggestionApplicationError('INVALID_SUGGESTION', 'Comment does not have file path'),
      );

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_SUGGESTION');
    });

    it('maps NO_SUGGESTION error from applier', async () => {
      const ctx = makeCtx();
      (ctx.reviewSuggestionApplier.apply as jest.Mock).mockRejectedValue(
        new SuggestionApplicationError('NO_SUGGESTION', 'No suggestion block'),
      );

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NO_SUGGESTION');
    });

    it('maps PATH_TRAVERSAL_BLOCKED error from applier', async () => {
      const ctx = makeCtx();
      (ctx.reviewSuggestionApplier.apply as jest.Mock).mockRejectedValue(
        new SuggestionApplicationError('PATH_TRAVERSAL_BLOCKED', 'Path traversal', {
          reason: 'path_traversal',
        }),
      );

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PATH_TRAVERSAL_BLOCKED');
      expect(result.error?.data).toEqual({ reason: 'path_traversal' });
    });

    it('maps SYMLINK_ESCAPE_BLOCKED error from applier', async () => {
      const ctx = makeCtx();
      (ctx.reviewSuggestionApplier.apply as jest.Mock).mockRejectedValue(
        new SuggestionApplicationError('SYMLINK_ESCAPE_BLOCKED', 'Symlink escape'),
      );

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SYMLINK_ESCAPE_BLOCKED');
    });

    it('maps INVALID_LINE_BOUNDS error from applier', async () => {
      const ctx = makeCtx();
      (ctx.reviewSuggestionApplier.apply as jest.Mock).mockRejectedValue(
        new SuggestionApplicationError('INVALID_LINE_BOUNDS', 'Line start exceeds file length'),
      );

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_LINE_BOUNDS');
    });

    it('returns FILE_NOT_FOUND when applier throws ENOENT', async () => {
      const ctx = makeCtx();
      (ctx.reviewSuggestionApplier.apply as jest.Mock).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('FILE_NOT_FOUND');
    });

    it('returns COMMENT_NOT_FOUND when applier throws COMMENT_NOT_IN_PROJECT', async () => {
      const ctx = makeCtx();
      (ctx.reviewSuggestionApplier.apply as jest.Mock).mockRejectedValue(
        new SuggestionApplicationError(
          'COMMENT_NOT_IN_PROJECT',
          'Comment does not belong to this project',
        ),
      );

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMMENT_NOT_IN_PROJECT');
    });

    it('returns COMMENT_NOT_FOUND when applier throws NotFoundError', async () => {
      const ctx = makeCtx();
      (ctx.reviewSuggestionApplier.apply as jest.Mock).mockRejectedValue(
        new NotFoundError('Comment', COMMENT_ID),
      );

      const result = await handleApplySuggestion(ctx, {
        sessionId: SESSION_ID,
        commentId: COMMENT_ID,
        version: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('COMMENT_NOT_FOUND');
    });
  });
});
