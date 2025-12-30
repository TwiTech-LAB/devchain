import { Test, TestingModule } from '@nestjs/testing';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { LocalStorageService } from './local-storage.service';
import { DB_CONNECTION } from '../db/db.provider';
import {
  NotFoundError,
  OptimisticLockError,
  ValidationError,
  ConflictError,
  StorageError,
} from '../../../common/errors/error-types';
import {
  CreateProject,
  CreateEpic,
  CreateEpicRecord,
  CreateDocument,
  Document,
  Prompt,
  Provider,
  Epic,
  Status,
  Agent,
  AgentProfile,
  EpicComment,
} from '../models/domain.models';

describe('LocalStorageService', () => {
  let service: LocalStorageService;
  let mockDb: jest.Mocked<BetterSQLite3Database>;

  beforeEach(async () => {
    // Create a mock database with chainable methods
    const mockChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };

    mockDb = {
      select: jest.fn().mockReturnValue(mockChain),
      from: jest.fn().mockReturnValue(mockChain),
      where: jest.fn().mockReturnValue(mockChain),
      limit: jest.fn().mockReturnValue(mockChain),
      offset: jest.fn().mockReturnValue(mockChain),
      orderBy: jest.fn().mockReturnValue(mockChain),
      innerJoin: jest.fn().mockReturnValue(mockChain),
      insert: jest.fn().mockReturnValue(mockChain),
      values: jest.fn().mockReturnValue(mockChain),
      update: jest.fn().mockReturnValue(mockChain),
      set: jest.fn().mockReturnValue(mockChain),
      delete: jest.fn().mockReturnValue(mockChain),
      transaction: jest.fn().mockImplementation(async (callback) => {
        // Create a mock transaction object with same chainable methods
        const txMock = {
          select: jest.fn().mockReturnValue(mockChain),
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
          update: jest.fn().mockReturnValue(mockChain),
          delete: jest.fn().mockReturnValue(mockChain),
        };
        return callback(txMock);
      }),
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

  describe('Epics helpers', () => {
    describe('listProjectEpics', () => {
      it('should return epics matching filters', async () => {
        const mockEpic: Epic = {
          id: 'epic-1',
          projectId: 'project-1',
          title: 'Sample Epic',
          description: 'Work item',
          statusId: 'status-1',
          parentId: null,
          agentId: null,
          version: 1,
          data: null,
          tags: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        };

        const countChain = {
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue([{ count: 1 }]),
            }),
          }),
        };

        const rowsChain = {
          from: jest.fn().mockReturnValue({
            innerJoin: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                orderBy: jest.fn().mockReturnValue({
                  limit: jest.fn().mockReturnValue({
                    offset: jest.fn().mockResolvedValue([{ id: mockEpic.id }]),
                  }),
                }),
              }),
            }),
          }),
        };

        mockDb.select = jest.fn().mockReturnValueOnce(countChain).mockReturnValueOnce(rowsChain);
        const getEpicSpy = jest.spyOn(service, 'getEpic').mockResolvedValue(mockEpic);

        const result = await service.listProjectEpics('project-1', {
          q: 'sample',
          limit: 10,
          offset: 0,
        });

        expect(result.items).toEqual([mockEpic]);
        expect(result.total).toBe(1);
        expect(getEpicSpy).toHaveBeenCalledWith(mockEpic.id);
      });
    });

    describe('listAssignedEpics', () => {
      it('should throw validation error when agentName is blank', async () => {
        await expect(service.listAssignedEpics('project-1', { agentName: '   ' })).rejects.toThrow(
          ValidationError,
        );
      });

      it('should return epics assigned to the requested agent', async () => {
        const mockEpic: Epic = {
          id: 'epic-2',
          projectId: 'project-1',
          title: 'Assigned Epic',
          description: null,
          statusId: 'status-1',
          parentId: null,
          agentId: 'agent-1',
          version: 1,
          data: null,
          tags: [],
          createdAt: '2024-01-05T00:00:00Z',
          updatedAt: '2024-01-06T00:00:00Z',
        };

        const countChain = {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ count: 1 }]),
          }),
        };

        const rowsChain = {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockReturnValue({
                  offset: jest.fn().mockResolvedValue([{ id: mockEpic.id }]),
                }),
              }),
            }),
          }),
        };

        mockDb.select = jest.fn().mockReturnValueOnce(countChain).mockReturnValueOnce(rowsChain);

        const getAgentSpy = jest.spyOn(service, 'getAgentByName').mockResolvedValue({
          id: 'agent-1',
          projectId: 'project-1',
          profileId: 'profile-1',
          name: 'Case Agent',
        } as Agent & { profile?: AgentProfile });

        const getEpicSpy = jest.spyOn(service, 'getEpic').mockResolvedValue(mockEpic);

        const result = await service.listAssignedEpics('project-1', {
          agentName: 'Case Agent',
          limit: 5,
          offset: 0,
        });

        expect(getAgentSpy).toHaveBeenCalledWith('project-1', 'Case Agent');
        expect(result.items).toEqual([mockEpic]);
        expect(result.total).toBe(1);
        expect(getEpicSpy).toHaveBeenCalledWith(mockEpic.id);
      });

      it('should propagate not found when agent does not exist', async () => {
        jest
          .spyOn(service, 'getAgentByName')
          .mockRejectedValue(new NotFoundError('Agent', 'project-1:missing'));

        await expect(
          service.listAssignedEpics('project-1', { agentName: 'missing' }),
        ).rejects.toThrow(NotFoundError);
      });
    });

    describe('createEpicForProject', () => {
      it('should use default status and resolve agent by name', async () => {
        const defaultStatusRow = [{ id: 'status-default' }];
        const statusChain = {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue(defaultStatusRow),
              }),
            }),
          }),
        };

        mockDb.select = jest.fn().mockReturnValueOnce(statusChain);

        const ensureAgentSpy = jest
          .spyOn(
            service as unknown as { ensureValidAgent: (...args: unknown[]) => Promise<void> },
            'ensureValidAgent',
          )
          .mockResolvedValue(undefined);
        const ensureParentSpy = jest
          .spyOn(
            service as unknown as { ensureValidEpicParent: (...args: unknown[]) => Promise<void> },
            'ensureValidEpicParent',
          )
          .mockResolvedValue(undefined);

        jest.spyOn(service, 'getAgentByName').mockResolvedValue({
          id: 'agent-1',
          projectId: 'project-1',
          profileId: 'profile-1',
          name: 'Helper Agent',
        } as Agent & { profile?: AgentProfile });

        const mockEpic: Epic = {
          id: 'epic-created',
          projectId: 'project-1',
          title: 'Created Epic',
          description: 'Desc',
          statusId: 'status-default',
          parentId: null,
          agentId: 'agent-1',
          version: 1,
          data: null,
          tags: ['tag'],
          createdAt: '2024-01-10T00:00:00Z',
          updatedAt: '2024-01-10T00:00:00Z',
        };

        const createEpicSpy = jest.spyOn(service, 'createEpic').mockResolvedValue(mockEpic);

        const result = await service.createEpicForProject('project-1', {
          title: 'Created Epic',
          description: 'Desc',
          tags: ['tag'],
          agentName: 'Helper Agent',
        });

        expect(createEpicSpy).toHaveBeenCalledWith({
          projectId: 'project-1',
          title: 'Created Epic',
          description: 'Desc',
          statusId: 'status-default',
          parentId: null,
          agentId: 'agent-1',
          data: null,
          tags: ['tag'],
        });

        expect(result).toEqual(mockEpic);
        expect(ensureAgentSpy).toHaveBeenCalled();
        expect(ensureParentSpy).toHaveBeenCalledWith('project-1', null);
      });

      it('should throw ValidationError when no default status exists', async () => {
        const statusChain = {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        };

        mockDb.select = jest.fn().mockReturnValueOnce(statusChain);

        await expect(
          service.createEpicForProject('project-1', { title: 'Missing Status Epic' }),
        ).rejects.toThrow(ValidationError);
      });
    });
  });

  describe('Projects isTemplate persistence/mapping', () => {
    it('getProject maps isTemplate boolean from row', async () => {
      const chain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValueOnce([
              {
                id: 'p1',
                name: 'P',
                description: null,
                rootPath: '/tmp/p',
                isTemplate: 1,
                createdAt: '2024-01-01',
                updatedAt: '2024-01-02',
              },
            ]),
          }),
        }),
      } as unknown as ReturnType<typeof mockDb.select>;
      (mockDb.select as unknown as jest.Mock) = jest.fn().mockReturnValue(chain);

      const result = await service.getProject('p1');
      expect(result.isTemplate).toBe(true);
    });

    it('listProjects maps isTemplate for each row', async () => {
      const itemsChain = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValueOnce([
              {
                id: 'p1',
                name: 'P',
                description: null,
                rootPath: '/tmp/p',
                isTemplate: 0,
                createdAt: '2024-01-01',
                updatedAt: '2024-01-02',
              },
            ]),
          }),
        }),
      } as unknown as ReturnType<typeof mockDb.select>;
      const countChain = { from: jest.fn().mockResolvedValue([{}]) } as unknown as ReturnType<
        typeof mockDb.select
      >;

      (mockDb.select as unknown as jest.Mock) = jest
        .fn()
        .mockReturnValueOnce(itemsChain)
        .mockReturnValueOnce(countChain);

      const result = await service.listProjects({ limit: 10, offset: 0 });
      expect(result.items[0].isTemplate).toBe(false);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('Projects', () => {
    describe('createProject', () => {
      it('should create a project with default statuses', async () => {
        const projectData: CreateProject = {
          name: 'Test Project',
          description: 'A test project',
          rootPath: '/test/path',
          isTemplate: false,
        };

        // Track insert calls inside transaction
        const txInsertMock = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });
        mockDb.transaction = jest.fn().mockImplementation(async (callback) => {
          const txMock = {
            insert: txInsertMock,
          };
          return callback(txMock);
        });

        const result = await service.createProject(projectData);

        expect(result).toBeDefined();
        expect(result.name).toBe('Test Project');
        expect(result.description).toBe('A test project');
        expect(result.rootPath).toBe('/test/path');
        expect(result.id).toBeDefined();
        expect(result.createdAt).toBeDefined();
        expect(result.updatedAt).toBeDefined();

        // Should have created project + 5 default statuses inside transaction
        expect(txInsertMock).toHaveBeenCalledTimes(6);
      });
    });

    describe('createProjectWithTemplate', () => {
      it('should throw StorageError when raw SQLite client is not accessible', async () => {
        // Mock db without $client or client property
        const badDb = {} as unknown as BetterSQLite3Database;
        const serviceWithBadDb = new LocalStorageService(badDb);

        const templatePayload = {
          statuses: [],
          epics: [],
          agents: [],
          profiles: [],
          prompts: [],
          documents: [],
        };

        await expect(
          serviceWithBadDb.createProjectWithTemplate(
            {
              name: 'Test',
              description: null,
              rootPath: '/test',
              isTemplate: false,
            },
            templatePayload,
          ),
        ).rejects.toThrow(StorageError);

        await expect(
          serviceWithBadDb.createProjectWithTemplate(
            {
              name: 'Test',
              description: null,
              rootPath: '/test',
              isTemplate: false,
            },
            templatePayload,
          ),
        ).rejects.toThrow('Unable to access underlying SQLite client for transaction control');
      });
    });

    describe('getProject', () => {
      it('should return a project when found', async () => {
        const mockProject = {
          id: 'project-1',
          name: 'Test Project',
          description: 'A test',
          rootPath: '/test',
          isTemplate: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockProject]),
            }),
          }),
        });

        const result = await service.getProject('project-1');

        expect(result).toEqual(mockProject);
      });

      it('should throw NotFoundError when project not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.getProject('nonexistent')).rejects.toThrow(NotFoundError);
        await expect(service.getProject('nonexistent')).rejects.toThrow(
          'Project with identifier nonexistent not found',
        );
      });
    });

    describe('listProjects', () => {
      it('should return paginated list of projects', async () => {
        const mockProjects = [
          {
            id: 'p1',
            name: 'Project 1',
            description: null,
            rootPath: '/p1',
            createdAt: '2024-01-01',
            updatedAt: '2024-01-01',
          },
          {
            id: 'p2',
            name: 'Project 2',
            description: null,
            rootPath: '/p2',
            createdAt: '2024-01-02',
            updatedAt: '2024-01-02',
          },
        ];

        // First call: select().from().limit().offset() returns items
        // Second call: select({ count }).from() returns count result
        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                offset: jest.fn().mockResolvedValue(mockProjects),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockResolvedValue([{ count: 2 }]),
          });

        const result = await service.listProjects({ limit: 10, offset: 0 });

        expect(result.items).toHaveLength(2);
        expect(result.total).toBe(2);
        expect(result.limit).toBe(10);
        expect(result.offset).toBe(0);
      });
    });

    describe('updateProject', () => {
      it('should update and return the project', async () => {
        const mockProject = {
          id: 'p1',
          name: 'Updated Project',
          description: 'Updated',
          rootPath: '/test',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        };

        mockDb.update = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        });

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockProject]),
            }),
          }),
        });

        const result = await service.updateProject('p1', { name: 'Updated Project' });

        expect(result.name).toBe('Updated Project');
      });
    });

    describe('deleteProject', () => {
      it('should delete a project', async () => {
        // deleteProject does many select queries to gather IDs for cascade deletion
        // Mock select to return empty arrays (no related items to delete)
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([]),
          }),
        });

        mockDb.delete = jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        });

        await expect(service.deleteProject('p1')).resolves.toBeUndefined();
        expect(mockDb.delete).toHaveBeenCalled();
      });
    });
  });

  describe('Epics - Optimistic Locking', () => {
    describe('createEpic', () => {
      it('should create an epic with version 1 and tags', async () => {
        const epicData: CreateEpic = {
          projectId: 'project-1',
          title: 'Test Epic',
          description: 'Description',
          statusId: 'status-1',
          data: { key: 'value' },
          tags: ['tag1', 'tag2'],
        };

        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        // Mock tag lookups
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await service.createEpic(epicData);

        expect(result.version).toBe(1);
        expect(result.title).toBe('Test Epic');
        expect(result.tags).toEqual(['tag1', 'tag2']);
      });
    });

    describe('updateEpic', () => {
      it('should update epic and increment version when version matches', async () => {
        const existingEpic = {
          id: 'epic-1',
          projectId: 'p1',
          title: 'Old Title',
          description: null,
          statusId: 's1',
          version: 1,
          data: null,
          tags: [],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        };

        const updatedEpic = { ...existingEpic, title: 'New Title', version: 2 };

        // Mock getEpic - called twice: once for version check, once after update
        // Each getEpic call does: select epic + select tags (with innerJoin)
        mockDb.select = jest
          .fn()
          // First getEpic: get epic
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([existingEpic]),
              }),
            }),
          })
          // First getEpic: get tags
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockResolvedValue([]),
              }),
            }),
          })
          // Second getEpic: get updated epic
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([updatedEpic]),
              }),
            }),
          })
          // Second getEpic: get tags
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockResolvedValue([]),
              }),
            }),
          });

        mockDb.update = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        });

        const result = await service.updateEpic('epic-1', { title: 'New Title' }, 1);

        expect(result.title).toBe('New Title');
        expect(result.version).toBe(2);
      });

      it('should throw OptimisticLockError when version mismatch', async () => {
        const existingEpic = {
          id: 'epic-1',
          projectId: 'p1',
          title: 'Title',
          description: null,
          statusId: 's1',
          version: 2,
          data: null,
          tags: [],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        };

        // Mock getEpic: select epic + select tags
        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([existingEpic]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockResolvedValue([]),
              }),
            }),
          });

        await expect(service.updateEpic('epic-1', { title: 'New' }, 1)).rejects.toThrow(
          OptimisticLockError,
        );

        // For second call
        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([existingEpic]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockResolvedValue([]),
              }),
            }),
          });

        await expect(service.updateEpic('epic-1', { title: 'New' }, 1)).rejects.toThrow(
          'Epic with identifier epic-1 was modified by another operation',
        );
      });
    });

    describe('getEpic', () => {
      it('should throw NotFoundError when epic not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.getEpic('nonexistent')).rejects.toThrow(NotFoundError);
        await expect(service.getEpic('nonexistent')).rejects.toThrow(
          'Epic with identifier nonexistent not found',
        );
      });
    });
  });

  describe('Prompts - Optimistic Locking', () => {
    describe('updatePrompt', () => {
      it('should throw OptimisticLockError on version conflict', async () => {
        const existingPrompt = {
          id: 'prompt-1',
          projectId: 'p1',
          title: 'Title',
          content: 'Content',
          version: 3,
          tags: [],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        };

        // Mock getPrompt - first call gets prompt, second gets tags
        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([existingPrompt]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockResolvedValue([]),
              }),
            }),
          });

        await expect(service.updatePrompt('prompt-1', { title: 'New' }, 2)).rejects.toThrow(
          OptimisticLockError,
        );
      });
    });
  });

  describe('Initial session prompt helper', () => {
    it('returns configured prompt id when value stored as string', async () => {
      // When value is a string, it's used directly (no JSON parsing)
      const limitMock = jest.fn().mockResolvedValue([{ value: 'prompt-1' }]);
      mockDb.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: limitMock,
          }),
        }),
      });

      const prompt = {
        id: 'prompt-1',
        projectId: null,
        title: 'Initial',
        content: 'Hello',
        version: 1,
        tags: [],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      const getPromptSpy = jest
        .spyOn(service, 'getPrompt')
        .mockResolvedValue(prompt as unknown as Prompt);

      const result = await service.getInitialSessionPrompt(null);

      expect(getPromptSpy).toHaveBeenCalledWith('prompt-1');
      expect(result).toEqual(prompt);

      getPromptSpy.mockRestore();
    });

    it('returns configured prompt id when value stored as object', async () => {
      mockDb.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ value: { initialSessionPromptId: 'prompt-2' } }]),
          }),
        }),
      });

      const prompt = {
        id: 'prompt-2',
        projectId: null,
        title: 'Initial',
        content: 'Hello',
        version: 1,
        tags: [],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      };

      const getPromptSpy = jest
        .spyOn(service, 'getPrompt')
        .mockResolvedValue(prompt as unknown as Prompt);

      const result = await service.getInitialSessionPrompt(null);

      expect(getPromptSpy).toHaveBeenCalledWith('prompt-2');
      expect(result).toEqual(prompt);

      getPromptSpy.mockRestore();
    });
  });

  describe('Records - Optimistic Locking', () => {
    describe('createRecord', () => {
      it('should create a record with version 1', async () => {
        const recordData: CreateEpicRecord = {
          epicId: 'epic-1',
          type: 'note',
          data: { content: 'Test note' },
          tags: ['urgent'],
        };

        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        // Mock epic lookup for projectId
        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ id: 'epic-1', projectId: 'p1' }]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            }),
          });

        const result = await service.createRecord(recordData);

        expect(result.version).toBe(1);
        expect(result.type).toBe('note');
        expect(result.epicId).toBe('epic-1');
      });
    });

    describe('updateRecord', () => {
      it('should throw OptimisticLockError on version conflict', async () => {
        const existingRecord = {
          id: 'record-1',
          epicId: 'epic-1',
          type: 'note',
          data: { content: 'Old' },
          version: 5,
          tags: [],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
        };

        // Mock getRecord - first call gets record, second gets tags
        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([existingRecord]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              innerJoin: jest.fn().mockReturnValue({
                where: jest.fn().mockResolvedValue([]),
              }),
            }),
          });

        await expect(
          service.updateRecord('record-1', { data: { content: 'New' } }, 4),
        ).rejects.toThrow(OptimisticLockError);
      });
    });
  });

  describe('Documents', () => {
    it('should create a document with generated slug and sanitized tags', async () => {
      const createData: CreateDocument = {
        title: 'My Doc Title',
        contentMd: '# Hello',
        projectId: null,
        tags: [' reference ', 'reference'],
      };

      const mockDocument: Document = {
        id: 'doc-123',
        title: createData.title,
        contentMd: createData.contentMd,
        slug: 'my-doc-title',
        projectId: null,
        archived: false,
        version: 1,
        tags: ['reference'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const slugSpy = jest
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn(service as any, 'generateDocumentSlug')
        .mockResolvedValue('my-doc-title');
      const tagSpy = jest
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn(service as any, 'setDocumentTags')
        .mockResolvedValue(undefined);
      const getDocumentSpy = jest.spyOn(service, 'getDocument').mockResolvedValue(mockDocument);

      mockDb.insert = jest.fn().mockReturnValue({
        values: jest.fn().mockResolvedValue(undefined),
      });

      const result = await service.createDocument(createData);

      expect(slugSpy).toHaveBeenCalledWith(null, createData.title);
      expect(tagSpy).toHaveBeenCalledWith(expect.any(String), ['reference'], null);
      expect(getDocumentSpy).toHaveBeenCalledWith({ id: expect.any(String) });
      expect(result).toEqual(mockDocument);
    });

    it('should update document slug and tags with optimistic locking', async () => {
      const currentDoc: Document = {
        id: 'doc-1',
        projectId: 'project-1',
        title: 'Current Title',
        slug: 'current-title',
        contentMd: '# Old',
        archived: false,
        version: 2,
        tags: ['old'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const updatedDoc: Document = {
        ...currentDoc,
        title: 'Updated Title',
        slug: 'updated-title',
        version: 3,
        tags: ['new'],
        updatedAt: new Date().toISOString(),
      };

      const slugSpy = jest
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn(service as any, 'generateDocumentSlug')
        .mockResolvedValue('updated-title');
      const tagSpy = jest
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .spyOn(service as any, 'setDocumentTags')
        .mockResolvedValue(undefined);
      const getDocumentSpy = jest
        .spyOn(service, 'getDocument')
        .mockResolvedValueOnce(currentDoc)
        .mockResolvedValueOnce(updatedDoc);

      mockDb.update = jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      });

      const result = await service.updateDocument('doc-1', {
        title: 'Updated Title',
        slug: 'Updated Title',
        tags: ['new'],
        version: 2,
        archived: true,
      });

      expect(slugSpy).toHaveBeenCalledWith(currentDoc.projectId, 'Updated Title', 'doc-1');
      expect(tagSpy).toHaveBeenCalledWith('doc-1', ['new'], currentDoc.projectId);
      expect(getDocumentSpy).toHaveBeenCalledTimes(2);
      expect(result).toEqual(updatedDoc);
    });

    it('should reject document update when version mismatch occurs', async () => {
      const currentDoc: Document = {
        id: 'doc-1',
        projectId: 'project-1',
        title: 'One',
        slug: 'one',
        contentMd: '# Content',
        archived: false,
        version: 5,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      jest.spyOn(service, 'getDocument').mockResolvedValue(currentDoc);

      await expect(
        service.updateDocument('doc-1', { title: 'Changed', version: 4 }),
      ).rejects.toThrow(OptimisticLockError);
    });

    it('should filter documents by tags and paginate results', async () => {
      const rows = [{ id: 'doc-1' }, { id: 'doc-2' }];
      const orderBy = jest.fn().mockResolvedValue(rows);
      const where = jest.fn().mockReturnValue({ orderBy });
      const baseQuery = {
        where,
        orderBy,
      };
      const from = jest.fn().mockReturnValue(baseQuery);
      mockDb.select = jest.fn().mockReturnValue({ from });

      const docOne: Document = {
        id: 'doc-1',
        projectId: null,
        title: 'First',
        slug: 'first',
        contentMd: '# First',
        archived: false,
        version: 1,
        tags: ['ref'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const docTwo: Document = {
        ...docOne,
        id: 'doc-2',
        slug: 'second',
        title: 'Second',
        tags: ['other'],
      };

      jest
        .spyOn(service, 'getDocument')
        .mockImplementation(async (identifier) => (identifier.id === 'doc-1' ? docOne : docTwo));

      const result = await service.listDocuments({ tags: ['ref'], limit: 1, offset: 0 });

      expect(mockDb.select).toHaveBeenCalled();
      expect(result.items).toEqual([docOne]);
      expect(result.total).toBe(1);
      expect(result.limit).toBe(1);
      expect(result.offset).toBe(0);
    });

    it('should filter documents by tag keys using EXISTS conditions before pagination', async () => {
      const rows = [{ id: 'doc-1' }, { id: 'doc-2' }];
      const filteredRows = [...rows];
      const orderBy = jest.fn().mockImplementation(() => Promise.resolve([...filteredRows]));
      let capturedWhere: unknown;
      const where = jest.fn().mockImplementation((condition) => {
        capturedWhere = condition;
        filteredRows.splice(0, filteredRows.length, ...rows);
        return { orderBy };
      });
      const baseQuery = {
        where,
        orderBy,
      };
      const from = jest.fn().mockReturnValue(baseQuery);
      mockDb.select = jest.fn().mockReturnValue({ from });

      const docOne: Document = {
        id: 'doc-1',
        projectId: null,
        title: 'First',
        slug: 'first',
        contentMd: '# First',
        archived: false,
        version: 1,
        tags: ['role:worker'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const docTwo: Document = {
        ...docOne,
        id: 'doc-2',
        slug: 'second',
        title: 'Second',
        tags: ['role'],
      };

      jest
        .spyOn(service, 'getDocument')
        .mockImplementation(async (identifier) => (identifier.id === 'doc-1' ? docOne : docTwo));

      const result = await service.listDocuments({ tagKeys: ['role'], limit: 10, offset: 0 });

      expect(where).toHaveBeenCalled();
      const queryChunks =
        (capturedWhere as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
      const querySql = queryChunks
        .map((chunk) => {
          if (typeof chunk === 'string') {
            return chunk;
          }
          if (chunk && typeof chunk === 'object' && 'value' in chunk) {
            const value = (chunk as { value: unknown }).value;
            if (Array.isArray(value)) {
              return value.join('');
            }
            return value ? String(value) : '';
          }
          return '';
        })
        .join('');

      expect(querySql).toContain('EXISTS');
      expect(querySql).toContain('role');

      expect(result.items).toEqual([docOne, docTwo]);
      expect(result.total).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(0);
    });

    it('should require projectId when querying by slug', async () => {
      await expect(service.getDocument({ slug: 'missing-project' })).rejects.toThrow(
        ValidationError,
      );
      await expect(service.getDocument({ slug: 'missing-project' })).rejects.toThrow(
        'projectId is required when querying document by slug',
      );
    });

    it('should throw ValidationError when neither id nor slug provided', async () => {
      await expect(
        service.getDocument({} as { id?: string; slug?: string; projectId?: string }),
      ).rejects.toThrow(ValidationError);
      await expect(
        service.getDocument({} as { id?: string; slug?: string; projectId?: string }),
      ).rejects.toThrow('Document identifier requires either id or slug');
    });
  });

  describe('Tags', () => {
    describe('createTag', () => {
      it('should create a tag', async () => {
        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        const result = await service.createTag({ projectId: 'p1', name: 'urgent' });

        expect(result.name).toBe('urgent');
        expect(result.projectId).toBe('p1');
        expect(result.id).toBeDefined();
      });
    });

    describe('getTag', () => {
      it('should throw NotFoundError when tag not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.getTag('nonexistent')).rejects.toThrow(NotFoundError);
      });
    });
  });

  describe('getProviderMcpMetadata', () => {
    it('returns metadata from provider', async () => {
      const mockProvider = {
        id: 'provider-1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: 'ws://127.0.0.1:4000',
        mcpRegisteredAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      mockDb.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockProvider]),
          }),
        }),
      });

      const metadata = await service.getProviderMcpMetadata('provider-1');
      expect(metadata).toEqual({
        mcpConfigured: true,
        mcpEndpoint: 'ws://127.0.0.1:4000',
        mcpRegisteredAt: '2024-01-01T00:00:00Z',
      });
    });
  });

  describe('updateProviderMcpMetadata', () => {
    it('delegates to updateProvider with normalized values', async () => {
      const updateSpy = jest.spyOn(service, 'updateProvider').mockResolvedValue({} as Provider);

      await service.updateProviderMcpMetadata('provider-1', {
        mcpConfigured: true,
        mcpEndpoint: 'ws://127.0.0.1:4000',
        mcpRegisteredAt: null,
      });

      expect(updateSpy).toHaveBeenCalledWith('provider-1', {
        mcpConfigured: true,
        mcpEndpoint: 'ws://127.0.0.1:4000',
        mcpRegisteredAt: null,
      });
    });
  });

  describe('Agent Profiles', () => {
    describe('createAgentProfile', () => {
      it('should create profile with providerId', async () => {
        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        const result = await service.createAgentProfile({
          name: 'Claude Profile',
          providerId: 'provider-1',
          options: '--model claude-3-sonnet',
          systemPrompt: 'You are helpful',
          temperature: 0.7,
          maxTokens: 4000,
        });

        expect(result.name).toBe('Claude Profile');
        expect(result.providerId).toBe('provider-1');
        expect(result.temperature).toBe(0.7);
        expect(mockDb.insert).toHaveBeenCalled();
      });

      it('should handle temperature conversion if needed', async () => {
        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        const result = await service.createAgentProfile({
          name: 'GPT-4 Profile',
          providerId: 'provider-2',
          options: '--model gpt-4',
          systemPrompt: 'You are helpful',
          temperature: 0.7,
          maxTokens: 4000,
        });

        expect(result.temperature).toBe(0.7);
        // Temperature should be stored as 70 (0.7 * 100) in the DB
        expect(mockDb.insert).toHaveBeenCalled();
      });
    });

    describe('getAgentProfile', () => {
      it('should throw NotFoundError when profile not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.getAgentProfile('nonexistent')).rejects.toThrow(NotFoundError);
      });
    });
  });

  describe('Agents', () => {
    describe('getAgent', () => {
      it('should throw NotFoundError when agent not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.getAgent('nonexistent')).rejects.toThrow(NotFoundError);
      });
    });

    describe('createAgent', () => {
      it('validates profile belongs to the same project on create', async () => {
        const getProfileSpy = jest
          .spyOn(
            service as unknown as { getAgentProfile: (id: string) => Promise<AgentProfile> },
            'getAgentProfile',
          )
          .mockResolvedValue({
            id: 'profile-1',
            projectId: 'project-2',
            name: 'P',
            providerId: 'provider-1',
            options: null,
            systemPrompt: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          });

        await expect(
          service.createAgent({ projectId: 'project-1', profileId: 'profile-1', name: 'A' }),
        ).rejects.toThrow(ValidationError);

        expect(getProfileSpy).toHaveBeenCalledWith('profile-1');
      });
    });

    describe('deleteAgent', () => {
      it('should throw ConflictError when agent has running sessions', async () => {
        const runningSessions = [
          {
            id: 'session-1',
            agentId: 'agent-1',
            status: 'running',
            startedAt: '2024-01-01T00:00:00Z',
          },
        ];

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(runningSessions),
          }),
        });

        await expect(service.deleteAgent('agent-1')).rejects.toThrow(ConflictError);
        await expect(service.deleteAgent('agent-1')).rejects.toThrow(
          'Cannot delete agent: 1 active session(s) are still running',
        );
      });

      it('should delete agent and auto-delete completed sessions', async () => {
        const completedSessions = [
          {
            id: 'session-1',
            agentId: 'agent-1',
            status: 'stopped',
            startedAt: '2024-01-01T00:00:00Z',
          },
          {
            id: 'session-2',
            agentId: 'agent-1',
            status: 'failed',
            startedAt: '2024-01-01T00:00:00Z',
          },
        ];

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(completedSessions),
          }),
        });

        mockDb.delete = jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        });

        await expect(service.deleteAgent('agent-1')).resolves.toBeUndefined();
        // Should delete sessions + agent
        expect(mockDb.delete).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('Statuses', () => {
    describe('getStatus', () => {
      it('should throw NotFoundError when status not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.getStatus('nonexistent')).rejects.toThrow(NotFoundError);
      });
    });

    describe('findStatusByName', () => {
      it('should return status when names match case-insensitively', async () => {
        const mockStatus: Status = {
          id: 'status-1',
          projectId: 'project-1',
          label: 'In Progress',
          color: '#ffffff',
          position: 1,
          mcpHidden: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        };

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockStatus]),
            }),
          }),
        });

        const result = await service.findStatusByName('project-1', 'in progress');

        expect(result).toEqual(mockStatus);
      });

      it('should return null when no matching status exists', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await service.findStatusByName('project-1', 'unknown');
        expect(result).toBeNull();
      });
    });
  });

  describe('Providers', () => {
    describe('createProvider', () => {
      it('should create a provider with binPath', async () => {
        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        const result = await service.createProvider({
          name: 'claude',
          binPath: '/usr/local/bin/claude',
        });

        expect(result).toBeDefined();
        expect(result.name).toBe('claude');
        expect(result.binPath).toBe('/usr/local/bin/claude');
        expect(result.mcpConfigured).toBe(false);
        expect(result.mcpEndpoint).toBeNull();
        expect(result.mcpRegisteredAt).toBeNull();
        expect(result.id).toBeDefined();
        expect(result.createdAt).toBeDefined();
        expect(result.updatedAt).toBeDefined();
        expect(mockDb.insert).toHaveBeenCalled();
      });

      it('should create a provider without binPath', async () => {
        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        const result = await service.createProvider({
          name: 'codex',
        });

        expect(result.name).toBe('codex');
        expect(result.binPath).toBeNull();
        expect(result.mcpConfigured).toBe(false);
      });
    });

    describe('getProvider', () => {
      it('should return a provider when found', async () => {
        const mockProvider = {
          id: 'provider-1',
          name: 'claude',
          binPath: '/usr/local/bin/claude',
          mcpConfigured: false,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockProvider]),
            }),
          }),
        });

        const result = await service.getProvider('provider-1');

        expect(result).toEqual(mockProvider);
      });

      it('should throw NotFoundError when provider not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.getProvider('nonexistent')).rejects.toThrow(NotFoundError);
        await expect(service.getProvider('nonexistent')).rejects.toThrow(
          'Provider with identifier nonexistent not found',
        );
      });
    });

    describe('listProviders', () => {
      it('should return paginated list of providers', async () => {
        const mockProviders = [
          {
            id: 'p1',
            name: 'claude',
            binPath: '/usr/local/bin/claude',
            mcpConfigured: false,
            mcpEndpoint: null,
            mcpRegisteredAt: null,
            createdAt: '2024-01-01',
            updatedAt: '2024-01-01',
          },
          {
            id: 'p2',
            name: 'codex',
            binPath: null,
            mcpConfigured: false,
            mcpEndpoint: null,
            mcpRegisteredAt: null,
            createdAt: '2024-01-02',
            updatedAt: '2024-01-02',
          },
        ];

        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                offset: jest.fn().mockResolvedValue(mockProviders),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockResolvedValue(mockProviders),
          });

        const result = await service.listProviders({ limit: 10, offset: 0 });

        expect(result.items).toHaveLength(2);
        expect(result.total).toBe(2);
      });
    });

    describe('updateProvider', () => {
      it('should update and return the provider', async () => {
        const mockProvider = {
          id: 'p1',
          name: 'claude',
          binPath: '/new/path/claude',
          mcpConfigured: true,
          mcpEndpoint: 'ws://localhost:4000',
          mcpRegisteredAt: '2024-01-02',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        };

        mockDb.update = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        });

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockProvider]),
            }),
          }),
        });

        const result = await service.updateProvider('p1', { binPath: '/new/path/claude' });

        expect(result.binPath).toBe('/new/path/claude');
      });
    });

    describe('deleteProvider', () => {
      it('should delete a provider', async () => {
        mockDb.delete = jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        });

        await expect(service.deleteProvider('p1')).resolves.toBeUndefined();
        expect(mockDb.delete).toHaveBeenCalled();
      });
    });
  });

  describe('Epic comments helpers', () => {
    describe('listEpicComments', () => {
      it('should return comments ordered by creation time with totals', async () => {
        const mockEpic: Epic = {
          id: 'epic-comments',
          projectId: 'project-1',
          title: 'Commented Epic',
          description: null,
          statusId: 'status-1',
          parentId: null,
          agentId: null,
          version: 1,
          data: null,
          tags: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        const mockComments: EpicComment[] = [
          {
            id: 'comment-1',
            epicId: mockEpic.id,
            authorName: 'Reviewer',
            content: 'Looks good',
            createdAt: '2024-01-05T12:00:00Z',
            updatedAt: '2024-01-05T12:00:00Z',
          },
        ];

        jest.spyOn(service, 'getEpic').mockResolvedValue(mockEpic);

        const rowsChain = {
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

        const countChain = {
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ count: 1 }]),
          }),
        };

        mockDb.select = jest.fn().mockReturnValueOnce(rowsChain).mockReturnValueOnce(countChain);

        const result = await service.listEpicComments(mockEpic.id, { limit: 10, offset: 0 });

        expect(result.items).toEqual(mockComments);
        expect(result.total).toBe(1);
      });
    });

    describe('createEpicComment', () => {
      it('should persist and return a new comment', async () => {
        const mockEpic: Epic = {
          id: 'epic-new-comment',
          projectId: 'project-1',
          title: 'Comment Epic',
          description: null,
          statusId: 'status-1',
          parentId: null,
          agentId: null,
          version: 1,
          data: null,
          tags: [],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        };

        jest.spyOn(service, 'getEpic').mockResolvedValue(mockEpic);

        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        const comment = await service.createEpicComment({
          epicId: mockEpic.id,
          authorName: 'Reviewer',
          content: 'Ship it',
        });

        expect(comment.epicId).toBe(mockEpic.id);
        expect(comment.authorName).toBe('Reviewer');
        expect(comment.content).toBe('Ship it');
        expect(mockDb.insert).toHaveBeenCalled();
      });
    });
  });

  // ============================================
  // TERMINAL WATCHERS
  // ============================================

  describe('Terminal Watchers', () => {
    const mockWatcher = {
      id: 'watcher-1',
      projectId: 'project-1',
      name: 'Test Watcher',
      description: 'Watches for errors',
      enabled: true,
      scope: 'all' as const,
      scopeFilterId: null,
      pollIntervalMs: 5000,
      viewportLines: 50,
      condition: { type: 'contains' as const, pattern: 'error' },
      cooldownMs: 60000,
      cooldownMode: 'time' as const,
      eventName: 'test.error.detected',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    describe('listWatchers', () => {
      it('should return watchers for a project', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([mockWatcher]),
            }),
          }),
        });

        const result = await service.listWatchers('project-1');

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(mockWatcher);
      });

      it('should return empty array when no watchers exist', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await service.listWatchers('project-empty');

        expect(result).toEqual([]);
      });
    });

    describe('getWatcher', () => {
      it('should return a watcher by id', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockWatcher]),
            }),
          }),
        });

        const result = await service.getWatcher('watcher-1');

        expect(result).toEqual(mockWatcher);
      });

      it('should return null when watcher not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await service.getWatcher('nonexistent');

        expect(result).toBeNull();
      });
    });

    describe('createWatcher', () => {
      it('should create a watcher with UUID and timestamps', async () => {
        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        const createData = {
          projectId: 'project-1',
          name: 'New Watcher',
          description: null,
          enabled: true,
          scope: 'all' as const,
          scopeFilterId: null,
          pollIntervalMs: 5000,
          viewportLines: 50,
          condition: { type: 'contains' as const, pattern: 'test' },
          cooldownMs: 60000,
          cooldownMode: 'time' as const,
          eventName: 'new.event',
        };

        const result = await service.createWatcher(createData);

        expect(result.id).toBeDefined();
        expect(result.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(result.name).toBe('New Watcher');
        expect(result.projectId).toBe('project-1');
        expect(result.condition).toEqual({ type: 'contains', pattern: 'test' });
        expect(result.createdAt).toBeDefined();
        expect(result.updatedAt).toBeDefined();
        expect(mockDb.insert).toHaveBeenCalled();
      });
    });

    describe('updateWatcher', () => {
      it('should update a watcher and set updatedAt', async () => {
        const updatedWatcher = { ...mockWatcher, name: 'Updated Watcher' };

        // First call: getWatcher to check existence
        // Second call: getWatcher after update
        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([mockWatcher]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([updatedWatcher]),
              }),
            }),
          });

        mockDb.update = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        });

        const result = await service.updateWatcher('watcher-1', { name: 'Updated Watcher' });

        expect(result.name).toBe('Updated Watcher');
        expect(mockDb.update).toHaveBeenCalled();
      });

      it('should throw NotFoundError when watcher does not exist', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.updateWatcher('nonexistent', { name: 'Test' })).rejects.toThrow(
          NotFoundError,
        );
        await expect(service.updateWatcher('nonexistent', { name: 'Test' })).rejects.toThrow(
          'Watcher with identifier nonexistent not found',
        );
      });
    });

    describe('deleteWatcher', () => {
      it('should delete a watcher', async () => {
        mockDb.delete = jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        });

        await service.deleteWatcher('watcher-1');

        expect(mockDb.delete).toHaveBeenCalled();
      });
    });

    describe('listEnabledWatchers', () => {
      it('should return all enabled watchers across projects', async () => {
        const enabledWatchers = [
          mockWatcher,
          { ...mockWatcher, id: 'watcher-2', projectId: 'project-2' },
        ];

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue(enabledWatchers),
            }),
          }),
        });

        const result = await service.listEnabledWatchers();

        expect(result).toHaveLength(2);
        expect(result[0].enabled).toBe(true);
        expect(result[1].enabled).toBe(true);
      });

      it('should return empty array when no enabled watchers exist', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await service.listEnabledWatchers();

        expect(result).toEqual([]);
      });
    });
  });

  // ============================================
  // AUTOMATION SUBSCRIBERS
  // ============================================

  describe('Automation Subscribers', () => {
    const mockSubscriber = {
      id: 'subscriber-1',
      projectId: 'project-1',
      name: 'Test Subscriber',
      description: 'Responds to errors',
      enabled: true,
      eventName: 'test.error.detected',
      eventFilter: null,
      actionType: 'send_agent_message',
      actionInputs: {
        text: { source: 'custom' as const, customValue: 'Error detected!' },
      },
      delayMs: 0,
      cooldownMs: 5000,
      retryOnError: false,
      groupName: null,
      position: 0,
      priority: 0,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    describe('listSubscribers', () => {
      it('should return subscribers for a project', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([mockSubscriber]),
            }),
          }),
        });

        const result = await service.listSubscribers('project-1');

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(mockSubscriber);
      });

      it('should return empty array when no subscribers exist', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await service.listSubscribers('project-empty');

        expect(result).toEqual([]);
      });
    });

    describe('getSubscriber', () => {
      it('should return a subscriber by id', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([mockSubscriber]),
            }),
          }),
        });

        const result = await service.getSubscriber('subscriber-1');

        expect(result).toEqual(mockSubscriber);
      });

      it('should return null when subscriber not found', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await service.getSubscriber('nonexistent');

        expect(result).toBeNull();
      });
    });

    describe('createSubscriber', () => {
      it('should create a subscriber with UUID and timestamps', async () => {
        mockDb.insert = jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        });

        const createData = {
          projectId: 'project-1',
          name: 'New Subscriber',
          description: null,
          enabled: true,
          eventName: 'new.event',
          eventFilter: { field: 'agentId', operator: 'equals' as const, value: 'agent-1' },
          actionType: 'send_agent_message',
          actionInputs: {
            text: { source: 'custom' as const, customValue: 'Hello' },
          },
          delayMs: 0,
          cooldownMs: 5000,
          retryOnError: false,
          groupName: null,
          position: 0,
          priority: 0,
        };

        const result = await service.createSubscriber(createData);

        expect(result.id).toBeDefined();
        expect(result.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(result.name).toBe('New Subscriber');
        expect(result.projectId).toBe('project-1');
        expect(result.actionInputs).toEqual({ text: { source: 'custom', customValue: 'Hello' } });
        expect(result.eventFilter).toEqual({
          field: 'agentId',
          operator: 'equals',
          value: 'agent-1',
        });
        expect(result.createdAt).toBeDefined();
        expect(result.updatedAt).toBeDefined();
        expect(mockDb.insert).toHaveBeenCalled();
      });
    });

    describe('updateSubscriber', () => {
      it('should update a subscriber and set updatedAt', async () => {
        const updatedSubscriber = { ...mockSubscriber, name: 'Updated Subscriber' };

        mockDb.select = jest
          .fn()
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([mockSubscriber]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([updatedSubscriber]),
              }),
            }),
          });

        mockDb.update = jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue(undefined),
          }),
        });

        const result = await service.updateSubscriber('subscriber-1', {
          name: 'Updated Subscriber',
        });

        expect(result.name).toBe('Updated Subscriber');
        expect(mockDb.update).toHaveBeenCalled();
      });

      it('should throw NotFoundError when subscriber does not exist', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        await expect(service.updateSubscriber('nonexistent', { name: 'Test' })).rejects.toThrow(
          NotFoundError,
        );
        await expect(service.updateSubscriber('nonexistent', { name: 'Test' })).rejects.toThrow(
          'Subscriber with identifier nonexistent not found',
        );
      });
    });

    describe('deleteSubscriber', () => {
      it('should delete a subscriber', async () => {
        mockDb.delete = jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        });

        await service.deleteSubscriber('subscriber-1');

        expect(mockDb.delete).toHaveBeenCalled();
      });
    });

    describe('findSubscribersByEventName', () => {
      it('should return enabled subscribers matching event name', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([mockSubscriber]),
            }),
          }),
        });

        const result = await service.findSubscribersByEventName('project-1', 'test.error.detected');

        expect(result).toHaveLength(1);
        expect(result[0].eventName).toBe('test.error.detected');
        expect(result[0].enabled).toBe(true);
      });

      it('should return empty array when no matching subscribers', async () => {
        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([]),
            }),
          }),
        });

        const result = await service.findSubscribersByEventName('project-1', 'unknown.event');

        expect(result).toEqual([]);
      });

      it('should handle JSON fields correctly', async () => {
        const subscriberWithFilter = {
          ...mockSubscriber,
          eventFilter: { field: 'agentId', operator: 'equals', value: 'agent-1' },
        };

        mockDb.select = jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockResolvedValue([subscriberWithFilter]),
            }),
          }),
        });

        const result = await service.findSubscribersByEventName('project-1', 'test.error.detected');

        expect(result[0].eventFilter).toEqual({
          field: 'agentId',
          operator: 'equals',
          value: 'agent-1',
        });
        expect(result[0].actionInputs).toEqual({
          text: { source: 'custom', customValue: 'Error detected!' },
        });
      });
    });
  });
});
