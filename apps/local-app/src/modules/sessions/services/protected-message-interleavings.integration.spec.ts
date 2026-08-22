import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { EventsService } from '../../events/services/events.service';
import { emitHumanPromptStateChangedBarrier } from '../../events/catalog/session.human-prompt-state-changed';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { HumanPromptStateService } from '../../terminal/services/human-prompt-state.service';
import {
  ProcessExecutor,
  type DaemonSpawnOptions,
  type ExecutorResult,
  type ProcessExecutorOptions,
} from '../../terminal/services/process-executor/process-executor.port';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import type { SessionDto } from '../dtos/sessions.dto';
import { DeliveryFailureNotifierService } from './delivery-failure-notifier.service';
import { MessageActivityStreamService } from './message-activity-stream.service';
import { MessageLogService } from './message-log.service';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionsMessagePoolService } from './sessions-message-pool.service';
import { SessionsService } from './sessions.service';

const SUCCESS: ExecutorResult = {
  success: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
};

class DeterministicPaneExecutor extends ProcessExecutor {
  readonly effects: string[] = [];
  private readonly buffers = new Map<string, string>();
  private heldLoad:
    | {
        needle: string;
        started: Promise<void>;
        markStarted: () => void;
        released: Promise<void>;
        release: () => void;
      }
    | undefined;
  private heldPaste:
    | {
        needle: string;
        started: Promise<void>;
        markStarted: () => void;
        released: Promise<void>;
        release: () => void;
      }
    | undefined;

  holdLoadContaining(needle: string): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.heldLoad = { needle, started, markStarted, released, release };
    return { started, release };
  }

  holdPasteContaining(needle: string): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.heldPaste = { needle, started, markStarted, released, release };
    return { started, release };
  }

  async run(options: ProcessExecutorOptions): Promise<ExecutorResult> {
    const command = options.argv[1];
    if (command === 'load-buffer') {
      const input = options.input ?? '';
      const hold = this.heldLoad;
      if (hold && input.includes(hold.needle)) {
        hold.markStarted();
        await hold.released;
        this.heldLoad = undefined;
      }
      this.buffers.set(this.argumentAfter(options.argv, '-b'), input);
      return SUCCESS;
    }

    if (command === 'paste-buffer') {
      const target = this.argumentAfter(options.argv, '-t');
      const buffer = this.argumentAfter(options.argv, '-b');
      const contents = this.buffers.get(buffer) ?? '';
      const hold = this.heldPaste;
      if (hold && contents.includes(hold.needle)) {
        hold.markStarted();
        await hold.released;
        this.heldPaste = undefined;
      }
      this.effects.push(`${target}:paste:${contents}`);
      return SUCCESS;
    }

    if (command === 'send-keys') {
      const targetIndex = options.argv.indexOf('-t');
      const target = options.argv[targetIndex + 1] ?? '';
      const keys = options.argv.slice(targetIndex + 2).join(' ');
      this.effects.push(`${target}:keys:${keys}`);
      return SUCCESS;
    }

    if (command === 'capture-pane') {
      return { ...SUCCESS, stdout: this.effects.join('\n') };
    }

    return SUCCESS;
  }

  async spawnDaemon(_options: DaemonSpawnOptions): Promise<{ pid: number }> {
    return { pid: 1 };
  }

  private argumentAfter(argv: readonly string[], flag: string): string {
    const index = argv.indexOf(flag);
    return index >= 0 ? (argv[index + 1] ?? '') : '';
  }
}

/**
 * Layer: backend integration. Real Nest event discovery, the per-agent coordinator,
 * prompt state, message pool, and TerminalIO FIFO are retained. Only the tmux process
 * boundary is replaced with a deterministic pane so races have observable output.
 */
