import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SubscriberExecutorService,
  type SubscriberExecutionResult,
  type SubscribableEventPayload,
} from './subscriber-executor.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Subscriber, EventFilter, ActionInput } from '../../storage/models/domain.models';
import type { TerminalWatcherTriggeredEventPayload } from '../../events/catalog/terminal.watcher.triggered';
import { TmuxService } from '../../terminal/services/tmux.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import { SessionsMessagePoolService } from '../../sessions/services/sessions-message-pool.service';
import { EventLogService } from '../../events/services/event-log.service';
import { AutomationSchedulerService } from './automation-scheduler.service';
import * as actionsRegistry from '../actions/actions.registry';
import type { ActionDefinition, ActionResult } from '../actions/action.interface';
import * as eventFieldsCatalog from '../events/event-fields-catalog';
import * as eventsService from '../../events/services/events.service';

describe('SubscriberExecutorService', () => {
  let service: SubscriberExecutorService;
  let mockStorage: jest.Mocked<
    Pick<StorageService, 'findSubscribersByEventName' | 'getSubscriber' | 'getAgent'>
  >;
  let mockTmuxService: jest.Mocked<Pick<TmuxService, 'pasteAndSubmit'>>;
  let mockSessionsService: jest.Mocked<Pick<SessionsService, 'getSession'>>;
  let mockSessionCoordinator: jest.Mocked<Pick<SessionCoordinatorService, 'withAgentLock'>>;
  let mockSendCoordinator: jest.Mocked<Pick<TerminalSendCoordinatorService, 'ensureAgentGap'>>;
  let mockMessagePoolService: jest.Mocked<Pick<SessionsMessagePoolService, 'enqueue'>>;
  let mockEventLogService: jest.Mocked<
    Pick<EventLogService, 'recordHandledOk' | 'recordHandledFail'>
  >;
  let mockEventEmitter: jest.Mocked<Pick<EventEmitter2, 'onAny' | 'offAny'>>;
  let mockScheduler: jest.Mocked<Pick<AutomationSchedulerService, 'schedule'>>;

  const createMockPayload = (
    overrides: Partial<TerminalWatcherTriggeredEventPayload> = {},
  ): TerminalWatcherTriggeredEventPayload => ({
    watcherId: 'watcher-1',
    watcherName: 'Test Watcher',
    customEventName: 'test.event',
    sessionId: 'session-123',
    agentId: 'agent-456',
    agentName: 'Test Agent',
    projectId: 'project-789',
    viewportSnippet: 'Error: Something went wrong',
    viewportHash: 'hash123',
    triggerCount: 1,
    triggeredAt: new Date().toISOString(),
    ...overrides,
  });

  const createMockSubscriber = (overrides: Partial<Subscriber> = {}): Subscriber => ({
    id: 'subscriber-1',
    projectId: 'project-789',
    name: 'Test Subscriber',
    description: null,
    enabled: true,
    eventName: 'test.event',
    eventFilter: null,
    actionType: 'send_agent_message',
    actionInputs: { text: { source: 'custom', customValue: 'Hello' } },
    delayMs: 0,
    cooldownMs: 0,
    retryOnError: false,
    groupName: null,
    position: 0,
    priority: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  });

  const createMockExecutionResult = (
    subscriber: Subscriber,
    overrides: Partial<SubscriberExecutionResult> = {},
  ): SubscriberExecutionResult => ({
    subscriberId: subscriber.id,
    subscriberName: subscriber.name,
    actionType: subscriber.actionType,
    success: true,
    durationMs: 10,
    ...overrides,
  });

  beforeEach(async () => {
    mockStorage = {
      findSubscribersByEventName: jest.fn().mockResolvedValue([]),
      getSubscriber: jest.fn().mockResolvedValue(null),
      getAgent: jest.fn().mockResolvedValue({
        id: 'agent-456',
        projectId: 'project-789',
        profileId: 'profile-1',
        name: 'Test Agent',
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    };

    mockEventEmitter = {
      onAny: jest.fn(),
      offAny: jest.fn(),
    };

    mockScheduler = {
      schedule: jest.fn(),
    };

    mockTmuxService = {
      pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
    };

    mockSessionsService = {
      getSession: jest.fn().mockReturnValue({
        id: 'session-123',
        tmuxSessionId: 'tmux-session-1',
        status: 'running',
        epicId: null,
        agentId: 'agent-456',
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    };

    mockSessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation(async (_agentId, fn) => fn()),
    };

    mockSendCoordinator = {
      ensureAgentGap: jest.fn().mockResolvedValue(undefined),
    };

    mockMessagePoolService = {
      enqueue: jest.fn().mockResolvedValue({ status: 'queued', poolSize: 1 }),
    };

    mockEventLogService = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'handler-1' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'handler-2' }),
    };

    // Mock getEventMetadata to return null by default (no eventId)
    jest.spyOn(eventsService, 'getEventMetadata').mockReturnValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriberExecutorService,
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
          provide: TerminalSendCoordinatorService,
          useValue: mockSendCoordinator,
        },
        {
          provide: SessionsMessagePoolService,
          useValue: mockMessagePoolService,
        },
        {
          provide: EventLogService,
          useValue: mockEventLogService,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
        {
          provide: AutomationSchedulerService,
          useValue: mockScheduler,
        },
      ],
    }).compile();

    service = module.get<SubscriberExecutorService>(SubscriberExecutorService);
  });

  describe('onModuleInit', () => {
    it('should initialize without errors', async () => {
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });

    it('should not cause unhandledRejection when scheduling fails from onAny handler', async () => {
      jest.spyOn(eventFieldsCatalog, 'isSubscribableEvent').mockReturnValue(true);

      const unhandledRejection = jest.fn();
      process.on('unhandledRejection', unhandledRejection);

      try {
        await service.onModuleInit();

        const onAnyHandler = mockEventEmitter.onAny.mock.calls[0]?.[0] as
          | ((eventName: string | string[], ...args: unknown[]) => void)
          | undefined;
        expect(typeof onAnyHandler).toBe('function');

        mockStorage.findSubscribersByEventName.mockRejectedValueOnce(new Error('storage failed'));

        onAnyHandler?.('terminal.watcher.triggered', createMockPayload());

        // Allow promise rejection to be observed if it were unhandled.
        await new Promise<void>((r) => setTimeout(r, 0));

        expect(unhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandledRejection);
      }
    });
  });

  describe('handleEvent', () => {
    beforeEach(() => {
      // Mock isSubscribableEvent to return true for test events
      jest.spyOn(eventFieldsCatalog, 'isSubscribableEvent').mockReturnValue(true);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return null for non-subscribable events', async () => {
      jest.spyOn(eventFieldsCatalog, 'isSubscribableEvent').mockReturnValue(false);
      const payload = createMockPayload();

      const result = await service.handleEvent('unknown.event', payload);

      expect(result).toBeNull();
      expect(mockStorage.findSubscribersByEventName).not.toHaveBeenCalled();
    });

    it('should return null when projectId cannot be resolved (no projectId and no session)', async () => {
      const payload = {} as SubscribableEventPayload;

      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(result).toBeNull();
    });

    it('should resolve projectId via session lookup when payload missing projectId', async () => {
      // Payload has sessionId but no projectId
      const payload = { sessionId: 'session-123' } as SubscribableEventPayload;

      // Session has agentId, agent has projectId
      mockSessionsService.getSession.mockReturnValue({
        id: 'session-123',
        tmuxSessionId: 'tmux-session-1',
        status: 'running',
        epicId: null,
        agentId: 'agent-456',
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      mockStorage.getAgent.mockResolvedValue({
        id: 'agent-456',
        projectId: 'resolved-project-id',
        profileId: 'profile-1',
        name: 'Test Agent',
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await service.handleEvent('terminal.watcher.triggered', payload);

      // Should have looked up via session -> agent -> projectId
      expect(mockSessionsService.getSession).toHaveBeenCalledWith('session-123');
      expect(mockStorage.getAgent).toHaveBeenCalledWith('agent-456');
      expect(mockStorage.findSubscribersByEventName).toHaveBeenCalledWith(
        'resolved-project-id',
        'terminal.watcher.triggered',
      );
    });

    it('should return null when session has no agent', async () => {
      const payload = { sessionId: 'session-123' } as SubscribableEventPayload;

      mockSessionsService.getSession.mockReturnValue({
        id: 'session-123',
        tmuxSessionId: 'tmux-session-1',
        status: 'running',
        epicId: null,
        agentId: null, // No agent
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(result).toBeNull();
      expect(mockStorage.getAgent).not.toHaveBeenCalled();
    });

    it('should return null when session not found during projectId resolution', async () => {
      const payload = { sessionId: 'nonexistent-session' } as SubscribableEventPayload;

      mockSessionsService.getSession.mockReturnValue(null);

      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(result).toBeNull();
    });

    it('should find subscribers by customEventName for terminal.watcher.triggered', async () => {
      const payload = createMockPayload({ customEventName: 'error.detected' });

      await service.handleEvent('terminal.watcher.triggered', payload);

      expect(mockStorage.findSubscribersByEventName).toHaveBeenCalledWith(
        'project-789',
        'error.detected',
      );
    });

    it('should find subscribers by event name for non-watcher events', async () => {
      const payload: SubscribableEventPayload = {
        projectId: 'project-789',
        epicId: 'epic-123',
        agentId: 'agent-456',
      };

      await service.handleEvent('epic.assigned', payload);

      expect(mockStorage.findSubscribersByEventName).toHaveBeenCalledWith(
        'project-789',
        'epic.assigned',
      );
    });

    it('should schedule enabled subscribers (no immediate execution)', async () => {
      const subscriber = createMockSubscriber({ enabled: true });
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);

      const executeSpy = jest
        .spyOn(service, 'executeSubscriber')
        .mockResolvedValue(createMockExecutionResult(subscriber));
      const payload = createMockPayload();

      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(result?.subscribersMatched).toBe(1);
      expect(result?.subscribersScheduled).toBe(1);
      expect(result?.subscribersSkipped).toBe(0);
      expect(mockScheduler.schedule).toHaveBeenCalledTimes(1);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('should skip disabled subscribers at scheduling time', async () => {
      const subscriber = createMockSubscriber({ enabled: false });
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);

      const executeSpy = jest
        .spyOn(service, 'executeSubscriber')
        .mockResolvedValue(createMockExecutionResult(subscriber));
      const payload = createMockPayload();

      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(executeSpy).not.toHaveBeenCalled();
      expect(mockScheduler.schedule).not.toHaveBeenCalled();
      expect(result?.subscribersMatched).toBe(1);
      expect(result?.subscribersScheduled).toBe(0);
      expect(result?.subscribersSkipped).toBe(1);
      expect(result?.skippedSubscribers[0].reason).toBe('disabled');
    });

    it('should check event filter before scheduling', async () => {
      const filter: EventFilter = { field: 'agentName', operator: 'equals', value: 'Wrong Agent' };
      const subscriber = createMockSubscriber({ eventFilter: filter });
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);

      const executeSpy = jest
        .spyOn(service, 'executeSubscriber')
        .mockResolvedValue(createMockExecutionResult(subscriber));
      const payload = createMockPayload({ agentName: 'Test Agent' });

      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(executeSpy).not.toHaveBeenCalled();
      expect(mockScheduler.schedule).not.toHaveBeenCalled();
      expect(result?.subscribersMatched).toBe(1);
      expect(result?.subscribersScheduled).toBe(0);
      expect(result?.subscribersSkipped).toBe(1);
      expect(result?.skippedSubscribers[0].reason).toBe('filter_not_matched');
    });

    it('should schedule subscriber when filter matches', async () => {
      const filter: EventFilter = { field: 'agentName', operator: 'equals', value: 'Test Agent' };
      const subscriber = createMockSubscriber({ eventFilter: filter });
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);

      const executeSpy = jest
        .spyOn(service, 'executeSubscriber')
        .mockResolvedValue(createMockExecutionResult(subscriber));
      const payload = createMockPayload({ agentName: 'Test Agent' });

      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(result?.subscribersMatched).toBe(1);
      expect(result?.subscribersScheduled).toBe(1);
      expect(result?.subscribersSkipped).toBe(0);
      expect(mockScheduler.schedule).toHaveBeenCalledTimes(1);
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('should handle no subscribers found', async () => {
      mockStorage.findSubscribersByEventName.mockResolvedValue([]);
      const payload = createMockPayload();

      const result = await service.handleEvent('terminal.watcher.triggered', payload);
      expect(result?.subscribersMatched).toBe(0);
      expect(result?.subscribersScheduled).toBe(0);
      expect(result?.subscribersSkipped).toBe(0);
      expect(mockScheduler.schedule).not.toHaveBeenCalled();
    });

    it('should schedule multiple subscribers in order', async () => {
      const subscriber1 = createMockSubscriber({ id: 'sub-1' });
      const subscriber2 = createMockSubscriber({ id: 'sub-2' });
      const subscriber3 = createMockSubscriber({ id: 'sub-3' });
      mockStorage.findSubscribersByEventName.mockResolvedValue([
        subscriber1,
        subscriber2,
        subscriber3,
      ]);

      const payload = createMockPayload();
      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(result?.subscribersMatched).toBe(3);
      expect(result?.subscribersScheduled).toBe(3);
      expect(result?.subscribersSkipped).toBe(0);
      expect(mockScheduler.schedule).toHaveBeenCalledTimes(3);
      expect(mockScheduler.schedule.mock.calls.map((c) => c[0].subscriberId)).toEqual([
        'sub-1',
        'sub-2',
        'sub-3',
      ]);
    });

    it('should return structured result with scheduling details', async () => {
      const subscriber = createMockSubscriber();
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);

      const payload = createMockPayload();
      const result = await service.handleEvent('terminal.watcher.triggered', payload);

      expect(result?.eventName).toBe('terminal.watcher.triggered');
      expect(result?.subscribersMatched).toBe(1);
      expect(result?.subscribersScheduled).toBe(1);
      expect(result?.subscribersSkipped).toBe(0);
      expect(result?.scheduledTasks).toHaveLength(1);
      expect(result?.scheduledTasks[0].subscriberId).toBe(subscriber.id);
      expect(result?.scheduledTasks[0].subscriberName).toBe(subscriber.name);
    });

    it('should call recordHandledOk when eventId is present', async () => {
      jest.spyOn(eventsService, 'getEventMetadata').mockReturnValue({ id: 'event-123' });
      const subscriber = createMockSubscriber();
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);

      const payload = createMockPayload();
      await service.handleEvent('terminal.watcher.triggered', payload);

      expect(mockEventLogService.recordHandledOk).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-123',
          handler: 'SubscriberExecutorService:schedule',
          detail: expect.objectContaining({
            matched: 1,
            scheduled: 1,
            skipped: 0,
          }),
        }),
      );
    });

    it('should not call recordHandledOk when eventId is not present', async () => {
      jest.spyOn(eventsService, 'getEventMetadata').mockReturnValue(null);
      const subscriber = createMockSubscriber();
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);

      jest
        .spyOn(service, 'executeSubscriber')
        .mockResolvedValue(createMockExecutionResult(subscriber));

      const payload = createMockPayload();
      await service.handleEvent('terminal.watcher.triggered', payload);

      expect(mockEventLogService.recordHandledOk).not.toHaveBeenCalled();
    });

    it('should call recordHandledFail when an error occurs and eventId is present', async () => {
      jest.spyOn(eventsService, 'getEventMetadata').mockReturnValue({ id: 'event-456' });
      mockStorage.findSubscribersByEventName.mockRejectedValue(new Error('Database error'));

      const payload = createMockPayload();
      await expect(service.handleEvent('terminal.watcher.triggered', payload)).rejects.toThrow(
        'Database error',
      );

      expect(mockEventLogService.recordHandledFail).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'event-456',
          handler: 'SubscriberExecutorService:schedule',
          detail: expect.objectContaining({
            error: 'Database error',
          }),
        }),
      );
    });
  });

  describe('getSubscribableEventNames', () => {
    it('should return list of subscribable events', () => {
      const events = service.getSubscribableEventNames();
      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      expect(events).toContain('terminal.watcher.triggered');
    });
  });

  describe('matchesFilter', () => {
    describe('equals operator', () => {
      it('should return true when field value equals filter value', () => {
        const filter: EventFilter = { field: 'agentName', operator: 'equals', value: 'Test Agent' };
        const payload = createMockPayload({ agentName: 'Test Agent' });

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });

      it('should return false when field value does not equal filter value', () => {
        const filter: EventFilter = {
          field: 'agentName',
          operator: 'equals',
          value: 'Other Agent',
        };
        const payload = createMockPayload({ agentName: 'Test Agent' });

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });

      it('should handle numeric fields converted to string', () => {
        const filter: EventFilter = { field: 'triggerCount', operator: 'equals', value: '5' };
        const payload = createMockPayload({ triggerCount: 5 });

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });
    });

    describe('contains operator', () => {
      it('should return true when field value contains filter value', () => {
        const filter: EventFilter = {
          field: 'viewportSnippet',
          operator: 'contains',
          value: 'Error',
        };
        const payload = createMockPayload({ viewportSnippet: 'Error: Something went wrong' });

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });

      it('should return false when field value does not contain filter value', () => {
        const filter: EventFilter = {
          field: 'viewportSnippet',
          operator: 'contains',
          value: 'Warning',
        };
        const payload = createMockPayload({ viewportSnippet: 'Error: Something went wrong' });

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });

      it('should be case-sensitive', () => {
        const filter: EventFilter = {
          field: 'viewportSnippet',
          operator: 'contains',
          value: 'error',
        };
        const payload = createMockPayload({ viewportSnippet: 'Error: Something went wrong' });

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });
    });

    describe('regex operator', () => {
      it('should return true when field value matches regex pattern', () => {
        const filter: EventFilter = {
          field: 'viewportSnippet',
          operator: 'regex',
          value: 'Error.*wrong',
        };
        const payload = createMockPayload({ viewportSnippet: 'Error: Something went wrong' });

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });

      it('should return false when field value does not match regex pattern', () => {
        const filter: EventFilter = {
          field: 'viewportSnippet',
          operator: 'regex',
          value: '^Warning',
        };
        const payload = createMockPayload({ viewportSnippet: 'Error: Something went wrong' });

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });

      it('should return false for invalid regex pattern', () => {
        const filter: EventFilter = {
          field: 'viewportSnippet',
          operator: 'regex',
          value: '[invalid(regex',
        };
        const payload = createMockPayload({ viewportSnippet: 'Error: Something went wrong' });

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });
    });

    describe('field access', () => {
      it('should return false for unknown fields', () => {
        const filter: EventFilter = { field: 'unknownField', operator: 'equals', value: 'test' };
        const payload = createMockPayload();

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });

      it('should return false for null field values', () => {
        const filter: EventFilter = { field: 'agentName', operator: 'equals', value: 'test' };
        const payload = createMockPayload({ agentName: null });

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });

      it('should access all known payload fields', () => {
        const fields = [
          'watcherId',
          'watcherName',
          'customEventName',
          'sessionId',
          'agentId',
          'agentName',
          'projectId',
          'viewportSnippet',
          'viewportHash',
          'triggerCount',
          'triggeredAt',
        ];

        for (const field of fields) {
          const filter: EventFilter = { field, operator: 'contains', value: '' };
          const payload = createMockPayload();

          // Should not throw and should return true for contains empty string
          expect(() => service.matchesFilter(filter, payload)).not.toThrow();
        }
      });

      it('should handle matchedPattern field when present', () => {
        const filter: EventFilter = {
          field: 'matchedPattern',
          operator: 'equals',
          value: 'Error.*',
        };
        const payload = createMockPayload({ matchedPattern: 'Error.*' });

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });
    });

    describe('nested field access', () => {
      it('should access nested fields with dot notation', () => {
        // Create a payload with nested structure by extending the mock
        const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
          nested: { value: string };
        };
        (payload as Record<string, unknown>).nested = { value: 'test-value' };

        const filter: EventFilter = {
          field: 'nested.value',
          operator: 'equals',
          value: 'test-value',
        };

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });

      it('should access deeply nested fields', () => {
        const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
          level1: { level2: { level3: string } };
        };
        (payload as Record<string, unknown>).level1 = { level2: { level3: 'deep-value' } };

        const filter: EventFilter = {
          field: 'level1.level2.level3',
          operator: 'equals',
          value: 'deep-value',
        };

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });

      it('should return false for non-existent nested paths', () => {
        const payload = createMockPayload();

        const filter: EventFilter = {
          field: 'nonexistent.nested.path',
          operator: 'equals',
          value: 'test',
        };

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });

      it('should return false when intermediate path is null', () => {
        const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
          nested: null;
        };
        (payload as Record<string, unknown>).nested = null;

        const filter: EventFilter = { field: 'nested.value', operator: 'equals', value: 'test' };

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });

      it('should return false when intermediate path is a primitive', () => {
        const payload = createMockPayload();

        // agentName is a string, so agentName.something should return undefined
        const filter: EventFilter = {
          field: 'agentName.something',
          operator: 'equals',
          value: 'test',
        };

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });

      it('should handle contains operator with nested fields', () => {
        const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
          data: { message: string };
        };
        (payload as Record<string, unknown>).data = { message: 'Error occurred in module' };

        const filter: EventFilter = {
          field: 'data.message',
          operator: 'contains',
          value: 'Error',
        };

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });

      it('should handle regex operator with nested fields', () => {
        const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
          data: { code: string };
        };
        (payload as Record<string, unknown>).data = { code: 'ERR-1234' };

        const filter: EventFilter = {
          field: 'data.code',
          operator: 'regex',
          value: '^ERR-\\d+$',
        };

        expect(service.matchesFilter(filter, payload)).toBe(true);
      });
    });

    describe('unknown operator', () => {
      it('should return false for unknown operator', () => {
        const filter = {
          field: 'agentName',
          operator: 'unknown' as EventFilter['operator'],
          value: 'test',
        };
        const payload = createMockPayload();

        expect(service.matchesFilter(filter, payload)).toBe(false);
      });
    });
  });

  describe('cooldown tracking', () => {
    describe('isOnCooldown', () => {
      it('should return false when cooldownMs is 0', () => {
        expect(service.isOnCooldown('sub-1', 'session-1', 0)).toBe(false);
      });

      it('should return false when cooldownMs is negative', () => {
        expect(service.isOnCooldown('sub-1', 'session-1', -1000)).toBe(false);
      });

      it('should return false when no previous execution', () => {
        expect(service.isOnCooldown('sub-1', 'session-1', 5000)).toBe(false);
      });

      it('should return true when within cooldown period', () => {
        service.setCooldown('sub-1', 'session-1');

        expect(service.isOnCooldown('sub-1', 'session-1', 60000)).toBe(true);
      });

      it('should return false when cooldown has expired', async () => {
        // Use fake timers to test cooldown expiry
        jest.useFakeTimers();

        service.setCooldown('sub-1', 'session-1');

        // Advance time past cooldown
        jest.advanceTimersByTime(5001);

        expect(service.isOnCooldown('sub-1', 'session-1', 5000)).toBe(false);

        jest.useRealTimers();
      });

      it('should track cooldown per subscriber+session pair', () => {
        service.setCooldown('sub-1', 'session-1');
        service.setCooldown('sub-1', 'session-2');
        service.setCooldown('sub-2', 'session-1');

        expect(service.isOnCooldown('sub-1', 'session-1', 60000)).toBe(true);
        expect(service.isOnCooldown('sub-1', 'session-2', 60000)).toBe(true);
        expect(service.isOnCooldown('sub-2', 'session-1', 60000)).toBe(true);
        expect(service.isOnCooldown('sub-2', 'session-2', 60000)).toBe(false);
      });
    });

    describe('setCooldown', () => {
      it('should set cooldown timestamp', () => {
        service.setCooldown('sub-1', 'session-1');

        expect(service.isOnCooldown('sub-1', 'session-1', 60000)).toBe(true);
      });

      it('should update existing cooldown', () => {
        jest.useFakeTimers();

        service.setCooldown('sub-1', 'session-1');
        jest.advanceTimersByTime(3000);

        // Update cooldown
        service.setCooldown('sub-1', 'session-1');

        // Should still be on cooldown from the new timestamp
        jest.advanceTimersByTime(3000);
        expect(service.isOnCooldown('sub-1', 'session-1', 5000)).toBe(true);

        jest.useRealTimers();
      });
    });

    describe('clearCooldown', () => {
      it('should clear cooldown for subscriber+session', () => {
        service.setCooldown('sub-1', 'session-1');
        expect(service.isOnCooldown('sub-1', 'session-1', 60000)).toBe(true);

        service.clearCooldown('sub-1', 'session-1');
        expect(service.isOnCooldown('sub-1', 'session-1', 60000)).toBe(false);
      });

      it('should not affect other subscriber+session pairs', () => {
        service.setCooldown('sub-1', 'session-1');
        service.setCooldown('sub-1', 'session-2');

        service.clearCooldown('sub-1', 'session-1');

        expect(service.isOnCooldown('sub-1', 'session-1', 60000)).toBe(false);
        expect(service.isOnCooldown('sub-1', 'session-2', 60000)).toBe(true);
      });

      it('should handle clearing non-existent cooldown', () => {
        expect(() => service.clearCooldown('sub-1', 'session-1')).not.toThrow();
      });
    });
  });

  describe('executeSubscriber', () => {
    let mockAction: ActionDefinition;
    let mockExecute: jest.Mock<Promise<ActionResult>>;

    beforeEach(() => {
      mockExecute = jest.fn().mockResolvedValue({ success: true });
      mockAction = {
        type: 'send_agent_message',
        name: 'Send Message',
        description: 'Send a message',
        category: 'terminal',
        inputs: [],
        execute: mockExecute,
      };
      jest.spyOn(actionsRegistry, 'getAction').mockReturnValue(mockAction);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    describe('cooldown checking', () => {
      it('should skip execution when subscriber is on cooldown', async () => {
        const subscriber = createMockSubscriber({ cooldownMs: 60000 });
        const payload = createMockPayload();

        // Set cooldown
        service.setCooldown(subscriber.id, payload.sessionId);

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).not.toHaveBeenCalled();
      });

      it('should execute when cooldown is 0', async () => {
        const subscriber = createMockSubscriber({ cooldownMs: 0 });
        const payload = createMockPayload();

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalled();
      });

      it('should set cooldown after execution', async () => {
        const subscriber = createMockSubscriber({ cooldownMs: 5000 });
        const payload = createMockPayload();

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(service.isOnCooldown(subscriber.id, payload.sessionId, 5000)).toBe(true);
      });

      it('should set cooldown even on action failure', async () => {
        mockExecute.mockResolvedValue({ success: false, error: 'Action failed' });
        const subscriber = createMockSubscriber({ cooldownMs: 5000, retryOnError: false });
        const payload = createMockPayload();

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(service.isOnCooldown(subscriber.id, payload.sessionId, 5000)).toBe(true);
      });
    });

    describe('action lookup', () => {
      it('should return error result for unknown action type', async () => {
        jest.spyOn(actionsRegistry, 'getAction').mockReturnValue(undefined);
        const subscriber = createMockSubscriber({ actionType: 'unknown_action' });
        const payload = createMockPayload();

        const result = await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(result.success).toBe(false);
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toBe('action_not_found');
        expect(result.error).toBe('Unknown action type: unknown_action');
      });

      it('should get action from registry', async () => {
        const subscriber = createMockSubscriber({ actionType: 'send_agent_message' });
        const payload = createMockPayload();

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(actionsRegistry.getAction).toHaveBeenCalledWith('send_agent_message');
      });
    });

    describe('delay semantics', () => {
      afterEach(() => {
        jest.useRealTimers();
      });

      it('should not sleep at execution time even when delayMs is set', async () => {
        jest.useFakeTimers();

        const subscriber = createMockSubscriber({ delayMs: 1000 });
        const payload = createMockPayload();

        const executePromise = service.executeSubscriber(subscriber, 'test.event', payload);
        await Promise.resolve(); // allow execution past the initial await

        const timerCount = jest.getTimerCount();
        if (timerCount > 0) {
          await jest.runOnlyPendingTimersAsync();
        }

        const result = await executePromise;

        expect(timerCount).toBe(0);
        expect(result.success).toBe(true);
        expect(mockExecute).toHaveBeenCalled();
      });
    });

    describe('input resolution', () => {
      it('should resolve inputs and pass to action', async () => {
        const subscriber = createMockSubscriber({
          actionInputs: {
            text: { source: 'custom', customValue: 'Hello World' },
            session: { source: 'event_field', eventField: 'sessionId' },
          },
        });
        const payload = createMockPayload({ sessionId: 'test-session' });

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            text: 'Hello World',
            session: 'test-session',
          }),
        );
      });

      it('should ignore legacy restart_agent agentId input mapping', async () => {
        const subscriber = createMockSubscriber({
          actionType: 'restart_agent',
          actionInputs: {
            agentId: { source: 'custom', customValue: 'legacy-agent-id' },
          } as Record<string, ActionInput>,
        });
        const payload = createMockPayload();

        mockAction = {
          type: 'restart_agent',
          name: 'Restart Agent',
          description: 'Restart agent',
          category: 'session',
          inputs: [{ name: 'agentName', label: 'Agent Name', type: 'string', required: false }],
          execute: mockExecute,
        };
        jest.spyOn(actionsRegistry, 'getAction').mockReturnValue(mockAction);

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalledWith(
          expect.any(Object),
          expect.not.objectContaining({ agentId: expect.anything() }),
        );
      });

      it('should resolve template vars from EventEnvelope common fields (e.g., projectId)', async () => {
        const subscriber = createMockSubscriber({
          actionInputs: {
            text: { source: 'custom', customValue: 'P={{projectId}} E={{eventName}}' },
            proj: { source: 'event_field', eventField: 'projectId' },
            ev: { source: 'event_field', eventField: 'eventName' },
          },
        });

        // Payload intentionally lacks projectId (it will be resolved via session -> agent lookup)
        const payload = {
          sessionId: 'session-123',
          agentId: 'agent-456',
        } as unknown as SubscribableEventPayload;

        mockSessionsService.getSession.mockReturnValue({
          id: 'session-123',
          tmuxSessionId: 'tmux-session-1',
          status: 'running',
          epicId: null,
          agentId: 'agent-456',
          startedAt: new Date().toISOString(),
          endedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        mockStorage.getAgent.mockResolvedValue({
          id: 'agent-456',
          projectId: 'resolved-project-id',
          profileId: 'profile-1',
          name: 'Test Agent',
          description: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            text: 'P=resolved-project-id E=test.event',
            proj: 'resolved-project-id',
            ev: 'test.event',
          }),
        );
      });

      it('should interpolate {{sessionIdShort}} to 8-char prefix when sessionId present', async () => {
        const fullSessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
        const subscriber = createMockSubscriber({
          actionInputs: {
            text: {
              source: 'custom',
              customValue: 'Session: {{sessionIdShort}} Full: {{sessionId}}',
            },
          },
        });

        const payload = createMockPayload({ sessionId: fullSessionId });

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            text: `Session: a1b2c3d4 Full: ${fullSessionId}`,
          }),
        );
      });

      it('should interpolate {{sessionIdShort}} to empty string when sessionId missing', async () => {
        const subscriber = createMockSubscriber({
          actionInputs: {
            text: {
              source: 'custom',
              customValue: 'Session: [{{sessionIdShort}}] end',
            },
          },
        });

        // Payload without sessionId
        const payload = createMockPayload({ sessionId: undefined });

        // Mock session lookup to return null (no session)
        mockSessionsService.getSession.mockReturnValue(null);

        // Since session is not found, executeSubscriber will return early with error
        // We need to test the interpolation path, so let's provide a mock session
        mockSessionsService.getSession.mockReturnValue({
          id: 'some-session',
          tmuxSessionId: 'tmux-session-1',
          status: 'running',
          epicId: null,
          agentId: 'agent-456',
          startedAt: new Date().toISOString(),
          endedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        // But payload.sessionId is undefined, so sessionIdShort should be empty
        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            text: 'Session: [] end',
          }),
        );
      });
    });

    describe('session validation', () => {
      it('should return error result when session not found', async () => {
        mockSessionsService.getSession.mockReturnValue(null);
        const subscriber = createMockSubscriber();
        const payload = createMockPayload({ sessionId: 'nonexistent' });

        const result = await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(result.success).toBe(false);
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toBe('session_error');
        expect(result.error).toBe('Session nonexistent not found');
      });

      it('should return error result when session has no tmux session', async () => {
        mockSessionsService.getSession.mockReturnValue({
          id: 'session-123',
          tmuxSessionId: null,
          status: 'running',
          epicId: null,
          agentId: null,
          startedAt: new Date().toISOString(),
          endedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const subscriber = createMockSubscriber();
        const payload = createMockPayload();

        const result = await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(result.success).toBe(false);
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toBe('session_error');
        expect(result.error).toBe('Session session-123 has no tmux session');
      });
    });

    describe('action context', () => {
      it('should build correct action context', async () => {
        const subscriber = createMockSubscriber();
        const payload = createMockPayload({
          sessionId: 'session-123',
          agentId: 'agent-456',
          projectId: 'project-789',
        });

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: 'session-123',
            agentId: 'agent-456',
            projectId: 'project-789',
            tmuxSessionName: 'tmux-session-1',
            event: expect.objectContaining({
              eventName: 'test.event',
              projectId: 'project-789',
              agentId: 'agent-456',
              sessionId: 'session-123',
              payload,
            }),
          }),
          expect.any(Object),
        );
      });

      it('should pass services in context', async () => {
        const subscriber = createMockSubscriber();
        const payload = createMockPayload();

        await service.executeSubscriber(subscriber, 'test.event', payload);

        const context = mockExecute.mock.calls[0][0];
        expect(context.tmuxService).toBeDefined();
        expect(context.sessionsService).toBeDefined();
        expect(context.sendCoordinator).toBeDefined();
        expect(context.logger).toBeDefined();
      });
    });

    describe('retry on error', () => {
      beforeEach(() => {
        jest.useFakeTimers();
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it('should retry once after 1s delay when retryOnError is enabled and action fails', async () => {
        mockExecute
          .mockResolvedValueOnce({ success: false, error: 'First failure' })
          .mockResolvedValueOnce({ success: true });

        const subscriber = createMockSubscriber({ retryOnError: true });
        const payload = createMockPayload();

        const executePromise = service.executeSubscriber(subscriber, 'test.event', payload);

        // Let initial async operations complete (projectId resolution, etc.)
        await jest.advanceTimersByTimeAsync(0);

        // First call should have happened after initial setup
        expect(mockExecute).toHaveBeenCalledTimes(1);

        // Advance timer for retry delay
        await jest.advanceTimersByTimeAsync(1000);
        await executePromise;

        expect(mockExecute).toHaveBeenCalledTimes(2);
      });

      it('should not retry when retryOnError is disabled', async () => {
        mockExecute.mockResolvedValue({ success: false, error: 'Failure' });

        const subscriber = createMockSubscriber({ retryOnError: false });
        const payload = createMockPayload();

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalledTimes(1);
      });

      it('should not retry when action succeeds', async () => {
        mockExecute.mockResolvedValue({ success: true });

        const subscriber = createMockSubscriber({ retryOnError: true });
        const payload = createMockPayload();

        await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(mockExecute).toHaveBeenCalledTimes(1);
      });
    });

    describe('full execution flow', () => {
      it('should complete full execution successfully', async () => {
        const subscriber = createMockSubscriber({
          actionType: 'send_agent_message',
          actionInputs: { text: { source: 'custom', customValue: '/compact' } },
          delayMs: 0,
          cooldownMs: 5000,
          retryOnError: false,
        });
        const payload = createMockPayload();

        await expect(
          service.executeSubscriber(subscriber, 'test.event', payload),
        ).resolves.not.toThrow();

        expect(actionsRegistry.getAction).toHaveBeenCalledWith('send_agent_message');
        expect(mockSessionsService.getSession).toHaveBeenCalledWith('session-123');
        expect(mockExecute).toHaveBeenCalledWith(
          expect.objectContaining({ tmuxSessionName: 'tmux-session-1' }),
          expect.objectContaining({ text: '/compact' }),
        );
        expect(service.isOnCooldown(subscriber.id, payload.sessionId, 5000)).toBe(true);
      });
    });
  });

  describe('scheduleEventProcessing', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('should schedule subscriber delay via task runAt', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

      const subscriber = createMockSubscriber({ delayMs: 5000 });
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);

      const payload = createMockPayload();

      const scheduleEventProcessing = (
        service as unknown as {
          scheduleEventProcessing: (
            eventName: string,
            payload: SubscribableEventPayload,
          ) => Promise<void>;
        }
      ).scheduleEventProcessing.bind(service);

      await scheduleEventProcessing('terminal.watcher.triggered', payload);

      expect(mockStorage.findSubscribersByEventName).toHaveBeenCalledWith(
        'project-789',
        'test.event',
      );
      expect(mockScheduler.schedule).toHaveBeenCalledTimes(1);

      const scheduledTask = mockScheduler.schedule.mock.calls[0][0];
      expect(scheduledTask.subscriberId).toBe(subscriber.id);
      expect(scheduledTask.runAt).toBe(Date.parse('2025-01-01T00:00:00.000Z') + 5000);
    });

    it('should execute after delayMs exactly once (scheduler + executor)', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

      const realScheduler = new AutomationSchedulerService();
      const serviceWithRealScheduler = new SubscriberExecutorService(
        mockStorage as unknown as StorageService,
        mockTmuxService as unknown as TmuxService,
        mockSessionsService as unknown as SessionsService,
        mockSessionCoordinator as unknown as SessionCoordinatorService,
        mockSendCoordinator as unknown as TerminalSendCoordinatorService,
        mockMessagePoolService as unknown as SessionsMessagePoolService,
        mockEventLogService as unknown as EventLogService,
        mockEventEmitter as unknown as EventEmitter2,
        realScheduler,
      );

      const mockExecute = jest.fn().mockResolvedValue({ success: true });
      const getActionSpy = jest.spyOn(actionsRegistry, 'getAction').mockReturnValue({
        type: 'send_agent_message',
        name: 'Send Agent Message',
        description: '',
        inputs: {},
        execute: mockExecute,
      } as unknown as ActionDefinition);

      const subscriber = createMockSubscriber({ delayMs: 5000 });
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);
      mockStorage.getSubscriber.mockResolvedValue(subscriber);

      const payload = createMockPayload();

      const scheduleEventProcessing = (
        serviceWithRealScheduler as unknown as {
          scheduleEventProcessing: (
            eventName: string,
            payload: SubscribableEventPayload,
          ) => Promise<void>;
        }
      ).scheduleEventProcessing.bind(serviceWithRealScheduler);

      await scheduleEventProcessing('terminal.watcher.triggered', payload);

      await jest.advanceTimersByTimeAsync(4999);
      await Promise.resolve();
      expect(mockExecute).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      if (jest.getTimerCount() > 0) {
        await jest.runOnlyPendingTimersAsync();
      }
      await Promise.resolve();

      expect(mockExecute).toHaveBeenCalledTimes(1);
      getActionSpy.mockRestore();
      realScheduler.onModuleDestroy();
    });
  });

  describe('getPayloadField', () => {
    it('should return top-level field value', () => {
      const payload = createMockPayload({ agentName: 'Test Agent' });

      expect(service.getPayloadField(payload, 'agentName')).toBe('Test Agent');
    });

    it('should return nested field value with dot notation', () => {
      const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
        nested: { value: string };
      };
      (payload as Record<string, unknown>).nested = { value: 'nested-value' };

      expect(service.getPayloadField(payload, 'nested.value')).toBe('nested-value');
    });

    it('should return undefined for non-existent field', () => {
      const payload = createMockPayload();

      expect(service.getPayloadField(payload, 'nonexistent')).toBeUndefined();
    });

    it('should return undefined for non-existent nested path', () => {
      const payload = createMockPayload();

      expect(service.getPayloadField(payload, 'nonexistent.nested.path')).toBeUndefined();
    });

    it('should return null for null field values', () => {
      const payload = createMockPayload({ agentName: null });

      expect(service.getPayloadField(payload, 'agentName')).toBeNull();
    });

    it('should return numeric values', () => {
      const payload = createMockPayload({ triggerCount: 42 });

      expect(service.getPayloadField(payload, 'triggerCount')).toBe(42);
    });

    it('should handle arrays at nested paths', () => {
      const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
        items: string[];
      };
      (payload as Record<string, unknown>).items = ['a', 'b', 'c'];

      expect(service.getPayloadField(payload, 'items')).toEqual(['a', 'b', 'c']);
    });

    it('should access array elements by index', () => {
      const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
        items: string[];
      };
      (payload as Record<string, unknown>).items = ['first', 'second', 'third'];

      expect(service.getPayloadField(payload, 'items.0')).toBe('first');
      expect(service.getPayloadField(payload, 'items.1')).toBe('second');
    });
  });

  describe('resolveInputs', () => {
    describe('event_field source', () => {
      it('should extract top-level field from payload', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'event_field', eventField: 'agentName' },
        };
        const payload = createMockPayload({ agentName: 'Test Agent' });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Test Agent');
      });

      it('should extract nested field using dot notation', () => {
        const inputMappings: Record<string, ActionInput> = {
          message: { source: 'event_field', eventField: 'nested.value' },
        };
        const payload = createMockPayload() as TerminalWatcherTriggeredEventPayload & {
          nested: { value: string };
        };
        (payload as Record<string, unknown>).nested = { value: 'nested-message' };

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.message).toBe('nested-message');
      });

      it('should return undefined for missing field', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'event_field', eventField: 'nonExistent' },
        };
        const payload = createMockPayload();

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBeUndefined();
      });

      it('should return undefined when eventField is not specified', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'event_field' },
        };
        const payload = createMockPayload();

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBeUndefined();
      });

      it('should extract numeric values', () => {
        const inputMappings: Record<string, ActionInput> = {
          count: { source: 'event_field', eventField: 'triggerCount' },
        };
        const payload = createMockPayload({ triggerCount: 42 });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.count).toBe(42);
      });

      it('should handle null field values', () => {
        const inputMappings: Record<string, ActionInput> = {
          agent: { source: 'event_field', eventField: 'agentName' },
        };
        const payload = createMockPayload({ agentName: null });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.agent).toBeNull();
      });
    });

    describe('custom source', () => {
      it('should use customValue directly', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'Hello World' },
        };
        const payload = createMockPayload();

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Hello World');
      });

      it('should return undefined when customValue is not specified', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom' },
        };
        const payload = createMockPayload();

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBeUndefined();
      });

      it('should handle empty string customValue', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: '' },
        };
        const payload = createMockPayload();

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('');
      });
    });

    describe('template interpolation', () => {
      it('should replace {{field}} with payload value', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'Hello {{agentName}}!' },
        };
        const payload = createMockPayload({ agentName: 'CoderAgent' });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Hello CoderAgent!');
      });

      it('should handle multiple variables in one string', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: {
            source: 'custom',
            customValue: 'Agent {{agentName}} in session {{sessionId}}',
          },
        };
        const payload = createMockPayload({
          agentName: 'TestAgent',
          sessionId: 'sess-123',
        });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Agent TestAgent in session sess-123');
      });

      it('should access nested fields via dot notation', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'Value: {{nested.value}}' },
        };
        const payload = createMockPayload();
        (payload as Record<string, unknown>).nested = { value: 'deep' };

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Value: deep');
      });

      it('should keep unknown variables as-is', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'Hello {{unknownField}}!' },
        };
        const payload = createMockPayload();

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Hello {{unknownField}}!');
      });

      it('should convert null values to empty string', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'Value: {{agentName}}' },
        };
        const payload = createMockPayload({ agentName: null });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Value: ');
      });

      it('should stringify numeric values', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'Count: {{triggerCount}}' },
        };
        const payload = createMockPayload({ triggerCount: 42 });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Count: 42');
      });

      it('should handle string with no template variables', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'Static text only' },
        };
        const payload = createMockPayload();

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Static text only');
      });

      it('should allow interpolation from merged templateVars (payload + envelope fields)', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'P={{projectId}} E={{eventName}}' },
          proj: { source: 'event_field', eventField: 'projectId' },
        };
        const payload = { agentName: 'Test Agent' } as unknown as SubscribableEventPayload;
        const templateVars = { ...payload, projectId: 'proj-1', eventName: 'evt-1' };

        const result = service.resolveInputs(inputMappings, payload, templateVars);

        expect(result.text).toBe('P=proj-1 E=evt-1');
        expect(result.proj).toBe('proj-1');
      });
    });

    describe('mixed sources', () => {
      it('should resolve multiple inputs with different sources', () => {
        const inputMappings: Record<string, ActionInput> = {
          agentName: { source: 'event_field', eventField: 'agentName' },
          customMessage: { source: 'custom', customValue: 'Static message' },
          sessionId: { source: 'event_field', eventField: 'sessionId' },
        };
        const payload = createMockPayload({
          agentName: 'Test Agent',
          sessionId: 'session-123',
        });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.agentName).toBe('Test Agent');
        expect(result.customMessage).toBe('Static message');
        expect(result.sessionId).toBe('session-123');
      });

      it('should handle empty input mappings', () => {
        const inputMappings: Record<string, ActionInput> = {};
        const payload = createMockPayload();

        const result = service.resolveInputs(inputMappings, payload);

        expect(result).toEqual({});
      });
    });

    describe('real subscriber scenario', () => {
      it('should resolve inputs matching actual subscriber actionInputs structure', () => {
        // Simulate a real subscriber's actionInputs for SendAgentMessage
        const subscriber = createMockSubscriber({
          actionInputs: {
            text: { source: 'custom', customValue: '/compact' },
            submitKey: { source: 'custom', customValue: 'Enter' },
            delayMs: { source: 'event_field', eventField: 'triggerCount' },
          },
        });
        const payload = createMockPayload({ triggerCount: 1000 });

        const result = service.resolveInputs(subscriber.actionInputs, payload);

        expect(result.text).toBe('/compact');
        expect(result.submitKey).toBe('Enter');
        expect(result.delayMs).toBe(1000);
      });

      it('should resolve viewport snippet for dynamic messages', () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'event_field', eventField: 'viewportSnippet' },
        };
        const payload = createMockPayload({
          viewportSnippet: 'Error: Context window full. Please compact.',
        });

        const result = service.resolveInputs(inputMappings, payload);

        expect(result.text).toBe('Error: Context window full. Please compact.');
      });
    });
  });
});

