import { GuestHealthService } from './guest-health.service';
import { GuestsService } from './guests.service';
import { StorageService } from '../../storage/interfaces/storage.interface';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { EventsService } from '../../events/services/events.service';
import { Guest } from '../../storage/models/domain.models';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';

// Mock timers
jest.useFakeTimers();

describe('GuestHealthService', () => {
  let healthService: GuestHealthService;
  let gate: ProjectWriteGate;
  let mockStorage: jest.Mocked<Pick<StorageService, 'listAllGuests'>>;
  let mockTerminalIO: jest.Mocked<Pick<TerminalIOService, 'sessionExists'>>;
  let mockEventsService: jest.Mocked<Pick<EventsService, 'publish'>>;
  let mockGuestsService: jest.Mocked<
    Pick<
      GuestsService,
      'setHealthServiceRef' | 'initializeAndCleanup' | 'deleteGuest' | 'updateGuestLastSeen'
    >
  >;

  const mockGuest: Guest = {
    id: 'guest-1',
    projectId: 'project-1',
    name: 'TestGuest',
    description: null,
    tmuxSessionId: 'tmux-session-123',
    lastSeenAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    gate = new ProjectWriteGate();
    mockStorage = {
      listAllGuests: jest.fn(),
    };

    mockTerminalIO = {
      sessionExists: jest.fn(),
    };

    mockEventsService = {
      publish: jest.fn(),
    };

    mockGuestsService = {
      setHealthServiceRef: jest.fn(),
      initializeAndCleanup: jest.fn(),
      deleteGuest: jest.fn(),
      updateGuestLastSeen: jest.fn(),
    };

    healthService = new GuestHealthService(
      mockStorage as unknown as StorageService,
      mockTerminalIO as unknown as TerminalIOService,
      mockEventsService as unknown as EventsService,
      mockGuestsService as unknown as GuestsService,
      gate,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.clearAllMocks();
  });

  async function markRemoteOwned(): Promise<void> {
    gate.bindStorage({
      listRemoteProjectBindings: jest
        .fn()
        .mockResolvedValue([
          { projectId: mockGuest.projectId, remoteId: 'remote-1', state: 'remote' },
        ]),
      getRemote: jest.fn().mockResolvedValue({ id: 'remote-1', name: 'VM' }),
      listFrozenProjects: jest.fn().mockResolvedValue([]),
    });
    await gate.onModuleInit();
    expect(gate.getRemoteOwner(mockGuest.projectId)?.state).toBe('remote');
  }

  it('defers remote-owned startup guests and probes them once the project is writable', async () => {
    await markRemoteOwned();
    mockStorage.listAllGuests.mockResolvedValue([mockGuest]);
    mockTerminalIO.sessionExists.mockResolvedValue(false);

    await healthService.onModuleInit();
    await jest.advanceTimersByTimeAsync(30000);

    expect(mockTerminalIO.sessionExists).not.toHaveBeenCalled();
    expect(mockGuestsService.updateGuestLastSeen).not.toHaveBeenCalled();
    expect(mockGuestsService.deleteGuest).not.toHaveBeenCalled();
    expect(mockEventsService.publish).not.toHaveBeenCalled();

    gate.bindStorage({
      listRemoteProjectBindings: jest.fn().mockResolvedValue([]),
      getRemote: jest.fn(),
      listFrozenProjects: jest.fn().mockResolvedValue([]),
    });
    await gate.refresh();
    await jest.advanceTimersByTimeAsync(30000);

    expect(mockTerminalIO.sessionExists).toHaveBeenCalledWith({ name: mockGuest.tmuxSessionId });
    expect(mockGuestsService.deleteGuest).toHaveBeenCalledWith(mockGuest.id);
  });

  it('skips an interval after its guest project becomes remote-owned', async () => {
    healthService.startMonitoring(mockGuest);
    await markRemoteOwned();

    await jest.advanceTimersByTimeAsync(30000);

    expect(mockTerminalIO.sessionExists).not.toHaveBeenCalled();
    expect(mockGuestsService.updateGuestLastSeen).not.toHaveBeenCalled();
    expect(mockGuestsService.deleteGuest).not.toHaveBeenCalled();
    expect(mockEventsService.publish).not.toHaveBeenCalled();
  });

  it('skips death handling when ownership changes during the terminal probe', async () => {
    healthService.startMonitoring(mockGuest);
    mockTerminalIO.sessionExists.mockImplementationOnce(async () => {
      await markRemoteOwned();
      return false;
    });

    await jest.advanceTimersByTimeAsync(30000);

    expect(mockTerminalIO.sessionExists).toHaveBeenCalledTimes(1);
    expect(mockGuestsService.deleteGuest).not.toHaveBeenCalled();
    expect(mockEventsService.publish).not.toHaveBeenCalled();
  });

  describe('onModuleInit', () => {
    it('should register with GuestsService', async () => {
      mockStorage.listAllGuests!.mockResolvedValueOnce([]);

      await healthService.onModuleInit();

      expect(mockGuestsService.setHealthServiceRef).toHaveBeenCalledWith(healthService);
    });

    it('should call initializeAndCleanup before resuming monitoring', async () => {
      mockStorage.listAllGuests!.mockResolvedValueOnce([]);

      await healthService.onModuleInit();

      expect(mockGuestsService.initializeAndCleanup).toHaveBeenCalled();
      // Verify order: setHealthServiceRef first, then initializeAndCleanup
      const setRefOrder = mockGuestsService.setHealthServiceRef!.mock.invocationCallOrder[0];
      const cleanupOrder = mockGuestsService.initializeAndCleanup!.mock.invocationCallOrder[0];
      expect(setRefOrder).toBeLessThan(cleanupOrder);
    });

    it('should resume monitoring for existing guests with alive sessions', async () => {
      mockStorage.listAllGuests!.mockResolvedValueOnce([mockGuest]);
      mockTerminalIO.sessionExists!.mockResolvedValue(true);

      await healthService.onModuleInit();
      mockTerminalIO.sessionExists.mockClear();
      await jest.advanceTimersByTimeAsync(30000);

      expect(mockTerminalIO.sessionExists).toHaveBeenCalledTimes(1);
      expect(mockTerminalIO.sessionExists).toHaveBeenCalledWith({ name: 'tmux-session-123' });
      expect(mockGuestsService.updateGuestLastSeen).toHaveBeenCalledWith('guest-1');
    });

    it('should clean up guests with dead sessions on startup', async () => {
      mockStorage.listAllGuests!.mockResolvedValueOnce([mockGuest]);
      mockTerminalIO.sessionExists!.mockResolvedValueOnce(false);
      mockGuestsService.deleteGuest!.mockResolvedValueOnce(undefined);
      mockEventsService.publish.mockResolvedValueOnce('event-id');

      await healthService.onModuleInit();

      expect(mockGuestsService.deleteGuest).toHaveBeenCalledWith('guest-1');
      expect(mockEventsService.publish).toHaveBeenCalledWith('guest.unregistered', {
        guestId: 'guest-1',
        projectId: 'project-1',
        name: 'TestGuest',
        tmuxSessionId: 'tmux-session-123',
        reason: 'tmux_session_died',
      });
    });
  });

  describe('onModuleDestroy', () => {
    it('should clear all health check intervals', async () => {
      // Start monitoring for a guest
      mockTerminalIO.sessionExists!.mockResolvedValue(true);
      healthService.startMonitoring(mockGuest);

      // Destroy module
      healthService.onModuleDestroy();

      // Verify interval was cleared by checking that advancing timers does nothing
      jest.advanceTimersByTime(60000);
      // hasSession should only have been called during startMonitoring setup, not from interval
      expect(mockTerminalIO.sessionExists).not.toHaveBeenCalled();
    });
  });

  describe('startMonitoring', () => {
    it('should stop existing monitoring before starting new one', async () => {
      mockTerminalIO.sessionExists.mockResolvedValue(true);
      healthService.startMonitoring(mockGuest);
      healthService.startMonitoring(mockGuest);

      await jest.advanceTimersByTimeAsync(30000);
      expect(mockTerminalIO.sessionExists).toHaveBeenCalledTimes(1);
      expect(mockGuestsService.updateGuestLastSeen).toHaveBeenCalledTimes(1);
      healthService.onModuleDestroy();
    });
  });

  describe('stopMonitoring', () => {
    it('should stop health checks for a guest', () => {
      healthService.startMonitoring(mockGuest);
      healthService.stopMonitoring('guest-1');

      // Verify interval was cleared
      jest.advanceTimersByTime(60000);
      expect(mockTerminalIO.sessionExists).not.toHaveBeenCalled();
    });
  });

  describe('health check behavior', () => {
    it('should update lastSeen when tmux session is alive', async () => {
      mockTerminalIO.sessionExists!.mockResolvedValue(true);
      mockGuestsService.updateGuestLastSeen!.mockResolvedValue(mockGuest);

      healthService.startMonitoring(mockGuest);

      // Advance time to trigger health check
      jest.advanceTimersByTime(30000);

      // Wait for async operations
      await Promise.resolve();
      await Promise.resolve();

      expect(mockGuestsService.updateGuestLastSeen).toHaveBeenCalledWith('guest-1');
    });

    it('should clean up guest when tmux session dies', async () => {
      mockTerminalIO.sessionExists!.mockResolvedValueOnce(false);
      mockGuestsService.deleteGuest!.mockResolvedValueOnce(undefined);
      mockEventsService.publish.mockResolvedValueOnce('event-id');

      healthService.startMonitoring(mockGuest);

      // Advance time to trigger health check
      jest.advanceTimersByTime(30000);

      // Wait for async operations
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockGuestsService.deleteGuest).toHaveBeenCalledWith('guest-1');
      expect(mockEventsService.publish).toHaveBeenCalledWith('guest.unregistered', {
        guestId: 'guest-1',
        projectId: 'project-1',
        name: 'TestGuest',
        tmuxSessionId: 'tmux-session-123',
        reason: 'tmux_session_died',
      });
    });
  });
});
