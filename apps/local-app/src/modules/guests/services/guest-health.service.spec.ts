import { GuestHealthService } from './guest-health.service';
import { GuestsService } from './guests.service';
import { StorageService } from '../../storage/interfaces/storage.interface';
import { TmuxService } from '../../terminal/services/tmux.service';
import { EventsService } from '../../events/services/events.service';
import { Guest } from '../../storage/models/domain.models';

// Mock timers
jest.useFakeTimers();

describe('GuestHealthService', () => {
  let healthService: GuestHealthService;
  let mockStorage: jest.Mocked<Partial<StorageService>>;
  let mockTmuxService: jest.Mocked<Partial<TmuxService>>;
  let mockEventsService: jest.Mocked<Partial<EventsService>>;
  let mockGuestsService: jest.Mocked<Partial<GuestsService>>;

  const mockGuest: Guest = {
    id: 'guest-1',
    projectId: 'project-1',
    name: 'TestGuest',
    tmuxSessionId: 'tmux-session-123',
    lastSeenAt: '2024-01-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  beforeEach(() => {
    mockStorage = {
      listAllGuests: jest.fn(),
    };

    mockTmuxService = {
      hasSession: jest.fn(),
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
      mockStorage as StorageService,
      mockTmuxService as TmuxService,
      mockEventsService as EventsService,
      mockGuestsService as GuestsService,
    );
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.clearAllMocks();
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
      mockTmuxService.hasSession!.mockResolvedValueOnce(true);

      await healthService.onModuleInit();

      // Verify monitoring was started (interval was set)
      expect(mockTmuxService.hasSession).toHaveBeenCalledWith('tmux-session-123');
    });

    it('should clean up guests with dead sessions on startup', async () => {
      mockStorage.listAllGuests!.mockResolvedValueOnce([mockGuest]);
      mockTmuxService.hasSession!.mockResolvedValueOnce(false);
      mockGuestsService.deleteGuest!.mockResolvedValueOnce(undefined);
      mockEventsService.publish!.mockResolvedValueOnce(undefined);

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
      mockTmuxService.hasSession!.mockResolvedValue(true);
      healthService.startMonitoring(mockGuest);

      // Destroy module
      healthService.onModuleDestroy();

      // Verify interval was cleared by checking that advancing timers does nothing
      jest.advanceTimersByTime(60000);
      // hasSession should only have been called during startMonitoring setup, not from interval
      expect(mockTmuxService.hasSession).not.toHaveBeenCalled();
    });
  });

  describe('startMonitoring', () => {
    it('should start periodic health checks', async () => {
      mockTmuxService.hasSession!.mockResolvedValue(true);
      mockGuestsService.updateGuestLastSeen!.mockResolvedValue(mockGuest);

      healthService.startMonitoring(mockGuest);

      // Advance time to trigger health check
      jest.advanceTimersByTime(30000);

      // Wait for async operations
      await Promise.resolve();

      expect(mockTmuxService.hasSession).toHaveBeenCalledWith('tmux-session-123');
    });

    it('should stop existing monitoring before starting new one', () => {
      healthService.startMonitoring(mockGuest);
      healthService.startMonitoring(mockGuest);

      // Should not have duplicate intervals
      healthService.onModuleDestroy();
    });
  });

  describe('stopMonitoring', () => {
    it('should stop health checks for a guest', () => {
      healthService.startMonitoring(mockGuest);
      healthService.stopMonitoring('guest-1');

      // Verify interval was cleared
      jest.advanceTimersByTime(60000);
      expect(mockTmuxService.hasSession).not.toHaveBeenCalled();
    });

    it('should handle stopping non-existent monitoring gracefully', () => {
      expect(() => healthService.stopMonitoring('non-existent')).not.toThrow();
    });
  });

  describe('health check behavior', () => {
    it('should update lastSeen when tmux session is alive', async () => {
      mockTmuxService.hasSession!.mockResolvedValue(true);
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
      mockTmuxService.hasSession!.mockResolvedValueOnce(false);
      mockGuestsService.deleteGuest!.mockResolvedValueOnce(undefined);
      mockEventsService.publish!.mockResolvedValueOnce(undefined);

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
