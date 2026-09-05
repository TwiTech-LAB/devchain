import type { EventsService } from '../../events/services/events.service';
import {
  AgentTimeAccountingService,
  EPIC_TIME_DELIVERY_KEY,
} from './agent-time-accounting.service';
import type { EpicTimeStore } from './epic-time.store';

// Layer: backend unit. Scheduling and hint serialization are observable through
// the store boundary and do not require a database or full Nest application.
describe('AgentTimeAccountingService', () => {
  const activation = {
    trackingStartedAt: '2026-01-01T00:00:10.000Z',
    idleTimeoutMs: 30_000,
    firstActivation: true,
    recoveredOpenSegments: 0,
  };
  let store: jest.Mocked<
    Pick<
      EpicTimeStore,
      | 'activate'
      | 'listReconciliationSessionIds'
      | 'reconcileSession'
      | 'recordTaskTouch'
      | 'processTeamBatches'
    >
  >;
  let events: { registerDurableSubscriber: jest.Mock };
  let unregister: jest.Mock;
  let service: AgentTimeAccountingService;

  beforeEach(() => {
    jest.useFakeTimers();
    store = {
      activate: jest.fn().mockResolvedValue(activation),
      listReconciliationSessionIds: jest.fn().mockReturnValue(['session-sweep']),
      reconcileSession: jest.fn().mockResolvedValue({
        sessionId: 'session-sweep',
        action: 'noop',
        watermark: null,
        segmentId: null,
      }),
      recordTaskTouch: jest.fn().mockResolvedValue({
        receiptCreated: true,
        claimedSegments: 0,
        discardedSegments: 0,
      }),
      processTeamBatches: jest.fn().mockResolvedValue({
        sealedBatches: 0,
        finalizedBatches: 0,
        cancelledBatches: 0,
      }),
    };
    unregister = jest.fn();
    events = { registerDurableSubscriber: jest.fn().mockReturnValue(unregister) };
    service = new AgentTimeAccountingService(
      store as unknown as EpicTimeStore,
      events as unknown as EventsService,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('activates once, runs the correctness sweep, and schedules recurring work', async () => {
    await service.onModuleInit();

    expect(store.activate).toHaveBeenCalledTimes(1);
    expect(events.registerDurableSubscriber).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryKey: EPIC_TIME_DELIVERY_KEY,
        eventNames: ['epic.created', 'epic.updated', 'epic.comment.created'],
        ordered: true,
      }),
    );
    expect(store.listReconciliationSessionIds).toHaveBeenCalledWith(activation.trackingStartedAt);
    expect(store.reconcileSession).toHaveBeenCalledWith(
      'session-sweep',
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      expect.any(Date),
      { forceCloseOpenSegment: true },
    );
    expect(store.processTeamBatches).toHaveBeenCalledWith(
      EPIC_TIME_DELIVERY_KEY,
      activation.idleTimeoutMs,
      expect.any(Date),
    );

    store.listReconciliationSessionIds.mockClear();
    store.reconcileSession.mockClear();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(store.listReconciliationSessionIds).toHaveBeenCalledTimes(1);
    expect(store.reconcileSession).toHaveBeenCalledWith(
      'session-sweep',
      activation.trackingStartedAt,
      activation.idleTimeoutMs,
      expect.any(Date),
      { forceCloseOpenSegment: false },
    );
  });

  it('records agent task touches without inspecting update changes', async () => {
    await service.onModuleInit();

    await service.handleCommittedTaskTouch({
      id: 'event-update',
      name: 'epic.updated',
      payload: {
        epicId: 'epic-target',
        projectId: 'project-1',
        parentId: null,
        version: 2,
        epicTitle: 'Target',
        actor: { type: 'agent', id: 'agent-1' },
        changes: {},
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(store.recordTaskTouch).toHaveBeenCalledWith({
      committedEventId: 'event-update',
      eventName: 'epic.updated',
      projectId: 'project-1',
      actorAgentId: 'agent-1',
      targetEpicId: 'epic-target',
      targetEpicTitle: 'Target',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });
  });

  it('claims a root creation against the created Epic', async () => {
    await service.onModuleInit();

    await service.handleCommittedTaskTouch({
      id: 'event-root-create',
      name: 'epic.created',
      payload: {
        epicId: 'epic-created',
        projectId: 'project-1',
        title: 'Created Epic',
        statusId: null,
        parentId: null,
        actor: { type: 'agent', id: 'agent-1' },
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(store.recordTaskTouch).toHaveBeenCalledWith({
      committedEventId: 'event-root-create',
      eventName: 'epic.created',
      projectId: 'project-1',
      actorAgentId: 'agent-1',
      targetEpicId: 'epic-created',
      targetEpicTitle: 'Created Epic',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });
  });

  it('claims a sub-epic creation against its parent Epic', async () => {
    await service.onModuleInit();

    await service.handleCommittedTaskTouch({
      id: 'event-child-create',
      name: 'epic.created',
      payload: {
        epicId: 'epic-child',
        projectId: 'project-1',
        title: 'Created Sub-epic',
        statusId: null,
        parentId: 'epic-parent',
        parentTitle: 'Parent Epic',
        actor: { type: 'agent', id: 'agent-1' },
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(store.recordTaskTouch).toHaveBeenCalledWith({
      committedEventId: 'event-child-create',
      eventName: 'epic.created',
      projectId: 'project-1',
      actorAgentId: 'agent-1',
      targetEpicId: 'epic-parent',
      targetEpicTitle: 'Parent Epic',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });
  });

  it('uses the created title when a sub-epic parent title snapshot is unavailable', async () => {
    await service.onModuleInit();

    await service.handleCommittedTaskTouch({
      id: 'event-child-create-without-parent-title',
      name: 'epic.created',
      payload: {
        epicId: 'epic-child',
        projectId: 'project-1',
        title: 'Created Sub-epic',
        statusId: null,
        parentId: 'epic-parent',
        actor: { type: 'agent', id: 'agent-1' },
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(store.recordTaskTouch).toHaveBeenCalledWith(
      expect.objectContaining({
        targetEpicId: 'epic-parent',
        targetEpicTitle: 'Created Sub-epic',
      }),
    );
  });

  it('claims an agent comment against its exact Epic regardless of parent context', async () => {
    await service.onModuleInit();

    await service.handleCommittedTaskTouch({
      id: 'event-comment-exact',
      name: 'epic.comment.created',
      payload: {
        commentId: 'comment-1',
        epicId: 'epic-sub',
        projectId: 'project-1',
        parentId: 'epic-parent',
        authorName: 'Coder',
        content: 'worked here',
        actor: { type: 'agent', id: 'agent-1' },
        epicTitle: 'Sub task',
        recipientIds: [],
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(store.recordTaskTouch).toHaveBeenCalledWith({
      committedEventId: 'event-comment-exact',
      eventName: 'epic.comment.created',
      projectId: 'project-1',
      actorAgentId: 'agent-1',
      targetEpicId: 'epic-sub',
      targetEpicTitle: 'Sub task',
      publishedAt: '2026-01-01T00:00:20.000Z',
    });
  });

  it('skips a malformed title-less comment touch without failing the ordered delivery', async () => {
    await service.onModuleInit();

    await expect(
      service.handleCommittedTaskTouch({
        id: 'event-comment-titleless',
        name: 'epic.comment.created',
        payload: {
          commentId: 'comment-2',
          epicId: 'epic-target',
          projectId: 'project-1',
          parentId: null,
          authorName: 'Coder',
          content: 'no title fact',
          actor: { type: 'agent', id: 'agent-1' },
          recipientIds: [],
        },
        requestId: null,
        publishedAt: '2026-01-01T00:00:20.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(store.recordTaskTouch).not.toHaveBeenCalled();

    await service.handleCommittedTaskTouch({
      id: 'event-after-titleless',
      name: 'epic.updated',
      payload: {
        epicId: 'epic-target',
        projectId: 'project-1',
        parentId: null,
        version: 2,
        epicTitle: 'Target',
        actor: { type: 'agent', id: 'agent-1' },
        changes: {},
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:21.000Z',
    });

    expect(store.recordTaskTouch).toHaveBeenCalledWith(
      expect.objectContaining({ committedEventId: 'event-after-titleless' }),
    );
  });

  it.each([
    ['actorless REST/mobile comment', null],
    ['guest comment', { type: 'guest' as const, id: 'guest-1' }],
  ])('treats a %s as a non-attributing no-op', async (_label, actor) => {
    await service.onModuleInit();

    await service.handleCommittedTaskTouch({
      id: `event-${_label}`,
      name: 'epic.comment.created',
      payload: {
        commentId: 'comment-actorless',
        epicId: 'epic-target',
        projectId: 'project-1',
        parentId: null,
        authorName: 'Someone',
        content: 'cannot claim time',
        actor,
        epicTitle: 'Target',
        recipientIds: [],
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(store.recordTaskTouch).not.toHaveBeenCalled();
  });

  it.each([
    ['browser/system', null],
    ['guest', { type: 'guest' as const, id: 'guest-1' }],
  ])('treats %s task touches as successful no-ops', async (_label, actor) => {
    await service.onModuleInit();
    await service.handleCommittedTaskTouch({
      id: `event-${_label}`,
      name: 'epic.created',
      payload: {
        epicId: 'epic-target',
        projectId: 'project-1',
        title: 'Target',
        statusId: null,
        actor,
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:20.000Z',
    });

    expect(store.recordTaskTouch).not.toHaveBeenCalled();
  });

  it('routes Busy, Idle, Stop, and Crash hints through the same reconciliation path', async () => {
    store.listReconciliationSessionIds.mockReturnValue([]);
    await service.onModuleInit();
    store.reconcileSession.mockClear();

    await service.handleActivityChanged({
      sessionId: 'busy',
      state: 'busy',
      lastActivityAt: 'stale-event-fact',
      busySince: 'stale-event-fact',
    });
    await service.handleActivityChanged({
      sessionId: 'idle',
      state: 'idle',
      lastActivityAt: null,
      busySince: null,
    });
    await service.handleSessionStopped({
      sessionId: 'stopped',
      source: 'web-api',
      reason: 'user-requested',
    });
    await service.handleSessionCrashed({ sessionId: 'crashed', sessionName: 'tmux-crashed' });

    expect(store.reconcileSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'busy',
      'idle',
      'stopped',
      'crashed',
    ]);
  });

  it('serializes a live hint against a concurrent correctness sweep', async () => {
    store.listReconciliationSessionIds.mockReturnValue([]);
    await service.onModuleInit();
    store.listReconciliationSessionIds.mockClear();
    let release!: () => void;
    store.reconcileSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ sessionId: 'live', action: 'noop', watermark: null, segmentId: null });
        }),
    );

    const live = service.requestSessionReconciliation('live');
    const sweep = service.requestFullSweep();
    await Promise.resolve();
    expect(store.listReconciliationSessionIds).not.toHaveBeenCalled();

    release();
    await live;
    await sweep;
    expect(store.listReconciliationSessionIds).toHaveBeenCalledTimes(1);
  });

  it('drains an accepted durable task touch through workTail after teardown begins', async () => {
    store.listReconciliationSessionIds.mockReturnValue([]);
    await service.onModuleInit();
    store.reconcileSession.mockClear();
    store.recordTaskTouch.mockClear();
    store.processTeamBatches.mockClear();
    const order: string[] = [];
    let release!: () => void;
    store.reconcileSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          order.push('reconcile-start');
          release = () => {
            order.push('reconcile-end');
            resolve({ sessionId: 'live', action: 'noop', watermark: null, segmentId: null });
          };
        }),
    );
    store.processTeamBatches.mockImplementation(async () => {
      order.push('batch-process');
      return { sealedBatches: 0, finalizedBatches: 0, cancelledBatches: 0 };
    });
    store.recordTaskTouch.mockImplementation(async () => {
      order.push('task-touch');
      return { receiptCreated: true, claimedSegments: 0, discardedSegments: 0 };
    });

    const live = service.requestSessionReconciliation('live');
    const durable = service.handleCommittedTaskTouch({
      id: 'event-serialized',
      name: 'epic.updated',
      payload: {
        epicId: 'epic-target',
        projectId: 'project-1',
        parentId: null,
        version: 2,
        epicTitle: 'Target',
        actor: { type: 'agent', id: 'agent-1' },
        changes: {},
      },
      requestId: null,
      publishedAt: '2026-01-01T00:00:20.000Z',
    });
    await Promise.resolve();
    expect(store.recordTaskTouch).not.toHaveBeenCalled();

    service.onModuleDestroy();
    expect(unregister).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([live, durable]);
    expect(order).toEqual([
      'reconcile-start',
      'reconcile-end',
      'batch-process',
      'task-touch',
      'batch-process',
    ]);
  });
});
