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
});
