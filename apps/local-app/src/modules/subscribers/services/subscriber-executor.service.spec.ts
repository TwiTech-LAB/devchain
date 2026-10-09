/**
 * Test layer: module unit.
 * Subscriber scheduling and execution require Nest wiring, while mocked storage and scheduler
 * boundaries avoid real I/O and make this the cheapest reliable layer for the orchestration.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ModuleRef } from '@nestjs/core';
import {
  SubscriberExecutorService,
  type SubscriberExecutionResult,
  type SubscribableEventPayload,
} from './subscriber-executor.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  Subscriber,
  EventFilter,
  EventFilterCondition,
  ActionInput,
} from '../../storage/models/domain.models';
import type { TerminalWatcherTriggeredEventPayload } from '../../events/catalog/terminal.watcher.triggered';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import { AgentMessageDeliveryService } from '../../agent-message-delivery/agent-message-delivery.service';
import { EventLogService } from '../../events/services/event-log.service';
import { AutomationSchedulerService } from './automation-scheduler.service';
import * as actionsRegistry from '../actions/actions.registry';
import type { ActionContext, ActionDefinition, ActionResult } from '../actions/action.interface';
import * as eventFieldsCatalog from '../events/event-fields-catalog';
import * as eventsService from '../../events/services/events.service';
import { TeamsService } from '../../teams/services/teams.service';
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';

describe('SubscriberExecutorService', () => {
  let service: SubscriberExecutorService;
  let mockStorage: jest.Mocked<
    Pick<StorageService, 'findSubscribersByEventName' | 'getSubscriber' | 'getAgent'>
  >;
  let mockTerminalIO: jest.Mocked<Partial<TerminalIOService>>;
  let mockSessionsService: jest.Mocked<Pick<SessionsService, 'getSession'>>;
  let mockSessionCoordinator: jest.Mocked<Pick<SessionCoordinatorService, 'withAgentLock'>>;
  let mockAmd: jest.Mocked<Pick<AgentMessageDeliveryService, 'deliver'>>;
  let mockEventLogService: jest.Mocked<
    Pick<EventLogService, 'recordHandledOk' | 'recordHandledFail'>
  >;
  let mockEventEmitter: jest.Mocked<Pick<EventEmitter2, 'onAny' | 'offAny'>>;
  let mockScheduler: jest.Mocked<Pick<AutomationSchedulerService, 'schedule'>>;
  let mockTeamsService: { listTeamsByAgent: jest.Mock };
  let mockModuleRef: { get: jest.Mock };

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

    mockTerminalIO = {};

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

    mockAmd = {
      deliver: jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: 'agent-456', status: 'queued' }],
      }),
    };

    mockEventLogService = {
      recordHandledOk: jest.fn().mockResolvedValue({ id: 'handler-1' }),
      recordHandledFail: jest.fn().mockResolvedValue({ id: 'handler-2' }),
    };

    mockTeamsService = {
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
    };

    mockModuleRef = {
      get: jest.fn().mockReturnValue(mockTeamsService),
    };

    // Mock getEventMetadata to return null by default (no eventId)
    jest.spyOn(eventsService, 'getEventMetadata').mockReturnValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ProjectWriteGate, useValue: createProjectWriteGateStub() },
        SubscriberExecutorService,
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorage,
        },
        {
          provide: TerminalIOService,
          useValue: mockTerminalIO,
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
          provide: AgentMessageDeliveryService,
          useValue: mockAmd,
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
        {
          provide: TeamsService,
          useValue: mockTeamsService,
        },
        {
          provide: ModuleRef,
          useValue: mockModuleRef,
        },
      ],
    }).compile();

    service = module.get<SubscriberExecutorService>(SubscriberExecutorService);
  });

  describe('onModuleInit', () => {
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

    it.each([
      { name: 'no project or session', payload: {} as SubscribableEventPayload, session: null },
      {
        name: 'session without agent',
        payload: { sessionId: 'session-123' } as SubscribableEventPayload,
        session: {
          id: 'session-123',
          tmuxSessionId: 'tmux-session-1',
          status: 'running' as const,
          epicId: null,
          agentId: null, // No agent
          startedAt: new Date().toISOString(),
          endedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      {
        name: 'missing session',
        payload: { sessionId: 'nonexistent-session' } as SubscribableEventPayload,
        session: null,
      },
    ])('returns no work for $name', async ({ payload, session }) => {
      mockSessionsService.getSession.mockReturnValue(session);
      expect(await service.handleEvent('terminal.watcher.triggered', payload)).toBeNull();
      expect(mockStorage.getAgent).not.toHaveBeenCalled();
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
        isProjectOwner: false,
        profileId: 'profile-1',
        providerConfigId: 'config-1',
        modelOverride: null,
        effortOverride: null,
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

    it.each([
      { name: 'enabled', enabled: true, filter: null, scheduled: 1, reason: undefined },
      { name: 'disabled', enabled: false, filter: null, scheduled: 0, reason: 'disabled' },
      {
        name: 'unmatched filter',
        enabled: true,
        filter: { field: 'agentName', operator: 'equals', value: 'Wrong Agent' },
        scheduled: 0,
        reason: 'filter_not_matched',
      },
      {
        name: 'matched filter',
        enabled: true,
        filter: { field: 'agentName', operator: 'equals', value: 'Test Agent' },
        scheduled: 1,
        reason: undefined,
      },
    ])(
      'schedules $name subscribers appropriately',
      async ({ enabled, filter, scheduled, reason }) => {
        const subscriber = createMockSubscriber({
          enabled,
          eventFilter: filter as EventFilter | null,
        });
        mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);
        const execute = jest
          .spyOn(service, 'executeSubscriber')
          .mockResolvedValue(createMockExecutionResult(subscriber));
        const result = await service.handleEvent(
          'terminal.watcher.triggered',
          createMockPayload({ agentName: 'Test Agent' }),
        );
        expect(result?.subscribersMatched).toBe(1);
        expect(result?.subscribersScheduled).toBe(scheduled);
        expect(result?.subscribersSkipped).toBe(1 - scheduled);
        expect(mockScheduler.schedule).toHaveBeenCalledTimes(scheduled);
        expect(execute).not.toHaveBeenCalled();
        if (reason) expect(result?.skippedSubscribers[0].reason).toBe(reason);
        expect(result?.eventName).toBe('terminal.watcher.triggered');
        expect(result?.scheduledTasks).toHaveLength(scheduled);
        if (scheduled)
          expect(result?.scheduledTasks[0]).toMatchObject({
            subscriberId: subscriber.id,
            subscriberName: subscriber.name,
          });
      },
    );

    it('schedules and executes one action when multiple OR conditions match', async () => {
      const subscriber = createMockSubscriber({
        eventFilter: {
          combinator: 'or',
          filters: [
            { field: 'agentName', operator: 'equals', value: 'Test Agent' },
            { field: 'viewportSnippet', operator: 'contains', value: 'Error' },
          ],
        },
      });
      mockStorage.findSubscribersByEventName.mockResolvedValue([subscriber]);
      mockStorage.getSubscriber.mockResolvedValue(subscriber);
      const executeSpy = jest
        .spyOn(service, 'executeSubscriber')
        .mockResolvedValue(createMockExecutionResult(subscriber));

      const result = await service.handleEvent('terminal.watcher.triggered', createMockPayload());

      expect(result?.subscribersScheduled).toBe(1);
      expect(mockScheduler.schedule).toHaveBeenCalledTimes(1);

      const task = mockScheduler.schedule.mock.calls[0][0];
      await task.execute();

      expect(executeSpy).toHaveBeenCalledTimes(1);
    });

    it('fails a malformed group closed without preventing later subscribers from scheduling', async () => {
      const malformed = createMockSubscriber({
        id: 'malformed-sub',
        eventFilter: { combinator: 'and', filters: [] } as unknown as EventFilter,
      });
      const valid = createMockSubscriber({ id: 'valid-sub' });
      mockStorage.findSubscribersByEventName.mockResolvedValue([malformed, valid]);

      const result = await service.handleEvent('terminal.watcher.triggered', createMockPayload());

      expect(result).toMatchObject({
        subscribersMatched: 2,
        subscribersScheduled: 1,
        subscribersSkipped: 1,
      });
      expect(mockScheduler.schedule).toHaveBeenCalledTimes(1);
      expect(mockScheduler.schedule.mock.calls[0][0].subscriberId).toBe('valid-sub');
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

  describe('matchesFilter', () => {
    describe('compound groups', () => {
      it('requires every condition in an AND group to match', () => {
        const payload = createMockPayload();

        expect(
          service.matchesFilter(
            {
              combinator: 'and',
              filters: [
                { field: 'agentName', operator: 'equals', value: 'Test Agent' },
                { field: 'viewportSnippet', operator: 'contains', value: 'Error' },
              ],
            },
            payload,
          ),
        ).toBe(true);
        expect(
          service.matchesFilter(
            {
              combinator: 'and',
              filters: [
                { field: 'agentName', operator: 'equals', value: 'Test Agent' },
                { field: 'viewportSnippet', operator: 'contains', value: 'Warning' },
              ],
            },
            payload,
          ),
        ).toBe(false);
      });

      it('requires at least one condition in an OR group to match', () => {
        const payload = createMockPayload();

        expect(
          service.matchesFilter(
            {
              combinator: 'or',
              filters: [
                { field: 'agentName', operator: 'equals', value: 'Other Agent' },
                { field: 'viewportSnippet', operator: 'contains', value: 'Error' },
              ],
            },
            payload,
          ),
        ).toBe(true);
        expect(
          service.matchesFilter(
            {
              combinator: 'or',
              filters: [
                { field: 'agentName', operator: 'equals', value: 'Other Agent' },
                { field: 'viewportSnippet', operator: 'contains', value: 'Warning' },
              ],
            },
            payload,
          ),
        ).toBe(false);
      });

      it.each([
        { combinator: 'and', filters: [] },
        { combinator: 'xor', filters: [{ field: 'agentName', operator: 'equals', value: 'x' }] },
        { combinator: 'and', filters: 'not-an-array' },
        { combinator: 'or', filters: [null] },
        {
          combinator: 'and',
          filters: [
            {
              combinator: 'or',
              filters: [{ field: 'agentName', operator: 'equals', value: 'Test Agent' }],
            },
          ],
        },
      ])('fails malformed stored group closed: %j', (malformedFilter) => {
        const logger = Reflect.get(service, 'logger') as {
          warn: (context: unknown, message: string) => void;
        };
        const warnSpy = jest.spyOn(logger, 'warn').mockImplementation();

        expect(
          service.matchesFilter(malformedFilter as unknown as EventFilter, createMockPayload()),
        ).toBe(false);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ filter: malformedFilter }),
          'Malformed event filter; failing closed',
        );
      });
    });

    describe('equals operator', () => {
      it.each([
        {
          name: 'should return true when field value equals filter value',
          filter: { field: 'agentName', operator: 'equals', value: 'Test Agent' } as EventFilter,
          payload: createMockPayload({ agentName: 'Test Agent' }),
          expected: true,
        },
        {
          name: 'should return false when field value does not equal filter value',
          filter: {
            field: 'agentName',
            operator: 'equals',
            value: 'Other Agent',
          } as EventFilter,
          payload: createMockPayload({ agentName: 'Test Agent' }),
          expected: false,
        },
        {
          name: 'should handle numeric fields converted to string',
          filter: { field: 'triggerCount', operator: 'equals', value: '5' } as EventFilter,
          payload: createMockPayload({ triggerCount: 5 }),
          expected: true,
        },
        {
          name: 'should return true when field value contains filter value',
          filter: {
            field: 'viewportSnippet',
            operator: 'contains',
            value: 'Error',
          } as EventFilter,
          payload: createMockPayload({ viewportSnippet: 'Error: Something went wrong' }),
          expected: true,
        },
        {
          name: 'should return false when field value does not contain filter value',
          filter: {
            field: 'viewportSnippet',
            operator: 'contains',
            value: 'Warning',
          } as EventFilter,
          payload: createMockPayload({ viewportSnippet: 'Error: Something went wrong' }),
          expected: false,
        },
        {
          name: 'should return true when field value matches regex pattern',
          filter: {
            field: 'viewportSnippet',
            operator: 'regex',
            value: 'Error.*wrong',
          } as EventFilter,
          payload: createMockPayload({ viewportSnippet: 'Error: Something went wrong' }),
          expected: true,
        },
        {
          name: 'should return false when field value does not match regex pattern',
          filter: {
            field: 'viewportSnippet',
            operator: 'regex',
            value: '^Warning',
          } as EventFilter,
          payload: createMockPayload({ viewportSnippet: 'Error: Something went wrong' }),
          expected: false,
        },
        {
          name: 'should return false for invalid regex pattern',
          filter: {
            field: 'viewportSnippet',
            operator: 'regex',
            value: '[invalid(regex',
          } as EventFilter,
          payload: createMockPayload({ viewportSnippet: 'Error: Something went wrong' }),
          expected: false,
        },
        {
          name: 'should return false for unknown fields',
          filter: { field: 'unknownField', operator: 'equals', value: 'test' } as EventFilter,
          payload: createMockPayload(),
          expected: false,
        },
        {
          name: 'should return false for null field values',
          filter: { field: 'agentName', operator: 'equals', value: 'test' } as EventFilter,
          payload: createMockPayload({ agentName: null }),
          expected: false,
        },
        {
          name: 'should return false for unknown operator',
          filter: {
            field: 'agentName',
            operator: 'unknown' as EventFilterCondition['operator'],
            value: 'test',
          } as EventFilter,
          payload: createMockPayload(),
          expected: false,
        },
      ])('$name', ({ filter, payload, expected }) => {
        expect(service.matchesFilter(filter, payload)).toBe(expected);
      });
    });

    describe('null-aware operators', () => {
      it.each([
        { operator: 'is_null', field: 'agentName', value: null, expected: true },
        { operator: 'is_null', field: 'agentName', value: 'Test Agent', expected: false },
        { operator: 'is_null', field: 'missingField', value: undefined, expected: false },
        { operator: 'is_not_null', field: 'agentName', value: null, expected: false },
        { operator: 'is_not_null', field: 'agentName', value: 'Test Agent', expected: true },
        { operator: 'is_not_null', field: 'missingField', value: undefined, expected: false },
      ] as const)(
        '$operator matches only the expected field state',
        ({ operator, field, value, expected }) => {
          const payload =
            field === 'missingField'
              ? createMockPayload()
              : createMockPayload({ agentName: value });
          const filter: EventFilter = { field, operator, value: '' };

          expect(service.matchesFilter(filter, payload)).toBe(expected);
        },
      );

      it('supports null-aware conditions inside flat AND and OR groups', () => {
        const payload = createMockPayload({ agentName: null });

        expect(
          service.matchesFilter(
            {
              combinator: 'and',
              filters: [
                { field: 'agentName', operator: 'is_null', value: '' },
                { field: 'projectId', operator: 'is_not_null', value: '' },
              ],
            },
            payload,
          ),
        ).toBe(true);

        expect(
          service.matchesFilter(
            {
              combinator: 'or',
              filters: [
                { field: 'agentName', operator: 'is_not_null', value: '' },
                { field: 'missingField', operator: 'is_null', value: '' },
              ],
            },
            payload,
          ),
        ).toBe(false);
      });
    });

    describe('contains operator', () => {
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

    describe('nested field access', () => {
      it.each([
        {
          name: 'should return false when intermediate path is null',
          payload: { ...createMockPayload(), nested: null },
          filter: { field: 'nested.value', operator: 'equals', value: 'test' } as EventFilter,
          checks: [['nested.value', undefined]] as [string, unknown][],
        },
        {
          name: 'should return false when intermediate path is a primitive',
          payload: createMockPayload(),
          filter: {
            field: 'agentName.something',
            operator: 'equals',
            value: 'test',
          } as EventFilter,
          checks: [['agentName.something', undefined]] as [string, unknown][],
        },
        {
          name: 'should return top-level field value',
          payload: createMockPayload({ agentName: 'Test Agent' }),
          filter: undefined,
          checks: [['agentName', 'Test Agent']] as [string, unknown][],
        },
        {
          name: 'should return nested field value with dot notation',
          payload: { ...createMockPayload(), nested: { value: 'nested-value' } },
          filter: undefined,
          checks: [['nested.value', 'nested-value']] as [string, unknown][],
        },
        {
          name: 'should return undefined for non-existent field',
          payload: createMockPayload(),
          filter: undefined,
          checks: [['nonexistent', undefined]] as [string, unknown][],
        },
        {
          name: 'should return undefined for non-existent nested path',
          payload: createMockPayload(),
          filter: undefined,
          checks: [['nonexistent.nested.path', undefined]] as [string, unknown][],
        },
        {
          name: 'should return null for null field values',
          payload: createMockPayload({ agentName: null }),
          filter: undefined,
          checks: [['agentName', null]] as [string, unknown][],
        },
        {
          name: 'should access array elements by index',
          payload: { ...createMockPayload(), items: ['first', 'second', 'third'] },
          filter: undefined,
          checks: [
            ['items.0', 'first'],
            ['items.1', 'second'],
          ] as [string, unknown][],
        },
      ])('$name', ({ payload, filter, checks }) => {
        for (const [field, expected] of checks)
          expect(service.getPayloadField(payload, field)).toBe(expected);
        if (filter) expect(service.matchesFilter(filter, payload)).toBe(false);
      });
    });
  });

  describe('cooldown tracking', () => {
    describe('isOnCooldown', () => {
      it('should return false when cooldownMs is 0', () => {
        expect(service.isOnCooldown('sub-1', 'session-1', 0)).toBe(false);
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
        const context = mockExecute.mock.calls[0][0] as ActionContext;
        expect([...(context.eventFieldInputs ?? [])]).toEqual(['session']);
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
          isProjectOwner: false,
          profileId: 'profile-1',
          providerConfigId: 'config-1',
          modelOverride: null,
          effortOverride: null,
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
        expect(context.terminalIO).toBeDefined();
        expect(context.sessionsService).toBeDefined();
        expect(context.teamsService).toBe(mockTeamsService);
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

      it('should not retry an action that returns retryable false', async () => {
        mockExecute.mockResolvedValue({
          success: false,
          error: 'Permanent action failure',
          retryable: false,
        });

        const subscriber = createMockSubscriber({ retryOnError: true });
        const result = await service.executeSubscriber(
          subscriber,
          'test.event',
          createMockPayload(),
        );

        expect(mockExecute).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ success: false, error: 'Permanent action failure' });
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
        mockTerminalIO as unknown as TerminalIOService,
        mockSessionsService as unknown as SessionsService,
        mockSessionCoordinator as unknown as SessionCoordinatorService,
        mockAmd as unknown as AgentMessageDeliveryService,
        mockEventLogService as unknown as EventLogService,
        mockEventEmitter as unknown as EventEmitter2,
        realScheduler,
        mockTeamsService as unknown as TeamsService,
        mockModuleRef as unknown as ModuleRef,
        createProjectWriteGateStub() as never,
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

  describe('resolveInputs', () => {
    describe('event_field source', () => {
      it.each([
        {
          name: 'should extract top-level field from payload',
          mappings: {
            text: { source: 'event_field', eventField: 'agentName' },
          } as Record<string, ActionInput>,
          payload: createMockPayload({ agentName: 'Test Agent' }),
          expected: 'Test Agent',
        },
        {
          name: 'should return undefined when eventField is not specified',
          mappings: {
            text: { source: 'event_field' },
          } as Record<string, ActionInput>,
          payload: createMockPayload(),
          expected: undefined,
        },
        {
          name: 'should use customValue directly',
          mappings: {
            text: { source: 'custom', customValue: 'Hello World' },
          } as Record<string, ActionInput>,
          payload: createMockPayload(),
          expected: 'Hello World',
        },
        {
          name: 'should return undefined when customValue is not specified',
          mappings: {
            text: { source: 'custom' },
          } as Record<string, ActionInput>,
          payload: createMockPayload(),
          expected: undefined,
        },
        {
          name: 'should handle empty string customValue',
          mappings: {
            text: { source: 'custom', customValue: '' },
          } as Record<string, ActionInput>,
          payload: createMockPayload(),
          expected: '',
        },
        {
          name: 'should replace {{field}} with payload value',
          mappings: {
            text: { source: 'custom', customValue: 'Hello {{agentName}}!' },
          } as Record<string, ActionInput>,
          payload: createMockPayload({ agentName: 'CoderAgent' }),
          expected: 'Hello CoderAgent!',
        },
        {
          name: 'should handle multiple variables in one string',
          mappings: {
            text: {
              source: 'custom',
              customValue: 'Agent {{agentName}} in session {{sessionId}}',
            },
          } as Record<string, ActionInput>,
          payload: createMockPayload({
            agentName: 'TestAgent',
            sessionId: 'sess-123',
          }),
          expected: 'Agent TestAgent in session sess-123',
        },
        {
          name: 'should access nested fields via dot notation',
          mappings: {
            text: { source: 'custom', customValue: 'Value: {{nested.value}}' },
          } as Record<string, ActionInput>,
          payload: { ...createMockPayload(), nested: { value: 'deep' } },
          expected: 'Value: deep',
        },
        {
          name: 'should keep unknown variables as-is',
          mappings: {
            text: { source: 'custom', customValue: 'Hello {{unknownField}}!' },
          } as Record<string, ActionInput>,
          payload: createMockPayload(),
          expected: 'Hello {{unknownField}}!',
        },
        {
          name: 'should convert null values to empty string',
          mappings: {
            text: { source: 'custom', customValue: 'Value: {{agentName}}' },
          } as Record<string, ActionInput>,
          payload: createMockPayload({ agentName: null }),
          expected: 'Value: ',
        },
      ])('$name', async ({ mappings, payload, expected }) => {
        const result = await service.resolveInputs(
          mappings,
          payload,
          undefined,
          'other_action',
          'sub-1',
        );
        expect(result.text).toBe(expected);
      });
    });

    describe('template interpolation', () => {
      it('should render unknown variables as empty string on send_agent_message.text (Handlebars path)', async () => {
        const result = await service.resolveInputs(
          { text: { source: 'custom', customValue: 'Hello {{unknownField}}!' } },
          createMockPayload(),
          undefined,
          'send_agent_message',
          'sub-1',
        );
        expect(result.text).toBe('Hello !');
      });

      it('should allow interpolation from merged templateVars (payload + envelope fields)', async () => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: 'P={{projectId}} E={{eventName}}' },
          proj: { source: 'event_field', eventField: 'projectId' },
        };
        const payload = { agentName: 'Test Agent' } as unknown as SubscribableEventPayload;
        const templateVars = { ...payload, projectId: 'proj-1', eventName: 'evt-1' };

        const result = await service.resolveInputs(
          inputMappings,
          payload,
          templateVars,
          'other_action',
          'sub-1',
        );

        expect(result.text).toBe('P=proj-1 E=evt-1');
        expect(result.proj).toBe('proj-1');
      });
    });

    describe('mixed sources', () => {
      it('should handle empty input mappings', async () => {
        const inputMappings: Record<string, ActionInput> = {};
        const payload = createMockPayload();

        const result = await service.resolveInputs(
          inputMappings,
          payload,
          undefined,
          'other_action',
          'sub-1',
        );

        expect(result).toEqual({});
      });
    });

    describe('real subscriber scenario', () => {
      it('should resolve inputs matching actual subscriber actionInputs structure', async () => {
        // Simulate a real subscriber's actionInputs for SendAgentMessage
        const subscriber = createMockSubscriber({
          actionInputs: {
            text: { source: 'custom', customValue: '/compact' },
            submitKey: { source: 'custom', customValue: 'Enter' },
            delayMs: { source: 'event_field', eventField: 'triggerCount' },
          },
        });
        const payload = createMockPayload({ triggerCount: 1000 });

        const result = await service.resolveInputs(
          subscriber.actionInputs,
          payload,
          undefined,
          'other_action',
          'sub-1',
        );

        expect(result.text).toBe('/compact');
        expect(result.submitKey).toBe('Enter');
        expect(result.delayMs).toBe(1000);
      });
    });

    describe('scoped Handlebars rendering (send_agent_message.text)', () => {
      const resolveMessage = (
        template: string,
        payloadOverrides: Record<string, unknown> = {},
        teams: Array<{ name: string; teamLeadAgentId: string | null }> = [],
      ) => {
        const inputMappings: Record<string, ActionInput> = {
          text: { source: 'custom', customValue: template },
        };
        const payload = createMockPayload(payloadOverrides);
        const templateVars = {
          ...(payload as Record<string, unknown>),
          eventName: 'test.event',
          projectId: 'project-789',
          agentId: payload.agentId ?? null,
          sessionId: payload.sessionId,
          sessionIdShort: payload.sessionId?.slice(0, 8) ?? '',
          occurredAt: '2025-01-01T00:00:00.000Z',
          eventId: undefined,
        };
        mockTeamsService.listTeamsByAgent.mockResolvedValue(
          teams.map((t) => ({
            id: `team-${t.name}`,
            name: t.name,
            teamLeadAgentId: t.teamLeadAgentId,
            projectId: 'project-789',
            description: null,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          })),
        );
        return service.resolveInputs(
          inputMappings,
          payload,
          templateVars,
          'send_agent_message',
          'sub-1',
        );
      };

      it('uses the constructor-injected TeamsService without a ModuleRef lookup', async () => {
        const result = await resolveMessage(
          '{{#if is_team_lead}}lead-only line{{/if}}',
          { agentId: 'agent-456' },
          [{ name: 'Alpha', teamLeadAgentId: 'agent-456' }],
        );

        expect(result.text).toBe('lead-only line');
        expect(mockTeamsService.listTeamsByAgent).toHaveBeenCalledWith('agent-456');
        expect(mockModuleRef.get).not.toHaveBeenCalled();
      });

      it('Handlebars and regex produce identical output for simple templates', async () => {
        const template = 'Agent {{agentName}} in session {{sessionId}}';
        const payload = createMockPayload({ agentName: 'TestAgent', sessionId: 'sess-123' });
        const templateVars = {
          ...(payload as Record<string, unknown>),
          eventName: 'test.event',
          projectId: 'project-789',
        };
        const handlebarsResult = await service.resolveInputs(
          { text: { source: 'custom', customValue: template } },
          payload,
          templateVars,
          'send_agent_message',
          'sub-1',
        );
        const regexResult = await service.resolveInputs(
          { text: { source: 'custom', customValue: template } },
          payload,
          templateVars,
          'other_action',
          'sub-1',
        );
        expect(handlebarsResult.text).toBe(regexResult.text);
      });

      it('restart_agent.agentName is NOT processed by Handlebars', async () => {
        const inputMappings: Record<string, ActionInput> = {
          agentName: { source: 'custom', customValue: '{{#if foo}}broken{{/if}}' },
        };
        const payload = createMockPayload();

        const result = await service.resolveInputs(
          inputMappings,
          payload,
          undefined,
          'restart_agent',
          'sub-1',
        );

        expect(result.agentName).toBe('{{#if foo}}broken{{/if}}');
      });

      it('malformed Handlebars template on send_agent_message.text aborts with error', async () => {
        const subscriber = createMockSubscriber({
          actionType: 'send_agent_message',
          actionInputs: {
            text: { source: 'custom', customValue: '{{#if foo}}no-close' },
          },
        });
        const payload = createMockPayload();
        mockStorage.getSubscriber.mockResolvedValue(subscriber);
        mockStorage.getAgent.mockResolvedValue({
          id: 'agent-456',
          projectId: 'project-789',
          isProjectOwner: false,
          profileId: 'profile-1',
          providerConfigId: 'config-1',
          modelOverride: null,
          effortOverride: null,
          name: 'Test Agent',
          description: null,
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        });

        const result = await service.executeSubscriber(subscriber, 'test.event', payload);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(mockAmd.deliver).not.toHaveBeenCalled();
      });

      it('legacy {team_name} and {is_team_lead} tokens still work after kernel migration', async () => {
        const result = await resolveMessage(
          'Team: {team_name}, lead: {is_team_lead}',
          { agentId: 'agent-456' },
          [{ name: 'Backend', teamLeadAgentId: 'agent-456' }],
        );
        expect(result.text).toBe('Team: Backend, lead: true');
      });

      it('legacy {otherEventField} is NOT promoted (stays literal)', async () => {
        const result = await resolveMessage(
          'Sender: {senderName}, team: {team_name}',
          { agentId: 'agent-456', senderName: 'alice' },
          [],
        );
        expect(result.text).toBe('Sender: {senderName}, team: ');
      });
    });
  });

  // Scheduling and execution are separated by a configurable delay, and the
  // subscriber's stored config can change in between. executeSubscriberForTask
  // re-loads the subscriber at execution time and re-applies the enabled and
  // filter checks against the CURRENT config, so a mutation made after
  // scheduling is honored. This matrix locks that schedule→mutate→execute
  // freshness contract end-to-end through the real scheduling path.
  describe('schedule → config-mutation → execute freshness contract', () => {
    const captureScheduledTask = () => {
      expect(mockScheduler.schedule).toHaveBeenCalledTimes(1);
      return mockScheduler.schedule.mock.calls[0][0];
    };

    it('skips with filter_not_matched when the filter is narrowed after scheduling', async () => {
      const atSchedule = createMockSubscriber({
        eventFilter: { field: 'agentId', operator: 'equals', value: 'agent-456' },
      });
      mockStorage.findSubscribersByEventName.mockResolvedValue([atSchedule]);

      await service.handleEvent('terminal.watcher.triggered', createMockPayload());

      const task = captureScheduledTask();

      // Config changes between schedule and execute: the filter no longer
      // matches the original payload.
      mockStorage.getSubscriber.mockResolvedValue(
        createMockSubscriber({
          eventFilter: { field: 'agentId', operator: 'equals', value: 'someone-else' },
        }),
      );

      const result = await task.execute();

      expect(result).toMatchObject({ skipped: true, skipReason: 'filter_not_matched' });
    });

    it('skips with filter_not_matched when the latest persisted group no longer matches', async () => {
      const atSchedule = createMockSubscriber({
        eventFilter: {
          combinator: 'or',
          filters: [
            { field: 'agentId', operator: 'equals', value: 'agent-456' },
            { field: 'agentName', operator: 'equals', value: 'Other Agent' },
          ],
        },
      });
      mockStorage.findSubscribersByEventName.mockResolvedValue([atSchedule]);

      await service.handleEvent('terminal.watcher.triggered', createMockPayload());

      const task = captureScheduledTask();
      mockStorage.getSubscriber.mockResolvedValue(
        createMockSubscriber({
          eventFilter: {
            combinator: 'and',
            filters: [
              { field: 'agentId', operator: 'equals', value: 'agent-456' },
              { field: 'agentName', operator: 'equals', value: 'Other Agent' },
            ],
          },
        }),
      );
      const executeSpy = jest.spyOn(service, 'executeSubscriber');

      const result = await task.execute();

      expect(result).toMatchObject({ skipped: true, skipReason: 'filter_not_matched' });
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('skips with disabled when the subscriber is disabled after scheduling', async () => {
      const atSchedule = createMockSubscriber({ eventFilter: null });
      mockStorage.findSubscribersByEventName.mockResolvedValue([atSchedule]);
      mockStorage.getSubscriber.mockResolvedValue(atSchedule);

      await service.handleEvent('terminal.watcher.triggered', createMockPayload());

      const task = captureScheduledTask();

      mockStorage.getSubscriber.mockResolvedValue(createMockSubscriber({ enabled: false }));

      const result = await task.execute();

      expect(result).toMatchObject({ skipped: true, skipReason: 'disabled' });
    });

    it('skips with deleted when the subscriber is deleted after scheduling', async () => {
      const atSchedule = createMockSubscriber({ eventFilter: null });
      mockStorage.findSubscribersByEventName.mockResolvedValue([atSchedule]);
      mockStorage.getSubscriber.mockResolvedValue(atSchedule);

      await service.handleEvent('terminal.watcher.triggered', createMockPayload());

      const task = captureScheduledTask();

      mockStorage.getSubscriber.mockResolvedValue(null);

      const result = await task.execute();

      expect(result).toMatchObject({ skipped: true, skipReason: 'deleted' });
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
  describe('getSessionRuntime fail-fast', () => {
    it('throws when SessionRuntime cannot be resolved via moduleRef', () => {
      const nullModuleRef = { get: jest.fn().mockReturnValue(undefined) };

      const svc = new SubscriberExecutorService(
        {} as unknown as never,
        // storage
        {} as unknown as never,
        // terminalIO
        {} as unknown as never,
        // sessionsService
        {} as unknown as never,
        // sessionCoordinator
        {} as unknown as never,
        // amd
        {} as unknown as never,
        // eventLogService
        { addListener: jest.fn(), onAny: jest.fn() } as unknown as never,
        // eventEmitter
        {} as unknown as never,
        // scheduler
        {} as unknown as never,
        // teamsService
        nullModuleRef as unknown as never,
        // moduleRef,
        createProjectWriteGateStub() as never,
      );

      expect(() =>
        (svc as unknown as { getSessionRuntime: () => unknown }).getSessionRuntime(),
      ).toThrow('SessionRuntime is not available in the current module context');
    });
  });
});
