import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { SessionsMessagePoolService } from './sessions-message-pool.service';
import { SessionsService } from './sessions.service';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionLifecycleFacade } from './session-lifecycle-facade.service';
import { MessageActivityStreamService } from './message-activity-stream.service';
import { MessageLogService } from './message-log.service';
import { DeliveryFailureNotifierService } from './delivery-failure-notifier.service';
import type { SessionDto } from '../dtos/sessions.dto';
import { HumanPromptStateService } from '../../terminal/services/human-prompt-state.service';
import { TerminalSession } from '../../terminal/services/terminal-session/terminal-session';
import { emitHumanPromptStateChangedBarrier } from '../../events/catalog/session.human-prompt-state-changed';

/**
 * Layer: backend integration. The real Nest event explorer and EventEmitter2 are the
 * cheapest reliable boundary for proving an async lifecycle event is not lost while
 * the synchronous idle-lane enqueue mutation is still running.
 */
describe('SessionsMessagePoolService idle lifecycle integration', () => {
  let moduleRef: TestingModule;
  let service: SessionsMessagePoolService;
  let eventEmitter: EventEmitter2;
  let humanPromptState: HumanPromptStateService;
  let coordinator: SessionCoordinatorService;
  let currentSession: SessionDto;
  let emitIdleDuringConfigRead: boolean;
  let terminalIO: { deliver: jest.Mock; deliverImmediate: jest.Mock; deliverGuarded: jest.Mock };

  const config = {
    enabled: true,
    delayMs: 10000,
    maxWaitMs: 30000,
    maxMessages: 10,
    separator: '\n---\n',
  };

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    currentSession = {
      id: 'session-1',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionId: 'tmux-1',
      providerSessionId: null,
      providerNameAtLaunch: null,
      status: 'running',
      startedAt: '2026-08-15T00:00:00.000Z',
      endedAt: null,
      lastActivityAt: '2026-08-15T00:00:00.000Z',
      activityState: 'busy',
      busySince: '2026-08-15T00:00:00.000Z',
      transcriptPath: null,
      name: null,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    };
    emitIdleDuringConfigRead = false;
    terminalIO = {
      deliver: jest.fn().mockResolvedValue({ confirmed: true, nonce: 'nonce-1', retryCount: 0 }),
      deliverImmediate: jest
        .fn()
        .mockResolvedValue({ confirmed: true, nonce: 'mobile', retryCount: 0 }),
      deliverGuarded: jest
        .fn()
        .mockImplementation(
          async (...[, , , , mutationFence]: Parameters<TerminalIOService['deliverGuarded']>) => {
            if (mutationFence && !mutationFence.canStartMutation()) {
              return { deferred: 'human_draft' };
            }
            mutationFence?.markMutationStarted();
            return { confirmed: true, nonce: 'nonce-1', retryCount: 0 };
          },
        ),
    };

    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        SessionsMessagePoolService,
        SessionCoordinatorService,
        MessageLogService,
        HumanPromptStateService,
        {
          provide: SessionsService,
          useValue: {
            getActiveSessionForAgent: jest.fn(() => currentSession),
            getSession: jest.fn(() => currentSession),
            listActiveSessions: jest.fn(async () => [currentSession]),
          },
        },
        { provide: TerminalIOService, useValue: terminalIO },
        {
          provide: SettingsService,
          useValue: {
            getMessagePoolConfig: jest.fn(() => config),
            getMessagePoolConfigForProject: jest.fn(() => {
              if (emitIdleDuringConfigRead) {
                emitIdleDuringConfigRead = false;
                currentSession = {
                  ...currentSession,
                  activityState: 'idle',
                  busySince: null,
                };
                eventEmitter.emit('session.activity.changed', {
                  sessionId: currentSession.id,
                  state: 'idle',
                  lastActivityAt: currentSession.lastActivityAt,
                  busySince: null,
                });
              }
              return config;
            }),
          },
        },
        {
          provide: STORAGE_SERVICE,
          useValue: {
            isAgentDisabled: jest.fn().mockReturnValue(false),
            getAgent: jest.fn(async () => ({
              id: 'agent-1',
              name: 'Agent One',
              projectId: 'project-1',
            })),
          },
        },
        {
          provide: MessageActivityStreamService,
          useValue: {
            broadcastEnqueued: jest.fn(),
            broadcastDelivered: jest.fn(),
            broadcastUnconfirmed: jest.fn(),
            broadcastFailed: jest.fn(),
            broadcastPoolsUpdated: jest.fn(),
          },
        },
        {
          provide: ProviderAdapterFactory,
          useValue: { getRuntimePromptBehaviorForAgent: jest.fn(async () => ({})) },
        },
        {
          provide: DeliveryFailureNotifierService,
          useValue: { notifySendersOfFailure: jest.fn(async () => undefined) },
        },
      ],
    }).compile();
    await moduleRef.init();

    service = moduleRef.get(SessionsMessagePoolService);
    eventEmitter = moduleRef.get(EventEmitter2);
    humanPromptState = moduleRef.get(HumanPromptStateService);
    coordinator = moduleRef.get(SessionCoordinatorService);
  });

  afterEach(async () => {
    await moduleRef.close();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('delivers when idle is persisted and emitted after the active-session read but before insertion', async () => {
    emitIdleDuringConfigRead = true;

    await expect(
      service.enqueue('agent-1', 'Deliver after the race', {
        source: 'integration',
        deliveryMode: 'on_idle',
        projectId: 'project-1',
        agentName: 'Agent One',
      }),
    ).resolves.toMatchObject({ status: 'queued' });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(terminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    expect(terminalIO.deliverGuarded).toHaveBeenCalledWith(
      { name: 'tmux-1' },
      'Deliver after the race',
      expect.objectContaining({ agentId: 'agent-1' }),
      undefined,
      expect.any(Object),
    );
    expect(service.getPoolStats()).toEqual([]);
  });

  it('awaits the Nest activation listener until pooled protected work is exact-session bound', async () => {
    await service.enqueue('agent-1', 'pooled before typing', {
      source: 'agent-message',
      deferWhileHumanTyping: true,
    });
    const draft = humanPromptState.recordPromptText('tmux-1');

    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: 'session-1',
      tmuxSessionName: 'tmux-1',
      generation: draft.generation,
      phase: 'draft_active',
    });

    expect(service.getPoolDetails()).toEqual([
      expect.objectContaining({ humanHeldMessageCount: 1 }),
    ]);
    await service.flushNow('agent-1');
    expect(terminalIO.deliver).not.toHaveBeenCalled();
  });

  it('finishes activation promotion before a queued replacement acquires the agent lock', async () => {
    await service.enqueue('agent-1', 'pooled before concurrent replacement', {
      source: 'agent-message',
      deferWhileHumanTyping: true,
    });
    const draft = humanPromptState.recordPromptText('tmux-1');

    const activation = emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: 'session-1',
      tmuxSessionName: 'tmux-1',
      generation: draft.generation,
      phase: 'draft_active',
    });
    let heldCountSeenByReplacement = -1;
    const replacement = coordinator.withAgentLock('agent-1', async () => {
      heldCountSeenByReplacement = service.getPoolDetails()[0]?.humanHeldMessageCount ?? 0;
      currentSession = {
        ...currentSession,
        id: 'session-2',
        tmuxSessionId: 'tmux-2',
      };
    });

    await Promise.all([activation, replacement]);

    expect(heldCountSeenByReplacement).toBe(1);
    expect(service.getPoolDetails()).toEqual([
      expect.objectContaining({ humanHeldMessageCount: 1 }),
    ]);
    expect(terminalIO.deliver).not.toHaveBeenCalled();
  });

  it('delivers deferred messages after Enter while the provider keeps printing output', async () => {
    const tmuxName = 'tmux-1';
    const session = new TerminalSession({
      sessionId: 'session-1',
      tmuxSessionName: tmuxName,
      humanPromptState: humanPromptState,
    });

    await service.enqueue('agent-1', 'deferred while typing', {
      source: 'agent-message',
      deferWhileHumanTyping: true,
    });
    const draft = humanPromptState.recordPromptText(tmuxName);
    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: 'session-1',
      tmuxSessionName: tmuxName,
      generation: draft.generation,
      phase: 'draft_active',
    });
    expect(service.getPoolDetails()).toEqual([
      expect.objectContaining({ humanHeldMessageCount: 1 }),
    ]);

    // Transition to awaiting_stable_idle via the real state machine
    const transition = humanPromptState.transitionToAwaiting(tmuxName, draft.generation);
    expect(transition.accepted).toBe(true);

    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: 'session-1',
      tmuxSessionName: tmuxName,
      generation: transition.state.generation,
      phase: 'awaiting_stable_idle',
    });

    // A working provider keeps printing real text through the real TerminalSession.
    // Only human input restarts the grace, so the 2-second window after Enter still fires.
    session.pushFrame('Reading files');
    await jest.advanceTimersByTimeAsync(1000);
    session.pushFrame('Running tests');
    expect(session.getActivityState().lastDataAt).not.toBeNull();

    // Wait for the rest of HUMAN_DRAFT_IDLE_GRACE_MS (2 s) + margin
    await jest.advanceTimersByTimeAsync(1500);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(terminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    expect(service.getPoolStats()).toEqual([]);

    session.dispose();
  }, 10_000);

  it('protects an active draft even when particles are the only output', async () => {
    await service.enqueue('agent-1', 'held while drafting', {
      source: 'agent-message',
      deferWhileHumanTyping: true,
    });
    const draft = humanPromptState.recordPromptText('tmux-1');
    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: 'session-1',
      tmuxSessionName: 'tmux-1',
      generation: draft.generation,
      phase: 'draft_active',
    });

    // Even after waiting, draft_active never arms the quiet timer
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(terminalIO.deliverGuarded).not.toHaveBeenCalled();
    expect(service.getPoolDetails()).toEqual([
      expect.objectContaining({ humanHeldMessageCount: 1 }),
    ]);
  });

  it('completes an explicit mobile submit without reacquiring the agent lock', async () => {
    await service.enqueue('agent-1', 'held autonomous', {
      source: 'agent-message',
      deferWhileHumanTyping: true,
    });
    const draft = humanPromptState.recordPromptText('tmux-1');
    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: 'session-1',
      tmuxSessionName: 'tmux-1',
      generation: draft.generation,
      phase: 'draft_active',
    });

    await expect(
      service.enqueue('agent-1', 'mobile reply', {
        source: 'mobile',
        deliveryMode: 'immediate',
        humanPromptSubmit: true,
      }),
    ).resolves.toMatchObject({ status: 'delivered' });

    expect(humanPromptState.getState('tmux-1')).toEqual(
      expect.objectContaining({ phase: 'awaiting_stable_idle', generation: 2 }),
    );
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
  });

  describe('force deferred delivery', () => {
    async function setupDeferredLane(): Promise<{ messageIds: string[] }> {
      jest.spyOn(Date, 'now').mockReturnValue(1000);

      await service.enqueue('agent-1', 'Queued message', {
        source: 'agent-message',
        deferWhileHumanTyping: true,
      });
      const draft = humanPromptState.recordPromptText('tmux-1');
      await emitHumanPromptStateChangedBarrier(eventEmitter, {
        sessionId: 'session-1',
        tmuxSessionName: 'tmux-1',
        generation: draft.generation,
        phase: 'draft_active',
      });

      const transition = humanPromptState.transitionToAwaiting('tmux-1', draft.generation);
      expect(transition.accepted).toBe(true);
      await emitHumanPromptStateChangedBarrier(eventEmitter, {
        sessionId: 'session-1',
        tmuxSessionName: 'tmux-1',
        generation: transition.state.generation,
        phase: 'awaiting_stable_idle',
      });

      const details = service.getPoolDetails();
      return { messageIds: details[0].deferredMessageIds! };
    }

    it('delivers when eligible and returns delivered status', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({ status: 'delivered', deliveredCount: 1 });
      expect(terminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
      expect(service.getPoolStats()).toEqual([]);
    });

    it.each([
      {
        label: 'too young',
        now: 20_000,
        staleBatch: false,
        projectId: 'project-1',
        sessionId: 'session-1',
        expected: { status: 'conflict', reason: 'Messages not yet eligible for force send' },
      },
      {
        label: 'changed batch',
        now: 32_000,
        staleBatch: true,
        projectId: 'project-1',
        sessionId: 'session-1',
        expected: { status: 'conflict', reason: 'Message batch has changed' },
      },
      {
        label: 'wrong project',
        now: 32_000,
        staleBatch: false,
        projectId: 'wrong-project',
        sessionId: 'session-1',
        expected: { status: 'not_found' },
      },
      {
        label: 'wrong session',
        now: 32_000,
        staleBatch: false,
        projectId: 'project-1',
        sessionId: 'wrong-session',
        expected: { status: 'not_found' },
      },
    ])('rejects force for $label', async ({ now, staleBatch, projectId, sessionId, expected }) => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      expect(
        await service.forceDeferredDelivery(
          'agent-1',
          projectId,
          sessionId,
          staleBatch ? ['00000000-0000-0000-0000-000000000000'] : messageIds,
        ),
      ).toEqual(expected);
    });

    it('rejects force during active human draft', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1000);
      await service.enqueue('agent-1', 'Queued message', {
        source: 'agent-message',
        deferWhileHumanTyping: true,
      });
      const draft = humanPromptState.recordPromptText('tmux-1');
      await emitHumanPromptStateChangedBarrier(eventEmitter, {
        sessionId: 'session-1',
        tmuxSessionName: 'tmux-1',
        generation: draft.generation,
        phase: 'draft_active',
      });

      jest.spyOn(Date, 'now').mockReturnValue(32_000);
      const details = service.getPoolDetails();
      expect(details[0].holdReason).toBe('human_draft');
      expect(details[0].forceEligibleAt).toBeUndefined();
    });

    it('exposes holdReason and forceEligibleAt in pool details', async () => {
      await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      const details = service.getPoolDetails();
      expect(details[0]).toEqual(
        expect.objectContaining({
          holdReason: 'awaiting_quiet',
          forceEligibleAt: expect.any(Number),
          activeSessionId: 'session-1',
          deferredMessageIds: expect.any(Array),
        }),
      );
      expect(details[0].forceEligibleAt!).toBeLessThanOrEqual(32_000);
    });

    it('delivers inactive/on_idle lane with busy provider via force', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1000);
      currentSession = { ...currentSession, activityState: 'busy' };

      await service.enqueue('agent-1', 'on_idle message', {
        source: 'agent-message',
        deliveryMode: 'on_idle',
        projectId: 'project-1',
        agentName: 'Agent One',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const details = service.getPoolDetails();
      expect(details[0].holdReason).toBe('awaiting_idle');
      const messageIds = details[0].deferredMessageIds!;
      expect(messageIds).toHaveLength(1);

      jest.spyOn(Date, 'now').mockReturnValue(32_000);
      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({ status: 'delivered', deliveredCount: 1 });
      expect(terminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    });

    it('returns conflict for repeated force while first is in flight', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      let resolveDelivery!: () => void;
      terminalIO.deliverGuarded.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDelivery = () => resolve({ confirmed: true, nonce: 'nonce-1', retryCount: 0 });
          }),
      );

      const first = service.forceDeferredDelivery('agent-1', 'project-1', 'session-1', messageIds);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const second = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(second).toEqual({
        status: 'conflict',
        reason: 'Delivery already in progress',
      });

      resolveDelivery();
      const firstResult = await first;
      expect(firstResult).toEqual({ status: 'delivered', deliveredCount: 1 });
      expect(terminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    });

    it('returns not_found for repeated force after delivery', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      await service.forceDeferredDelivery('agent-1', 'project-1', 'session-1', messageIds);

      const second = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(second).toEqual({ status: 'not_found' });
    });

    it('preserves queue state on deferred outcome', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      terminalIO.deliverGuarded.mockImplementation(
        async (...[, , , , mutationFence]: Parameters<TerminalIOService['deliverGuarded']>) => {
          humanPromptState.recordPromptText('tmux-1');
          if (mutationFence && !mutationFence.canStartMutation()) {
            return { deferred: 'human_draft' };
          }
          mutationFence?.markMutationStarted();
          return { confirmed: true, nonce: 'nonce-1', retryCount: 0 };
        },
      );

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({ status: 'deferred', reason: 'Input changed before paste' });

      const details = service.getPoolDetails();
      expect(details).toHaveLength(1);
      expect(details[0].deferredMessageIds).toHaveLength(1);
      expect(details[0].messageCount).toBe(1);
    });

    it('does not include messages arriving after the claim in the forced batch', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      let resolveDelivery!: () => void;
      terminalIO.deliverGuarded.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveDelivery = () => resolve({ confirmed: true, nonce: 'nonce-1', retryCount: 0 });
          }),
      );

      const forcePromise = service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      await service.enqueue('agent-1', 'Late arrival', {
        source: 'agent-message',
        deferWhileHumanTyping: true,
      });

      resolveDelivery();
      const result = await forcePromise;
      expect(result).toEqual({ status: 'delivered', deliveredCount: 1 });

      expect(terminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
      const deliveredText = terminalIO.deliverGuarded.mock.calls[0][1];
      expect(deliveredText).not.toContain('Late arrival');
    });

    it('force vs quiet-timer race: exactly one delivery, loser gets non-delivering result', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      let resolveForceDelivery!: () => void;
      let forceDeliveryStarted = false;
      terminalIO.deliverGuarded.mockImplementation(
        () =>
          new Promise((resolve) => {
            forceDeliveryStarted = true;
            resolveForceDelivery = () =>
              resolve({ confirmed: true, nonce: 'nonce-1', retryCount: 0 });
          }),
      );

      const forcePromise = service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(forceDeliveryStarted).toBe(true);

      // Quiet timer fires while force is in flight — claim already held
      eventEmitter.emit('session.activity.changed', {
        sessionId: 'session-1',
        state: 'idle',
        lastActivityAt: currentSession.lastActivityAt,
        busySince: null,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      resolveForceDelivery();
      const forceResult = await forcePromise;

      expect(forceResult).toEqual({ status: 'delivered', deliveredCount: 1 });
      expect(terminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
    });

    it('session stop during force preparing cancels without paste and returns failed', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      terminalIO.deliverGuarded.mockImplementation(
        async (...[, , , , mutationFence]: Parameters<TerminalIOService['deliverGuarded']>) => {
          // Session stop fires during the delivery
          eventEmitter.emit('session.stopped', { sessionId: 'session-1' });
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));

          if (mutationFence && !mutationFence.canStartMutation()) {
            return { deferred: 'human_draft' };
          }
          mutationFence?.markMutationStarted();
          return { confirmed: true, nonce: 'nonce-1', retryCount: 0 };
        },
      );

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({
        status: 'failed',
        reason: 'Target session stopped before deferred delivery',
      });
      expect(service.getPoolStats()).toEqual([]);
    });

    it('reports unconfirmed outcome with matching message-log state', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      terminalIO.deliverGuarded.mockImplementation(
        async (...[, , , , mutationFence]: Parameters<TerminalIOService['deliverGuarded']>) => {
          mutationFence?.markMutationStarted();
          return { confirmed: false, nonce: 'nonce-unc', retryCount: 2 };
        },
      );

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({ status: 'unconfirmed', deliveredCount: 1 });

      const logEntry = service.getMessageById(messageIds[0]);
      expect(logEntry).toEqual(
        expect.objectContaining({
          status: 'unconfirmed',
          nonce: 'nonce-unc',
          retryCount: 2,
        }),
      );
    });

    it('reports failed outcome when delivery throws', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      terminalIO.deliverGuarded.mockImplementation(async () => {
        throw new Error('tmux session disappeared');
      });

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({
        status: 'failed',
        reason: expect.stringContaining('tmux'),
      });

      const logEntry = service.getMessageById(messageIds[0]);
      expect(logEntry).toEqual(
        expect.objectContaining({
          status: 'failed',
        }),
      );
    });

    describe('disabled agent', () => {
      let storage: { isAgentDisabled: jest.Mock };
      let writes: number;

      beforeEach(() => {
        storage = moduleRef.get(STORAGE_SERVICE);
        writes = 0;
        terminalIO.deliverGuarded.mockImplementation(
          async (...[, , , , mutationFence]: Parameters<TerminalIOService['deliverGuarded']>) => {
            if (mutationFence && !mutationFence.canStartMutation()) {
              return { deferred: 'human_draft' };
            }
            mutationFence?.markMutationStarted();
            writes += 1;
            return { confirmed: true, nonce: 'nonce-1', retryCount: 0 };
          },
        );
      });

      /** The stop that follows Disable: the session ends and its lane fails. */
      const stopSession = async () => {
        currentSession = { ...currentSession, status: 'stopped' };
        await service.handleSessionStopped({
          sessionId: 'session-1',
          source: 'web-api',
          reason: 'user-requested',
        });
      };
      const force = (messageIds: string[]) =>
        service.forceDeferredDelivery('agent-1', 'project-1', 'session-1', messageIds);
      const deferredIds = () => service.getPoolDetails()[0]?.deferredMessageIds ?? [];
      const disabledConflict = { status: 'conflict', reason: 'Agent is disabled' };

      it('refuses a Force Send that waited for the lock while Disable ran, and the delayed stop fails the lane', async () => {
        const { messageIds } = await setupDeferredLane();
        jest.spyOn(Date, 'now').mockReturnValue(32_000);
        let releaseStop!: () => void;
        const stopGate = new Promise<void>((resolve) => (releaseStop = resolve));
        const sessions = moduleRef.get(SessionsService) as unknown as Record<string, unknown>;
        sessions.terminateSession = jest.fn(async () => {
          await stopGate;
          await stopSession();
        });
        const facade = new SessionLifecycleFacade(
          {} as never,
          sessions as never,
          {} as never,
          coordinator,
          service,
        );
        let release!: () => void;
        let entered!: () => void;
        const inside = new Promise<void>((resolve) => (entered = resolve));
        const holder = coordinator.withAgentLock(
          'agent-1',
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
              entered();
            }),
        );
        await inside;

        const forced = force(messageIds);
        // Disable: the flag write, then the facade's stop, which queues behind Force Send.
        storage.isAgentDisabled.mockReturnValue(true);
        const disable = facade.stopDisabledAgent('agent-1', {
          source: 'web-api',
          reason: 'user-requested',
        });
        release();
        await holder;

        await expect(forced).resolves.toEqual(disabledConflict);
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(sessions.terminateSession).toHaveBeenCalledTimes(1);
        expect(terminalIO.deliverGuarded).not.toHaveBeenCalled();
        expect(deferredIds()).toEqual(messageIds);

        releaseStop();
        await disable;
        expect(service.getPoolDetails()).toEqual([]);
        expect(service.getMessageLog({ agentId: 'agent-1' })).toEqual([
          expect.objectContaining({ status: 'failed' }),
        ]);
      });

      it('stops a forced claim at the pre-paste guard, releases it, and lets the stop finish', async () => {
        const { messageIds } = await setupDeferredLane();
        jest.spyOn(Date, 'now').mockReturnValue(32_000);
        const applyForce = jest.spyOn(humanPromptState, 'applyForceDelivery');
        terminalIO.deliverGuarded.mockImplementationOnce(
          async (...[, , , , mutationFence]: Parameters<TerminalIOService['deliverGuarded']>) => {
            storage.isAgentDisabled.mockReturnValue(true);
            return mutationFence?.canStartMutation()
              ? { confirmed: true, nonce: 'nonce-1', retryCount: 0 }
              : { deferred: 'human_draft' };
          },
        );

        await expect(force(messageIds)).resolves.toEqual(disabledConflict);
        expect(applyForce).not.toHaveBeenCalled();
        expect(writes).toBe(0);

        // The refused claim released the lane, so a retry meets the flag, not the claim.
        await expect(force(messageIds)).resolves.toEqual(disabledConflict);
        await stopSession();
        await expect(force(messageIds)).resolves.toEqual({ status: 'not_found' });
      });

      it('lets a paste that started before the flag write complete', async () => {
        const { messageIds } = await setupDeferredLane();
        jest.spyOn(Date, 'now').mockReturnValue(32_000);
        terminalIO.deliverGuarded.mockImplementationOnce(
          async (...[, , , , mutationFence]: Parameters<TerminalIOService['deliverGuarded']>) => {
            expect(mutationFence?.canStartMutation()).toBe(true);
            mutationFence?.markMutationStarted();
            storage.isAgentDisabled.mockReturnValue(true);
            return { confirmed: true, nonce: 'nonce-1', retryCount: 0 };
          },
        );

        await expect(force(messageIds)).resolves.toEqual({
          status: 'delivered',
          deliveredCount: 1,
        });
        await stopSession();
        expect(service.getPoolDetails()).toEqual([]);
      });

      it('delivers the kept lane with a later Force Send when the stop fails and Enable clears the flag', async () => {
        const { messageIds } = await setupDeferredLane();
        jest.spyOn(Date, 'now').mockReturnValue(32_000);
        storage.isAgentDisabled.mockReturnValue(true);
        await expect(force(messageIds)).resolves.toEqual(disabledConflict);

        storage.isAgentDisabled.mockReturnValue(false);

        await expect(force(messageIds)).resolves.toEqual({
          status: 'delivered',
          deliveredCount: 1,
        });
        expect(writes).toBe(1);
      });

      describe('automatic claim', () => {
        const enqueueWhileBusy = async () => {
          currentSession = { ...currentSession, activityState: 'busy' };
          await service.enqueue('agent-1', 'on_idle message', {
            source: 'agent-message',
            deliveryMode: 'on_idle',
            projectId: 'project-1',
            agentName: 'Agent One',
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          currentSession = { ...currentSession, activityState: 'idle', busySince: null };
        };
        const becomeIdle = () =>
          service.handleSessionActivityChanged({
            sessionId: 'session-1',
            state: 'idle',
            lastActivityAt: currentSession.lastActivityAt ?? null,
            busySince: null,
          });

        it('starts no claim and arms no retry while the flag is set and the session lives', async () => {
          await enqueueWhileBusy();
          storage.isAgentDisabled.mockReturnValue(true);

          await becomeIdle();
          const checks = storage.isAgentDisabled.mock.calls.length;
          await jest.advanceTimersByTimeAsync(60_000);

          expect(terminalIO.deliverGuarded).not.toHaveBeenCalled();
          expect(storage.isAgentDisabled.mock.calls.length).toBe(checks);
          expect(deferredIds()).toHaveLength(1);
          await stopSession();
          expect(service.getPoolDetails()).toEqual([]);
        });

        it('stops a claim at the pre-paste guard when the flag is written after the claim started', async () => {
          await enqueueWhileBusy();
          terminalIO.deliverGuarded.mockImplementationOnce(
            async (...[, , , , mutationFence]: Parameters<TerminalIOService['deliverGuarded']>) => {
              storage.isAgentDisabled.mockReturnValue(true);
              return mutationFence?.canStartMutation()
                ? { confirmed: true, nonce: 'nonce-1', retryCount: 0 }
                : { deferred: 'human_draft' };
            },
          );

          await becomeIdle();
          await jest.advanceTimersByTimeAsync(60_000);

          expect(terminalIO.deliverGuarded).toHaveBeenCalledTimes(1);
          expect(writes).toBe(0);
          expect(deferredIds()).toHaveLength(1);
        });
      });
    });
  });
});
