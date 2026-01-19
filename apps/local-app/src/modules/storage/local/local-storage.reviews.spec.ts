import { Test, TestingModule } from '@nestjs/testing';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { LocalStorageService } from './local-storage.service';
import { DB_CONNECTION } from '../db/db.provider';
import { NotFoundError, OptimisticLockError } from '../../../common/errors/error-types';
import { CreateReview } from '../models/domain.models';

describe('LocalStorageService - Reviews', () => {
  let service: LocalStorageService;
  let mockDb: jest.Mocked<BetterSQLite3Database>;

  beforeEach(async () => {
    const mockChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    mockDb = {
      select: jest.fn().mockReturnValue(mockChain),
      insert: jest.fn().mockReturnValue(mockChain),
      update: jest.fn().mockReturnValue(mockChain),
      delete: jest.fn().mockReturnValue(mockChain),
    } as unknown as jest.Mocked<BetterSQLite3Database>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalStorageService,
        {
          provide: DB_CONNECTION,
          useValue: mockDb,
        },
      ],
    }).compile();

    service = module.get<LocalStorageService>(LocalStorageService);
  });

  describe('createReview', () => {
    it('should create a review successfully', async () => {
      const createData: CreateReview = {
        projectId: 'project-1',
        epicId: 'epic-1',
        title: 'Test Review',
        description: 'Review description',
        status: 'draft',
        mode: 'commit',
        baseRef: 'main',
        headRef: 'feature/test',
        baseSha: 'abc123',
        headSha: 'def456',
        createdBy: 'user',
        createdByAgentId: null,
      };

      const insertChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.createReview(createData);

      expect(result).toMatchObject({
        projectId: createData.projectId,
        epicId: createData.epicId,
        title: createData.title,
        description: createData.description,
        status: createData.status,
        mode: createData.mode,
        baseRef: createData.baseRef,
        headRef: createData.headRef,
        baseSha: createData.baseSha,
        headSha: createData.headSha,
        createdBy: createData.createdBy,
        version: 1,
      });
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });
  });

  describe('getReview', () => {
    it('should get a review with comment count', async () => {
      const reviewId = 'review-1';
      const mockReview = {
        id: reviewId,
        projectId: 'project-1',
        epicId: 'epic-1',
        title: 'Test Review',
        description: 'Description',
        status: 'draft',
        mode: 'commit',
        baseRef: 'main',
        headRef: 'feature/test',
        baseSha: 'abc123',
        headSha: 'def456',
        createdBy: 'user',
        createdByAgentId: null,
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      const selectReviewChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockReview]),
          }),
        }),
      };

      const selectCountChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: 5 }]),
        }),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(selectReviewChain)
        .mockReturnValueOnce(selectCountChain);

      const result = await service.getReview(reviewId);

      expect(result).toMatchObject({
        id: reviewId,
        commentCount: 5,
      });
    });

    it('should throw NotFoundError when review not found', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.getReview('non-existent')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateReview', () => {
    it('should update a review with optimistic locking', async () => {
      const reviewId = 'review-1';
      const currentVersion = 1;
      const mockReview = {
        id: reviewId,
        projectId: 'project-1',
        epicId: 'epic-1',
        title: 'Test Review',
        description: 'Description',
        status: 'draft',
        mode: 'commit',
        baseRef: 'main',
        headRef: 'feature/test',
        baseSha: 'abc123',
        headSha: 'def456',
        createdBy: 'user',
        createdByAgentId: null,
        version: currentVersion,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      const selectReviewChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockReview]),
          }),
        }),
      };

      const selectCountChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: 0 }]),
        }),
      };

      const updateChain = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };

      const updatedReview = { ...mockReview, status: 'pending', version: 2 };
      const selectUpdatedChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([updatedReview]),
          }),
        }),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(selectReviewChain)
        .mockReturnValueOnce(selectCountChain)
        .mockReturnValueOnce(selectUpdatedChain)
        .mockReturnValueOnce(selectCountChain);
      mockDb.update = jest.fn().mockReturnValue(updateChain);

      const result = await service.updateReview(reviewId, { status: 'pending' }, currentVersion);

      expect(result.status).toBe('pending');
      expect(result.version).toBe(2);
    });

    it('should throw OptimisticLockError on version mismatch', async () => {
      const reviewId = 'review-1';
      const mockReview = {
        id: reviewId,
        projectId: 'project-1',
        version: 2, // Current version is 2, but we're sending expectedVersion 1
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      const selectReviewChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockReview]),
          }),
        }),
      };

      const selectCountChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: 0 }]),
        }),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(selectReviewChain)
        .mockReturnValueOnce(selectCountChain);

      await expect(service.updateReview(reviewId, { status: 'pending' }, 1)).rejects.toThrow(
        OptimisticLockError,
      );
    });
  });

  describe('deleteReview', () => {
    it('should delete a review', async () => {
      const deleteChain = {
        where: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.delete = jest.fn().mockReturnValue(deleteChain);

      await expect(service.deleteReview('review-1')).resolves.toBeUndefined();
    });
  });

  describe('listReviews', () => {
    it('should list reviews with filters', async () => {
      const mockReviews = [
        {
          id: 'review-1',
          projectId: 'project-1',
          status: 'pending',
          version: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'review-2',
          projectId: 'project-1',
          status: 'pending',
          version: 1,
          createdAt: '2024-01-02T00:00:00.000Z',
        },
      ];

      const selectListChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                offset: jest.fn().mockResolvedValue(mockReviews),
              }),
            }),
          }),
        }),
      };

      // Single aggregate query for comment counts (grouped by reviewId)
      const selectCountChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockResolvedValue([
              { reviewId: 'review-1', count: 3 },
              { reviewId: 'review-2', count: 5 },
            ]),
          }),
        }),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(selectListChain)
        .mockReturnValueOnce(selectCountChain);

      const result = await service.listReviews('project-1', { status: 'pending', limit: 10 });

      expect(result.items).toHaveLength(2);
      expect(result.limit).toBe(10);
      // Verify comment counts are correctly mapped from single aggregate query
      expect(result.items[0].commentCount).toBe(3);
      expect(result.items[1].commentCount).toBe(5);
    });
  });
});

