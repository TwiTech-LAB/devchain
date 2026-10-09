/**
 * Layer: backend unit. Direct collaborators and fake timers are the cheapest reliable
 * boundary for lane mutation order, exact-session fencing, and flush isolation.
 */
const mockLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => mockLogger,
}));

import { SessionsMessagePoolService } from './sessions-message-pool.service';
import type { SessionsService } from './sessions.service';
import type { SessionCoordinatorService } from './session-coordinator.service';
import type { MessageActivityStreamService } from './message-activity-stream.service';
import type { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import type { SettingsService } from '../../settings/services/settings.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { IOError } from '../../../common/errors/error-types';
import type { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { MessageLogService } from './message-log.service';
import { DeliveryFailureNotifierService } from './delivery-failure-notifier.service';
import { HumanPromptStateService } from '../../terminal/services/human-prompt-state.service';
import { createMockAgent as createAgentFixture } from '../../../../test/factories';

describe('SessionsMessagePoolService', () => {
  let service: SessionsMessagePoolService;
  let mockSessionsService: jest.Mocked<
    Pick<SessionsService, 'listActiveSessions' | 'getActiveSessionForAgent' | 'getSession'>
  >;
  let mockCoordinator: jest.Mocked<Pick<SessionCoordinatorService, 'withAgentLock'>>;
  let mockTerminalIO: jest.Mocked<
    Pick<TerminalIOService, 'deliver' | 'deliverImmediate' | 'deliverGuarded' | 'sendControl'>
  >;
  let mockSettings: jest.Mocked<
    Pick<SettingsService, 'getMessagePoolConfig' | 'getMessagePoolConfigForProject'>
  >;
  let mockStorage: jest.Mocked<Pick<StorageService, 'getAgent'>>;
  let mockActivityStream: jest.Mocked<MessageActivityStreamService>;
  let mockProviderAdapterFactory: jest.Mocked<
    Pick<ProviderAdapterFactory, 'getRuntimePromptBehaviorForAgent'>
  >;
  let humanPromptState: HumanPromptStateService;

  const createMockAgent = (overrides: { id?: string; name?: string; projectId?: string } = {}) =>
    createAgentFixture({
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
    lastActivityAt: null,
    activityState: 'busy' as const,
    busySince: new Date().toISOString(),
    transcriptPath: null,
    name: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    jest.useFakeTimers();

    const activeSession = createActiveSession('agent-1');
    mockSessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([activeSession]),
      getActiveSessionForAgent: jest.fn().mockReturnValue(activeSession),
      getSession: jest
        .fn()
        .mockImplementation((sessionId) => (sessionId === activeSession.id ? activeSession : null)),
    };

    mockCoordinator = {
      withAgentLock: jest.fn().mockImplementation(async (_agentId, fn) => fn()),
    };

    mockTerminalIO = {
      deliver: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'abc1234', retryCount: 0 }),
      deliverImmediate: jest
        .fn()
        .mockResolvedValue({ confirmed: true, nonce: 'abc1234', retryCount: 0 }),
      deliverGuarded: jest
        .fn()
        .mockImplementation(async (_target, _text, _options, _snapshot, mutationFence) => {
          if (mutationFence && !mutationFence.canStartMutation()) {
            return { deferred: 'human_draft' };
          }
          mutationFence?.markMutationStarted();
          return { confirmed: true, nonce: 'abc1234', retryCount: 0 };
        }),
      sendControl: jest.fn().mockResolvedValue(undefined),
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
      broadcastUnconfirmed: jest.fn(),
      broadcastFailed: jest.fn(),
      broadcastPoolsUpdated: jest.fn(),
    } as unknown as jest.Mocked<MessageActivityStreamService>;

    mockProviderAdapterFactory = {
      // A Claude agent unless a test says otherwise: the provider that gets the follow note.
      getRuntimePromptBehaviorForAgent: jest.fn().mockResolvedValue({ followNote: true }),
    };

    const mockMessageLog = new MessageLogService();
    const mockFailureNotifier = {
      notifySendersOfFailure: jest.fn().mockResolvedValue(undefined),
    } as unknown as DeliveryFailureNotifierService;
    humanPromptState = new HumanPromptStateService();

    service = new SessionsMessagePoolService(
      mockSessionsService as unknown as SessionsService,
      mockCoordinator as unknown as SessionCoordinatorService,
      mockTerminalIO as unknown as TerminalIOService,
      mockSettings as unknown as SettingsService,
      mockStorage as unknown as StorageService,
      mockActivityStream,
      mockProviderAdapterFactory as unknown as ProviderAdapterFactory,
      mockMessageLog,
      mockFailureNotifier,
      humanPromptState,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('Debounce behavior', () => {
    // Module-unit: fake timers and a rejected public flush expose rejection handling without terminal I/O.
    it.each([
      { timer: 'max-wait', protectedInput: false },
      { timer: 'debounce', protectedInput: false },
      { timer: 'max-wait', protectedInput: true },
      { timer: 'debounce', protectedInput: true },
    ])(
      'logs a rejected $timer flush for protectedInput=$protectedInput',
      async ({ timer, protectedInput }) => {
        mockSettings.getMessagePoolConfigForProject.mockReturnValue({
          enabled: true,
          delayMs: timer === 'debounce' ? 100 : 1000,
          maxWaitMs: timer === 'max-wait' ? 100 : 1000,
          maxMessages: 10,
          separator: '\n---\n',
        });
        const error = new Error('flush rejected with provider details');
        const flush = jest.spyOn(service, 'flushNow').mockRejectedValueOnce(error);
        await service.enqueue('agent-1', 'Message', {
          source: 'test',
          deferWhileHumanTyping: protectedInput,
          failureDisclosure: protectedInput ? 'project-safe' : 'legacy',
        });

        await jest.advanceTimersByTimeAsync(100);

        expect(flush).toHaveBeenCalledTimes(1);
        expect(mockLogger.error).toHaveBeenCalledWith(
          { agentId: 'agent-1', error: protectedInput ? 'DELIVERY_FAILED' : error },
          timer === 'max-wait' ? 'Max wait flush failed' : 'Debounce flush failed',
        );
      },
    );

    it('should reset timer on each enqueue', async () => {
      await service.enqueue('agent-1', 'Message 1', { source: 'test' });
      await jest.advanceTimersByTimeAsync(5000);

      // Add another message - should reset the timer
      await service.enqueue('agent-1', 'Message 2', { source: 'test' });
      await jest.advanceTimersByTimeAsync(5000);

      // Not yet delivered (timer reset)
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

      // Advance past the debounce delay
      await jest.advanceTimersByTimeAsync(5001);

      // Now should be delivered
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      expect(mockTerminalIO.deliver).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        expect.stringContaining('Message 1'),
        expect.any(Object),
      );
      expect(mockTerminalIO.deliver).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        expect.stringContaining('Message 2'),
        expect.any(Object),
      );
    });

    it('should flush after delayMs with no new messages', async () => {
      await service.enqueue('agent-1', 'Single message', { source: 'test' });

      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      expect(mockTerminalIO.deliver).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        expect.stringContaining('Single message'),
        expect.objectContaining({ agentId: 'agent-1', followNote: true }),
      );
    });

    it.each(['batch', 'immediate', 'disabled'] as const)(
      'omits the follow note for outside text in %s delivery',
      async (mode) => {
        if (mode === 'disabled')
          mockSettings.getMessagePoolConfigForProject.mockReturnValue({
            enabled: false,
            delayMs: 10000,
            maxWaitMs: 30000,
            maxMessages: 10,
            separator: '\n---\n',
          });
        if (mode === 'batch') await service.enqueue('agent-1', 'From an agent', { source: 'test' });
        await service.enqueue('agent-1', 'From a guest', {
          source: 'test',
          outsideText: true,
          immediate: mode === 'immediate',
        });
        if (mode === 'batch') await jest.advanceTimersByTimeAsync(10001);
        const deliver =
          mode === 'immediate' ? mockTerminalIO.deliverImmediate : mockTerminalIO.deliver;
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(deliver.mock.calls[0][1]).toContain('From a guest');
        expect(deliver.mock.calls[0][2]).toHaveProperty('followNote', false);
      },
    );

    it("types no follow note when the agent's provider does not use it", async () => {
      mockProviderAdapterFactory.getRuntimePromptBehaviorForAgent.mockResolvedValue({});

      await service.enqueue('agent-1', 'Single message', { source: 'test' });
      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      expect(mockTerminalIO.deliver.mock.calls[0][2]).toHaveProperty('followNote', false);
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
      expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledTimes(1);

      const [target, calledText, calledOpts] = mockTerminalIO.deliverImmediate.mock.calls[0];
      expect(target).toEqual({ name: 'tmux-1' });
      expect(calledText).toContain('Urgent message');
      expect(calledOpts).toHaveProperty('confirm', false);
      expect(calledOpts).toHaveProperty('followNote', true);

      const log = service.getMessageLog();
      expect(log).toHaveLength(1);
      expect(log[0].immediate).toBe(true);
      expect(log[0].status).toBe('delivered');
      expect(log[0].deliveredAt).toBeDefined();
      expect(log[0].failureCode).toBeUndefined();
      expect(log[0].retryCount).toBe(0);
      expect(mockActivityStream.broadcastUnconfirmed).not.toHaveBeenCalled();
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
      expect(mockTerminalIO.deliverImmediate).not.toHaveBeenCalled();
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      expect(mockTerminalIO.deliver.mock.calls[0][2]).toHaveProperty('followNote', true);
    });

    it('should return failed status when immediate delivery fails', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      const result = await service.enqueue('agent-1', 'Message', {
        source: 'test',
        immediate: true,
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('No active session');
      expect(service.getMessageLog()).toEqual([
        expect.objectContaining({
          status: 'failed',
          immediate: true,
          error: expect.stringContaining('No active session'),
        }),
      ]);
    });

    it('classifies protected immediate failures without retaining provider details', async () => {
      const rawError = 'provider failed at /private/source/project';
      mockTerminalIO.deliverImmediate.mockRejectedValue(new Error(rawError));

      const result = await service.enqueue('agent-1', 'Message', {
        source: 'mcp.send_message',
        immediate: true,
        failureDisclosure: 'project-safe',
      });

      expect(result).toMatchObject({ status: 'failed', error: 'DELIVERY_FAILED' });
      expect(service.getMessageLog()[0]).toMatchObject({
        status: 'failed',
        error: 'DELIVERY_FAILED',
        failureCode: 'project_delivery_failed',
      });
      expect(mockActivityStream.broadcastFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'DELIVERY_FAILED',
          failureCode: 'project_delivery_failed',
        }),
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(rawError);
    });

    it('should use deliver for pooled delivery via batch', async () => {
      await service.enqueue('agent-1', 'Pooled message', { source: 'test' });
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

      await service.flushNow('agent-1');

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      const [target, calledText] = mockTerminalIO.deliver.mock.calls[0];
      expect(target).toEqual({ name: 'tmux-1' });
      expect(calledText).toContain('Pooled message');
    });
  });

  describe('Delivery modes and exact-session idle lanes', () => {
    it('resolves valid explicit modes before the legacy immediate flag', async () => {
      const queued = await service.enqueue('agent-1', 'Explicit default', {
        source: 'test',
        deliveryMode: 'default',
        immediate: true,
      });

      expect(queued.status).toBe('queued');
      expect(mockTerminalIO.deliverImmediate).not.toHaveBeenCalled();

      const delivered = await service.enqueue('agent-1', 'Explicit immediate', {
        source: 'test',
        deliveryMode: 'immediate',
        immediate: false,
      });

      expect(delivered.status).toBe('delivered');
      expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
    });

    it('falls back from an invalid explicit mode to legacy immediate behavior', async () => {
      const result = await service.enqueue('agent-1', 'Legacy immediate', {
        source: 'test',
        deliveryMode: 'invalid' as 'default',
        immediate: true,
      });

      expect(result.status).toBe('delivered');
      expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
    });

    it('keeps a busy-session idle lane isolated until its exact session becomes idle', async () => {
      const result = await service.enqueue('agent-1', 'Wait for idle', {
        source: 'test',
        deliveryMode: 'on_idle',
      });

      expect(result).toMatchObject({ status: 'queued', poolSize: 1 });
      expect(mockActivityStream.broadcastPoolsUpdated.mock.calls[0][0]).toEqual([
        expect.objectContaining({
          agentId: 'agent-1',
          messageCount: 1,
          messages: [expect.objectContaining({ preview: 'Wait for idle' })],
        }),
      ]);

      await jest.advanceTimersByTimeAsync(60000);
      await service.flushNow('agent-1');
      await service.flushAll();
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

      const idleSession = {
        ...createActiveSession('agent-1'),
        activityState: 'idle' as const,
        busySince: null,
      };
      mockSessionsService.getSession.mockReturnValue(idleSession);
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(idleSession);
      mockSessionsService.listActiveSessions.mockResolvedValue([idleSession]);

      await service.handleSessionActivityChanged({
        sessionId: idleSession.id,
        state: 'idle',
        lastActivityAt: new Date().toISOString(),
        busySince: null,
      });

      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
      expect(service.getPoolStats()).toEqual([]);
    });

    it('starts exact-session delivery during enqueue when the persisted session is idle', async () => {
      const idleSession = {
        ...createActiveSession('agent-1'),
        activityState: 'idle' as const,
        busySince: null,
      };
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(idleSession);
      mockSessionsService.getSession.mockReturnValue(idleSession);
      mockSessionsService.listActiveSessions.mockResolvedValue([idleSession]);
      const flushNow = jest.spyOn(service, 'flushNow');

      const result = await service.enqueue('agent-1', 'Already idle', {
        source: 'test',
        deliveryMode: 'on_idle',
      });

      expect(result.status).toBe('delivered');
      // Claim and completion each use the agent lock so appends during terminal delivery survive.
      expect(mockCoordinator.withAgentLock).toHaveBeenCalledTimes(2);
      expect(flushNow).not.toHaveBeenCalled();
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
      expect(mockTerminalIO.deliverGuarded.mock.calls[0][2]).toHaveProperty('followNote', true);
    });

    it('replaces and fails an old-session lane without exposing it to delayed old events', async () => {
      const oldSession = createActiveSession('agent-1', 'tmux-old');
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(oldSession);
      mockSessionsService.getSession.mockReturnValue(oldSession);

      await service.enqueue('agent-1', 'Old session message', {
        source: 'test',
        deliveryMode: 'on_idle',
      });

      const newSession = {
        ...createActiveSession('agent-1', 'tmux-new'),
        id: 'session-new',
      };
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(newSession);
      mockSessionsService.getSession.mockImplementation((sessionId) =>
        sessionId === oldSession.id ? oldSession : newSession,
      );

      await service.enqueue('agent-1', 'New session message', {
        source: 'test',
        deliveryMode: 'on_idle',
      });

      expect(
        service.getMessageLog().find((entry) => entry.text === 'Old session message'),
      ).toMatchObject({ status: 'failed', failureCode: 'no_active_session' });
      expect(
        service.getMessageLog().find((entry) => entry.text === 'New session message'),
      ).toMatchObject({ status: 'queued' });

      await service.handleSessionActivityChanged({
        sessionId: oldSession.id,
        state: 'idle',
        lastActivityAt: new Date().toISOString(),
        busySince: null,
      });
      await service.handleSessionStopped({
        sessionId: oldSession.id,
        source: 'subscriber',
        reason: 'restart',
      });
      await service.handleSessionCrashed({ sessionId: oldSession.id, sessionName: 'old' });

      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
      expect(service.getPoolStats()).toEqual([
        expect.objectContaining({ agentId: 'agent-1', messageCount: 1 }),
      ]);

      const idleNewSession = { ...newSession, activityState: 'idle' as const, busySince: null };
      mockSessionsService.getSession.mockReturnValue(idleNewSession);
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(idleNewSession);
      mockSessionsService.listActiveSessions.mockResolvedValue([idleNewSession]);
      await service.handleSessionActivityChanged({
        sessionId: idleNewSession.id,
        state: 'idle',
        lastActivityAt: new Date().toISOString(),
        busySince: null,
      });

      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledWith(
        { name: 'tmux-new' },
        'New session message',
        expect.objectContaining({ agentId: 'agent-1' }),
        undefined,
        expect.any(Object),
      );
    });

    it('checks idempotency before current capacity and refreshes capacity on each enqueue', async () => {
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: false,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 1,
        separator: '\n---\n',
      });

      const first = await service.enqueue('agent-1', 'First', {
        source: 'test',
        deliveryMode: 'on_idle',
        clientMessageId: 'client-1',
      });
      const duplicate = await service.enqueue('agent-1', 'Duplicate', {
        source: 'test',
        deliveryMode: 'on_idle',
        clientMessageId: 'client-1',
      });
      const full = await service.enqueue('agent-1', 'Full', {
        source: 'test',
        deliveryMode: 'on_idle',
        clientMessageId: 'client-2',
        failureDisclosure: 'project-safe',
      });

      expect(duplicate).toEqual({ status: 'queued', logEntryId: first.logEntryId });
      expect(full).toEqual({ status: 'failed', error: 'DELIVERY_FAILED' });
      expect(service.getMessageLog()).toHaveLength(1);

      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: false,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 2,
        separator: '\n+++\n',
      });
      await expect(
        service.enqueue('agent-1', 'Now accepted', {
          source: 'test',
          deliveryMode: 'on_idle',
          clientMessageId: 'client-2',
        }),
      ).resolves.toMatchObject({ status: 'queued', poolSize: 2 });
      expect(mockSettings.getMessagePoolConfigForProject).toHaveBeenCalledTimes(3);

      const idleSession = {
        ...createActiveSession('agent-1'),
        activityState: 'idle' as const,
        busySince: null,
      };
      mockSessionsService.getSession.mockReturnValue(idleSession);
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(idleSession);
      mockSessionsService.listActiveSessions.mockResolvedValue([idleSession]);
      await service.handleSessionActivityChanged({
        sessionId: idleSession.id,
        state: 'idle',
        lastActivityAt: new Date().toISOString(),
        busySince: null,
      });
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        'First\n+++\nNow accepted',
        expect.any(Object),
        undefined,
        expect.any(Object),
      );
    });

    it('fails only a matching stopped lane', async () => {
      const session = createActiveSession('agent-1');
      await service.enqueue('agent-1', 'Stop me', { source: 'test', deliveryMode: 'on_idle' });

      mockSessionsService.getSession.mockReturnValue({ ...session, id: 'unrelated-session' });
      await service.handleSessionStopped({
        sessionId: 'unrelated-session',
        source: 'subscriber',
        reason: 'user-requested',
      });
      expect(service.getPoolStats()).toHaveLength(1);

      mockSessionsService.getSession.mockReturnValue(session);
      await service.handleSessionStopped({
        sessionId: session.id,
        source: 'subscriber',
        reason: 'user-requested',
      });

      expect(service.getPoolStats()).toEqual([]);
      expect(service.getMessageLog()[0]).toMatchObject({ status: 'failed' });
    });

    it('fails a matching crashed lane', async () => {
      const session = createActiveSession('agent-1');
      await service.enqueue('agent-1', 'Crash me', { source: 'test', deliveryMode: 'on_idle' });
      mockSessionsService.getSession.mockReturnValue(session);

      await service.handleSessionCrashed({ sessionId: session.id, sessionName: 'crashed' });

      expect(service.getPoolStats()).toEqual([]);
      expect(service.getMessageLog()[0]).toMatchObject({ status: 'failed' });
    });

    it('aggregates default and idle messages into one timestamp-ordered agent record', async () => {
      await service.enqueue('agent-1', 'Default first', {
        source: 'default-source',
        deliveryMode: 'default',
      });
      await jest.advanceTimersByTimeAsync(1);
      await service.enqueue('agent-1', 'Idle second', {
        source: 'idle-source',
        deliveryMode: 'on_idle',
      });

      expect(service.getPoolStats()).toEqual([
        expect.objectContaining({ agentId: 'agent-1', messageCount: 2 }),
      ]);
      expect(service.getPoolDetails()).toEqual([
        expect.objectContaining({
          agentId: 'agent-1',
          messageCount: 2,
          messages: [
            expect.objectContaining({ preview: 'Default first' }),
            expect.objectContaining({ preview: 'Idle second' }),
          ],
        }),
      ]);

      const idleSession = {
        ...createActiveSession('agent-1'),
        activityState: 'idle' as const,
        busySince: null,
      };
      mockSessionsService.getSession.mockReturnValue(idleSession);
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(idleSession);
      mockSessionsService.listActiveSessions.mockResolvedValue([idleSession]);
      await service.handleSessionActivityChanged({
        sessionId: idleSession.id,
        state: 'idle',
        lastActivityAt: new Date().toISOString(),
        busySince: null,
      });

      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        'Idle second',
        expect.any(Object),
        undefined,
        expect.any(Object),
      );
      expect(service.getPoolDetails()).toEqual([
        expect.objectContaining({
          messageCount: 1,
          messages: [expect.objectContaining({ preview: 'Default first' })],
        }),
      ]);
    });

    it('classifies a missing-session idle failure before returning it', async () => {
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(null);

      await expect(
        service.enqueue('agent-1', 'No session', {
          source: 'test',
          deliveryMode: 'on_idle',
          failureDisclosure: 'project-safe',
        }),
      ).resolves.toEqual({ status: 'failed', error: 'DELIVERY_FAILED' });
      expect(service.getMessageLog()).toEqual([]);
    });

    it('clears idle lanes on shutdown without terminal delivery', async () => {
      await service.enqueue('agent-1', 'Do not deliver', {
        source: 'test',
        deliveryMode: 'on_idle',
      });

      await service.onModuleDestroy();

      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
      expect(service.getPoolStats()).toEqual([]);
      expect(service.getMessageLog()[0]).toMatchObject({ status: 'failed' });
    });
  });

  describe('human-draft exact-session lane', () => {
    const protectedOptions = {
      source: 'structured-agent-message',
      deferWhileHumanTyping: true,
    } as const;

    async function activate(generation?: number): Promise<number> {
      const state = generation
        ? humanPromptState.getState('tmux-1')
        : humanPromptState.recordPromptText('tmux-1');
      const activeGeneration = generation ?? state.generation;
      await service.handleHumanPromptStateChanged({
        sessionId: 'session-agent-1',
        tmuxSessionName: 'tmux-1',
        generation: activeGeneration,
        phase: 'draft_active',
      });
      return activeGeneration;
    }

    async function submit(expectedGeneration: number): Promise<number> {
      const result = humanPromptState.transitionToAwaiting('tmux-1', expectedGeneration);
      if (!result.accepted) throw new Error('test prompt transition rejected');
      await service.handleHumanPromptStateChanged({
        sessionId: 'session-agent-1',
        tmuxSessionName: 'tmux-1',
        generation: result.state.generation,
        phase: 'awaiting_stable_idle',
      });
      return result.state.generation;
    }

    async function waitForGuardedDelivery(): Promise<void> {
      for (
        let turn = 0;
        turn < 20 && mockTerminalIO.deliverGuarded.mock.calls.length === 0;
        turn += 1
      ) {
        await Promise.resolve();
      }
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    }

    async function startBlockedMutatingClaim(text: string): Promise<() => void> {
      let release!: () => void;
      const terminalResult = new Promise<{
        confirmed: true;
        nonce: string;
        retryCount: number;
      }>((resolve) => {
        release = () => resolve({ confirmed: true, nonce: 'blocked', retryCount: 0 });
      });
      mockTerminalIO.deliverGuarded.mockImplementationOnce(
        async (_target, _text, _options, _snapshot, mutationFence) => {
          if (!mutationFence?.canStartMutation()) return { deferred: 'human_draft' };
          mutationFence.markMutationStarted();
          return terminalResult;
        },
      );

      const generation = await activate();
      await service.enqueue('agent-1', text, protectedOptions);
      await submit(generation);
      jest.advanceTimersByTime(2_000);
      await waitForGuardedDelivery();
      return release;
    }

    it('preserves truthful outcomes for unblocked protected delivery modes', async () => {
      await expect(
        service.enqueue('agent-1', 'default queued', {
          ...protectedOptions,
          deliveryMode: 'default',
        }),
      ).resolves.toMatchObject({ status: 'queued' });
      await expect(
        service.enqueue('agent-1', 'immediate delivered', {
          ...protectedOptions,
          deliveryMode: 'immediate',
        }),
      ).resolves.toMatchObject({ status: 'delivered' });

      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: false,
        delayMs: 10_000,
        maxWaitMs: 30_000,
        maxMessages: 10,
        separator: '\n---\n',
      });
      await expect(
        service.enqueue('agent-1', 'pooling disabled delivered', protectedOptions),
      ).resolves.toMatchObject({ status: 'delivered' });

      const idleSession = {
        ...createActiveSession('agent-1'),
        activityState: 'idle' as const,
        busySince: null,
      };
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(idleSession);
      mockSessionsService.getSession.mockReturnValue(idleSession);
      mockSessionsService.listActiveSessions.mockResolvedValue([idleSession]);
      await expect(
        service.enqueue('agent-1', 'on idle delivered', {
          ...protectedOptions,
          deliveryMode: 'on_idle',
        }),
      ).resolves.toMatchObject({ status: 'delivered' });
    });

    it.each([
      ['default', { deliveryMode: 'default' as const }],
      ['immediate', { deliveryMode: 'immediate' as const }],
    ])('queues blocked %s delivery without terminal mutation', async (_label, mode) => {
      await activate();

      const result = await service.enqueue('agent-1', `${_label} protected`, {
        ...protectedOptions,
        ...mode,
      });

      expect(result.status).toBe('queued');
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
      expect(mockTerminalIO.deliverImmediate).not.toHaveBeenCalled();
      expect(service.getPoolDetails()).toEqual([
        expect.objectContaining({
          messageCount: 1,
          humanHeldMessageCount: 1,
        }),
      ]);
    });

    it('queues protected delivery while pooling is disabled', async () => {
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: false,
        delayMs: 10_000,
        maxWaitMs: 30_000,
        maxMessages: 10,
        separator: '\n---\n',
      });
      await activate();

      const result = await service.enqueue('agent-1', 'pooling-disabled protected', {
        ...protectedOptions,
        deliveryMode: 'default',
      });

      expect(result.status).toBe('queued');
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
    });

    it('never lets maxWait override an active human draft', async () => {
      await activate();
      await service.enqueue('agent-1', 'held beyond max wait', protectedOptions);

      await jest.advanceTimersByTimeAsync(120_000);

      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
      expect(mockTerminalIO.deliverGuarded).not.toHaveBeenCalled();
      expect(service.getPoolDetails()[0]).toEqual(
        expect.objectContaining({ humanHeldMessageCount: 1 }),
      );
    });

    it('exposes and accepts explicit release only after 30 seconds of human inactivity', async () => {
      jest.setSystemTime(new Date('2026-08-23T10:00:00.000Z'));
      await activate();
      await service.enqueue('agent-1', 'held for confirmation', protectedOptions);

      expect(service.getPoolDetails()[0]).toEqual(
        expect.objectContaining({
          humanHeldMessageCount: 1,
          humanReleaseEligibleAt: Date.now() + 30_000,
        }),
      );
      await expect(service.releaseHumanHeldMessages('agent-1', 'project-1')).resolves.toEqual({
        status: 'not_ready',
        eligibleAt: Date.now() + 30_000,
      });

      await jest.advanceTimersByTimeAsync(30_000);
      await expect(service.releaseHumanHeldMessages('agent-1', 'project-1')).resolves.toEqual({
        status: 'released',
      });
      expect(humanPromptState.getState('tmux-1').phase).toBe('awaiting_stable_idle');

      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
      expect(service.getPoolDetails()).toEqual([]);
    });

    it('rejects explicit release for a different project', async () => {
      await activate();
      await service.enqueue('agent-1', 'held for project one', protectedOptions);
      await jest.advanceTimersByTimeAsync(30_000);

      await expect(service.releaseHumanHeldMessages('agent-1', 'project-2')).resolves.toEqual({
        status: 'not_found',
      });
    });

    it('drains a held message after matching Backspaces clear an exact draft', async () => {
      let state = humanPromptState.recordPromptText('tmux-1', 3);
      await service.handleHumanPromptStateChanged({
        sessionId: 'session-agent-1',
        tmuxSessionName: 'tmux-1',
        generation: state.generation,
        phase: 'draft_active',
      });
      await service.enqueue('agent-1', 'arrived while viewing another agent', protectedOptions);

      for (let index = 0; index < 3; index += 1) {
        const edit = humanPromptState.recordControlInput('tmux-1', state.generation, 'BSpace');
        if (!edit.accepted) throw new Error('test Backspace transition rejected');
        state = edit.state as typeof state;
        await service.handleHumanPromptStateChanged({
          sessionId: 'session-agent-1',
          tmuxSessionName: 'tmux-1',
          generation: edit.state.generation,
          phase: edit.state.phase,
        });
      }

      expect(humanPromptState.getState('tmux-1').phase).toBe('awaiting_stable_idle');
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
      expect(service.getPoolDetails()).toEqual([]);
    });

    it('promotes pooled protected work before replacement fails its exact lane', async () => {
      await service.enqueue('agent-1', 'pooled before typing', protectedOptions);
      expect(service.getPoolDetails()[0].humanHeldMessageCount).toBe(0);

      await activate();
      const replacement = {
        ...createActiveSession('agent-1', 'tmux-new'),
        id: 'replacement-session',
      };
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(replacement);
      mockSessionsService.listActiveSessions.mockResolvedValue([replacement]);
      await service.flushNow('agent-1');

      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
      expect(service.getPoolDetails()).toEqual([]);
      expect(service.getMessageLog()[0]).toMatchObject({ status: 'failed' });
    });

    it('fails an old exact-session hold when a replacement accepts new work', async () => {
      await activate();
      await service.enqueue('agent-1', 'old held', protectedOptions);
      const oldSession = createActiveSession('agent-1');
      const replacement = {
        ...createActiveSession('agent-1', 'tmux-new'),
        id: 'replacement-session',
      };
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(replacement);
      mockSessionsService.getSession.mockImplementation((sessionId) =>
        sessionId === oldSession.id ? oldSession : replacement,
      );

      await service.enqueue('agent-1', 'replacement queued', protectedOptions);

      expect(service.getMessageLog().find((entry) => entry.text === 'old held')).toMatchObject({
        status: 'failed',
        failureCode: 'no_active_session',
      });
      expect(
        service.getMessageLog().find((entry) => entry.text === 'replacement queued'),
      ).toMatchObject({ status: 'queued' });
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
    });

    it('deduplicates before enforcing one shared ordinary/deferred capacity', async () => {
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: true,
        delayMs: 10_000,
        maxWaitMs: 30_000,
        maxMessages: 2,
        separator: '\n---\n',
      });
      await service.enqueue('agent-1', 'ordinary protected', {
        ...protectedOptions,
        clientMessageId: 'client-1',
      });
      await activate();
      const second = await service.enqueue('agent-1', 'held immediate', {
        ...protectedOptions,
        deliveryMode: 'immediate',
        clientMessageId: 'client-2',
      });

      await expect(
        service.enqueue('agent-1', 'duplicate', {
          ...protectedOptions,
          deliveryMode: 'immediate',
          clientMessageId: 'client-2',
        }),
      ).resolves.toEqual({ status: 'queued', logEntryId: second.logEntryId });
      await expect(
        service.enqueue('agent-1', 'over capacity', {
          ...protectedOptions,
          clientMessageId: 'client-3',
        }),
      ).resolves.toMatchObject({ status: 'failed', error: 'Message pool capacity reached' });
      expect(service.getMessageLog()).toHaveLength(2);
    });

    it('rebinds the complete lane to the latest generation and releases after stable quiet', async () => {
      const firstGeneration = await activate();
      await service.enqueue('agent-1', 'first generation', protectedOptions);
      const secondState = humanPromptState.recordPromptText('tmux-1');
      await activate(secondState.generation);
      await service.enqueue('agent-1', 'second generation', protectedOptions);
      const awaitingGeneration = await submit(secondState.generation);

      await jest.advanceTimersByTimeAsync(1_999);
      expect(mockTerminalIO.deliverGuarded).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);

      expect(firstGeneration).toBe(1);
      expect(awaitingGeneration).toBe(3);
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        'first generation\n---\nsecond generation',
        expect.objectContaining({ agentId: 'agent-1' }),
        expect.objectContaining({ expectedGeneration: awaitingGeneration }),
        expect.any(Object),
      );
      expect(service.getPoolDetails()).toEqual([]);
    });

    it('restarts a full grace when executed input changes the quiet snapshot', async () => {
      const generation = await activate();
      await service.enqueue('agent-1', 'wait for true quiet', protectedOptions);
      await submit(generation);

      await jest.advanceTimersByTimeAsync(1_000);
      humanPromptState.recordExecutedInput('tmux-1');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(mockTerminalIO.deliverGuarded).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1_999);
      expect(mockTerminalIO.deliverGuarded).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    });

    it('keeps claimed work and schedules a new full grace after FIFO-head mismatch', async () => {
      mockTerminalIO.deliverGuarded
        .mockResolvedValueOnce({ deferred: 'human_draft' })
        .mockResolvedValueOnce({ confirmed: true, nonce: 'ok', retryCount: 0 });
      const generation = await activate();
      await service.enqueue('agent-1', 'retry guarded delivery', protectedOptions);
      await submit(generation);

      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
      expect(service.getPoolDetails()[0].humanHeldMessageCount).toBe(1);

      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(2);
      expect(service.getPoolDetails()).toEqual([]);
    });

    it('creates the missing grace timer for a protected message arriving after Enter', async () => {
      const generation = await activate();
      await submit(generation);

      await service.enqueue('agent-1', 'late arrival', {
        ...protectedOptions,
        deliveryMode: 'immediate',
      });
      await jest.advanceTimersByTimeAsync(1_999);
      expect(mockTerminalIO.deliverGuarded).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    });

    it('lets explicit mobile user delivery bypass the hold and completes it under one agent lock', async () => {
      await activate();
      await service.enqueue('agent-1', 'held autonomous', protectedOptions);
      const lockCountBeforeSubmit = mockCoordinator.withAgentLock.mock.calls.length;

      const result = await service.enqueue('agent-1', 'mobile human reply', {
        source: 'mobile',
        deliveryMode: 'immediate',
        humanPromptSubmit: true,
        clientMessageId: 'mobile-human-1',
      });

      expect(result.status).toBe('delivered');
      expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        'mobile human reply',
        expect.objectContaining({ confirm: false }),
      );
      expect(mockCoordinator.withAgentLock.mock.calls.length).toBe(lockCountBeforeSubmit + 1);
      expect(humanPromptState.getState('tmux-1').phase).toBe('awaiting_stable_idle');

      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        'held autonomous',
        expect.any(Object),
        expect.objectContaining({ expectedGeneration: 2 }),
        expect.any(Object),
      );
    });

    it('preserves messages appended while a claimed snapshot is delivering', async () => {
      let release!: (result: { confirmed: true; nonce: string; retryCount: number }) => void;
      mockTerminalIO.deliverGuarded.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      const generation = await activate();
      await service.enqueue('agent-1', 'claimed first', protectedOptions);
      await submit(generation);
      jest.advanceTimersByTime(2_000);
      for (
        let turn = 0;
        turn < 20 && mockTerminalIO.deliverGuarded.mock.calls.length === 0;
        turn += 1
      ) {
        await Promise.resolve();
      }
      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);

      await service.enqueue('agent-1', 'appended second', protectedOptions);
      humanPromptState.clearSession('tmux-1');
      release({ confirmed: true, nonce: 'first', retryCount: 0 });
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();

      expect(service.getPoolDetails()).toEqual([
        expect.objectContaining({
          messageCount: 1,
          messages: [expect.objectContaining({ preview: 'appended second' })],
        }),
      ]);
    });

    it('cancels and fails a preparing claim before its first pane mutation', async () => {
      let releasePreflight!: () => void;
      let markPreflightStarted!: () => void;
      const preflightStarted = new Promise<void>((resolve) => {
        markPreflightStarted = resolve;
      });
      const preflight = new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      const markMutationStarted = jest.fn();
      mockTerminalIO.deliverGuarded.mockImplementationOnce(
        async (_target, _text, _options, _snapshot, mutationFence) => {
          markPreflightStarted();
          await preflight;
          if (!mutationFence?.canStartMutation()) return { deferred: 'human_draft' };
          markMutationStarted();
          mutationFence.markMutationStarted();
          return { confirmed: true, nonce: 'unexpected', retryCount: 0 };
        },
      );

      const generation = await activate();
      await service.enqueue('agent-1', 'cancel before mutation', protectedOptions);
      await submit(generation);
      jest.advanceTimersByTime(2_000);
      await preflightStarted;

      await service.handleSessionStopped({
        sessionId: 'session-agent-1',
        source: 'subscriber',
        reason: 'user-requested',
      });

      expect(service.getMessageLog()[0]).toMatchObject({ status: 'failed' });
      releasePreflight();
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
      expect(markMutationStarted).not.toHaveBeenCalled();
      expect(service.getMessageLog()[0]).toMatchObject({ status: 'failed' });
    });

    it.each(['stopped', 'crashed'] as const)(
      'waits for a mutating claim and records its real result when the session %s',
      async (event) => {
        const release = await startBlockedMutatingClaim(`${event} in flight`);

        const lifecycle =
          event === 'stopped'
            ? service.handleSessionStopped({
                sessionId: 'session-agent-1',
                source: 'subscriber',
                reason: 'user-requested',
              })
            : service.handleSessionCrashed({
                sessionId: 'session-agent-1',
                sessionName: 'tmux-1',
              });
        let settled = false;
        void lifecycle.then(() => {
          settled = true;
        });
        await Promise.resolve();

        expect(settled).toBe(false);
        expect(service.getMessageLog()[0]).toMatchObject({ status: 'queued' });
        release();
        await lifecycle;

        expect(service.getMessageLog()[0]).toMatchObject({ status: 'delivered' });
        expect(service.getPoolDetails()).toEqual([]);
      },
    );

    it('waits for a mutating claim during shutdown and preserves its delivered result', async () => {
      const release = await startBlockedMutatingClaim('shutdown in flight');

      const shutdown = service.onModuleDestroy();
      await Promise.resolve();
      expect(service.getMessageLog()[0]).toMatchObject({ status: 'queued' });
      release();
      await shutdown;

      expect(service.getMessageLog()[0]).toMatchObject({ status: 'delivered' });
      expect(service.getPoolDetails()).toEqual([]);
    });

    it('waits for a mutating old-session claim before admitting replacement work', async () => {
      const release = await startBlockedMutatingClaim('old session in flight');
      const oldSession = createActiveSession('agent-1');
      const replacement = {
        ...oldSession,
        id: 'replacement-session',
        tmuxSessionId: 'tmux-2',
      };
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(replacement);
      mockSessionsService.getSession.mockImplementation((sessionId) =>
        sessionId === oldSession.id ? oldSession : replacement,
      );

      const replacementEnqueue = service.enqueue('agent-1', 'replacement queued', {
        source: 'test',
        deliveryMode: 'on_idle',
      });
      let replacementSettled = false;
      void replacementEnqueue.then(() => {
        replacementSettled = true;
      });
      await Promise.resolve();

      expect(replacementSettled).toBe(false);
      expect(service.getMessageLog()[0]).toMatchObject({ status: 'queued' });
      release();
      await expect(replacementEnqueue).resolves.toMatchObject({ status: 'queued' });

      expect(
        service.getMessageLog().find((entry) => entry.text === 'old session in flight'),
      ).toMatchObject({ status: 'delivered' });
      expect(
        service.getMessageLog().find((entry) => entry.text === 'replacement queued'),
      ).toMatchObject({ status: 'queued' });
    });

    it('requires provider idle and human quiet for mixed on_idle work', async () => {
      const generation = await activate();
      await service.enqueue('agent-1', 'mixed idle', {
        ...protectedOptions,
        deliveryMode: 'on_idle',
      });
      await submit(generation);

      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockTerminalIO.deliverGuarded).not.toHaveBeenCalled();

      const idleSession = {
        ...createActiveSession('agent-1'),
        activityState: 'idle' as const,
        busySince: null,
      };
      mockSessionsService.getSession.mockReturnValue(idleSession);
      mockSessionsService.getActiveSessionForAgent.mockReturnValue(idleSession);
      mockSessionsService.listActiveSessions.mockResolvedValue([idleSession]);
      await service.handleSessionActivityChanged({
        sessionId: idleSession.id,
        state: 'idle',
        lastActivityAt: null,
        busySince: null,
      });
      await jest.advanceTimersByTimeAsync(2_000);

      expect(mockTerminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    });

    it('fails human-held work during shutdown without terminal delivery', async () => {
      await activate();
      await service.enqueue('agent-1', 'shutdown held', protectedOptions);

      await service.onModuleDestroy();

      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
      expect(mockTerminalIO.deliverGuarded).not.toHaveBeenCalled();
      expect(service.getPoolDetails()).toEqual([]);
      expect(service.getMessageLog()[0]).toMatchObject({ status: 'failed' });
    });

    it.each(['stopped', 'crashed'] as const)(
      'fails human-held work when the exact session %s',
      async (event) => {
        await activate();
        await service.enqueue('agent-1', `${event} held`, protectedOptions);

        if (event === 'stopped') {
          await service.handleSessionStopped({
            sessionId: 'session-agent-1',
            source: 'subscriber',
            reason: 'user-requested',
          });
        } else {
          await service.handleSessionCrashed({
            sessionId: 'session-agent-1',
            sessionName: 'tmux-1',
          });
        }

        expect(service.getPoolDetails()).toEqual([]);
        expect(service.getMessageLog()[0]).toMatchObject({ status: 'failed' });
        expect(mockTerminalIO.deliverGuarded).not.toHaveBeenCalled();
      },
    );
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
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

      const result = await service.enqueue('agent-1', 'Message 3', { source: 'test' });

      expect(result.status).toBe('delivered');
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
    });

    it.each(['No active session', 'Connection refused'])(
      'reports maxMessages flush failure: %s',
      async (error) => {
        mockSettings.getMessagePoolConfigForProject.mockReturnValue({
          enabled: true,
          delayMs: 10000,
          maxWaitMs: 30000,
          maxMessages: 2,
          separator: '\n---\n',
        });
        await service.enqueue('agent-1', 'Message 1', { source: 'test' });
        if (error === 'No active session')
          mockSessionsService.listActiveSessions.mockResolvedValue([]);
        else mockTerminalIO.deliver.mockRejectedValue(new Error(error));
        const result = await service.enqueue('agent-1', 'Message 2', { source: 'test' });
        expect(result).toMatchObject({ status: 'failed', error });
      },
    );

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
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
    });
  });

  describe('Message ordering', () => {
    it('should deliver messages in enqueue order', async () => {
      await service.enqueue('agent-1', 'First', { source: 'test' });
      await service.enqueue('agent-1', 'Second', { source: 'test' });
      await service.enqueue('agent-1', 'Third', { source: 'test' });

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      const calledText = mockTerminalIO.deliver.mock.calls[0][1];
      expect(calledText).toContain('First\n---\nSecond\n---\nThird');
    });

    it('should maintain independent pools for multiple agents', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        createActiveSession('agent-1', 'tmux-1'),
        createActiveSession('agent-2', 'tmux-2'),
      ]);

      await service.enqueue('agent-1', 'Agent1 Message', { source: 'test' });
      await service.enqueue('agent-2', 'Agent2 Message', { source: 'test' });

      await jest.advanceTimersByTimeAsync(10001);

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(2);
      expect(mockTerminalIO.deliver).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        expect.stringContaining('Agent1 Message'),
        expect.any(Object),
      );
      expect(mockTerminalIO.deliver).toHaveBeenCalledWith(
        { name: 'tmux-2' },
        expect.stringContaining('Agent2 Message'),
        expect.any(Object),
      );
    });
  });

  describe('Session locking', () => {
    it('should call withAgentLock during flush', async () => {
      await service.enqueue('agent-1', 'Message', { source: 'test' });
      await jest.advanceTimersByTimeAsync(10001);

      expect(mockCoordinator.withAgentLock).toHaveBeenCalledWith('agent-1', expect.any(Function));
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

      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

      await service.onModuleDestroy();

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(2);
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
    it('should use default config when SettingsService throws', async () => {
      mockSettings.getMessagePoolConfig.mockImplementation(() => {
        throw new Error('Settings not available');
      });

      const serviceWithDefaultConfig = new SessionsMessagePoolService(
        mockSessionsService as unknown as SessionsService,
        mockCoordinator as unknown as SessionCoordinatorService,
        mockTerminalIO as unknown as TerminalIOService,
        mockSettings as unknown as SettingsService,
        mockStorage as unknown as StorageService,
        mockActivityStream,
        mockProviderAdapterFactory as unknown as ProviderAdapterFactory,
        new MessageLogService(),
        { notifySendersOfFailure: jest.fn() } as unknown as DeliveryFailureNotifierService,
        new HumanPromptStateService(),
      );

      mockSettings.getMessagePoolConfigForProject.mockImplementation(() => {
        throw new Error('Settings not available');
      });
      expect(
        await serviceWithDefaultConfig.enqueue('agent-1', 'fallback', { source: 'test' }),
      ).toMatchObject({ status: 'queued' });
      await jest.advanceTimersByTimeAsync(9999);
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      await serviceWithDefaultConfig.onModuleDestroy();
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
    it.each([
      {
        label: 'provided',
        messages: [{ text: 'Message', submitKeys: ['Tab', 'Enter'] }],
        expected: ['Tab', 'Enter'],
      },
      {
        label: 'last message',
        messages: [
          { text: 'Message 1', submitKeys: ['Tab'] },
          { text: 'Message 2', submitKeys: ['Enter'] },
        ],
        expected: ['Enter'],
      },
      {
        label: 'default',
        messages: [{ text: 'Message', submitKeys: undefined }],
        expected: ['Enter'],
      },
    ])('uses $label submit keys', async ({ messages, expected }) => {
      for (const message of messages)
        await service.enqueue('agent-1', message.text, {
          source: 'test',
          submitKeys: message.submitKeys,
        });
      await jest.advanceTimersByTimeAsync(10001);
      expect(mockTerminalIO.deliver).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        expect.stringContaining('Message'),
        expect.objectContaining({ submitKeys: expected }),
      );
    });
  });

  describe('flushNow', () => {
    it('should clear timers when flushing', async () => {
      await service.enqueue('agent-1', 'Message', { source: 'test' });

      await service.flushNow('agent-1');

      // Advance time - no additional flush should occur
      await jest.advanceTimersByTimeAsync(20000);

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
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
      mockTerminalIO.deliver.mockRejectedValue(new Error('Tmux connection failed'));

      await service.enqueue('agent-1', 'Message', { source: 'test' });

      const result = await service.flushNow('agent-1');

      expect(result.success).toBe(false);
      expect(result.discardedCount).toBe(1);
      expect(result.reason).toBe('Tmux connection failed');
    });

    it('classifies protected no-session failures across log, activity, notifier, and flush', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([]);

      await service.enqueue('agent-1', 'Protected', {
        source: 'mcp.send_message',
        senderAgentId: 'sender-1',
        failureDisclosure: 'project-safe',
      });
      const result = await service.flushNow('agent-1');

      expect(result).toEqual({
        success: false,
        discardedCount: 1,
        reason: 'DELIVERY_FAILED',
      });
      expect(service.getMessageLog()[0]).toMatchObject({
        error: 'DELIVERY_FAILED',
        failureCode: 'project_delivery_failed',
      });
      expect(mockActivityStream.broadcastFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'DELIVERY_FAILED',
          failureCode: 'project_delivery_failed',
        }),
      );
      const notifier = (
        service as unknown as { failureNotifier: { notifySendersOfFailure: jest.Mock } }
      ).failureNotifier;
      expect(notifier.notifySendersOfFailure).toHaveBeenCalledWith(
        expect.any(Array),
        'agent-1',
        'DELIVERY_FAILED',
      );
    });

    it('uses project-safe disclosure on shared mixed-batch surfaces', async () => {
      const rawError = 'send keys failed at /private/source/project';
      mockTerminalIO.deliver.mockRejectedValue(new Error(rawError));

      await service.enqueue('agent-1', 'Legacy', { source: 'test' });
      await service.enqueue('agent-1', 'Protected', {
        source: 'mcp.send_message',
        senderAgentId: 'sender-1',
        failureDisclosure: 'project-safe',
      });
      const result = await service.flushNow('agent-1');

      expect(result.reason).toBe('DELIVERY_FAILED');
      const log = service.getMessageLog();
      expect(log.find((entry) => entry.text === 'Legacy')).toMatchObject({
        error: rawError,
        failureCode: 'send_keys_failed',
      });
      expect(log.find((entry) => entry.text === 'Protected')).toMatchObject({
        error: 'DELIVERY_FAILED',
        failureCode: 'project_delivery_failed',
      });
      const notifier = (
        service as unknown as { failureNotifier: { notifySendersOfFailure: jest.Mock } }
      ).failureNotifier;
      expect(notifier.notifySendersOfFailure).toHaveBeenCalledWith(
        expect.any(Array),
        'agent-1',
        'DELIVERY_FAILED',
      );
      expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(rawError);
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
      expect(log[0].failureCode).toBe('no_active_session');
      expect(log[0].batchId).toBeDefined();
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

    it.each([
      { length: 150, expected: 'A'.repeat(100) + '...' },
      { length: 100, expected: 'A'.repeat(100) },
    ])('formats the preview for $length characters', async ({ length, expected }) => {
      await service.enqueue('agent-1', 'A'.repeat(length), {
        source: 'test',
        projectId: 'project-1',
        agentName: 'Test Agent',
      });
      expect(service.getPoolDetails()[0].messages[0].preview).toBe(expected);
    });

    it.each([
      { projectId: 'project-1', expected: ['agent-1'] },
      { projectId: undefined, expected: ['agent-1', 'agent-2'] },
    ])('lists pools filtered by $projectId', async ({ projectId, expected }) => {
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
      const pools = service.getPoolDetails(projectId);
      expect(pools.map((pool) => pool.agentId)).toEqual(expected);
      if (projectId) expect(pools[0].projectId).toBe(projectId);
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

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      // Should use new separator
      expect(mockTerminalIO.deliver).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        expect.stringContaining('Message 1\n===\nMessage 2'),
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

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
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
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

      // Wait 5 more seconds (remaining max wait time)
      await jest.advanceTimersByTimeAsync(5000);

      // Now should have flushed due to recalculated max wait
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
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

      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
      expect(mockTerminalIO.deliver).toHaveBeenCalledWith(
        { name: 'tmux-1' },
        expect.stringContaining('Message 1\n---\nMessage 2'),
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

      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

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
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);
    });
  });

  describe('Per-project pool configuration', () => {
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
      expect(mockTerminalIO.deliver).not.toHaveBeenCalled();

      // Advance by global delayMs (10000)
      await jest.advanceTimersByTimeAsync(10000);

      expect(mockTerminalIO.deliver).toHaveBeenCalled();
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

  describe('Confirmed delivery retry and status tracking', () => {
    beforeEach(() => {
      // Use real timers for retry tests (retry uses 200ms setTimeout)
      jest.useRealTimers();

      // Use immediate delivery (pooling disabled) for easier testing
      mockSettings.getMessagePoolConfig.mockReturnValue({
        enabled: false,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });
      mockSettings.getMessagePoolConfigForProject.mockReturnValue({
        enabled: false,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      });
    });

    it('sets confirmedAt and retryCount on successful delivery', async () => {
      mockTerminalIO.deliver.mockResolvedValue({
        confirmed: true,
        nonce: 'abc1234',
        retryCount: 0,
      });
      const result = await service.enqueue('agent-1', 'Hello', { source: 'test' });

      expect(result.status).toBe('delivered');
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);

      // Verify log entry has confirmedAt and retryCount
      const log = service.getMessageLog();
      expect(log[0].status).toBe('delivered');
      expect(log[0].confirmedAt).toBeDefined();
      expect(log[0].retryCount).toBe(0);
      expect(log[0].nonce).toBe('abc1234');
      expect(log[0].nonce).toMatch(/^[0-9a-f]{7}$/);
    });

    it('sets unconfirmed status when deliver returns unconfirmed', async () => {
      mockTerminalIO.deliver.mockResolvedValue({
        confirmed: false,
        nonce: 'abc1234',
        retryCount: 1,
      });

      const result = await service.enqueue('agent-1', 'Hello', { source: 'test' });

      expect(result.status).toBe('unconfirmed');
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);

      const log = service.getMessageLog();
      expect(log[0].status).toBe('unconfirmed');
      expect(log[0].confirmedAt).toBeUndefined();

      expect(mockActivityStream.broadcastUnconfirmed).toHaveBeenCalled();
    });

    it('does NOT retry on IOError — fails immediately', async () => {
      mockTerminalIO.deliver.mockRejectedValue(new IOError('tmux crashed'));

      const result = await service.enqueue('agent-1', 'Hello', { source: 'test' });

      expect(result.status).toBe('failed');
      expect(mockTerminalIO.deliver).toHaveBeenCalledTimes(1);

      const log = service.getMessageLog();
      expect(log[0].status).toBe('failed');
      expect(log[0].failureCode).toBe('tmux_error');
    });
  });

  describe('postPasteDelayMs integration', () => {
    it.each([
      { immediate: true, delay: 1500 },
      { immediate: true, delay: undefined },
      { immediate: false, delay: 1500 },
      { immediate: false, delay: undefined },
    ])('threads provider delay=$delay for immediate=$immediate', async ({ immediate, delay }) => {
      mockProviderAdapterFactory.getRuntimePromptBehaviorForAgent.mockResolvedValue(
        delay === undefined ? {} : { postPasteDelayMs: delay },
      );
      await service.enqueue('agent-1', 'hello', { source: 'test', immediate });
      if (!immediate) await jest.advanceTimersByTimeAsync(10_001);
      await jest.runAllTimersAsync();
      expect(mockProviderAdapterFactory.getRuntimePromptBehaviorForAgent).toHaveBeenCalledWith(
        'agent-1',
      );
      const deliver = immediate ? mockTerminalIO.deliverImmediate : mockTerminalIO.deliver;
      expect(deliver.mock.calls[0][2]?.postPasteDelayMs).toBe(delay);
    });
  });

  describe('clientMessageId idempotency', () => {
    it('dedups two CONCURRENT same-clientMessageId immediate enqueues (one delivery, one row)', async () => {
      // Delay resolveProjectInfo (its only await is storage.getAgent) so BOTH
      // enqueues suspend past the method entry before either reaches the dedup
      // check — the exact race the atomic check→addEntry invariant must survive.
      const resolvers: Array<(agent: unknown) => void> = [];
      mockStorage.getAgent.mockImplementation(
        () => new Promise((res) => resolvers.push(res as (agent: unknown) => void)),
      );

      const opts = { source: 'mobile', immediate: true, clientMessageId: 'client-1' };
      const p1 = service.enqueue('agent-1', 'Hello', opts);
      const p2 = service.enqueue('agent-1', 'Hello', opts);

      // Both calls have reached the getAgent await; release them together.
      expect(resolvers).toHaveLength(2);
      resolvers.forEach((res) => res(createMockAgent()));

      const [r1, r2] = await Promise.all([p1, p2]);

      // Exactly ONE tmux delivery and ONE log row survive the race.
      expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
      const rows = service.getMessageLog({ source: 'mobile' });
      expect(rows).toHaveLength(1);

      // The second call returns the FIRST entry's ids instead of re-enqueuing.
      expect(r1.logEntryId).toBe(rows[0].id);
      expect(r2.logEntryId).toBe(r1.logEntryId);
    });

    it('dedups a SEQUENTIAL retry with the same clientMessageId (no second delivery)', async () => {
      const opts = { source: 'mobile', immediate: true, clientMessageId: 'client-2' };

      const first = await service.enqueue('agent-1', 'Hello', opts);
      const second = await service.enqueue('agent-1', 'Hello', opts);

      expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
      expect(service.getMessageLog({ source: 'mobile' })).toHaveLength(1);
      expect(second.logEntryId).toBe(first.logEntryId);
    });

    it('does NOT dedup across a different source or agent (dedup key is id+agent+source)', async () => {
      mockSessionsService.listActiveSessions.mockResolvedValue([
        createActiveSession('agent-1'),
        createActiveSession('agent-2', 'tmux-2'),
      ]);

      await service.enqueue('agent-1', 'A', {
        source: 'mobile',
        immediate: true,
        clientMessageId: 'shared',
      });
      // Same clientMessageId but different source → distinct entry, delivered again.
      await service.enqueue('agent-1', 'B', {
        source: 'other',
        immediate: true,
        clientMessageId: 'shared',
      });
      // Same clientMessageId+source but different agent → distinct entry.
      await service.enqueue('agent-2', 'C', {
        source: 'mobile',
        immediate: true,
        clientMessageId: 'shared',
      });

      expect(mockTerminalIO.deliverImmediate).toHaveBeenCalledTimes(3);
      expect(service.getMessageLog()).toHaveLength(3);
    });

    it('threads clientMessageId onto the created log entry', async () => {
      await service.enqueue('agent-1', 'Hello', {
        source: 'mobile',
        immediate: true,
        clientMessageId: 'client-3',
      });

      const rows = service.getMessageLog({ source: 'mobile' });
      expect(rows[0].clientMessageId).toBe('client-3');
    });
  });
});
