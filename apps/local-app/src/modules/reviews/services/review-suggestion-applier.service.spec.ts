import { Test, TestingModule } from '@nestjs/testing';
import {
  ReviewSuggestionApplier,
  SuggestionApplicationError,
} from './review-suggestion-applier.service';
import { ReviewsService } from './reviews.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Review, ReviewComment } from '../../storage/models/domain.models';
import { NotFoundError, OptimisticLockError } from '../../../common/errors/error-types';
import * as fs from 'fs/promises';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  writeFile: jest.fn(),
  lstat: jest.fn().mockResolvedValue({
    isSymbolicLink: () => false,
  }),
  realpath: jest.fn().mockImplementation((p: string) => Promise.resolve(p)),
}));

const mockedFs = jest.mocked(fs);

describe('ReviewSuggestionApplier', () => {
  let applier: ReviewSuggestionApplier;
  let storage: jest.Mocked<Pick<StorageService, 'getReviewComment' | 'getReview'>>;
  let reviewsService: jest.Mocked<Pick<ReviewsService, 'resolveComment'>>;

  const projectId = '550e8400-e29b-41d4-a716-446655440000';
  const reviewId = '550e8400-e29b-41d4-a716-446655440001';
  const commentId = '550e8400-e29b-41d4-a716-446655440002';
  const projectRootPath = '/home/user/project';

  beforeEach(async () => {
    storage = {
      getReviewComment: jest.fn(),
      getReview: jest.fn(),
    };

    reviewsService = {
      resolveComment: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectWriteAdmissionService, useValue: createProjectWriteAdmissionStub() },
        ReviewSuggestionApplier,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: ReviewsService, useValue: reviewsService },
      ],
    }).compile();

    applier = module.get(ReviewSuggestionApplier);
    jest.clearAllMocks();
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
      commentCount: overrides.commentCount ?? 0,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  function makeComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
    const now = new Date().toISOString();
    return {
      id: overrides.id ?? commentId,
      reviewId: overrides.reviewId ?? reviewId,
      filePath: 'filePath' in overrides ? overrides.filePath! : 'src/index.ts',
      parentId: 'parentId' in overrides ? overrides.parentId! : null,
      lineStart: 'lineStart' in overrides ? overrides.lineStart! : 3,
      lineEnd: 'lineEnd' in overrides ? overrides.lineEnd! : 3,
      side: 'side' in overrides ? overrides.side! : null,
      content: overrides.content ?? 'Replace this:\n```suggestion\nconst x = 42;\n```',
      commentType: overrides.commentType ?? 'suggestion',
      status: overrides.status ?? 'open',
      authorType: overrides.authorType ?? 'agent',
      authorAgentId: 'authorAgentId' in overrides ? overrides.authorAgentId! : null,
      editedAt: 'editedAt' in overrides ? overrides.editedAt! : null,
      version: overrides.version ?? 1,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  function setupHappyPath() {
    const comment = makeComment();
    const review = makeReview();
    const resolvedComment = makeComment({ status: 'resolved', version: 2 });

    storage.getReviewComment.mockResolvedValue(comment);
    storage.getReview.mockResolvedValue(review);
    mockedFs.readFile.mockResolvedValue('line 1\nline 2\nline 3\nline 4\n');
    mockedFs.writeFile.mockResolvedValue();
    reviewsService.resolveComment.mockResolvedValue(resolvedComment);

    return { comment, review, resolvedComment };
  }

  describe('happy path', () => {
    it('applies suggestion and resolves comment', async () => {
      const { resolvedComment } = setupHappyPath();

      const result = await applier.apply({
        commentId,
        projectId,
        projectRootPath,
        version: 1,
      });

      expect(result.updatedComment).toBe(resolvedComment);
      expect(result.filePath).toBe('src/index.ts');
      expect(result.suggestedCode).toBe('const x = 42;');
      expect(result.lineStart).toBe(3);
      expect(result.lineEnd).toBe(3);
    });

    it('performs 1-indexed line splice replacing single line', async () => {
      setupHappyPath();
      mockedFs.readFile.mockResolvedValue('aaa\nbbb\nccc\nddd\n');

      await applier.apply({
        commentId,
        projectId,
        projectRootPath,
        version: 1,
      });

      const writtenContent = mockedFs.writeFile.mock.calls[0][1] as string;
      const lines = writtenContent.split('\n');
      expect(lines[0]).toBe('aaa');
      expect(lines[1]).toBe('bbb');
      expect(lines[2]).toBe('const x = 42;');
      expect(lines[3]).toBe('ddd');
    });

    it.each([
      {
        label: 'multi-line range',
        lineEnd: 3,
        content: '```suggestion\nreplaced\n```',
        file: 'aaa\nbbb\nccc\nddd\n',
        expected: ['aaa', 'replaced', 'ddd', ''],
      },
      {
        label: 'null end',
        lineEnd: null,
        content: '```suggestion\nnew line\n```',
        file: 'aaa\nbbb\nccc\n',
        expected: ['aaa', 'new line', 'ccc', ''],
      },
    ])('$label', async ({ lineEnd, content, file, expected }) => {
      storage.getReviewComment.mockResolvedValue(makeComment({ lineStart: 2, lineEnd, content }));
      storage.getReview.mockResolvedValue(makeReview());
      mockedFs.readFile.mockResolvedValue(file);
      mockedFs.writeFile.mockResolvedValue();
      reviewsService.resolveComment.mockResolvedValue(
        makeComment({ status: 'resolved', version: 2 }),
      );
      await applier.apply({ commentId, projectId, projectRootPath, version: 1 });
      expect((mockedFs.writeFile.mock.calls[0][1] as string).split('\n')).toEqual(expected);
    });
  });

  describe('project boundary (IDOR)', () => {
    it('rejects comment from different project', async () => {
      storage.getReviewComment.mockResolvedValue(makeComment());
      storage.getReview.mockResolvedValue(makeReview({ projectId: 'different-project-id' }));

      await expect(
        applier.apply({
          commentId,
          projectId,
          projectRootPath,
          version: 1,
        }),
      ).rejects.toThrow(SuggestionApplicationError);

      await expect(
        applier.apply({
          commentId,
          projectId,
          projectRootPath,
          version: 1,
        }),
      ).rejects.toMatchObject({ code: 'COMMENT_NOT_IN_PROJECT' });
    });
  });

  describe('suggestion extraction', () => {
    it.each([
      { label: 'no path', override: { filePath: null }, code: 'INVALID_SUGGESTION' },
      { label: 'no start', override: { lineStart: null }, code: 'INVALID_SUGGESTION' },
      {
        label: 'no suggestion',
        override: { content: 'No suggestion here' },
        code: 'NO_SUGGESTION',
      },
    ])('$label', async ({ override, code }) => {
      storage.getReviewComment.mockResolvedValue(makeComment(override));
      storage.getReview.mockResolvedValue(makeReview());
      await expect(
        applier.apply({ commentId, projectId, projectRootPath, version: 1 }),
      ).rejects.toMatchObject({ code });
    });
  });

  describe('path traversal rejection', () => {
    it.each(['../../../etc/passwd', '/etc/passwd'])(
      'rejects traversal path %s',
      async (filePath) => {
        storage.getReviewComment.mockResolvedValue(makeComment({ filePath }));
        storage.getReview.mockResolvedValue(makeReview());
        await expect(
          applier.apply({ commentId, projectId, projectRootPath, version: 1 }),
        ).rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' });
      },
    );
  });

  describe('symlink escape rejection', () => {
    it('rejects symlinks pointing outside project', async () => {
      storage.getReviewComment.mockResolvedValue(makeComment());
      storage.getReview.mockResolvedValue(makeReview());

      mockedFs.lstat.mockResolvedValueOnce({
        isSymbolicLink: () => true,
      } as unknown as Awaited<ReturnType<typeof mockedFs.lstat>>);
      mockedFs.realpath.mockResolvedValueOnce('/outside/project/file.ts');

      await expect(
        applier.apply({ commentId, projectId, projectRootPath, version: 1 }),
      ).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE_BLOCKED' });
    });
  });

  describe('line bounds validation', () => {
    it.each([
      { label: 'start beyond file', lineStart: 100, lineEnd: 100, file: 'line 1\nline 2\n' },
      { label: 'end beyond file', lineStart: 1, lineEnd: 100, file: 'line 1\nline 2\n' },
      { label: 'reversed range', lineStart: 3, lineEnd: 1, file: 'line 1\nline 2\nline 3\n' },
    ])('$label', async ({ lineStart, lineEnd, file }) => {
      storage.getReviewComment.mockResolvedValue(makeComment({ lineStart, lineEnd }));
      storage.getReview.mockResolvedValue(makeReview());
      mockedFs.readFile.mockResolvedValue(file);
      mockedFs.writeFile.mockResolvedValue();
      await expect(
        applier.apply({ commentId, projectId, projectRootPath, version: 1 }),
      ).rejects.toMatchObject({ code: 'INVALID_LINE_BOUNDS' });
    });
  });

  describe('pre-flight version check', () => {
    it('rejects stale version before writeFile — zero disk mutations', async () => {
      const comment = makeComment({ version: 5 });
      storage.getReviewComment.mockResolvedValue(comment);
      storage.getReview.mockResolvedValue(makeReview());
      mockedFs.readFile.mockResolvedValue('line 1\nline 2\nline 3\nline 4\n');
      mockedFs.writeFile.mockResolvedValue();

      await expect(
        applier.apply({ commentId, projectId, projectRootPath, version: 3 }),
      ).rejects.toMatchObject({
        code: 'VERSION_CONFLICT',
        details: { expectedVersion: 3, currentVersion: 5 },
      });

      expect(mockedFs.writeFile).not.toHaveBeenCalled();
      expect(reviewsService.resolveComment).not.toHaveBeenCalled();
    });
  });

  describe('resolve-after-write atomicity', () => {
    it('resolves comment only after successful write', async () => {
      setupHappyPath();

      const callOrder: string[] = [];
      mockedFs.writeFile.mockImplementation(async () => {
        callOrder.push('writeFile');
      });
      reviewsService.resolveComment.mockImplementation(async () => {
        callOrder.push('resolveComment');
        return makeComment({ status: 'resolved', version: 2 });
      });

      await applier.apply({ commentId, projectId, projectRootPath, version: 1 });

      expect(callOrder).toEqual(['writeFile', 'resolveComment']);
    });

    it('does not resolve comment when write fails', async () => {
      setupHappyPath();
      mockedFs.writeFile.mockRejectedValue(new Error('disk full'));

      await expect(
        applier.apply({ commentId, projectId, projectRootPath, version: 1 }),
      ).rejects.toThrow('disk full');

      expect(reviewsService.resolveComment).not.toHaveBeenCalled();
    });
  });

  describe('optimistic version conflict', () => {
    it('propagates optimistic lock error from resolveComment', async () => {
      setupHappyPath();
      reviewsService.resolveComment.mockRejectedValue(
        new OptimisticLockError('ReviewComment', commentId),
      );

      await expect(
        applier.apply({ commentId, projectId, projectRootPath, version: 1 }),
      ).rejects.toThrow(OptimisticLockError);
    });
  });

  describe('not found propagation', () => {
    it.each(['comment', 'review'])('propagates missing %s', async (missing) => {
      storage.getReviewComment.mockResolvedValue(makeComment());
      if (missing === 'comment') {
        storage.getReviewComment.mockRejectedValue(new NotFoundError('ReviewComment', commentId));
      } else {
        storage.getReview.mockRejectedValue(new NotFoundError('Review', reviewId));
      }
      await expect(
        applier.apply({ commentId, projectId, projectRootPath, version: 1 }),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
