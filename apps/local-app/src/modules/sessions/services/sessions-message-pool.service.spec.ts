import { SessionsMessagePoolService, FAILURE_NOTICE_SOURCE } from './sessions-message-pool.service';
import type { SessionsService } from './sessions.service';
import type { SessionCoordinatorService } from './session-coordinator.service';
import type { MessageActivityStreamService } from './message-activity-stream.service';
import type { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import type { TmuxService } from '../../terminal/services/tmux.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';

describe('SessionsMessagePoolService', () => {
  let service: SessionsMessagePoolService;
  let mockSessionsService: jest.Mocked<Pick<SessionsService, 'listActiveSessions'>>;
  let mockCoordinator: jest.Mocked<Pick<SessionCoordinatorService, 'withAgentLock'>>;
  let mockSendCoordinator: jest.Mocked<Pick<TerminalSendCoordinatorService, 'ensureAgentGap'>>;
  let mockTmux: jest.Mocked<Pick<TmuxService, 'pasteAndSubmit'>>;
  let mockSettings: jest.Mocked<
    Pick<SettingsService, 'getMessagePoolConfig' | 'getMessagePoolConfigForProject'>
  >;
  let mockStorage: jest.Mocked<Pick<StorageService, 'getAgent'>>;
  let mockActivityStream: jest.Mocked<MessageActivityStreamService>;

  const createMockAgent = (overrides: { id?: string; name?: string; projectId?: string } = {}) => ({
    id: overrides.id ?? 'agent-1',
    name: overrides.name ?? 'Test Agent',
    projectId: overrides.projectId ?? 'project-1',
    profileId: 'profile-1',
    description: 'Test agent description',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const createActiveSession = (agentId: string, tmuxSessionId: string = 'tmux-1') => ({
    id: `session-${agentId}`,
    agentId,
    tmuxSessionId,
    status: 'running' as const,
    epicId: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    jest.useFakeTimers();

    mockSessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([createActiveSession('agent-1')]),
    };

    mockCoordinator = {
      withAgentLock: jest.fn().mockImplementation(async (_agentId, fn) => fn()),
    };

    mockSendCoordinator = {
      ensureAgentGap: jest.fn().mockResolvedValue(undefined),
    };

    mockTmux = {
      pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
    };

    mockSettings = {
      getMessagePoolConfig: jest.fn().mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      }),
      getMessagePoolConfigForProject: jest.fn().mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      }),
    };

    mockStorage = {
      getAgent: jest.fn().mockResolvedValue(createMockAgent()),
    };

    mockActivityStream = {
      broadcastEnqueued: jest.fn(),
      broadcastDelivered: jest.fn(),
      broadcastFailed: jest.fn(),
      broadcastPoolsUpdated: jest.fn(),
    } as unknown as jest.Mocked<MessageActivityStreamService>;

    service = new SessionsMessagePoolService(
      mockSessionsService as unknown as SessionsService,
      mockCoordinator as unknown as SessionCoordinatorService,
      mockSendCoordinator as unknown as TerminalSendCoordinatorService,
      mockTmux as unknown as TmuxService,
      mockSettings as unknown as SettingsService,
      mockStorage as unknown as StorageService,
      mockActivityStream,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('Debounce behavior', () => {
    it('should reset timer on each enqueue', async () => {
      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await jest.advanceTimersByTimeAsync(5000);

      // Add another message - should reset the timer
      await service.enqueue('agent-1', 'Message 2', { source: 'test' });
      await jest.advanceTimersByTimeAsync(5000);

      // Not yet delivered (timer reset)
      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      // Advance past the debounce delay
      await jest.advanceTimersByTimeAsync(5001);

      // Now should be delivered
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        expect.stringContaining('Message 1'),
        expect.any(Object),
      );
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        expect.stringContaining('Message 2'),
        expect.any(Object),
      );
    });

    it('should flush after delayMs with no new messages', async () => {
      await service.enqueue('agent-1', 'Single message', { source: 'test' });

      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        'Single message',
        expect.objectContaining({ bracketed: true }),
      );
    });

    it('should return queued status when message is pooled', async () => {
      const result = await service.enqueue('agent-1', 'Message', { source: 'test' });

      expect(result.status).toBe('queued');
      expect(result.poolSize).toBe(1);
    });
  });

  describe('Immediate bypass', () => {
    it('should deliver immediately when immediate: true', async () => {
      const result = await service.enqueue('agent-1', 'Urgent message', {
        source: 'test',
        immediate: true,
      });

      expect(result.status).toBe('delivered');
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        'Urgent message',
        expect.objectContaining({ bracketed: true }),
      );
    });

    it('should add to pool when immediate: false (default)', async () => {
      const result = await service.enqueue('agent-1', 'Normal message', {
        source: 'test',
        immediate: false,
      });

      expect(result.status).toBe('queued');
      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();
    });

    it('should deliver immediately when pooling is disabled', async () => {
      // Configure per-project pooling disabled
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: false,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      const result = await service.enqueue('agent-1', 'Message', { source: 'test' });

      expect(result.status).toBe('delivered');
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });

    it('should return failed status when immediate delivery fails', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      const result = await service.enqueue('agent-1', 'Message', {
        source: 'test',
        immediate: true,
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('No active session');
    });
  });

  describe('Limit enforcement', () => {
    it('should flush when maxMessages is reached', async () => {
      // Configure per-project maxMessages=3
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 3,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await service.enqueue('agent-1', 'Message 2', { source: 'test' });
      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      const result = await service.enqueue('agent-1', 'Message 3', { source: 'test' });

      expect(result.status).toBe('delivered');
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });

    it('should return failed status when maxMessages flush fails due to no session', async () => {
      // Configure per-project maxMessages=2
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 2,
        separator: '\n---\n',
      });

      // First message - session exists
      await service.enqueue('agent-1', 'Message 1', { source: 'test' });

      // Remove session before second message triggers flush
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      const result = await service.enqueue('agent-1', 'Message 2', { source: 'test' });

      // Should return failed (not delivered!) since flush failed
      expect(result.status).toBe('failed');
      expect(result.error).toBe('No active session');
    });

    it('should return failed status when maxMessages flush fails due to tmux error', async () => {
      // Configure per-project maxMessages=2
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 2,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 1', { source: 'test' });

      // Make tmux fail on the flush
      mockTmux.pasteAndSubmit.mockRejectedValue(new Error('Connection refused'));

      const result = await service.enqueue('agent-1', 'Message 2', { source: 'test' });

      expect(result.status).toBe('failed');
      expect(result.error).toBe('Connection refused');
    });

    it('should flush after maxWaitMs despite ongoing activity', async () => {
      // Configure per-project maxWaitMs=5000, delayMs=10000
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 5000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 1', { source: 'test' });

      // Keep adding messages every 2 seconds (less than delayMs)
      for (let i = 0; i < 3; i++) {
        await jest.advanceTimersByTimeAsync(2000);
        await service.enqueue('agent-1', `Message ${i + 2}`, { source: 'test' });
      }

      // maxWaitMs (5s) should have triggered despite debounce resets
      // Total time: 6 seconds, maxWaitMs: 5 seconds
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('Message ordering', () => {
    it('should deliver messages in enqueue order', async () => {
      await service.enqueue('agent-1', 'First', { source: 'test' });
      await service.enqueue('agent-1', 'Second', { source: 'test' });
      await service.enqueue('agent-1', 'Third', { source: 'test' });

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      const calledText = mockTmux.pasteAndSubmit.mock.calls[0][1];
      expect(calledText).toBe('First\n---\nSecond\n---\nThird');
    });

    it('should maintain independent pools for multiple agents', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        createActiveSession('agent-1', 'tmux-1'),
        createActiveSession('agent-2', 'tmux-2'),
      ]);

      await service.enqueue('agent-1', 'Agent1 Message', { source: 'test' });
      await service.enqueue('agent-2', 'Agent2 Message', { source: 'test' });

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(2);
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        'Agent1 Message',
        expect.any(Object),
      );
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-2',
        'Agent2 Message',
        expect.any(Object),
      );
    });
  });

  describe('Failure notification', () => {
    it('should notify sender on delivery failure', async () => {
      mockSessionsService.listActiveSessions
        .mockResolvedValueOnce([]) // First call - no session for agent-1
        .mockResolvedValue([createActiveSession('sender-agent', 'tmux-sender')]); // Subsequent calls

      await service.enqueue('agent-1', 'Message', {
        source: 'test',
        senderAgentId: 'sender-agent',
      });

      await jest.advanceTimersByTimeAsync(10001);

      // First call was for agent-1 (failed), second should be notification to sender
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-sender',
        expect.stringContaining('[Delivery Failed]'),
        expect.any(Object),
      );
    });

    it('should skip notification for messages with source pool.failure_notice (loop guard)', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      await service.enqueue('agent-1', 'Failure notice', {
        source: FAILURE_NOTICE_SOURCE,
        senderAgentId: 'sender-agent',
      });

      await jest.advanceTimersByTimeAsync(10001);

      // No notification should be sent for failure notices
      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();
    });

    it('should use immediate: true for failure notifications', async () => {
      const enqueueSpy = jest.spyOn(service, 'enqueue');

      mockSessionsService.listActiveSessions
        .mockResolvedValueOnce([]) // No session for agent-1
        .mockResolvedValue([createActiveSession('sender-agent', 'tmux-sender')]);

      await service.enqueue('agent-1', 'Message', {
        source: 'test',
        senderAgentId: 'sender-agent',
      });

      await jest.advanceTimersByTimeAsync(10001);

      // Find the notification enqueue call
      const notificationCall = enqueueSpy.mock.calls.find(
        (call) => call[2]?.source === FAILURE_NOTICE_SOURCE,
      );

      expect(notificationCall).toBeDefined();
      expect(notificationCall?.[2]?.immediate).toBe(true);
    });
  });

  describe('Session locking', () => {
    it('should call withAgentLock during flush', async () => {
      await service.enqueue('agent-1', 'Message', { source: 'test' });
      await jest.advanceTimersByTimeAsync(10001);

      expect(mockCoordinator.withAgentLock).toHaveBeenCalledWith('agent-1', expect.any(Function));
    });

    it('should call ensureAgentGap before sending', async () => {
      await service.enqueue('agent-1', 'Message', { source: 'test' });
      await jest.advanceTimersByTimeAsync(10001);

      expect(mockSendCoordinator.ensureAgentGap).toHaveBeenCalledWith('agent-1', 500);
    });

    it('should use agent lock for immediate delivery', async () => {
      await service.enqueue('agent-1', 'Immediate message', {
        source: 'test',
        immediate: true,
      });

      expect(mockCoordinator.withAgentLock).toHaveBeenCalledWith('agent-1', expect.any(Function));
    });
  });

  describe('Graceful shutdown', () => {
    it('should flush all pending pools on module destroy', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        createActiveSession('agent-1', 'tmux-1'),
        createActiveSession('agent-2', 'tmux-2'),
      ]);

      await service.enqueue('agent-1', 'Agent1 Message', { source: 'test' });
      await service.enqueue('agent-2', 'Agent2 Message', { source: 'test' });

      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      await service.onModuleDestroy();

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(2);
    });

    it('should clear all timers on shutdown', async () => {
      await service.enqueue('agent-1', 'Message', { source: 'test' });

      // Get initial pool stats
      const statsBefore = service.getPoolStats();
      expect(statsBefore.length).toBe(1);

      await service.onModuleDestroy();

      // Pool should be empty after shutdown
      const statsAfter = service.getPoolStats();
      expect(statsAfter.length).toBe(0);
    });

    it('should not block forever on shutdown timeout', async () => {
      // Make flushAll hang
      mockCoordinator.withAgentLock.mockImplementation(
        () => new Promise(() => {}), // Never resolves
      );

      await service.enqueue('agent-1', 'Message', { source: 'test' });

      // Start shutdown (should not block forever)
      const shutdownPromise = service.onModuleDestroy();

      // Advance past the 5 second timeout
      await jest.advanceTimersByTimeAsync(6000);

      // Shutdown should complete due to timeout
      await expect(shutdownPromise).resolves.not.toThrow();
    });
  });

  describe('Configuration', () => {
    it('should load config from SettingsService', () => {
      expect(mockSettings.getMessagePoolConfig).toHaveBeenCalled();
    });

    it('should use default config when SettingsService throws', () => {
      mockSettings.getMessagePoolConfig.mockImplementation(() => {
        throw new Error('Settings not available');
      });

      const serviceWithDefaultConfig = new SessionsMessagePoolService(
        mockSessionsService as unknown as SessionsService,
        mockCoordinator as unknown as SessionCoordinatorService,
        mockSendCoordinator as unknown as TerminalSendCoordinatorService,
        mockTmux as unknown as TmuxService,
        mockSettings as unknown as SettingsService,
        mockStorage as unknown as StorageService,
        mockActivityStream,
      );

      // Should not throw, uses defaults
      expect(serviceWithDefaultConfig).toBeDefined();
    });

    it('should reload config when reloadConfig is called', () => {
      mockSettings.getMessagePoolConfig.mockReturnValue({
        enabled: false,
        delayMs: 5000,
        maxWaitMs: 15000,
        maxMessages: 5,
        separator: '---',
      });

      service.reloadConfig();

      expect(mockSettings.getMessagePoolConfig).toHaveBeenCalledTimes(2); // Initial + reload
    });

    it('should allow runtime configuration updates', async () => {
      // Configure per-project maxMessages=2
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 2,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      const result = await service.enqueue('agent-1', 'Message 2', { source: 'test' });

      expect(result.status).toBe('delivered');
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('Pool statistics', () => {
    it('should return accurate pool stats', async () => {
      jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await service.enqueue('agent-1', 'Message 2', { source: 'test' });

      await jest.advanceTimersByTimeAsync(1000);

      const stats = service.getPoolStats();

      expect(stats).toHaveLength(1);
      expect(stats[0].agentId).toBe('agent-1');
      expect(stats[0].messageCount).toBe(2);
      expect(stats[0].waitingMs).toBe(1000);
    });

    it('should return empty stats when no pools', () => {
      const stats = service.getPoolStats();
      expect(stats).toHaveLength(0);
    });
  });

  describe('Submit keys handling', () => {
    it('should use provided submitKeys', async () => {
      await service.enqueue('agent-1', 'Message', {
        source: 'test',
        submitKeys: ['Tab', 'Enter'],
      });

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        'Message',
        expect.objectContaining({ submitKeys: ['Tab', 'Enter'] }),
      );
    });

    it('should use last message submitKeys for batch', async () => {
      await service.enqueue('agent-1', 'Message 1', {
        source: 'test',
        submitKeys: ['Tab'],
      });
      await service.enqueue('agent-1', 'Message 2', {
        source: 'test',
        submitKeys: ['Enter'],
      });

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        expect.any(String),
        expect.objectContaining({ submitKeys: ['Enter'] }),
      );
    });

    it('should default to Enter key', async () => {
      await service.enqueue('agent-1', 'Message', { source: 'test' });

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        'Message',
        expect.objectContaining({ submitKeys: ['Enter'] }),
      );
    });
  });

  describe('flushNow', () => {
    it('should immediately flush a specific agent pool', async () => {
      await service.enqueue('agent-1', 'Message', { source: 'test' });

      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      await service.flushNow('agent-1');

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });

    it('should do nothing if agent has no pool', async () => {
      await service.flushNow('non-existent-agent');

      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();
    });

    it('should clear timers when flushing', async () => {
      await service.enqueue('agent-1', 'Message', { source: 'test' });

      await service.flushNow('agent-1');

      // Advance time - no additional flush should occur
      await jest.advanceTimersByTimeAsync(20000);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });

    it('should return success result with delivered count on successful flush', async () => {
      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await service.enqueue('agent-1', 'Message 2', { source: 'test' });

      const result = await service.flushNow('agent-1');

      expect(result.success).toBe(true);
      expect(result.deliveredCount).toBe(2);
      expect(result.discardedCount).toBeUndefined();
      expect(result.reason).toBeUndefined();
    });

    it('should return failure result when no active session', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await service.enqueue('agent-1', 'Message 2', { source: 'test' });

      const result = await service.flushNow('agent-1');

      expect(result.success).toBe(false);
      expect(result.discardedCount).toBe(2);
      expect(result.reason).toBe('No active session');
      expect(result.deliveredCount).toBeUndefined();
    });

    it('should return success result with zero count for empty pool', async () => {
      const result = await service.flushNow('non-existent-agent');

      expect(result.success).toBe(true);
      expect(result.deliveredCount).toBe(0);
    });

    it('should return failure result when tmux paste fails', async () => {
      mockTmux.pasteAndSubmit.mockRejectedValue(new Error('Tmux connection failed'));

      await service.enqueue('agent-1', 'Message', { source: 'test' });

      const result = await service.flushNow('agent-1');

      expect(result.success).toBe(false);
      expect(result.discardedCount).toBe(1);
      expect(result.reason).toBe('Tmux connection failed');
    });
  });

  describe('Message logging', () => {
    it('should create log entry when message is enqueued', async () => {
      await service.enqueue('agent-1', 'Test message', {
        source: 'test.source',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      const log = service.getMessageLog();
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        agentId: 'agent-1',
        text: 'Test message',
        source: 'test.source',
        projectId: 'project-1',
        agentName: 'Test Agent',
        status: 'queued',
        immediate: false,
      });
      expect(log[0].id).toBeDefined();
      expect(log[0].timestamp).toBeDefined();
    });

    it('should update log entry to delivered on successful flush', async () => {
      await service.enqueue('agent-1', 'Test message', { source: 'test' });
      await service.flushNow('agent-1');

      const log = service.getMessageLog();
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe('delivered');
      expect(log[0].deliveredAt).toBeDefined();
      expect(log[0].batchId).toBeDefined();
    });

    it('should set same batchId for messages flushed together', async () => {
      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await service.enqueue('agent-1', 'Message 2', { source: 'test' });
      await service.flushNow('agent-1');

      const log = service.getMessageLog();
      expect(log).toHaveLength(2);
      expect(log[0].batchId).toBe(log[1].batchId);
      expect(log[0].batchId).toBeDefined();
    });

    it('should update log entry to failed when delivery fails', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      await service.enqueue('agent-1', 'Test message', { source: 'test' });
      await service.flushNow('agent-1');

      const log = service.getMessageLog();
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe('failed');
      expect(log[0].error).toBe('No active session');
      expect(log[0].batchId).toBeDefined();
    });

    it('should track immediate messages', async () => {
      await service.enqueue('agent-1', 'Immediate message', {
        source: 'test',
        immediate: true,
      });

      const log = service.getMessageLog();
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe('delivered');
      expect(log[0].immediate).toBe(true);
      expect(log[0].deliveredAt).toBeDefined();
    });

    it('should track failed immediate messages', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      await service.enqueue('agent-1', 'Immediate message', {
        source: 'test',
        immediate: true,
      });

      const log = service.getMessageLog();
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe('failed');
      expect(log[0].immediate).toBe(true);
      expect(log[0].error).toBeDefined();
    });

    it('should filter log by projectId', async () => {
      await service.enqueue('agent-1', 'Message 1', {
        source: 'test',
        projectId: 'project-1',
      });
      await service.enqueue('agent-1', 'Message 2', {
        source: 'test',
        projectId: 'project-2',
      });

      const filtered = service.getMessageLog({ projectId: 'project-1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].projectId).toBe('project-1');
    });

    it('should filter log by agentId', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        createActiveSession('agent-1'),
        createActiveSession('agent-2', 'tmux-2'),
      ]);

      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await service.enqueue('agent-2', 'Message 2', { source: 'test' });

      const filtered = service.getMessageLog({ agentId: 'agent-1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].agentId).toBe('agent-1');
    });

    it('should filter log by status', async () => {
      await service.enqueue('agent-1', 'Pooled message', { source: 'test' });
      await service.enqueue('agent-1', 'Immediate message', {
        source: 'test',
        immediate: true,
      });

      const queued = service.getMessageLog({ status: 'queued' });
      expect(queued).toHaveLength(1);
      expect(queued[0].text).toBe('Pooled message');

      const delivered = service.getMessageLog({ status: 'delivered' });
      expect(delivered).toHaveLength(1);
      expect(delivered[0].text).toBe('Immediate message');
    });

    it('should filter log by source', async () => {
      await service.enqueue('agent-1', 'Epic message', {
        source: 'epic.assigned',
        immediate: true,
      });
      await service.enqueue('agent-1', 'Chat message', {
        source: 'chat.message',
        immediate: true,
      });

      const epicMessages = service.getMessageLog({ source: 'epic.assigned' });
      expect(epicMessages).toHaveLength(1);
      expect(epicMessages[0].text).toBe('Epic message');

      const chatMessages = service.getMessageLog({ source: 'chat.message' });
      expect(chatMessages).toHaveLength(1);
      expect(chatMessages[0].text).toBe('Chat message');
    });

    it('should limit log results', async () => {
      await service.enqueue('agent-1', 'Message 1', {
        source: 'test',
        immediate: true,
      });
      await service.enqueue('agent-1', 'Message 2', {
        source: 'test',
        immediate: true,
      });
      await service.enqueue('agent-1', 'Message 3', {
        source: 'test',
        immediate: true,
      });

      const limited = service.getMessageLog({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('should return log in newest-first order', async () => {
      await service.enqueue('agent-1', 'First', { source: 'test', immediate: true });
      await service.enqueue('agent-1', 'Second', { source: 'test', immediate: true });
      await service.enqueue('agent-1', 'Third', { source: 'test', immediate: true });

      const log = service.getMessageLog();
      expect(log[0].text).toBe('Third');
      expect(log[1].text).toBe('Second');
      expect(log[2].text).toBe('First');
    });

    it('should resolve project info from storage when not provided', async () => {
      mockStorage.getAgent.mockResolvedValue(
        createMockAgent({ name: 'Storage Agent', projectId: 'storage-project' }),
      );

      await service.enqueue('agent-1', 'Test message', { source: 'test' });

      const log = service.getMessageLog();
      expect(log[0].agentName).toBe('Storage Agent');
      expect(log[0].projectId).toBe('storage-project');
      expect(mockStorage.getAgent).toHaveBeenCalledWith('agent-1');
    });

    it('should use provided project info over storage lookup', async () => {
      await service.enqueue('agent-1', 'Test message', {
        source: 'test',
        projectId: 'provided-project',
        agentName: 'Provided Agent',
      });

      const log = service.getMessageLog();
      expect(log[0].agentName).toBe('Provided Agent');
      expect(log[0].projectId).toBe('provided-project');
      expect(mockStorage.getAgent).not.toHaveBeenCalled();
    });

    it('should handle storage lookup failure gracefully', async () => {
      mockStorage.getAgent.mockRejectedValue(new Error('Agent not found'));

      await service.enqueue('agent-1', 'Test message', { source: 'test' });

      const log = service.getMessageLog();
      expect(log[0].agentName).toBe('unknown');
      expect(log[0].projectId).toBe('unknown');
    });

    describe('getLogStats', () => {
      it('should return correct log statistics', async () => {
        await service.enqueue('agent-1', 'Hello world', {
          source: 'test',
          immediate: true,
        });

        const stats = service.getLogStats();
        expect(stats.entryCount).toBe(1);
        expect(stats.bytesUsed).toBe(11); // "Hello world".length
        expect(stats.maxEntries).toBe(500);
        expect(stats.maxBytes).toBe(2 * 1024 * 1024);
      });

      it('should return zero stats for empty log', () => {
        const stats = service.getLogStats();
        expect(stats.entryCount).toBe(0);
        expect(stats.bytesUsed).toBe(0);
      });
    });

    describe('getMessageById', () => {
      it('should return message when found', async () => {
        await service.enqueue('agent-1', 'Test message', {
          source: 'test',
          immediate: true,
        });

        const log = service.getMessageLog();
        const messageId = log[0].id;

        const result = service.getMessageById(messageId);
        expect(result).not.toBeNull();
        expect(result!.id).toBe(messageId);
        expect(result!.text).toBe('Test message');
      });

      it('should return null when message not found', () => {
        const result = service.getMessageById('non-existent-id');
        expect(result).toBeNull();
      });

      it('should return null for invalid UUID', () => {
        const result = service.getMessageById('invalid-uuid');
        expect(result).toBeNull();
      });
    });

    describe('pruning', () => {
      it('should protect queued entries from pruning', async () => {
        // Configure very small limits to trigger pruning
        service.configure({ maxMessages: 100, delayMs: 10000, maxWaitMs: 30000 });

        // Enqueue messages that stay queued (not flushed)
        await service.enqueue('agent-1', 'Queued message 1', {
          source: 'test',
          projectId: 'project-1',
          agentName: 'Test Agent',
        });
        await service.enqueue('agent-1', 'Queued message 2', {
          source: 'test',
          projectId: 'project-1',
          agentName: 'Test Agent',
        });

        // Flush to mark as delivered
        await jest.advanceTimersByTimeAsync(10001);

        // Now the messages are delivered, add a new queued one
        await service.enqueue('agent-2', 'New queued message', {
          source: 'test',
          projectId: 'project-1',
          agentName: 'Agent 2',
        });

        // Get the log - should contain both delivered and queued
        const log = service.getMessageLog();
        const queuedMessages = log.filter((m) => m.status === 'queued');
        const deliveredMessages = log.filter((m) => m.status === 'delivered');

        expect(queuedMessages.length).toBe(1);
        expect(deliveredMessages.length).toBe(2);
        expect(queuedMessages[0].text).toBe('New queued message');
      });

      it('should remove delivered entries before queued when pruning', async () => {
        // Enqueue and flush to create delivered entries
        await service.enqueue('agent-1', 'Will be delivered', {
          source: 'test',
          projectId: 'project-1',
          agentName: 'Test Agent',
        });
        await jest.advanceTimersByTimeAsync(10001);

        // Now entries are delivered
        let log = service.getMessageLog();
        expect(log[0].status).toBe('delivered');

        // Enqueue new message (queued)
        await service.enqueue('agent-2', 'Stays queued', {
          source: 'test',
          projectId: 'project-1',
          agentName: 'Agent 2',
        });

        log = service.getMessageLog();
        const queuedEntry = log.find((m) => m.status === 'queued');
        expect(queuedEntry).toBeDefined();
        expect(queuedEntry!.text).toBe('Stays queued');
      });

      it('should correctly update byte count after pruning', async () => {
        // Add a message and flush it
        const message1 = 'First message for byte test';
        await service.enqueue('agent-1', message1, {
          source: 'test',
          projectId: 'project-1',
          agentName: 'Test Agent',
        });
        await jest.advanceTimersByTimeAsync(10001);

        const statsAfterFirst = service.getLogStats();
        expect(statsAfterFirst.bytesUsed).toBe(message1.length);

        // Add another message
        const message2 = 'Second message';
        await service.enqueue('agent-1', message2, {
          source: 'test',
          projectId: 'project-1',
          agentName: 'Test Agent',
        });
        await jest.advanceTimersByTimeAsync(10001);

        const statsAfterSecond = service.getLogStats();
        expect(statsAfterSecond.bytesUsed).toBe(message1.length + message2.length);
      });

      it('should not over-prune when one removal is sufficient', async () => {
        // Add and flush multiple messages
        for (let i = 0; i < 5; i++) {
          await service.enqueue('agent-1', `Message ${i}`, {
            source: 'test',
            projectId: 'project-1',
            agentName: 'Test Agent',
          });
        }
        await jest.advanceTimersByTimeAsync(10001);

        // All 5 messages should be in the log
        let log = service.getMessageLog();
        expect(log.length).toBe(5);

        // Add one more - should not trigger pruning since we're well under limits
        await service.enqueue('agent-2', 'One more', {
          source: 'test',
          projectId: 'project-1',
          agentName: 'Agent 2',
        });

        log = service.getMessageLog();
        expect(log.length).toBe(6);
      });
    });
  });

  describe('getPoolDetails', () => {
    it('should return empty array when no pools exist', () => {
      const details = service.getPoolDetails();
      expect(details).toHaveLength(0);
    });

    it('should return pool details with message previews', async () => {
      await service.enqueue('agent-1', 'Hello world', {
        source: 'test.source',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      const details = service.getPoolDetails();
      expect(details).toHaveLength(1);
      expect(details[0]).toMatchObject({
        agentId: 'agent-1',
        agentName: 'Test Agent',
        projectId: 'project-1',
        messageCount: 1,
      });
      expect(details[0].waitingMs).toBeGreaterThanOrEqual(0);
      expect(details[0].messages).toHaveLength(1);
      expect(details[0].messages[0]).toMatchObject({
        preview: 'Hello world',
        source: 'test.source',
      });
    });

    it('should truncate long messages to 100 chars with ellipsis', async () => {
      const longText = 'A'.repeat(150);
      await service.enqueue('agent-1', longText, {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      const details = service.getPoolDetails();
      expect(details[0].messages[0].preview).toBe('A'.repeat(100) + '...');
    });

    it('should not add ellipsis for messages exactly 100 chars', async () => {
      const exactText = 'B'.repeat(100);
      await service.enqueue('agent-1', exactText, {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      const details = service.getPoolDetails();
      expect(details[0].messages[0].preview).toBe(exactText);
    });

    it('should filter by projectId', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        createActiveSession('agent-1'),
        createActiveSession('agent-2', 'tmux-2'),
      ]);

      await service.enqueue('agent-1', 'Message 1', {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Agent 1',
      });
      await service.enqueue('agent-2', 'Message 2', {
        source: 'test',
        projectId: 'project-2',
        agentName: 'Agent 2',
      });

      const filtered = service.getPoolDetails('project-1');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].agentId).toBe('agent-1');
      expect(filtered[0].projectId).toBe('project-1');
    });

    it('should return all pools when no projectId filter', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        createActiveSession('agent-1'),
        createActiveSession('agent-2', 'tmux-2'),
      ]);

      await service.enqueue('agent-1', 'Message 1', {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Agent 1',
      });
      await service.enqueue('agent-2', 'Message 2', {
        source: 'test',
        projectId: 'project-2',
        agentName: 'Agent 2',
      });

      const all = service.getPoolDetails();
      expect(all).toHaveLength(2);
    });

    it('should sort by waitingMs descending (longest waiting first)', async () => {
      jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

      mockSessionsService.listActiveSessions.mockResolvedValue([
        createActiveSession('agent-1'),
        createActiveSession('agent-2', 'tmux-2'),
      ]);

      await service.enqueue('agent-1', 'First message', {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Agent 1',
      });

      jest.setSystemTime(new Date('2025-01-01T00:00:05.000Z'));

      await service.enqueue('agent-2', 'Second message', {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Agent 2',
      });

      const details = service.getPoolDetails();
      expect(details).toHaveLength(2);
      // agent-1 has been waiting longer (5 seconds more)
      expect(details[0].agentId).toBe('agent-1');
      expect(details[1].agentId).toBe('agent-2');
      expect(details[0].waitingMs).toBeGreaterThan(details[1].waitingMs);
    });

    it('should include all messages in pool', async () => {
      await service.enqueue('agent-1', 'Message 1', {
        source: 'source-1',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });
      await service.enqueue('agent-1', 'Message 2', {
        source: 'source-2',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      const details = service.getPoolDetails();
      expect(details).toHaveLength(1);
      expect(details[0].messageCount).toBe(2);
      expect(details[0].messages).toHaveLength(2);
      expect(details[0].messages[0].preview).toBe('Message 1');
      expect(details[0].messages[1].preview).toBe('Message 2');
    });

    it('should return empty after pool is flushed', async () => {
      await service.enqueue('agent-1', 'Test', {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      expect(service.getPoolDetails()).toHaveLength(1);

      await service.flushNow('agent-1');

      expect(service.getPoolDetails()).toHaveLength(0);
    });

    it('should not affect getPoolStats() (backward compatibility)', async () => {
      await service.enqueue('agent-1', 'Test message', {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      const stats = service.getPoolStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]).toEqual({
        agentId: 'agent-1',
        messageCount: 1,
        waitingMs: expect.any(Number),
      });
      // getPoolStats should NOT have agentName, projectId, or messages
      expect((stats[0] as Record<string, unknown>).agentName).toBeUndefined();
      expect((stats[0] as Record<string, unknown>).projectId).toBeUndefined();
      expect((stats[0] as Record<string, unknown>).messages).toBeUndefined();
    });
  });

  describe('Activity stream broadcasting', () => {
    it('should broadcast enqueued when message is added to pool', async () => {
      await service.enqueue('agent-1', 'Test message', {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      expect(mockActivityStream.broadcastEnqueued).toHaveBeenCalledTimes(1);
      expect(mockActivityStream.broadcastEnqueued).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          text: 'Test message',
          status: 'queued',
        }),
      );
    });

    it('should broadcast pools updated when message is enqueued', async () => {
      await service.enqueue('agent-1', 'Test message', {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });

      expect(mockActivityStream.broadcastPoolsUpdated).toHaveBeenCalled();
    });

    it('should broadcast delivered when messages are flushed successfully', async () => {
      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await service.enqueue('agent-1', 'Message 2', { source: 'test' });
      mockActivityStream.broadcastEnqueued.mockClear();
      mockActivityStream.broadcastPoolsUpdated.mockClear();

      await service.flushNow('agent-1');

      expect(mockActivityStream.broadcastDelivered).toHaveBeenCalledTimes(1);
      expect(mockActivityStream.broadcastDelivered).toHaveBeenCalledWith(
        expect.any(String), // batchId
        expect.arrayContaining([
          expect.objectContaining({ text: 'Message 1', status: 'delivered' }),
          expect.objectContaining({ text: 'Message 2', status: 'delivered' }),
        ]),
      );
    });

    it('should broadcast pools updated after flush', async () => {
      await service.enqueue('agent-1', 'Test', { source: 'test' });
      mockActivityStream.broadcastPoolsUpdated.mockClear();

      await service.flushNow('agent-1');

      expect(mockActivityStream.broadcastPoolsUpdated).toHaveBeenCalled();
    });

    it('should broadcast failed when delivery fails', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      await service.enqueue('agent-1', 'Test message', { source: 'test' });
      mockActivityStream.broadcastEnqueued.mockClear();

      await service.flushNow('agent-1');

      expect(mockActivityStream.broadcastFailed).toHaveBeenCalled();
      expect(mockActivityStream.broadcastFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Test message',
          status: 'failed',
          error: 'No active session',
        }),
      );
    });

    it('should broadcast delivered for immediate messages', async () => {
      await service.enqueue('agent-1', 'Immediate message', {
        source: 'test',
        immediate: true,
      });

      expect(mockActivityStream.broadcastDelivered).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({
            text: 'Immediate message',
            status: 'delivered',
            immediate: true,
          }),
        ]),
      );
    });

    it('should broadcast failed for failed immediate messages', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      await service.enqueue('agent-1', 'Immediate message', {
        source: 'test',
        immediate: true,
      });

      expect(mockActivityStream.broadcastFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Immediate message',
          status: 'failed',
          immediate: true,
        }),
      );
    });
  });

  describe('Config hot-reload', () => {
    it('should detect config changes and update pool config', async () => {
      // Initial config
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      // First enqueue creates pool with initial config
      await service.enqueue('agent-1', 'Message 1', { source: 'test', projectId: 'project-1' });

      // Change config
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 5000, // Changed
        maxWaitMs: 15000, // Changed
        maxMessages: 5, // Changed
        separator: '\n===\n', // Changed
      });

      // Second enqueue should detect config change
      await service.enqueue('agent-1', 'Message 2', { source: 'test', projectId: 'project-1' });

      // Advance by new delayMs (5000), should flush
      await jest.advanceTimersByTimeAsync(5000);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      // Should use new separator
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        'Message 1\n===\nMessage 2',
        expect.any(Object),
      );
    });

    it('should reset debounce timer when config changes', async () => {
      // Initial config with 10s delay
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 1', { source: 'test', projectId: 'project-1' });

      // Wait 4 seconds
      await jest.advanceTimersByTimeAsync(4000);

      // Change config to shorter delay
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 3000, // Shorter delay
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      // Second message triggers config change and timer reset
      await service.enqueue('agent-1', 'Message 2', { source: 'test', projectId: 'project-1' });

      // Wait 3 seconds (new delayMs) - should flush now
      await jest.advanceTimersByTimeAsync(3000);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });

    it('should recalculate max-wait timer based on elapsed time', async () => {
      jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

      // Initial config with 30s max wait
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 60000, // Long delay so debounce doesn't trigger
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 1', { source: 'test', projectId: 'project-1' });

      // Wait 20 seconds
      await jest.advanceTimersByTimeAsync(20000);

      // Change max wait to 25 seconds - only 5 seconds should remain
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 60000,
        maxWaitMs: 25000, // 25 seconds total, 20 already elapsed = 5 remaining
        maxMessages: 10,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 2', { source: 'test', projectId: 'project-1' });

      // Should not have flushed yet
      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      // Wait 5 more seconds (remaining max wait time)
      await jest.advanceTimersByTimeAsync(5000);

      // Now should have flushed due to recalculated max wait
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });

    it('should flush immediately if max-wait already exceeded after config change', async () => {
      jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

      // Initial config with 30s max wait
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 60000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 1', { source: 'test', projectId: 'project-1' });

      // Wait 25 seconds
      await jest.advanceTimersByTimeAsync(25000);

      // Change max wait to 20 seconds - already exceeded!
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 60000,
        maxWaitMs: 20000, // 20 seconds, but 25 already elapsed
        maxMessages: 10,
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 2', { source: 'test', projectId: 'project-1' });

      // Should flush immediately since max wait already exceeded
      // Need to let the async flush complete
      await jest.advanceTimersByTimeAsync(0);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        'Message 1\n---\nMessage 2',
        expect.any(Object),
      );
      expect(service.getPoolStats()).toHaveLength(0);
    });

    it('should flush when maxMessages is reduced below current count', async () => {
      // Initial config with maxMessages=10
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      // Add 4 messages
      await service.enqueue('agent-1', 'Message 1', { source: 'test', projectId: 'project-1' });
      await service.enqueue('agent-1', 'Message 2', { source: 'test', projectId: 'project-1' });
      await service.enqueue('agent-1', 'Message 3', { source: 'test', projectId: 'project-1' });
      await service.enqueue('agent-1', 'Message 4', { source: 'test', projectId: 'project-1' });

      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      // Change maxMessages to 3 (below current count of 4)
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 3, // Now 4 messages >= 3
        separator: '\n---\n',
      });

      // Add 5th message - should trigger flush due to count >= new maxMessages
      const result = await service.enqueue('agent-1', 'Message 5', {
        source: 'test',
        projectId: 'project-1',
      });

      expect(result.status).toBe('delivered');
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });

    it('should not reset timers if config has not changed', async () => {
      // Same config throughout
      const config = {
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      };
      mockSettings.getMessagePoolConfigForProject.mockReturnValue(config);

      await service.enqueue('agent-1', 'Message 1', { source: 'test', projectId: 'project-1' });

      // Wait 5 seconds
      await jest.advanceTimersByTimeAsync(5000);

      // Second message with same config - debounce resets but max-wait timer unchanged
      await service.enqueue('agent-1', 'Message 2', { source: 'test', projectId: 'project-1' });

      // Wait 10 more seconds (full delayMs from second message)
      await jest.advanceTimersByTimeAsync(10000);

      // Should flush at this point (debounce from second message)
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('Per-project pool configuration', () => {
    it('should use project-specific config for pool timers', async () => {
      // Configure project-specific settings with shorter delays
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 5000, // Shorter than global 10000
        maxWaitMs: 15000, // Shorter than global 30000
        maxMessages: 5, // Smaller than global 10
        separator: '\n===\n',
      });

      await service.enqueue('agent-1', 'Message 1', {
        source: 'test',
        projectId: 'project-custom',
      });

      // Verify project config was fetched
      expect(mockSettings.getMessagePoolConfigForProject).toHaveBeenCalledWith('project-custom');

      // Should not flush yet (under maxMessages=5)
      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      // Advance by project-specific delayMs (5000)
      await jest.advanceTimersByTimeAsync(5000);

      // Should have flushed using project config delay
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalled();
    });

    it('should flush at project-specific maxMessages threshold', async () => {
      // Configure project-specific maxMessages=3
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 3, // Lower threshold
        separator: '\n---\n',
      });

      await service.enqueue('agent-1', 'Message 1', {
        source: 'test',
        projectId: 'project-custom',
      });
      await service.enqueue('agent-1', 'Message 2', {
        source: 'test',
        projectId: 'project-custom',
      });

      // Not yet at threshold
      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      // Third message should trigger flush (maxMessages=3)
      await service.enqueue('agent-1', 'Message 3', {
        source: 'test',
        projectId: 'project-custom',
      });

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalled();
    });

    it('should use project-specific separator when flushing', async () => {
      // Configure project-specific separator
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n===CUSTOM===\n', // Custom separator
      });

      await service.enqueue('agent-1', 'Message 1', {
        source: 'test',
        projectId: 'project-custom',
      });
      await service.enqueue('agent-1', 'Message 2', {
        source: 'test',
        projectId: 'project-custom',
      });

      // Trigger flush via timer
      await jest.advanceTimersByTimeAsync(10000);

      // Verify custom separator was used
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-1',
        'Message 1\n===CUSTOM===\nMessage 2',
        expect.any(Object),
      );
    });

    it('should disable pooling when project config has enabled=false', async () => {
      // Configure project-specific pooling disabled
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: false, // Disabled for this project
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });

      const result = await service.enqueue('agent-1', 'Message', {
        source: 'test',
        projectId: 'project-no-pool',
      });

      // Should be delivered immediately (bypassing pool)
      expect(result.status).toBe('delivered');
      expect(mockTmux.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });

    it('should fall back to global config when project config fails', async () => {
      // Make project config lookup throw
      mockSettings.getMessagePoolConfigForProject.mockImplementation(() => {
        throw new Error('Config lookup failed');
      });

      await service.enqueue('agent-1', 'Message', {
        source: 'test',
        projectId: 'project-error',
      });

      // Should still work using global config
      expect(mockTmux.pasteAndSubmit).not.toHaveBeenCalled();

      // Advance by global delayMs (10000)
      await jest.advanceTimersByTimeAsync(10000);

      expect(mockTmux.pasteAndSubmit).toHaveBeenCalled();
    });

    it('should resolve projectId from storage when not provided', async () => {
      mockStorage.getAgent.mockResolvedValue(createMockAgent({ projectId: 'resolved-project-id' }));

      await service.enqueue('agent-1', 'Message', { source: 'test' });

      // Should have looked up project config with resolved projectId
      expect(mockSettings.getMessagePoolConfigForProject).toHaveBeenCalledWith(
        'resolved-project-id',
      );
    });
  });
});