/**
 * Integration tests for EventEmitter2 onAny() eventName capture.
 *
 * These tests verify that the onAny handler pattern used by SubscriberExecutorService
 * correctly receives event names from EventEmitter2. This is critical because:
 * - The handler must receive the actual event name (not undefined)
 * - EventEmitter2 passes eventName as string | string[] to onAny handlers
 * - The service must correctly extract the event name from this format
 */
describe('EventEmitter2 onAny eventName capture (integration)', () => {
  it('should capture eventName via onAny when emitting a single event', () => {
    const emitter = new EventEmitter2();
    let capturedEventName: string | undefined;

    emitter.onAny((event: string | string[]) => {
      capturedEventName = Array.isArray(event) ? event[0] : event;
    });

    emitter.emit('terminal.watcher.triggered', { projectId: 'test-project' });

    expect(capturedEventName).toBe('terminal.watcher.triggered');
  });

  it('should capture eventName with full payload via onAny', () => {
    const emitter = new EventEmitter2();
    let capturedEventName: string | undefined;
    let capturedPayload: unknown;

    emitter.onAny((event: string | string[], ...args: unknown[]) => {
      capturedEventName = Array.isArray(event) ? event[0] : event;
      capturedPayload = args[0];
    });

    const payload = {
      projectId: 'test-project',
      sessionId: 'session-123',
      agentId: 'agent-456',
    };
    emitter.emit('epic.assigned', payload);

    expect(capturedEventName).toBe('epic.assigned');
    expect(capturedPayload).toEqual(payload);
  });

  it('should correctly handle multiple sequential events', () => {
    const emitter = new EventEmitter2();
    const capturedEvents: string[] = [];

    emitter.onAny((event: string | string[]) => {
      const name = Array.isArray(event) ? event[0] : event;
      if (name) capturedEvents.push(name);
    });

    emitter.emit('terminal.watcher.triggered', { projectId: 'p1' });
    emitter.emit('epic.assigned', { projectId: 'p2' });
    emitter.emit('epic.status_changed', { projectId: 'p3' });

    expect(capturedEvents).toEqual([
      'terminal.watcher.triggered',
      'epic.assigned',
      'epic.status_changed',
    ]);
  });

  it('should correctly cleanup onAny handler with offAny', () => {
    const emitter = new EventEmitter2();
    const capturedEvents: string[] = [];

    const handler = (event: string | string[]) => {
      const name = Array.isArray(event) ? event[0] : event;
      if (name) capturedEvents.push(name);
    };

    emitter.onAny(handler);
    emitter.emit('event.one', {});

    emitter.offAny(handler);
    emitter.emit('event.two', {});

    expect(capturedEvents).toEqual(['event.one']);
    expect(capturedEvents).not.toContain('event.two');
  });

  it('should handle wildcard event patterns if configured', () => {
    const emitter = new EventEmitter2({ wildcard: true, delimiter: '.' });
    let capturedEventName: string | undefined;

    emitter.onAny((event: string | string[]) => {
      capturedEventName = Array.isArray(event) ? event[0] : event;
    });

    emitter.emit('terminal.watcher.triggered', { projectId: 'test' });

    expect(capturedEventName).toBe('terminal.watcher.triggered');
  });

  it('should not receive undefined eventName', () => {
    const emitter = new EventEmitter2();
    const receivedEventNames: Array<string | string[] | undefined> = [];

    emitter.onAny((event: string | string[]) => {
      receivedEventNames.push(event);
    });

    emitter.emit('test.event', { data: 'value' });

    expect(receivedEventNames).toHaveLength(1);
    expect(receivedEventNames[0]).toBe('test.event');
    expect(receivedEventNames[0]).not.toBeUndefined();
  });
});
