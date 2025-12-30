import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { WatcherRunnerService } from './services/watcher-runner.service';
import { SubscriberExecutorService } from '../subscribers/services/subscriber-executor.service';
import { AutomationSchedulerService } from '../subscribers/services/automation-scheduler.service';
import { EventsService } from '../events/services/events.service';
import { EventLogService } from '../events/services/event-log.service';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { TmuxService } from '../terminal/services/tmux.service';
import { SessionsService } from '../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../sessions/services/session-coordinator.service';
import { TerminalSendCoordinatorService } from '../terminal/services/terminal-send-coordinator.service';
import { SessionsMessagePoolService } from '../sessions/services/sessions-message-pool.service';
import type { Watcher, Subscriber, Agent } from '../storage/models/domain.models';
import type { SessionDto } from '../sessions/dtos/sessions.dto';

/**
 * End-to-end integration test for the watcher → subscriber flow.
 *
 * Tests the complete automation pipeline:
 * 1. Watcher polls terminal viewport
 * 2. Pattern matches → event published
 * 3. Subscriber receives event
 * 4. Subscriber executes action (sends message to terminal)
 */
describe('Watcher → Subscriber E2E Flow', () => {
  let module: TestingModule;
  let watcherRunner: WatcherRunnerService;

  // Mocks
  let mockStorage: {
    listEnabledWatchers: jest.Mock;
    getWatcher: jest.Mock;
    listAgents: jest.Mock;
    getAgentProfile: jest.Mock;
    getAgent: jest.Mock;
    getSubscriber: jest.Mock;
    findSubscribersByEventName: jest.Mock;
  };
  let mockTmuxService: {
    capturePane: jest.Mock;
    pasteAndSubmit: jest.Mock;
  };
  let mockSessionsService: {
    listActiveSessions: jest.Mock;
    getSession: jest.Mock;
  };
  let mockSessionCoordinator: {
    withAgentLock: jest.Mock;
  };
  let mockEventLogService: {
    recordPublished: jest.Mock;
    recordHandledOk: jest.Mock;
    recordHandledFail: jest.Mock;
  };
  let mockSendCoordinator: {
    ensureAgentGap: jest.Mock;
  };

  // Test data factories
  const createMockWatcher = (overrides: Partial<Watcher> = {}): Watcher => ({
    id: 'watcher-1',
    projectId: 'project-1',
    name: 'Test Watcher',
    description: null,
    enabled: true,
    scope: 'all',
    scopeFilterId: null,
    pollIntervalMs: 1000,
    viewportLines: 50,
    condition: { type: 'contains', pattern: 'test pattern' },
    cooldownMs: 5000,
    cooldownMode: 'time',
    eventName: 'test.event',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  // T3-FIX: Add immediate: true to actionInputs so messages bypass pool and call pasteAndSubmit directly
  const createMockSubscriber = (overrides: Partial<Subscriber> = {}): Subscriber => ({
    id: 'subscriber-1',
    projectId: 'project-1',
    name: 'Test Subscriber',
    description: null,
    enabled: true,
    eventName: 'test.event',
    eventFilter: null,
    actionType: 'send_agent_message',
    actionInputs: {
      text: { source: 'custom', customValue: '/compact' },
      immediate: { source: 'custom', customValue: 'true' },
    },
    delayMs: 0,
    cooldownMs: 0,
    retryOnError: false,
    groupName: null,
    position: 0,
    priority: 0,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  const createMockSession = (overrides: Partial<SessionDto> = {}): SessionDto => ({
    id: 'session-1',
    epicId: null,
    agentId: 'agent-1',
    tmuxSessionId: 'tmux-session-1',
    status: 'running',
    startedAt: '2024-01-01T00:00:00Z',
    endedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  const createMockAgent = (overrides: Partial<Agent> = {}): Agent => ({
    id: 'agent-1',
    name: 'Test Agent',
    profileId: 'profile-1',
    projectId: 'project-1',
    description: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  });

  /** Wait for the event emitter to process events */
  const waitForEvents = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Helper to set up subscribers with proper getSubscriber mock */
  const setUpSubscribers = (subscribers: Subscriber[]) => {
    mockStorage.findSubscribersByEventName.mockResolvedValue(subscribers);
    // Also set up getSubscriber to return the subscriber by ID (for freshness check)
    const subscriberMap = new Map(subscribers.map((s) => [s.id, s]));
    mockStorage.getSubscriber.mockImplementation(
      async (id: string) => subscriberMap.get(id) ?? null,
    );
  };

  beforeEach(async () => {
    // Initialize mocks
    mockStorage = {
      listEnabledWatchers: jest.fn().mockResolvedValue([]),
      getWatcher: jest.fn().mockResolvedValue(null),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 }),
      getAgentProfile: jest.fn().mockResolvedValue(null),
      getAgent: jest.fn().mockResolvedValue(createMockAgent()),
      getSubscriber: jest.fn().mockResolvedValue(null),
      findSubscribersByEventName: jest.fn().mockResolvedValue([]),
    };

    mockTmuxService = {
      capturePane: jest.fn().mockResolvedValue(''),
      pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
    };

    mockSessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([]),
      getSession: jest.fn().mockReturnValue(null),
    };

    mockSessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation(async (_agentId, fn) => fn()),
    };

    mockEventLogService = {
      recordPublished: jest.fn().mockImplementation(async () => ({
        id: `event-${Date.now()}`,
        publishedAt: new Date().toISOString(),
      })),
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'handler-1' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'handler-2' }),
    };

    mockSendCoordinator = {
      ensureAgentGap: jest.fn().mockResolvedValue(undefined),
    };

    // Build test module with real EventEmitter2
    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: false, maxListeners: 20 })],
      providers: [
        WatcherRunnerService,
        SubscriberExecutorService,
        AutomationSchedulerService,
        EventsService,
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorage,
        },
        {
          provide: TmuxService,
          useValue: mockTmuxService,
        },
        {
          provide: SessionsService,
          useValue: mockSessionsService,
        },
        {
          provide: SessionCoordinatorService,
          useValue: mockSessionCoordinator,
        },
        {
          provide: EventLogService,
          useValue: mockEventLogService,
        },
        {
          provide: TerminalSendCoordinatorService,
          useValue: mockSendCoordinator,
        },
        // T3-FIX: Add missing SessionsMessagePoolService dependency for SubscriberExecutorService
        // The mock simulates immediate delivery: returns { status: 'delivered' } and calls pasteAndSubmit
        {
          provide: SessionsMessagePoolService,
          useFactory: () => ({
            enqueue: jest
              .fn()
              .mockImplementation(
                async (agentId: string, text: string, options: { submitKeys?: string[] } = {}) => {
                  // Simulate immediate delivery by calling pasteAndSubmit directly
                  const session = mockSessionsService.getSession();
                  if (session?.tmuxSessionId) {
                    await mockSessionCoordinator.withAgentLock(agentId, async () => {
                      await mockSendCoordinator.ensureAgentGap(agentId, 500);
                      await mockTmuxService.pasteAndSubmit(session.tmuxSessionId, text, {
                        bracketed: true,
                        submitKeys: options.submitKeys ?? ['Enter'],
                      });
                    });
                  }
                  return { status: 'delivered' };
                },
              ),
            getMessageLog: jest.fn().mockReturnValue([]),
          }),
        },
      ],
    }).compile();

    // Initialize the module to set up event listeners
    await module.init();

    watcherRunner = module.get<WatcherRunnerService>(WatcherRunnerService);
  });

  afterEach(async () => {
    // Clean up intervals and state
    await watcherRunner.onModuleDestroy();
    await module.close();
    jest.clearAllMocks();
  });

  describe('Full Flow: Watcher triggers Subscriber action', () => {
    it('should execute subscriber action when watcher pattern matches', async () => {
      // Setup
      const watcher = createMockWatcher({
        condition: { type: 'contains', pattern: 'ERROR:' },
        eventName: 'error.detected',
      });
      const subscriber = createMockSubscriber({
        eventName: 'error.detected',
        actionInputs: {
          text: { source: 'custom', customValue: '/fix-error' },
          immediate: { source: 'custom', customValue: 'true' },
        },
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue(
        'Some output\nERROR: Connection failed\nMore output',
      );
      setUpSubscribers([subscriber]);

      // Start watcher
      await watcherRunner.startWatcher(watcher);

      // Trigger poll cycle
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);

      // Wait for async event processing
      await waitForEvents(100);

      // Verify complete flow
      expect(mockTmuxService.capturePane).toHaveBeenCalledWith('tmux-session-1', 50, false);
      expect(mockEventLogService.recordPublished).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'terminal.watcher.triggered',
        }),
      );
      expect(mockStorage.findSubscribersByEventName).toHaveBeenCalledWith(
        'project-1',
        'error.detected',
      );
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-session-1',
        '/fix-error',
        expect.objectContaining({ bracketed: true }),
      );
    });
  });

  describe('Cooldown prevents re-trigger', () => {
    it('should not re-trigger watcher within cooldown period (time mode)', async () => {
      const watcher = createMockWatcher({
        cooldownMs: 60000,
        cooldownMode: 'time',
        condition: { type: 'contains', pattern: 'error' },
      });
      const subscriber = createMockSubscriber();
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('error occurred');
      setUpSubscribers([subscriber]);

      await watcherRunner.startWatcher(watcher);

      // First poll - triggers
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents();
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);

      // Change content
      mockTmuxService.capturePane.mockResolvedValue('error occurred again');

      // Second poll - blocked by cooldown
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents();
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('until_clear cooldown mode', () => {
    it('should block re-trigger while condition is still matching', async () => {
      const watcher = createMockWatcher({
        cooldownMode: 'until_clear',
        cooldownMs: 0,
        condition: { type: 'contains', pattern: 'error' },
      });
      const subscriber = createMockSubscriber();
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      setUpSubscribers([subscriber]);

      await watcherRunner.startWatcher(watcher);

      // First: pattern matches → triggers
      mockTmuxService.capturePane.mockResolvedValue('error in log');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents();
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);

      // Second: pattern still matches with different content → blocked by until_clear
      mockTmuxService.capturePane.mockResolvedValue('another error occurred');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents();
      // Still only 1 - blocked because condition was already true
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('Subscriber event filter', () => {
    it('should skip subscriber when filter does not match', async () => {
      const watcher = createMockWatcher({
        eventName: 'test.event',
        condition: { type: 'contains', pattern: 'trigger' },
      });
      const subscriber = createMockSubscriber({
        eventName: 'test.event',
        eventFilter: { field: 'agentName', operator: 'equals', value: 'Other Agent' },
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('trigger this');
      setUpSubscribers([subscriber]);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      // Event published but subscriber filtered out
      expect(mockEventLogService.recordPublished).toHaveBeenCalled();
      expect(mockTmuxService.pasteAndSubmit).not.toHaveBeenCalled();
    });

    it('should execute subscriber when filter matches', async () => {
      const watcher = createMockWatcher({
        eventName: 'test.event',
        condition: { type: 'contains', pattern: 'trigger' },
      });
      const subscriber = createMockSubscriber({
        eventName: 'test.event',
        eventFilter: { field: 'agentName', operator: 'equals', value: 'Test Agent' },
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('trigger this');
      setUpSubscribers([subscriber]);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalled();
    });
  });

  describe('Disabled entities are skipped', () => {
    it('should skip disabled subscriber', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'contains', pattern: 'error' },
      });
      const subscriber = createMockSubscriber({ enabled: false });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('error occurred');
      setUpSubscribers([subscriber]);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      expect(mockEventLogService.recordPublished).toHaveBeenCalled();
      expect(mockTmuxService.pasteAndSubmit).not.toHaveBeenCalled();
    });
  });

  describe('Multiple subscribers for same event', () => {
    it('should execute all matching subscribers', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'contains', pattern: 'trigger' },
        eventName: 'multi.event',
      });
      const subscriber1 = createMockSubscriber({
        id: 'sub-1',
        eventName: 'multi.event',
        actionInputs: {
          text: { source: 'custom', customValue: 'action1' },
          immediate: { source: 'custom', customValue: 'true' },
        },
      });
      const subscriber2 = createMockSubscriber({
        id: 'sub-2',
        eventName: 'multi.event',
        actionInputs: {
          text: { source: 'custom', customValue: 'action2' },
          immediate: { source: 'custom', customValue: 'true' },
        },
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('trigger this');
      setUpSubscribers([subscriber1, subscriber2]);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledTimes(2);
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-session-1',
        'action1',
        expect.any(Object),
      );
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-session-1',
        'action2',
        expect.any(Object),
      );
    });

    it('should isolate errors between subscribers', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'contains', pattern: 'trigger' },
        eventName: 'error.test',
      });
      const subscriber1 = createMockSubscriber({
        id: 'sub-fail',
        eventName: 'error.test',
        actionInputs: {
          text: { source: 'custom', customValue: 'fail' },
          immediate: { source: 'custom', customValue: 'true' },
        },
      });
      const subscriber2 = createMockSubscriber({
        id: 'sub-success',
        eventName: 'error.test',
        actionInputs: {
          text: { source: 'custom', customValue: 'succeed' },
          immediate: { source: 'custom', customValue: 'true' },
        },
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('trigger this');
      setUpSubscribers([subscriber1, subscriber2]);

      // First subscriber fails, second succeeds
      mockTmuxService.pasteAndSubmit
        .mockRejectedValueOnce(new Error('First subscriber failed'))
        .mockResolvedValueOnce(undefined);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      // Both attempted despite first failing
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledTimes(2);
    });
  });

  describe('Pattern matching', () => {
    it('should match regex patterns', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'regex', pattern: 'ERROR:\\s+\\d+' },
        eventName: 'regex.match',
      });
      const subscriber = createMockSubscriber({ eventName: 'regex.match' });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('Log: ERROR: 42 occurred');
      setUpSubscribers([subscriber]);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalled();
    });

    it('should trigger when pattern is NOT found (not_contains)', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'not_contains', pattern: 'success' },
        eventName: 'no.success',
      });
      const subscriber = createMockSubscriber({ eventName: 'no.success' });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('Something failed');
      setUpSubscribers([subscriber]);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalled();
    });
  });

  describe('Hash-based deduplication', () => {
    it('should not re-trigger on same viewport content', async () => {
      const watcher = createMockWatcher({
        cooldownMs: 0,
        condition: { type: 'contains', pattern: 'error' },
      });
      const subscriber = createMockSubscriber();
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('error in viewport');
      setUpSubscribers([subscriber]);

      await watcherRunner.startWatcher(watcher);

      // First poll
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents();
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);

      // Second poll with SAME content - blocked by hash dedup
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents();
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('Subscriber freshness rules (execution-time state)', () => {
    it('should skip execution when subscriber is deleted between scheduling and execution', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'contains', pattern: 'trigger' },
        eventName: 'freshness.deleted',
      });
      const subscriber = createMockSubscriber({
        id: 'sub-to-delete',
        eventName: 'freshness.deleted',
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('trigger this');

      // Schedule phase: subscriber exists
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);
      // Execution phase: subscriber is now deleted (getSubscriber returns null)
      mockStorage.getSubscriber.mockResolvedValue(null);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      // Event should be published (watcher triggered)
      expect(mockEventLogService.recordPublished).toHaveBeenCalled();
      // But action should NOT be executed (subscriber was deleted)
      expect(mockTmuxService.pasteAndSubmit).not.toHaveBeenCalled();
    });

    it('should skip execution when subscriber is disabled between scheduling and execution', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'contains', pattern: 'trigger' },
        eventName: 'freshness.disabled',
      });
      const subscriberEnabled = createMockSubscriber({
        id: 'sub-to-disable',
        eventName: 'freshness.disabled',
        enabled: true,
      });
      const subscriberDisabled = createMockSubscriber({
        id: 'sub-to-disable',
        eventName: 'freshness.disabled',
        enabled: false, // Disabled after scheduling
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('trigger this');

      // Schedule phase: subscriber is enabled
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriberEnabled]);
      // Execution phase: subscriber is now disabled
      mockStorage.getSubscriber.mockResolvedValue(subscriberDisabled);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      // Event should be published
      expect(mockEventLogService.recordPublished).toHaveBeenCalled();
      // But action should NOT be executed (subscriber was disabled)
      expect(mockTmuxService.pasteAndSubmit).not.toHaveBeenCalled();
    });

    it('should use updated config when subscriber is modified between scheduling and execution', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'contains', pattern: 'trigger' },
        eventName: 'freshness.updated',
      });
      const subscriberOriginal = createMockSubscriber({
        id: 'sub-to-update',
        eventName: 'freshness.updated',
        actionInputs: {
          text: { source: 'custom', customValue: 'original-message' },
          immediate: { source: 'custom', customValue: 'true' },
        },
      });
      const subscriberUpdated = createMockSubscriber({
        id: 'sub-to-update',
        eventName: 'freshness.updated',
        actionInputs: {
          text: { source: 'custom', customValue: 'updated-message' },
          immediate: { source: 'custom', customValue: 'true' },
        },
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('trigger this');

      // Schedule phase: subscriber has original config
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriberOriginal]);
      // Execution phase: subscriber has updated config
      mockStorage.getSubscriber.mockResolvedValue(subscriberUpdated);

      await watcherRunner.startWatcher(watcher);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (watcherRunner as any).pollWatcher(watcher.id);
      await waitForEvents(100);

      // Should execute with UPDATED message, not original
      expect(mockTmuxService.pasteAndSubmit).toHaveBeenCalledWith(
        'tmux-session-1',
        'updated-message',
        expect.any(Object),
      );
    });

    it('should not crash when subscriber is removed while tasks are queued', async () => {
      const watcher = createMockWatcher({
        condition: { type: 'contains', pattern: 'trigger' },
        eventName: 'freshness.crash-test',
      });
      const subscriber = createMockSubscriber({
        id: 'sub-removed',
        eventName: 'freshness.crash-test',
      });
      const session = createMockSession();

      mockSessionsService.listActiveSessions.mockResolvedValue([session]);
      mockSessionsService.getSession.mockReturnValue(session);
      mockTmuxService.capturePane.mockResolvedValue('trigger this');

      // Schedule phase: subscriber exists
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);
      // Execution phase: subscriber is gone (simulates deletion mid-queue)
      mockStorage.getSubscriber.mockResolvedValue(null);

      // Should not throw
      await expect(async () => {
        await watcherRunner.startWatcher(watcher);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (watcherRunner as any).pollWatcher(watcher.id);
        await waitForEvents(100);
      }).not.toThrow();

      // Gracefully skipped without executing
      expect(mockTmuxService.pasteAndSubmit).not.toHaveBeenCalled();
    });
  });
});