describe('LocalStorageService - Review Comments', () => {
  let service: LocalStorageService;
  let mockDb: jest.Mocked<BetterSQLite3Database>;

  beforeEach(async () => {
    const mockChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    mockDb = {
      select: jest.fn().mockReturnValue(mockChain),
      insert: jest.fn().mockReturnValue(mockChain),
      update: jest.fn().mockReturnValue(mockChain),
      delete: jest.fn().mockReturnValue(mockChain),
    } as unknown as jest.Mocked<BetterSQLite3Database>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalStorageService,
        {
          provide: DB_CONNECTION,
          useValue: mockDb,
        },
      ],
    }).compile();

    service = module.get<LocalStorageService>(LocalStorageService);
  });

  describe('getReviewComment', () => {
    it('should get a review comment', async () => {
      const mockComment = {
        id: 'comment-1',
        reviewId: 'review-1',
        filePath: 'src/test.ts',
        parentId: null,
        lineStart: 10,
        lineEnd: 20,
        side: 'right',
        content: 'Test comment',
        commentType: 'comment',
        status: 'open',
        authorType: 'user',
        authorAgentId: null,
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockComment]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getReviewComment('comment-1');

      expect(result).toMatchObject({
        id: 'comment-1',
        content: 'Test comment',
        status: 'open',
      });
    });

    it('should throw NotFoundError when comment not found', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.getReviewComment('non-existent')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateReviewComment', () => {
    it('should update a comment with optimistic locking', async () => {
      const mockComment = {
        id: 'comment-1',
        reviewId: 'review-1',
        content: 'Original content',
        status: 'open',
        version: 1,
        editedAt: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockComment]),
          }),
        }),
      };

      const updateChain = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };

      const updatedComment = { ...mockComment, status: 'resolved', version: 2 };
      const selectUpdatedChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([updatedComment]),
          }),
        }),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(selectChain)
        .mockReturnValueOnce(selectUpdatedChain);
      mockDb.update = jest.fn().mockReturnValue(updateChain);

      const result = await service.updateReviewComment('comment-1', { status: 'resolved' }, 1);

      expect(result.status).toBe('resolved');
      expect(result.version).toBe(2);
    });

    it('does not bump version or editedAt on no-op content update', async () => {
      const mockComment = {
        id: 'comment-1',
        reviewId: 'review-1',
        content: 'Original content',
        status: 'open',
        version: 1,
        editedAt: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockComment]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);
      mockDb.update = jest.fn();

      const result = await service.updateReviewComment(
        'comment-1',
        { content: 'Original content' },
        1,
      );

      expect(result.version).toBe(1);
      expect(result.editedAt).toBeNull();
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('sets editedAt and bumps version when content changes', async () => {
      const mockComment = {
        id: 'comment-1',
        reviewId: 'review-1',
        content: 'Original content',
        status: 'open',
        version: 1,
        editedAt: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockComment]),
          }),
        }),
      };

      const updateChain = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };

      const updatedComment = {
        ...mockComment,
        content: 'Updated content',
        version: 2,
        editedAt: '2024-01-02T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      };
      const selectUpdatedChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([updatedComment]),
          }),
        }),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(selectChain)
        .mockReturnValueOnce(selectUpdatedChain);
      mockDb.update = jest.fn().mockReturnValue(updateChain);

      const result = await service.updateReviewComment(
        'comment-1',
        { content: 'Updated content' },
        1,
      );

      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Updated content',
          editedAt: expect.any(String),
          version: 2,
          updatedAt: expect.any(String),
        }),
      );
      expect(result.content).toBe('Updated content');
      expect(result.version).toBe(2);
      expect(result.editedAt).toBe('2024-01-02T00:00:00.000Z');
    });

    it('should throw OptimisticLockError on version mismatch', async () => {
      const mockComment = {
        id: 'comment-1',
        version: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockComment]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(
        service.updateReviewComment('comment-1', { status: 'resolved' }, 1),
      ).rejects.toThrow(OptimisticLockError);
    });
  });

  describe('listReviewComments', () => {
    it('should list comments with filters', async () => {
      const mockComments = [
        {
          id: 'comment-1',
          reviewId: 'review-1',
          content: 'Hello from an agent',
          status: 'open',
          parentId: null,
          authorType: 'agent',
          authorAgentId: 'agent-1',
          version: 1,
          editedAt: null,
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const listCommentsChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                offset: jest.fn().mockResolvedValue(mockComments),
              }),
            }),
          }),
        }),
      };

      const authorAgentsChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            {
              id: 'agent-1',
              name: 'Brainstormer',
            },
          ]),
        }),
      };

      const targetsChain = {
        from: jest.fn().mockReturnValue({
          leftJoin: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                commentId: 'comment-1',
                agentId: 'agent-2',
                agentName: 'Coder',
              },
            ]),
          }),
        }),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(listCommentsChain)
        .mockReturnValueOnce(authorAgentsChain)
        .mockReturnValueOnce(targetsChain);

      const result = await service.listReviewComments('review-1', { parentId: null });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].status).toBe('open');
      expect(result.items[0].authorAgentName).toBe('Brainstormer');
      expect(result.items[0].targetAgents).toEqual([{ agentId: 'agent-2', name: 'Coder' }]);
    });
  });
});