describe('protected message ownership interleavings', () => {
  let moduleRef: TestingModule;
  let eventEmitter: EventEmitter2;
  let humanPromptState: HumanPromptStateService;
  let messagePool: SessionsMessagePoolService;
  let pane: DeterministicPaneExecutor;
  let terminalIO: TerminalIOService;

  const session: SessionDto = {
    id: 'session-1',
    epicId: null,
    agentId: 'agent-1',
    tmuxSessionId: 'tmux-1',
    providerSessionId: null,
    providerNameAtLaunch: null,
    status: 'running',
    startedAt: '2026-08-22T00:00:00.000Z',
    endedAt: null,
    lastActivityAt: '2026-08-22T00:00:00.000Z',
    activityState: 'busy',
    busySince: '2026-08-22T00:00:00.000Z',
    transcriptPath: null,
    name: null,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  };

  beforeEach(async () => {
    pane = new DeterministicPaneExecutor();
    const config = {
      enabled: true,
      delayMs: 10_000,
      maxWaitMs: 30_000,
      maxMessages: 10,
      separator: '\n---\n',
    };

    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' })],
      providers: [
        HumanPromptStateService,
        TerminalIOService,
        SessionsMessagePoolService,
        SessionCoordinatorService,
        MessageLogService,
        { provide: ProcessExecutor, useValue: pane },
        { provide: EventsService, useValue: { publish: jest.fn() } },
        {
          provide: SessionsService,
          useValue: {
            getActiveSessionForAgent: jest.fn(() => session),
            getSession: jest.fn(() => session),
            listActiveSessions: jest.fn(async () => [session]),
          },
        },
        {
          provide: SettingsService,
          useValue: {
            getMessagePoolConfig: jest.fn(() => config),
            getMessagePoolConfigForProject: jest.fn(() => config),
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
          useValue: { getPostPasteDelayMsForAgent: jest.fn(async () => 0) },
        },
        {
          provide: DeliveryFailureNotifierService,
          useValue: { notifySendersOfFailure: jest.fn(async () => undefined) },
        },
      ],
    }).compile();
    await moduleRef.init();

    eventEmitter = moduleRef.get(EventEmitter2);
    humanPromptState = moduleRef.get(HumanPromptStateService);
    messagePool = moduleRef.get(SessionsMessagePoolService);
    terminalIO = moduleRef.get(TerminalIOService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('binds protected work to the exact lane before any pane mutation', async () => {
    const draft = humanPromptState.recordPromptText('tmux-1');
    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: session.id,
      tmuxSessionName: 'tmux-1',
      generation: draft.generation,
      phase: 'draft_active',
    });

    await expect(
      messagePool.enqueue('agent-1', 'protected after human text', {
        source: 'agent-message',
        deliveryMode: 'immediate',
        deferWhileHumanTyping: true,
      }),
    ).resolves.toMatchObject({ status: 'queued' });

    expect(pane.effects).toEqual([]);
    expect(messagePool.getPoolDetails()).toEqual([
      expect.objectContaining({
        agentId: 'agent-1',
        messageCount: 1,
        humanHeldMessageCount: 1,
      }),
    ]);
    expect(messagePool.getMessageLog()).toEqual([
      expect.objectContaining({ text: 'protected after human text', status: 'queued' }),
    ]);
  });

  it('finishes protected delivery before later human text mutates the pane', async () => {
    const held = pane.holdLoadContaining('protected before typing');
    const protectedDelivery = messagePool.enqueue('agent-1', 'protected before typing', {
      source: 'agent-message',
      deliveryMode: 'immediate',
      deferWhileHumanTyping: true,
    });
    await held.started;

    const draft = humanPromptState.recordPromptText('tmux-1');
    const laterHumanText = (async () => {
      await emitHumanPromptStateChangedBarrier(eventEmitter, {
        sessionId: session.id,
        tmuxSessionName: 'tmux-1',
        generation: draft.generation,
        phase: 'draft_active',
      });
      await terminalIO.sendControl({ name: 'tmux-1' }, ['-l', '--', 'later human text']);
    })();

    await Promise.resolve();
    expect(pane.effects).toEqual([]);

    held.release();
    await expect(protectedDelivery).resolves.toMatchObject({ status: 'delivered' });
    await laterHumanText;

    expect(pane.effects).toHaveLength(3);
    expect(pane.effects[0]).toContain('paste:');
    expect(pane.effects[0]).toContain('protected before typing');
    expect(pane.effects[1]).toBe('=tmux-1::keys:Enter');
    expect(pane.effects[2]).toBe('=tmux-1::keys:-l -- later human text');
    expect(messagePool.getPoolDetails()).toEqual([]);
    expect(messagePool.getMessageLog()).toEqual([
      expect.objectContaining({ text: 'protected before typing', status: 'delivered' }),
    ]);
  });

  it('cancels lifecycle detachment while guarded delivery is still preparing', async () => {
    jest.useFakeTimers();
    const draft = humanPromptState.recordPromptText('tmux-1');
    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: session.id,
      tmuxSessionName: 'tmux-1',
      generation: draft.generation,
      phase: 'draft_active',
    });
    await messagePool.enqueue('agent-1', 'cancel held load', {
      source: 'agent-message',
      deferWhileHumanTyping: true,
    });
    const awaiting = humanPromptState.transitionToAwaiting('tmux-1', draft.generation);
    if (!awaiting.accepted) throw new Error('test prompt transition rejected');
    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: session.id,
      tmuxSessionName: 'tmux-1',
      generation: awaiting.state.generation,
      phase: 'awaiting_stable_idle',
    });
    const held = pane.holdLoadContaining('cancel held load');

    jest.advanceTimersByTime(2_000);
    await held.started;
    await messagePool.handleSessionStopped({
      sessionId: session.id,
      source: 'subscriber',
      reason: 'user-requested',
    });

    expect(messagePool.getMessageLog()[0]).toMatchObject({ status: 'failed' });
    held.release();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    expect(pane.effects).toEqual([]);
    expect(messagePool.getMessageLog()[0]).toMatchObject({ status: 'failed' });
    jest.useRealTimers();
  });

  it('awaits lifecycle detachment after the first pane mutation starts', async () => {
    jest.useFakeTimers();
    const draft = humanPromptState.recordPromptText('tmux-1');
    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: session.id,
      tmuxSessionName: 'tmux-1',
      generation: draft.generation,
      phase: 'draft_active',
    });
    await messagePool.enqueue('agent-1', 'finish held paste', {
      source: 'agent-message',
      deferWhileHumanTyping: true,
    });
    const awaiting = humanPromptState.transitionToAwaiting('tmux-1', draft.generation);
    if (!awaiting.accepted) throw new Error('test prompt transition rejected');
    await emitHumanPromptStateChangedBarrier(eventEmitter, {
      sessionId: session.id,
      tmuxSessionName: 'tmux-1',
      generation: awaiting.state.generation,
      phase: 'awaiting_stable_idle',
    });
    const held = pane.holdPasteContaining('finish held paste');

    jest.advanceTimersByTime(2_000);
    await held.started;
    const stopped = messagePool.handleSessionStopped({
      sessionId: session.id,
      source: 'subscriber',
      reason: 'user-requested',
    });
    let stoppedSettled = false;
    void stopped.then(() => {
      stoppedSettled = true;
    });
    await Promise.resolve();

    expect(stoppedSettled).toBe(false);
    expect(messagePool.getMessageLog()[0]).toMatchObject({ status: 'queued' });
    held.release();
    await stopped;

    expect(pane.effects[0]).toContain('finish held paste');
    expect(messagePool.getMessageLog()[0]).toMatchObject({ status: 'delivered' });
    jest.useRealTimers();
  });
});
