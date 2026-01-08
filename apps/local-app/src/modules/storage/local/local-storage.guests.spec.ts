import { Test, TestingModule } from '@nestjs/testing';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { LocalStorageService } from './local-storage.service';
import { DB_CONNECTION } from '../db/db.provider';
import { NotFoundError, ConflictError } from '../../../common/errors/error-types';
import { Guest, CreateGuest, Project } from '../models/domain.models';

describe('LocalStorageService - Guests', () => {
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

  describe('createGuest', () => {
    it('should create a guest successfully', async () => {
      const createData: CreateGuest = {
        projectId: 'project-1',
        name: 'TestGuest',
        tmuxSessionId: 'tmux-session-123',
        lastSeenAt: new Date().toISOString(),
      };

      // Mock: no existing guest with same name
      const nameCheckChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      // Mock: no existing guest with same tmux session
      const tmuxCheckChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      // Mock insert
      const insertChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(nameCheckChain)
        .mockReturnValueOnce(tmuxCheckChain);
      mockDb.insert = jest.fn().mockReturnValue(insertChain);

      const result = await service.createGuest(createData);

      expect(result).toMatchObject({
        projectId: createData.projectId,
        name: createData.name,
        tmuxSessionId: createData.tmuxSessionId,
        lastSeenAt: createData.lastSeenAt,
      });
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });

    it('should throw ConflictError when guest name already exists in project', async () => {
      const createData: CreateGuest = {
        projectId: 'project-1',
        name: 'ExistingGuest',
        tmuxSessionId: 'tmux-session-new',
        lastSeenAt: new Date().toISOString(),
      };

      // Mock: existing guest with same name
      const nameCheckChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 'existing-guest-id' }]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValueOnce(nameCheckChain);

      await expect(service.createGuest(createData)).rejects.toThrow(ConflictError);
    });

    it('should throw ConflictError when tmux session already exists', async () => {
      const createData: CreateGuest = {
        projectId: 'project-1',
        name: 'NewGuest',
        tmuxSessionId: 'tmux-session-existing',
        lastSeenAt: new Date().toISOString(),
      };

      // Mock: no existing guest with same name
      const nameCheckChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      // Mock: existing guest with same tmux session
      const tmuxCheckChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 'existing-guest-id' }]),
          }),
        }),
      };

      mockDb.select = jest
        .fn()
        .mockReturnValueOnce(nameCheckChain)
        .mockReturnValueOnce(tmuxCheckChain);

      await expect(service.createGuest(createData)).rejects.toThrow(ConflictError);
    });
  });

  describe('getGuest', () => {
    it('should return guest when found', async () => {
      const mockGuest: Guest = {
        id: 'guest-1',
        projectId: 'project-1',
        name: 'TestGuest',
        tmuxSessionId: 'tmux-123',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockGuest]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getGuest('guest-1');
      expect(result).toEqual(mockGuest);
    });

    it('should throw NotFoundError when guest not found', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.getGuest('nonexistent-id')).rejects.toThrow(NotFoundError);
    });
  });

  describe('getGuestByName', () => {
    it('should return guest when found by name (case-insensitive)', async () => {
      const mockGuest: Guest = {
        id: 'guest-1',
        projectId: 'project-1',
        name: 'TestGuest',
        tmuxSessionId: 'tmux-123',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockGuest]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getGuestByName('project-1', 'testguest');
      expect(result).toEqual(mockGuest);
    });

    it('should return null when guest not found', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getGuestByName('project-1', 'nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getGuestByTmuxSessionId', () => {
    it('should return guest when found by tmux session', async () => {
      const mockGuest: Guest = {
        id: 'guest-1',
        projectId: 'project-1',
        name: 'TestGuest',
        tmuxSessionId: 'tmux-123',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockGuest]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getGuestByTmuxSessionId('tmux-123');
      expect(result).toEqual(mockGuest);
    });

    it('should return null when tmux session not found', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getGuestByTmuxSessionId('nonexistent-tmux');
      expect(result).toBeNull();
    });
  });

  describe('listGuests', () => {
    it('should return guests for a project', async () => {
      const mockGuests: Guest[] = [
        {
          id: 'guest-1',
          projectId: 'project-1',
          name: 'AlphaGuest',
          tmuxSessionId: 'tmux-1',
          lastSeenAt: '2024-01-01T00:00:00Z',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'guest-2',
          projectId: 'project-1',
          name: 'BetaGuest',
          tmuxSessionId: 'tmux-2',
          lastSeenAt: '2024-01-02T00:00:00Z',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockResolvedValue(mockGuests),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.listGuests('project-1');
      expect(result).toEqual(mockGuests);
      expect(result.length).toBe(2);
    });
  });

  describe('listAllGuests', () => {
    it('should return all guests across projects', async () => {
      const mockGuests: Guest[] = [
        {
          id: 'guest-1',
          projectId: 'project-1',
          name: 'Guest1',
          tmuxSessionId: 'tmux-1',
          lastSeenAt: '2024-01-01T00:00:00Z',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'guest-2',
          projectId: 'project-2',
          name: 'Guest2',
          tmuxSessionId: 'tmux-2',
          lastSeenAt: '2024-01-02T00:00:00Z',
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];

      const selectChain = {
        from: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockResolvedValue(mockGuests),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.listAllGuests();
      expect(result).toEqual(mockGuests);
    });
  });

  describe('deleteGuest', () => {
    it('should delete an existing guest', async () => {
      const mockGuest: Guest = {
        id: 'guest-1',
        projectId: 'project-1',
        name: 'TestGuest',
        tmuxSessionId: 'tmux-123',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      // Mock getGuest (called to verify existence)
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockGuest]),
          }),
        }),
      };

      const deleteChain = {
        where: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);
      mockDb.delete = jest.fn().mockReturnValue(deleteChain);

      await expect(service.deleteGuest('guest-1')).resolves.toBeUndefined();
    });

    it('should throw NotFoundError when deleting nonexistent guest', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(service.deleteGuest('nonexistent-id')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateGuestLastSeen', () => {
    it('should update lastSeenAt timestamp', async () => {
      const mockGuest: Guest = {
        id: 'guest-1',
        projectId: 'project-1',
        name: 'TestGuest',
        tmuxSessionId: 'tmux-123',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const newLastSeen = '2024-01-02T12:00:00Z';

      // Mock getGuest
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockGuest]),
          }),
        }),
      };

      const updateChain = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue(undefined),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);
      mockDb.update = jest.fn().mockReturnValue(updateChain);

      const result = await service.updateGuestLastSeen('guest-1', newLastSeen);

      expect(result.lastSeenAt).toBe(newLastSeen);
      expect(result.id).toBe(mockGuest.id);
    });

    it('should throw NotFoundError when updating nonexistent guest', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      await expect(
        service.updateGuestLastSeen('nonexistent-id', new Date().toISOString()),
      ).rejects.toThrow(NotFoundError);
    });
  });
});