describe('LocalStorageService - Review Comment Targets', () => {
  let service: LocalStorageService;
  let mockDb: jest.Mocked<BetterSQLite3Database>;

  beforeEach(async () => {
    const mockChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
    };

    mockDb = {
      select: jest.fn().mockReturnValue(mockChain),
      insert: jest.fn().mockReturnValue(mockChain),
    } as unknown as jest.Mocked<BetterSQLite3Database>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalStorageService,
        {
          provide: DB_CONNECTION,
          useValue: mockDb,
        },
      ],
    }).compile();

    service = module.get<LocalStorageService>(LocalStorageService);
  });

  describe('getReviewCommentTargets', () => {
    it('should get comment targets', async () => {
      const mockTargets = [
        {
          id: 'target-1',
          commentId: 'comment-1',
          agentId: 'agent-1',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'target-2',
          commentId: 'comment-1',
          agentId: 'agent-2',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ];

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(mockTargets),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getReviewCommentTargets('comment-1');

      expect(result).toHaveLength(2);
      expect(result[0].agentId).toBe('agent-1');
      expect(result[1].agentId).toBe('agent-2');
    });
  });

  describe('addReviewCommentTargets', () => {
    it('should add targets to a comment', async () => {
      const mockComment = {
        id: 'comment-1',
        reviewId: 'review-1',
        version: 1,
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      const selectCommentChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockComment]),
          }),
        }),
      };

      const insertChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.select = jest.fn().mockReturnValue(selectCommentChain);
      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.addReviewCommentTargets('comment-1', ['agent-1', 'agent-2']);

      expect(result).toHaveLength(2);
      expect(result[0].agentId).toBe('agent-1');
      expect(result[1].agentId).toBe('agent-2');
    });
  });
});
