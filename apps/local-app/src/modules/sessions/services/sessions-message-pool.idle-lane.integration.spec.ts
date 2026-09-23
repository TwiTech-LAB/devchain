import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { SessionsMessagePoolService } from './sessions-message-pool.service';
import { SessionsService } from './sessions.service';
import { SessionCoordinatorService } from './session-coordinator.service';
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
          useValue: { getPostPasteDelayMsForAgent: jest.fn(async () => undefined) },
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
    jest.useFakeTimers();
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

  it('delivers deferred messages when particle-only output does not starve the quiet window', async () => {
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

    // Push particle-only frames through the real TerminalSession.
    // With the fix these do NOT advance the meaningful output epoch,
    // so the quiet snapshot stays stable and the 2-second grace fires.
    session.pushFrame('\x1b[38;5;245m⠁\x1b[0m');
    session.pushFrame('⠂⠄⠈');

    expect(humanPromptState.getState(tmuxName).meaningfulOutputEpoch).toBe(0);

    // Wait for HUMAN_DRAFT_IDLE_GRACE_MS (2 s) + margin
    await new Promise((resolve) => setTimeout(resolve, 2500));
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

    it('rejects force when messages are not yet 30 seconds old', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(20_000);

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({
        status: 'conflict',
        reason: 'Messages not yet eligible for force send',
      });
    });

    it('rejects force when message batch has changed', async () => {
      await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      const result = await service.forceDeferredDelivery('agent-1', 'project-1', 'session-1', [
        '00000000-0000-0000-0000-000000000000',
      ]);

      expect(result).toEqual({ status: 'conflict', reason: 'Message batch has changed' });
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

    it('rejects force with wrong project', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'wrong-project',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({ status: 'not_found' });
    });

    it('rejects force with wrong session', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'wrong-session',
        messageIds,
      );

      expect(result).toEqual({ status: 'not_found' });
    });

    it('returns deferred when input changes before paste', async () => {
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

    it('force succeeds despite meaningful output continuing', async () => {
      const { messageIds } = await setupDeferredLane();
      jest.spyOn(Date, 'now').mockReturnValue(32_000);

      humanPromptState.recordMeaningfulOutput('tmux-1');
      humanPromptState.recordMeaningfulOutput('tmux-1');

      const result = await service.forceDeferredDelivery(
        'agent-1',
        'project-1',
        'session-1',
        messageIds,
      );

      expect(result).toEqual({ status: 'delivered', deliveredCount: 1 });
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
  });
});