describe('LocalStorageService - Project Path Lookups', () => {
  let service: LocalStorageService;
  let mockDb: jest.Mocked<BetterSQLite3Database>;

  beforeEach(async () => {
    const mockChain = {
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
    };

    mockDb = {
      select: jest.fn().mockReturnValue(mockChain),
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

  describe('getProjectByRootPath', () => {
    it('should return project when exact rootPath matches', async () => {
      const mockProject: Project = {
        id: 'project-1',
        name: 'Test Project',
        description: null,
        rootPath: '/home/user/project',
        isTemplate: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([mockProject]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getProjectByRootPath('/home/user/project');
      expect(result).toMatchObject({
        id: mockProject.id,
        name: mockProject.name,
        rootPath: mockProject.rootPath,
      });
    });

    it('should return null when no project matches', async () => {
      const selectChain = {
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValue(selectChain);

      const result = await service.getProjectByRootPath('/nonexistent/path');
      expect(result).toBeNull();
    });
  });

  describe('findProjectContainingPath', () => {
    it('should find project containing the given path', async () => {
      const mockProjects: Project[] = [
        {
          id: 'project-1',
          name: 'Root Project',
          description: null,
          rootPath: '/home/user/projects/app',
          isTemplate: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      // First call returns projects, second call returns empty (pagination done)
      const selectChain1 = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue(mockProjects),
          }),
        }),
      };

      const selectChain2 = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValueOnce(selectChain1).mockReturnValueOnce(selectChain2);

      const result = await service.findProjectContainingPath(
        '/home/user/projects/app/src/components',
      );
      expect(result).not.toBeNull();
      expect(result?.id).toBe('project-1');
    });

    it('should return most specific match (longest rootPath)', async () => {
      const mockProjects: Project[] = [
        {
          id: 'project-parent',
          name: 'Parent Project',
          description: null,
          rootPath: '/home/user/projects',
          isTemplate: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 'project-child',
          name: 'Child Project',
          description: null,
          rootPath: '/home/user/projects/app',
          isTemplate: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const selectChain1 = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue(mockProjects),
          }),
        }),
      };

      const selectChain2 = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValueOnce(selectChain1).mockReturnValueOnce(selectChain2);

      const result = await service.findProjectContainingPath(
        '/home/user/projects/app/src/index.ts',
      );

      // Should return the more specific (child) project
      expect(result).not.toBeNull();
      expect(result?.id).toBe('project-child');
    });

    it('should return null when no project contains the path', async () => {
      const mockProjects: Project[] = [
        {
          id: 'project-1',
          name: 'Other Project',
          description: null,
          rootPath: '/home/user/other',
          isTemplate: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const selectChain1 = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue(mockProjects),
          }),
        }),
      };

      const selectChain2 = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValueOnce(selectChain1).mockReturnValueOnce(selectChain2);

      const result = await service.findProjectContainingPath('/home/user/different/path');
      expect(result).toBeNull();
    });

    it('should return exact match when path equals rootPath', async () => {
      const mockProjects: Project[] = [
        {
          id: 'project-1',
          name: 'Exact Match Project',
          description: null,
          rootPath: '/home/user/project',
          isTemplate: false,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ];

      const selectChain1 = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue(mockProjects),
          }),
        }),
      };

      const selectChain2 = {
        from: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            offset: jest.fn().mockResolvedValue([]),
          }),
        }),
      };

      mockDb.select = jest.fn().mockReturnValueOnce(selectChain1).mockReturnValueOnce(selectChain2);

      const result = await service.findProjectContainingPath('/home/user/project');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('project-1');
    });
  });
});
