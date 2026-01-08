import { GuestsService } from './guests.service';
import { StorageService } from '../../storage/interfaces/storage.interface';
import { TmuxService } from '../../terminal/services/tmux.service';
import { EventsService } from '../../events/services/events.service';
import { ValidationError, ConflictError, NotFoundError } from '../../../common/errors/error-types';
import { GUEST_SANDBOX_PROJECT_NAME, GUEST_SANDBOX_ROOT_PATH } from '../constants';
import { Project, Agent, Guest } from '../../storage/models/domain.models';

describe('GuestsService', () => {
  let guestsService: GuestsService;
  let mockStorage: jest.Mocked<Partial<StorageService>>;
  let mockTmuxService: jest.Mocked<Partial<TmuxService>>;
  let mockEventsService: jest.Mocked<Partial<EventsService>>;

  beforeEach(() => {
    mockStorage = {
      getProjectByRootPath: jest.fn(),
      findProjectContainingPath: jest.fn(),
      createProject: jest.fn(),
      deleteProject: jest.fn(),
      createGuest: jest.fn(),
      getGuest: jest.fn(),
      getGuestByName: jest.fn(),
      getGuestByTmuxSessionId: jest.fn(),
      listGuests: jest.fn(),
      listAllGuests: jest.fn(),
      deleteGuest: jest.fn(),
      updateGuestLastSeen: jest.fn(),
      getAgentByName: jest.fn(),
    };

    mockTmuxService = {
      hasSession: jest.fn(),
      getSessionCwd: jest.fn(),
    };

    mockEventsService = {
      publish: jest.fn(),
    };

    guestsService = new GuestsService(
      mockStorage as StorageService,
      mockTmuxService as TmuxService,
      mockEventsService as EventsService,
    );
  });

  describe('onModuleInit', () => {
    it('should do nothing (startup is coordinated by GuestHealthService)', async () => {
      await expect(guestsService.onModuleInit()).resolves.not.toThrow();
      // Verify no cleanup calls are made from onModuleInit
      expect(mockStorage.getProjectByRootPath).not.toHaveBeenCalled();
      expect(mockStorage.deleteProject).not.toHaveBeenCalled();
    });
  });

  describe('initializeAndCleanup', () => {
    it('should clean up sandbox project from previous run', async () => {
      const mockSandbox: Partial<Project> = { id: 'sandbox-id', name: GUEST_SANDBOX_PROJECT_NAME };
      mockStorage.getProjectByRootPath!.mockResolvedValueOnce(mockSandbox as Project);
      mockStorage.deleteProject!.mockResolvedValueOnce(undefined);

      await guestsService.initializeAndCleanup();

      expect(mockStorage.getProjectByRootPath).toHaveBeenCalledWith(GUEST_SANDBOX_ROOT_PATH);
      expect(mockStorage.deleteProject).toHaveBeenCalledWith('sandbox-id');
    });

    it('should not throw if no sandbox exists', async () => {
      mockStorage.getProjectByRootPath!.mockResolvedValueOnce(null);

      await expect(guestsService.initializeAndCleanup()).resolves.not.toThrow();
      expect(mockStorage.deleteProject).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreateSandboxProject', () => {
    it('should return existing sandbox if it exists', async () => {
      const mockSandbox: Partial<Project> = { id: 'sandbox-id', name: GUEST_SANDBOX_PROJECT_NAME };
      mockStorage.getProjectByRootPath!.mockResolvedValueOnce(mockSandbox as Project);

      const result = await guestsService.getOrCreateSandboxProject();

      expect(result).toEqual({ id: 'sandbox-id', name: GUEST_SANDBOX_PROJECT_NAME });
      expect(mockStorage.createProject).not.toHaveBeenCalled();
    });

    it('should create sandbox if it does not exist', async () => {
      const newSandbox: Partial<Project> = {
        id: 'new-sandbox-id',
        name: GUEST_SANDBOX_PROJECT_NAME,
        rootPath: GUEST_SANDBOX_ROOT_PATH,
      };
      mockStorage.getProjectByRootPath!.mockResolvedValueOnce(null);
      mockStorage.createProject!.mockResolvedValueOnce(newSandbox as Project);

      const result = await guestsService.getOrCreateSandboxProject();

      expect(result).toEqual({ id: 'new-sandbox-id', name: GUEST_SANDBOX_PROJECT_NAME });
      expect(mockStorage.createProject).toHaveBeenCalledWith({
        name: GUEST_SANDBOX_PROJECT_NAME,
        description: expect.any(String),
        rootPath: GUEST_SANDBOX_ROOT_PATH,
        isTemplate: false,
      });
    });
  });

  describe('register', () => {
    const mockRegisterDto = {
      name: 'TestGuest',
      tmuxSessionId: 'tmux-session-123',
    };

    const mockProject: Partial<Project> = {
      id: 'project-1',
      name: 'Test Project',
      rootPath: '/home/user/project',
    };

    const mockGuest: Guest = {
      id: 'guest-1',
      projectId: 'project-1',
      name: 'TestGuest',
      tmuxSessionId: 'tmux-session-123',
      lastSeenAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    it('should successfully register a guest with matching project', async () => {
      mockTmuxService.hasSession!.mockResolvedValueOnce(true);
      mockStorage.getGuestByTmuxSessionId!.mockResolvedValueOnce(null);
      mockTmuxService.getSessionCwd!.mockResolvedValueOnce('/home/user/project/src');
      mockStorage.findProjectContainingPath!.mockResolvedValueOnce(mockProject as Project);
      mockStorage.getAgentByName!.mockRejectedValueOnce(new NotFoundError('Agent', 'TestGuest'));
      mockStorage.getGuestByName!.mockResolvedValueOnce(null);
      mockStorage.createGuest!.mockResolvedValueOnce(mockGuest);
      mockEventsService.publish!.mockResolvedValueOnce(undefined);

      const result = await guestsService.register(mockRegisterDto);

      expect(result).toEqual({
        guestId: 'guest-1',
        projectId: 'project-1',
        projectName: 'Test Project',
        isSandbox: false,
      });
      expect(mockEventsService.publish).toHaveBeenCalledWith(
        'guest.registered',
        expect.any(Object),
      );
    });

    it('should register guest with sandbox when no matching project', async () => {
      const mockSandbox: Partial<Project> = { id: 'sandbox-id', name: GUEST_SANDBOX_PROJECT_NAME };

      mockTmuxService.hasSession!.mockResolvedValueOnce(true);
      mockStorage.getGuestByTmuxSessionId!.mockResolvedValueOnce(null);
      mockTmuxService.getSessionCwd!.mockResolvedValueOnce('/tmp/random');
      mockStorage.findProjectContainingPath!.mockResolvedValueOnce(null);
      mockStorage.getProjectByRootPath!.mockResolvedValueOnce(null);
      mockStorage.createProject!.mockResolvedValueOnce(mockSandbox as Project);
      mockStorage.getAgentByName!.mockRejectedValueOnce(new NotFoundError('Agent', 'TestGuest'));
      mockStorage.getGuestByName!.mockResolvedValueOnce(null);
      mockStorage.createGuest!.mockResolvedValueOnce({ ...mockGuest, projectId: 'sandbox-id' });
      mockEventsService.publish!.mockResolvedValueOnce(undefined);

      const result = await guestsService.register(mockRegisterDto);

      expect(result.isSandbox).toBe(true);
      expect(result.projectName).toBe(GUEST_SANDBOX_PROJECT_NAME);
    });

    it('should throw ValidationError if tmux session does not exist', async () => {
      mockTmuxService.hasSession!.mockResolvedValueOnce(false);

      await expect(guestsService.register(mockRegisterDto)).rejects.toThrow(ValidationError);
    });

    it('should throw ConflictError if tmux session already registered', async () => {
      mockTmuxService.hasSession!.mockResolvedValueOnce(true);
      mockStorage.getGuestByTmuxSessionId!.mockResolvedValueOnce(mockGuest);

      await expect(guestsService.register(mockRegisterDto)).rejects.toThrow(ConflictError);
    });

    it('should throw ValidationError if cannot get tmux cwd', async () => {
      mockTmuxService.hasSession!.mockResolvedValueOnce(true);
      mockStorage.getGuestByTmuxSessionId!.mockResolvedValueOnce(null);
      mockTmuxService.getSessionCwd!.mockResolvedValueOnce(null);

      await expect(guestsService.register(mockRegisterDto)).rejects.toThrow(ValidationError);
    });

    it('should throw ConflictError if name already used by agent', async () => {
      const existingAgent: Partial<Agent> = { id: 'agent-1', name: 'TestGuest' };
      mockTmuxService.hasSession!.mockResolvedValueOnce(true);
      mockStorage.getGuestByTmuxSessionId!.mockResolvedValueOnce(null);
      mockTmuxService.getSessionCwd!.mockResolvedValueOnce('/home/user/project/src');
      mockStorage.findProjectContainingPath!.mockResolvedValueOnce(mockProject as Project);
      mockStorage.getAgentByName!.mockResolvedValueOnce(existingAgent as Agent);

      await expect(guestsService.register(mockRegisterDto)).rejects.toThrow(ConflictError);
    });

    it('should throw ConflictError if name already used by guest', async () => {
      const existingGuest: Partial<Guest> = { id: 'existing-guest', name: 'TestGuest' };
      mockTmuxService.hasSession!.mockResolvedValueOnce(true);
      mockStorage.getGuestByTmuxSessionId!.mockResolvedValueOnce(null);
      mockTmuxService.getSessionCwd!.mockResolvedValueOnce('/home/user/project/src');
      mockStorage.findProjectContainingPath!.mockResolvedValueOnce(mockProject as Project);
      mockStorage.getAgentByName!.mockRejectedValueOnce(new NotFoundError('Agent', 'TestGuest'));
      mockStorage.getGuestByName!.mockResolvedValueOnce(existingGuest as Guest);

      await expect(guestsService.register(mockRegisterDto)).rejects.toThrow(ConflictError);
    });
  });
});
