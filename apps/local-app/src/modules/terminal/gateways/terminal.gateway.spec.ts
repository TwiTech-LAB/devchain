import { TerminalGateway } from './terminal.gateway';
import {
  PROMPT_PASTE_MAX_REQUESTS_PER_SESSION,
  PROMPT_PASTE_RETRY_WINDOW_MS,
} from './terminal.gateway';
import { WsException } from '@nestjs/websockets';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { TerminalStreamService, type FrameReplayResult } from '../services/terminal-stream.service';
import {
  SettingsService,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
} from '../../settings/services/settings.service';
import { PtyService } from '../services/pty.service';
import {
  TerminalSeedDelivery,
  TerminalSeedService,
  type TerminalSeedDeliveryDecision,
} from '../services/terminal-seed.service';
import { TerminalIOService } from '../services/terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from '../services/terminal-session/terminal-session-registry';
import { createEnvelope } from '../dtos/ws-envelope.dto';
import type { SessionTerminalRuntimeService } from '../../session-terminal-runtime/session-terminal-runtime.service';
import type { Socket } from 'socket.io';

function runtimeDescriptor(sessionId: string, usesAlternateScreen = false) {
  return {
    sessionId,
    tmuxSessionName: `tmux_${sessionId}`,
    normalizeLf: true,
    usesAlternateScreen,
  };
}

function setUsesAlternateScreen(
  runtime: Partial<SessionTerminalRuntimeService>,
  usesAlternateScreen: boolean,
): void {
  (runtime.getDescriptor as jest.Mock).mockImplementation((sessionId: string) =>
    runtimeDescriptor(sessionId, usesAlternateScreen),
  );
}
import { TerminalViewportFacade } from '../services/terminal-viewport/terminal-viewport.facade';
import {
  TerminalSendAdmission,
  TerminalSendSchedulerService,
} from '../services/terminal-send-scheduler.service';
import { TerminalSocketDrainAdapter } from '../services/terminal-socket-drain.adapter';
import { HumanPromptStateService } from '../services/human-prompt-state.service';
import { HumanPromptInputService } from '../services/human-prompt-input.service';
import { sessionHumanPromptStateChangedEvent } from '../../events/catalog/session.human-prompt-state-changed';

/** The stable sequence-domain epoch the mock stream service reports for every session. */
const MOCK_SEQUENCE_EPOCH = 'epoch-1';

function promptPastePayload(sessionId: string, ordinal = 1, data = 'selected prompt') {
  return {
    kind: 'prompt-paste' as const,
    sessionId,
    requestId: `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`,
    data,
  };
}

class GatewayDrainAdapter {
  readonly sent: ReturnType<typeof createEnvelope>[] = [];
  private readonly sentBySocket = new Map<string, ReturnType<typeof createEnvelope>[]>();
  private readonly writable = new Map<string, boolean>();
  private readonly completion = new Map<string, () => void>();
  private readonly ready = new Map<string, () => void>();

  setWritable(socket: Socket, writable: boolean): void {
    this.writable.set(socket.id, writable);
    if (writable) {
      const ready = this.ready.get(socket.id);
      this.ready.delete(socket.id);
      ready?.();
    }
  }

  isWritable(socket: Socket): boolean {
    return this.writable.get(socket.id) ?? false;
  }

  send(socket: Socket, envelope: ReturnType<typeof createEnvelope>, complete: () => void): boolean {
    if (!this.isWritable(socket)) return false;
    this.sent.push(envelope);
    const sent = this.sentBySocket.get(socket.id) ?? [];
    sent.push(envelope);
    this.sentBySocket.set(socket.id, sent);
    this.writable.set(socket.id, false);
    this.completion.set(socket.id, complete);
    return true;
  }

  onWritable(socket: Socket, listener: () => void): () => void {
    this.ready.set(socket.id, listener);
    return () => {
      if (this.ready.get(socket.id) === listener) this.ready.delete(socket.id);
    };
  }

  complete(socket: Socket): void {
    const completion = this.completion.get(socket.id);
    this.completion.delete(socket.id);
    completion?.();
    this.setWritable(socket, true);
  }

  sentTo(socket: Socket): ReturnType<typeof createEnvelope>[] {
    return this.sentBySocket.get(socket.id) ?? [];
  }

  getBufferedPacketCount(): number {
    return 0;
  }
}

function createMockSocket(
  id: string,
): Socket & { trigger: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  const base = {
    id,
    emit: jest.fn(),
    join: jest.fn(),
    leave: jest.fn(),
    disconnect: jest.fn(),
    connected: true,
    conn: {
      transport: {
        name: 'websocket',
      },
      close: jest.fn(),
    } as unknown,
    trigger(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args);
      }
    },
  } as Partial<Socket> & { trigger: (event: string, ...args: unknown[]) => void };

  base.on = ((event: string, handler: (...args: unknown[]) => void) => {
    const existing = handlers.get(event) ?? [];
    handlers.set(event, [...existing, handler]);
    return base as unknown as Socket;
  }) as unknown as Socket['on'];

  base.off = ((event: string, handler: (...args: unknown[]) => void) => {
    handlers.set(
      event,
      (handlers.get(event) ?? []).filter((fn) => fn !== handler),
    );
    return base as unknown as Socket;
  }) as unknown as Socket['off'];

  return base as unknown as Socket & { trigger: (event: string, ...args: unknown[]) => void };
}

const createGateway = (options?: {
  seedMaxBytes?: number;
  seedSettleMs?: number;
  snapshot?: string;
  bufferedFrames?: ReturnType<typeof createEnvelope>[];
  replayResult?: FrameReplayResult;
  scrollbackLines?: number;
  autoCreateRegistrySessions?: boolean;
  sendScheduler?: TerminalSendSchedulerService;
}) => {
  const streamService: Partial<TerminalStreamService> = {
    initializeBuffer: jest.fn(),
    getFramesSince: jest.fn().mockReturnValue(
      options?.replayResult ?? {
        status: 'covered',
        frames: options?.bufferedFrames ?? [],
        currentSequence: 7,
      },
    ),
    getCurrentSequence: jest.fn().mockReturnValue(7),
    addFrame: jest
      .fn()
      .mockImplementation((sessionId: string, data: string) => [
        createEnvelope(`terminal/${sessionId}`, 'data', { data, sequence: 1 }),
      ]),
    markDiscontinuous: jest.fn().mockReturnValue(8),
    resumeRetention: jest.fn(),
    // Disconnect paths schedule a delayed clearBuffer; without this stub the timer
    // crashes the process after teardown when open handles outlive the suite.
    clearBuffer: jest.fn(),
  };
  // Sequence-domain (epoch) surface. sampleCursor/getReconnectReplay track the mocked
  // getCurrentSequence so tests that override the live sequence still line up. The recovery counter
  // increments per session (mirrors the buffer-owned counter) so monotonic-epoch assertions hold.
  const recoveryCounters = new Map<string, number>();
  streamService.getSequenceEpoch = jest.fn().mockReturnValue(MOCK_SEQUENCE_EPOCH);
  streamService.sampleCursor = jest.fn(() => ({
    sequenceEpoch: MOCK_SEQUENCE_EPOCH,
    currentSequence: (streamService.getCurrentSequence as jest.Mock)(),
  }));
  streamService.getReconnectReplay = jest.fn(() => ({
    ...(options?.replayResult ?? {
      status: 'covered',
      frames: options?.bufferedFrames ?? [],
      currentSequence: (streamService.getCurrentSequence as jest.Mock)(),
    }),
    sequenceEpoch: MOCK_SEQUENCE_EPOCH,
  }));
  streamService.nextRecoveryCounter = jest.fn((sessionId: string) => {
    const next = (recoveryCounters.get(sessionId) ?? 0) + 1;
    recoveryCounters.set(sessionId, next);
    return next;
  });
  // Delayed-clear ownership now lives in the stream service; the mock mirrors the real timer so the
  // gateway's stop/subscribe/restore delegation still drives the 60s-retain → clearBuffer path under
  // fake timers, and the constructor's setClearExpiryHandler wiring has a target. On expiry it runs
  // the mocked clearBuffer plus the registered expiry handler (retireSessionRecoveries).
  const scheduledClears = new Map<string, { timer: NodeJS.Timeout; delayMs: number }>();
  let clearExpiryHandler: ((sessionId: string) => void) | undefined;
  streamService.setClearExpiryHandler = jest.fn((handler: (sessionId: string) => void) => {
    clearExpiryHandler = handler;
  });
  streamService.cancelScheduledClear = jest.fn((sessionId: string) => {
    const existing = scheduledClears.get(sessionId);
    if (!existing) return null;
    clearTimeout(existing.timer);
    scheduledClears.delete(sessionId);
    return existing.delayMs;
  });
  streamService.scheduleClear = jest.fn((sessionId: string, delayMs: number) => {
    const existing = scheduledClears.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      scheduledClears.delete(sessionId);
      (streamService.clearBuffer as jest.Mock)(sessionId);
      clearExpiryHandler?.(sessionId);
    }, delayMs);
    timer.unref();
    scheduledClears.set(sessionId, { timer, delayMs });
  });

  const settingsService: Partial<SettingsService> = {
    getSetting: jest.fn((key: string) => {
      if (key === 'terminal.seeding.maxBytes') {
        const value =
          options?.seedMaxBytes !== undefined
            ? options.seedMaxBytes
            : DEFAULT_TERMINAL_SEED_MAX_BYTES;
        return String(value);
      }
      return undefined;
    }),
    getScrollbackLines: jest.fn().mockReturnValue(options?.scrollbackLines ?? 10000),
  };

  const ptyService: Partial<PtyService> = {
    setOutputHandler: jest.fn(),
    resize: jest.fn(),
    startStreaming: jest.fn(),
    isStreaming: jest.fn().mockReturnValue(true),
    stopStreaming: jest.fn(),
    triggerRedraw: jest.fn().mockResolvedValue(undefined),
  };

  const seedService: Partial<TerminalSeedService> = {
    resolveSeedingConfig: jest.fn().mockReturnValue({
      maxBytes: options?.seedMaxBytes ?? DEFAULT_TERMINAL_SEED_MAX_BYTES,
    }),
    emitSeedToClient: jest
      .fn()
      .mockImplementation(
        async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
          if (!seedOptions.recovery) return undefined;
          const capturedSequence = seedOptions.recovery.getCurrentSequence();
          seedOptions.recovery.onCapturedSequence?.(capturedSequence);
          return {
            sequenceEpoch: seedOptions.recovery.sequenceEpoch,
            recoveryEpoch: seedOptions.recovery.recoveryEpoch,
            capturedSequence,
          };
        },
      ),
    invalidateCache: jest.fn(),
    truncateToMaxBytes: jest.fn().mockImplementation((text: string, maxBytes: number) => ({
      truncated: text.slice(0, maxBytes),
      wasTruncated: Buffer.byteLength(text, 'utf-8') > maxBytes,
    })),
  };

  const terminalIO: Partial<TerminalIOService> = {
    captureHistory: jest.fn().mockResolvedValue({ ok: true, output: '' }),
    getCursorPosition: jest.fn().mockResolvedValue(null),
    sendControl: jest.fn().mockResolvedValue(undefined),
    deliverImmediate: jest.fn().mockResolvedValue({ confirmed: true }),
    sessionExists: jest.fn().mockResolvedValue(true),
    applyWindowTheme: jest.fn().mockResolvedValue(undefined),
  };

  const sessionTerminalRuntime: Partial<SessionTerminalRuntimeService> = {
    retireConfirmedLoss: jest.fn(),
    getProviderNameAtLaunch: jest.fn().mockReturnValue(null),
    getDescriptor: jest
      .fn()
      .mockImplementation((sessionId: string) => runtimeDescriptor(sessionId)),
  };

  const humanPromptState = new HumanPromptStateService();
  const eventEmitter = new EventEmitter2();
  const registry = new TerminalSessionRegistry(undefined, humanPromptState);
  const originalGet = registry.get.bind(registry);
  registry.get = (sessionId: string) => {
    let session = originalGet(sessionId);
    if (!session && options?.autoCreateRegistrySessions !== false) {
      session = registry.create(sessionId, `tmux_${sessionId}`);
    }
    return session;
  };

  const mockRealtimeBroadcast = { setServer: jest.fn(), broadcastEvent: jest.fn() };
  const mockMetricsService = {
    registerCacheStatsProvider: jest.fn(),
    registerStatsProvider: jest.fn(),
  } as never;
  const sendScheduler = {
    registerSocket: jest.fn(),
    removeSocket: jest.fn(),
    removeLane: jest.fn(),
    removeSession: jest.fn(),
    enqueueLive: jest.fn((client: Socket, envelope: unknown) => {
      client.emit('message', envelope);
      return TerminalSendAdmission.Accepted;
    }),
    enqueueRecovery: jest.fn().mockReturnValue(TerminalSendAdmission.Accepted),
    beginRecovery: jest.fn().mockReturnValue(true),
    markSynchronized: jest.fn(),
    isDesynchronized: jest.fn().mockReturnValue(false),
    getStats: jest.fn().mockReturnValue({
      terminalQueuedBytes: 0,
      terminalInFlightBytes: 0,
      terminalDesynchronizedClients: 0,
      terminalDesynchronizedLanes: 0,
      terminalDroppedFrames: 0,
      terminalDroppedBytes: 0,
      terminalQueues: {},
    }),
    dispose: jest.fn(),
  };
  const humanPromptInput = new HumanPromptInputService(humanPromptState, eventEmitter);
  const gateway = new TerminalGateway(
    streamService as TerminalStreamService,
    settingsService as SettingsService,
    ptyService as PtyService,
    seedService as TerminalSeedService,
    terminalIO as TerminalIOService,
    humanPromptInput,
    registry,
    sessionTerminalRuntime as SessionTerminalRuntimeService,
    mockRealtimeBroadcast as never,
    options?.sendScheduler ?? (sendScheduler as never),
    mockMetricsService,
    options?.seedSettleMs ?? 0,
  );

  (gateway as unknown as { ensurePtyStreaming: jest.Mock }).ensurePtyStreaming = jest
    .fn()
    .mockResolvedValue(undefined);

  const roomEmit = jest.fn();
  gateway.server = {
    to: jest.fn().mockReturnValue({ emit: roomEmit }),
    sockets: {
      adapter: { rooms: new Map<string, Set<string>>() },
      sockets: new Map(),
    },
    emit: jest.fn(),
  } as unknown as typeof gateway.server;

  return {
    gateway,
    streamService,
    settingsService,
    ptyService,
    seedService,
    terminalIO,
    humanPromptState,
    humanPromptInput,
    eventEmitter,
    sessionTerminalRuntime,
    registry,
    roomEmit,
    sendScheduler,
  };
};

describe('TerminalGateway lifecycle', () => {
  it('registers its existing synchronous broadcast path only when the Nest lifecycle hook runs', () => {
    const { gateway, ptyService } = createGateway();
    const broadcast = jest.spyOn(gateway, 'broadcastTerminalData').mockImplementation(() => {});

    expect(ptyService.setOutputHandler).not.toHaveBeenCalled();

    gateway.onModuleInit();

    expect(ptyService.setOutputHandler).toHaveBeenCalledTimes(1);
    const handler = (ptyService.setOutputHandler as jest.Mock).mock.calls[0][0] as (
      sessionId: string,
      data: string,
    ) => void;
    handler('session-output', 'ordered-data');
    expect(broadcast).toHaveBeenCalledWith('session-output', 'ordered-data');
  });
});

describe('TerminalGateway.handleRequestFullHistory', () => {
  it.each([
    { requested: 50000, scrollback: 5000, expected: 5000 },
    { requested: 3.7, scrollback: 10000, expected: 3 },
    { requested: undefined, scrollback: 10000, expected: 10000 },
    { requested: null, scrollback: 10000, expected: 10000 },
    { requested: '100.7', scrollback: 10000, expected: 100 },
  ])(
    'captures requested=$requested within scrollback=$scrollback',
    async ({ requested, scrollback, expected }) => {
      const { gateway, settingsService, terminalIO } = createGateway();
      const client = createMockSocket('history-client');
      (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(scrollback);
      gateway.handleConnection(client);
      await gateway.handleSubscribe(client, { sessionId: 'history-session', rows: 24, cols: 80 });
      await gateway.handleRequestFullHistory(client, {
        sessionId: 'history-session',
        maxLines: requested as number,
      });
      expect(terminalIO.captureHistory).toHaveBeenCalledWith(
        { name: 'tmux_history-session' },
        expected,
        true,
      );
      expect(client.emit).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({ type: 'full_history' }),
      );
    },
  );

  it.each([
    { maxLines: 0, correlationId: undefined },
    { maxLines: 'abc', correlationId: undefined },
    { maxLines: 1000, correlationId: 123 },
  ])('rejects history payload %j', async ({ maxLines, correlationId }) => {
    const { gateway, terminalIO } = createGateway();
    const client = createMockSocket('bad-history-client');
    gateway.handleConnection(client);
    await gateway.handleSubscribe(client, { sessionId: 'history-session', rows: 24, cols: 80 });
    await expect(
      gateway.handleRequestFullHistory(client, {
        sessionId: 'history-session',
        maxLines: maxLines as number,
        correlationId: correlationId as unknown as string,
      }),
    ).rejects.toThrow(WsException);
    expect(terminalIO.captureHistory).not.toHaveBeenCalled();
  });

  it('preserves real trailing blank rows in full history', async () => {
    const { gateway, terminalIO } = createGateway();
    const client = createMockSocket('client-history-blank-row');

    (terminalIO.captureHistory as jest.Mock).mockResolvedValue({
      ok: true,
      output: 'line 1\r\nline 2\r\n\r\n',
    });

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-history-blank-row',
      rows: 24,
      cols: 80,
    });

    await gateway.handleRequestFullHistory(client as unknown as Socket, {
      sessionId: 'session-history-blank-row',
      maxLines: 100,
    });

    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect((historyCall![1] as { payload: { history: string } }).payload.history).toBe(
      'line 1\r\nline 2\r\n',
    );
  });

  it('includes captured cursor coordinates in full_history payload', async () => {
    const { gateway, terminalIO } = createGateway();
    const client = createMockSocket('client-cursor');
    (terminalIO.getCursorPosition as jest.Mock).mockResolvedValue({ x: 7, y: 8 });

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-cursor',
      rows: 24,
      cols: 80,
    });

    await gateway.handleRequestFullHistory(client as unknown as Socket, {
      sessionId: 'session-cursor',
      maxLines: 100,
    });

    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
    expect(
      (historyCall![1] as { payload: { cursorX?: number; cursorY?: number } }).payload,
    ).toEqual(expect.objectContaining({ cursorX: 7, cursorY: 8 }));
  });

  it('echoes the correlation token on the full_history response', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-correlate');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-correlate',
      rows: 24,
      cols: 80,
    });

    await gateway.handleRequestFullHistory(client as unknown as Socket, {
      sessionId: 'session-correlate',
      maxLines: 1000,
      correlationId: 'req-42',
    });

    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect((historyCall![1] as { payload: { correlationId?: string } }).payload.correlationId).toBe(
      'req-42',
    );
  });

  it('omits correlationId from full_history when the request carried none', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-no-correlate');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-no-correlate',
      rows: 24,
      cols: 80,
    });

    await gateway.handleRequestFullHistory(client as unknown as Socket, {
      sessionId: 'session-no-correlate',
      maxLines: 1000,
    });

    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect((historyCall![1] as { payload: Record<string, unknown> }).payload).not.toHaveProperty(
      'correlationId',
    );
  });

  it('captures freshly on every accepted history request', async () => {
    const { gateway, settingsService, terminalIO } = createGateway();
    const client = createMockSocket('client-fresh');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-fresh',
      rows: 24,
      cols: 80,
    });

    // Distinct output per capture proves the response is not a cached first snapshot: a stale
    // cache would echo 'fresh-capture-1' on the second request. Each accepted request must
    // re-run capture-pane and emit whatever the terminal holds at that moment.
    (terminalIO.captureHistory as jest.Mock).mockClear();
    (terminalIO.captureHistory as jest.Mock)
      .mockResolvedValueOnce({ ok: true, output: 'fresh-capture-1\r\n' })
      .mockResolvedValueOnce({ ok: true, output: 'fresh-capture-2\r\n' });

    await gateway.handleRequestFullHistory(client as unknown as Socket, {
      sessionId: 'session-fresh',
      maxLines: 1000,
    });
    await gateway.handleRequestFullHistory(client as unknown as Socket, {
      sessionId: 'session-fresh',
      maxLines: 1000,
    });

    expect(terminalIO.captureHistory).toHaveBeenCalledTimes(2);
    expect(terminalIO.captureHistory).toHaveBeenNthCalledWith(
      1,
      { name: 'tmux_session-fresh' },
      1000,
      true,
    );
    expect(terminalIO.captureHistory).toHaveBeenNthCalledWith(
      2,
      { name: 'tmux_session-fresh' },
      1000,
      true,
    );

    const histories = (client.emit as jest.Mock).mock.calls
      .filter(
        ([event, envelope]) =>
          event === 'message' && (envelope as { type?: string }).type === 'full_history',
      )
      .map(([, envelope]) => (envelope as { payload: { history: string } }).payload.history);

    expect(histories).toHaveLength(2);
    expect(histories[0]).toContain('fresh-capture-1');
    expect(histories[0]).not.toContain('fresh-capture-2');
    expect(histories[1]).toContain('fresh-capture-2');
    expect(histories[1]).not.toContain('fresh-capture-1');
  });

  it('samples capturedSequence after the tmux capture completes (tail-duplication race)', async () => {
    const { gateway, streamService, settingsService, terminalIO } = createGateway();
    const client = createMockSocket('client-race');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    // Simulate frames being stamped WHILE capture-pane runs: the live counter sits at 7
    // when the request arrives and advances to 12 during the pending capture. Those
    // frames' content is inside the returned snapshot, so the emitted capturedSequence
    // must cover them or the client replays them on top of the snapshot.
    let liveSequence = 7;
    (streamService.getCurrentSequence as jest.Mock).mockImplementation(() => liveSequence);
    (terminalIO.captureHistory as jest.Mock).mockImplementation(async () => {
      liveSequence = 12;
      return { ok: true, output: 'line-1\nline-2\nline-3' };
    });

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-race',
      rows: 24,
      cols: 80,
    });

    await gateway.handleRequestFullHistory(client as unknown as Socket, {
      sessionId: 'session-race',
      maxLines: 1000,
    });

    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
    expect(
      (historyCall![1] as { payload: { capturedSequence?: number } }).payload.capturedSequence,
    ).toBe(12);
  });
});

describe('TerminalGateway session lifecycle registry policy', () => {
  it('creates restored sessions with captured normalization enabled', () => {
    const { gateway, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    const createSpy = jest.spyOn(registry, 'create');

    gateway.handleSessionRestored({
      sessionId: 'raw-session',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionName: 'tmux_raw-session',
      providerName: 'claude',
    });

    expect(createSpy).toHaveBeenCalledWith('raw-session', 'tmux_raw-session', {
      normalizeCapturedLineEndings: true,
    });
  });
});

describe('TerminalGateway.handleSubscribe', () => {
  it('uses the configured targeted seed service on a registry-backed first attach', async () => {
    const seedMaxBytes = 128 * 1024;
    const { gateway, seedService, ptyService, registry } = createGateway({
      bufferedFrames: [],
      seedMaxBytes,
    });
    const client = createMockSocket('client-1');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-1',
      rows: 30,
      cols: 120,
    });

    expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(1);
    expect(seedService.emitSeedToClient).toHaveBeenCalledWith({
      deliver: expect.any(Function),
      sessionId: 'session-1',
      maxBytes: seedMaxBytes,
      cols: 120,
      rows: 30,
      allowEmpty: true,
      getCurrentSequence: expect.any(Function),
    });
    expect(ptyService.resize).toHaveBeenCalledWith('session-1', 120, 30);

    const session = registry.get('session-1')!;
    expect(session.hasSubscriber('client-1')).toBe(true);
  });

  const findSubscribed = (client: { emit: unknown }) =>
    (client.emit as jest.Mock).mock.calls
      .filter(([event]) => event === 'message')
      .map(([, envelope]) => envelope)
      .find((envelope) => (envelope as { type?: string }).type === 'subscribed') as
      | { payload: Record<string, unknown> }
      | undefined;

  it.each([false, true])(
    'publishes history refresh capability for alternate-screen=%s',
    async (usesAlternateScreen) => {
      const { gateway, sessionTerminalRuntime } = createGateway();
      setUsesAlternateScreen(sessionTerminalRuntime, usesAlternateScreen);
      const client = createMockSocket('cap-client');
      gateway.handleConnection(client);
      await gateway.handleSubscribe(client, { sessionId: 'cap-session', rows: 24, cols: 80 });
      expect(findSubscribed(client)?.payload).toMatchObject({
        replayStatus: 'seed',
        historyRefreshable: !usesAlternateScreen,
      });
    },
  );

  it('routes a successful empty first capture through the scheduler-admission guard', async () => {
    const { gateway, seedService, sendScheduler } = createGateway();
    (seedService.emitSeedToClient as jest.Mock).mockImplementation(
      async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
        seedOptions.deliver(
          createEnvelope('terminal/session-empty', 'seed_empty', {
            capturedSequence: seedOptions.getCurrentSequence?.() ?? 0,
          }),
        );
        return undefined;
      },
    );
    const client = createMockSocket('client-empty');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-empty',
      rows: 24,
      cols: 80,
    });

    expect(sendScheduler.enqueueRecovery).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        type: 'seed_empty',
        payload: expect.objectContaining({ capturedSequence: 7 }),
      }),
    );
  });

  it('aborts an empty completion superseded by an active recovery', async () => {
    const { gateway, seedService, sendScheduler } = createGateway();
    let decision: TerminalSeedDeliveryDecision | undefined;
    (seedService.emitSeedToClient as jest.Mock).mockImplementation(
      async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
        if (seedOptions.recovery) return undefined;
        // A recovery for this socket/session lands before the empty completion delivers.
        (gateway as unknown as { recoveries: Map<string, unknown> }).recoveries.set(
          'client-superseded:session-superseded',
          {},
        );
        decision = seedOptions.deliver(
          createEnvelope('terminal/session-superseded', 'seed_empty', { capturedSequence: 0 }),
        );
        return undefined;
      },
    );
    const client = createMockSocket('client-superseded');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-superseded',
      rows: 24,
      cols: 80,
    });

    expect(decision).toBe(TerminalSeedDelivery.Abort);
    expect(sendScheduler.enqueueRecovery).not.toHaveBeenCalledWith(
      client,
      expect.objectContaining({ type: 'seed_empty' }),
    );
  });

  it('sends a new attaching viewer one targeted seed without broadcasting to existing viewers', async () => {
    const { gateway, seedService, roomEmit, sendScheduler } = createGateway();
    const firstClient = createMockSocket('viewer-1');
    const secondClient = createMockSocket('viewer-2');
    gateway.handleConnection(firstClient as unknown as Socket);
    await gateway.handleSubscribe(firstClient as unknown as Socket, {
      sessionId: 'shared-session',
      rows: 24,
      cols: 80,
    });

    (seedService.emitSeedToClient as jest.Mock).mockClear();
    (seedService.emitSeedToClient as jest.Mock).mockImplementation(
      async ({
        deliver,
        sessionId,
      }: {
        deliver: (envelope: unknown) => void;
        sessionId: string;
      }) => {
        deliver(
          createEnvelope(`terminal/${sessionId}`, 'seed_ansi', {
            data: 'targeted seed',
            chunk: 0,
            totalChunks: 1,
          }),
        );
      },
    );
    (firstClient.emit as jest.Mock).mockClear();
    roomEmit.mockClear();
    gateway.handleConnection(secondClient as unknown as Socket);
    await gateway.handleSubscribe(secondClient as unknown as Socket, {
      sessionId: 'shared-session',
      rows: 30,
      cols: 100,
    });

    expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(1);
    expect(seedService.emitSeedToClient).toHaveBeenCalledWith(
      expect.objectContaining({
        deliver: expect.any(Function),
        sessionId: 'shared-session',
        maxBytes: DEFAULT_TERMINAL_SEED_MAX_BYTES,
      }),
    );
    expect(roomEmit).not.toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'seed_ansi' }),
    );
    expect(firstClient.emit).not.toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'seed_ansi' }),
    );
    expect(sendScheduler.enqueueRecovery).toHaveBeenCalledWith(
      secondClient,
      expect.objectContaining({ type: 'seed_ansi' }),
    );
  });

  it('applies latest debounced resize to the PTY during seed jiggle', async () => {
    const { gateway, ptyService } = createGateway();
    const client = createMockSocket('client-jiggle-resize');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-jiggle-resize',
      rows: 24,
      cols: 80,
    });

    (ptyService.resize as jest.Mock).mockClear();
    jest.useFakeTimers();
    try {
      await gateway.handleResize(client as unknown as Socket, {
        sessionId: 'session-jiggle-resize',
        rows: 23,
        cols: 80,
      });
      await gateway.handleResize(client as unknown as Socket, {
        sessionId: 'session-jiggle-resize',
        rows: 24,
        cols: 80,
      });

      expect(ptyService.resize).toHaveBeenNthCalledWith(1, 'session-jiggle-resize', 80, 23);
      expect(ptyService.resize).toHaveBeenNthCalledWith(2, 'session-jiggle-resize', 80, 24);

      jest.runAllTimers();
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops legacy seed_ansi frames instead of broadcasting them to the room', async () => {
    const { gateway, registry, roomEmit } = createGateway();
    const client = createMockSocket('client-seed');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-seed',
      rows: 24,
      cols: 80,
    });

    const session = registry.get('session-seed')!;
    session.stream.emit('frame', {
      type: 'seed_ansi',
      sessionId: 'session-seed',
      payload: { ansi: '<seed-content>' },
    });

    expect(roomEmit).not.toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'seed_ansi' }),
    );
  });

  it('rewires stale frame listener when a restored session reuses the same session id', async () => {
    const { gateway, registry, roomEmit } = createGateway();
    const firstClient = createMockSocket('client-restore-old');
    const secondClient = createMockSocket('client-restore-new');

    gateway.handleConnection(firstClient as unknown as Socket);
    await gateway.handleSubscribe(firstClient as unknown as Socket, {
      sessionId: 'session-restore',
      rows: 24,
      cols: 80,
    });

    const oldSession = registry.get('session-restore')!;
    registry.dispose('session-restore');
    const newSession = registry.create('session-restore', 'tmux_session-restore-new');

    gateway.handleConnection(secondClient as unknown as Socket);
    await gateway.handleSubscribe(secondClient as unknown as Socket, {
      sessionId: 'session-restore',
      rows: 24,
      cols: 80,
    });

    roomEmit.mockClear();
    oldSession.stream.emit('frame', {
      type: 'focus_changed',
      sessionId: 'session-restore',
      payload: { clientId: 'old-client' },
    });
    newSession.stream.emit('frame', {
      type: 'focus_changed',
      sessionId: 'session-restore',
      payload: { clientId: 'new-client' },
    });

    const focusCalls = roomEmit.mock.calls.filter(
      ([, envelope]: [string, { type?: string; payload?: { clientId?: string } }]) =>
        envelope?.type === 'focus_changed',
    );
    expect(focusCalls).toHaveLength(1);
    expect(focusCalls[0][1]).toEqual(
      expect.objectContaining({
        type: 'focus_changed',
        payload: expect.objectContaining({ clientId: 'new-client' }),
      }),
    );
  });

  it('unwires frame listener on session.stopped', async () => {
    const { gateway, registry, roomEmit } = createGateway();
    const client = createMockSocket('client-stopped-unwire');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-stopped-unwire',
      rows: 24,
      cols: 80,
    });

    const session = registry.get('session-stopped-unwire')!;
    gateway.handleSessionStopped({ sessionId: 'session-stopped-unwire' });

    roomEmit.mockClear();
    session.stream.emit('frame', {
      type: 'focus_changed',
      sessionId: 'session-stopped-unwire',
      payload: { clientId: 'late-client' },
    });

    expect(roomEmit).not.toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'focus_changed' }),
    );
  });

  it('does not duplicate room-frame forwarding for multiple subscribers on one session', async () => {
    const { gateway, registry, roomEmit } = createGateway();
    const firstClient = createMockSocket('client-multi-1');
    const secondClient = createMockSocket('client-multi-2');

    gateway.handleConnection(firstClient as unknown as Socket);
    await gateway.handleSubscribe(firstClient as unknown as Socket, {
      sessionId: 'session-multi',
      rows: 24,
      cols: 80,
    });

    gateway.handleConnection(secondClient as unknown as Socket);
    await gateway.handleSubscribe(secondClient as unknown as Socket, {
      sessionId: 'session-multi',
      rows: 24,
      cols: 80,
    });

    roomEmit.mockClear();
    registry.get('session-multi')!.stream.emit('frame', {
      type: 'focus_changed',
      sessionId: 'session-multi',
      payload: { clientId: 'client-multi-2' },
    });

    const focusCalls = roomEmit.mock.calls.filter(
      ([, envelope]: [string, { type?: string }]) => envelope?.type === 'focus_changed',
    );
    expect(focusCalls).toHaveLength(1);
  });

  it('forwards resize_jiggle from TerminalSession frame stream to socket room', async () => {
    const { gateway, registry, roomEmit } = createGateway();
    const client = createMockSocket('client-jiggle');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-jiggle',
      rows: 24,
      cols: 80,
    });

    const session = registry.get('session-jiggle')!;
    session.stream.emit('frame', {
      type: 'resize_jiggle',
      sessionId: 'session-jiggle',
      payload: { reason: 'manual_redraw' },
    });

    expect(roomEmit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'resize_jiggle' }),
    );
  });

  it('falls back to seedService.emitSeedToClient when session not in registry', async () => {
    const { gateway, seedService, registry, sessionTerminalRuntime } = createGateway();
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    const client = createMockSocket('client-fallback');

    // Remove the auto-create override so registry returns undefined
    registry.get = () => undefined;

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'no-registry-session',
      rows: 24,
      cols: 80,
    });

    expect(seedService.emitSeedToClient).toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        type: 'subscribed',
        payload: expect.objectContaining({ replayStatus: 'seed', historyRefreshable: false }),
      }),
    );
  });

  it('passes client dimensions to ensurePtyStreaming to eliminate double-SIGWINCH on first attach', async () => {
    const { gateway } = createGateway();
    const client = createMockSocket('client-dims');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-dims',
      rows: 40,
      cols: 120,
    });

    const ensureMock = (gateway as unknown as { ensurePtyStreaming: jest.Mock }).ensurePtyStreaming;
    expect(ensureMock).toHaveBeenCalledWith('session-dims', expect.any(String), {
      cols: 120,
      rows: 40,
    });
  });

  it('replays frames based on last sequence when reconnecting', async () => {
    const { gateway, streamService, seedService } = createGateway();
    const client = createMockSocket('client-3');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-3',
      lastSequence: 42,
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
    });

    // On a same-domain reconnect (epoch matches), no seeding — replay by the epoch-scoped cursor.
    expect(seedService.emitSeedToClient).not.toHaveBeenCalled();
    expect(streamService.getReconnectReplay).toHaveBeenCalledWith('session-3', {
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      sequence: 42,
    });
  });

  it('emits resync_required and one bounded targeted seed when replay has a gap', async () => {
    const { gateway, seedService, registry } = createGateway({
      seedMaxBytes: 256 * 1024,
      replayResult: {
        status: 'gap',
        currentSequence: 150,
        earliestAvailableSequence: 51,
      },
    });
    const client = createMockSocket('client-gap');
    const session = registry.get('session-gap')!;
    const subscribeSpy = jest.spyOn(session, 'subscribe');
    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-gap',
      lastSequence: 42,
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      cols: 100,
      rows: 30,
    });

    const resyncEnvelope = (client.emit as jest.Mock).mock.calls
      .filter(([event]: [string]) => event === 'message')
      .map(([, envelope]: [string, ReturnType<typeof createEnvelope>]) => envelope)
      .find((envelope: ReturnType<typeof createEnvelope>) => envelope.type === 'resync_required');
    expect(resyncEnvelope?.payload).toEqual({
      sessionId: 'session-gap',
      requestedSequence: 42,
      currentSequence: 150,
      earliestAvailableSequence: 51,
    });
    expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith('client-gap');
    expect(seedService.invalidateCache).toHaveBeenCalledWith('session-gap');
    expect(seedService.emitSeedToClient).toHaveBeenCalledWith({
      deliver: expect.any(Function),
      sessionId: 'session-gap',
      maxBytes: 256 * 1024,
      cols: 100,
      rows: 30,
      allowEmpty: true,
      recovery: {
        sequenceEpoch: MOCK_SEQUENCE_EPOCH,
        recoveryEpoch: 1,
        getCurrentSequence: expect.any(Function),
        onCapturedSequence: expect.any(Function),
      },
    });
  });

  it('delivers output produced during a seed as a covered tail before resuming live', async () => {
    const { gateway, streamService, seedService, sendScheduler } = createGateway();
    const client = createMockSocket('client-recovery-tail');
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-recovery-tail',
      rows: 24,
      cols: 80,
    });

    const tail = createEnvelope('terminal/session-recovery-tail', 'data', {
      data: 'during-seed',
      sequence: 8,
    });
    (streamService.getCurrentSequence as jest.Mock).mockReturnValue(7);
    (streamService.getFramesSince as jest.Mock).mockImplementation(
      (_sessionId: string, afterSequence?: number) =>
        afterSequence === 7
          ? { status: 'covered', frames: [tail], currentSequence: 8 }
          : { status: 'covered', frames: [], currentSequence: 8 },
    );
    (seedService.emitSeedToClient as jest.Mock).mockImplementation(
      async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
        const recovery = seedOptions.recovery!;
        const capturedSequence = recovery.getCurrentSequence();
        recovery.onCapturedSequence?.(capturedSequence);
        seedOptions.deliver(
          createEnvelope('terminal/session-recovery-tail', 'seed_ansi', {
            data: 'snapshot',
            chunk: 0,
            totalChunks: 1,
            recoveryEpoch: recovery.recoveryEpoch,
            capturedSequence,
          }),
        );
        return { recoveryEpoch: recovery.recoveryEpoch, capturedSequence };
      },
    );
    (sendScheduler.enqueueRecovery as jest.Mock).mockClear();

    await gateway.handleResyncRequest(client as unknown as Socket, {
      sessionId: 'session-recovery-tail',
      reason: 'client_write_overflow',
    });

    expect(sendScheduler.beginRecovery).toHaveBeenCalledWith(client, 'session-recovery-tail', 1);
    expect(sendScheduler.enqueueRecovery).toHaveBeenCalledWith(
      client,
      expect.objectContaining({
        type: 'seed_ansi',
        payload: expect.objectContaining({ recoveryEpoch: 1, capturedSequence: 7 }),
      }),
    );

    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'session-recovery-tail',
      recoveryEpoch: 0,
      capturedSequence: 7,
    });
    expect(streamService.getFramesSince).not.toHaveBeenCalled();

    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'session-recovery-tail',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    const tailCall = (sendScheduler.enqueueRecovery as jest.Mock).mock.calls.find(
      ([, envelope]: [Socket, ReturnType<typeof createEnvelope>]) => envelope.type === 'data',
    );
    expect(tailCall?.[1]).toBe(tail);
    expect(sendScheduler.markSynchronized).not.toHaveBeenCalled();

    tailCall?.[2]();
    expect(streamService.getFramesSince).toHaveBeenLastCalledWith('session-recovery-tail', 8);
    expect(sendScheduler.markSynchronized).toHaveBeenCalledWith(
      client.id,
      'session-recovery-tail',
      1,
    );

    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'session-recovery-tail',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    expect(sendScheduler.markSynchronized).toHaveBeenCalledTimes(1);
  });

  it('coalesces recovery requests, permits one replacement seed, then disconnects on a repeated tail gap', async () => {
    const { gateway, streamService, seedService, sendScheduler } = createGateway();
    const client = createMockSocket('client-replacement');
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-replacement',
      rows: 24,
      cols: 80,
    });
    const epochs: number[] = [];
    (streamService.getCurrentSequence as jest.Mock).mockReturnValue(12);
    (streamService.getFramesSince as jest.Mock).mockReturnValue({
      status: 'gap',
      currentSequence: 20,
      earliestAvailableSequence: 15,
    });
    (seedService.emitSeedToClient as jest.Mock).mockImplementation(
      async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
        const recovery = seedOptions.recovery!;
        epochs.push(recovery.recoveryEpoch);
        const capturedSequence = recovery.getCurrentSequence();
        recovery.onCapturedSequence?.(capturedSequence);
        return { recoveryEpoch: recovery.recoveryEpoch, capturedSequence };
      },
    );

    const request = {
      sessionId: 'session-replacement',
      reason: 'client_write_overflow' as const,
    };
    await Promise.all([
      gateway.handleResyncRequest(client as unknown as Socket, request),
      gateway.handleResyncRequest(client as unknown as Socket, request),
    ]);
    expect(epochs).toEqual([1]);

    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'session-replacement',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 12,
    });
    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'session-replacement',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 12,
    });
    await Promise.resolve();

    expect(epochs).toEqual([1, 2]);
    expect(sendScheduler.beginRecovery).toHaveBeenCalledTimes(2);
    expect(sendScheduler.markSynchronized).not.toHaveBeenCalled();

    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'session-replacement',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 2,
      capturedSequence: 12,
    });
    expect(client.conn.close).toHaveBeenCalledTimes(1);
    expect(sendScheduler.removeSocket).toHaveBeenCalledWith(client.id);
  });

  it('aborts only the current recovery epoch and converges through one fresh epoch', async () => {
    const { gateway, sendScheduler, streamService } = createGateway();
    const client = createMockSocket('client-abort-retry');
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-abort-retry',
      rows: 24,
      cols: 80,
    });
    (streamService.getFramesSince as jest.Mock).mockReturnValue({
      status: 'covered',
      frames: [],
      currentSequence: 7,
    });

    await gateway.handleResyncRequest(client as unknown as Socket, {
      sessionId: 'session-abort-retry',
      reason: 'client_write_overflow',
    });

    expect(
      gateway.handleResyncAbort(client as unknown as Socket, {
        sessionId: 'session-abort-retry',
        sequenceEpoch: MOCK_SEQUENCE_EPOCH,
        recoveryEpoch: 1,
      }),
    ).toBe(true);
    expect(sendScheduler.removeLane).toHaveBeenCalledWith(client.id, 'session-abort-retry');

    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'session-abort-retry',
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    expect(sendScheduler.markSynchronized).not.toHaveBeenCalled();

    await gateway.handleResyncRequest(client as unknown as Socket, {
      sessionId: 'session-abort-retry',
      reason: 'client_write_overflow',
    });
    expect(sendScheduler.beginRecovery).toHaveBeenLastCalledWith(client, 'session-abort-retry', 2);

    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'session-abort-retry',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 2,
      capturedSequence: 7,
    });
    expect(sendScheduler.markSynchronized).toHaveBeenCalledWith(
      client.id,
      'session-abort-retry',
      2,
    );
  });

  it('rejects malformed, stale, cross-session, and cross-socket recovery aborts', async () => {
    const { gateway, sendScheduler } = createGateway();
    const owner = createMockSocket('client-abort-owner');
    const other = createMockSocket('client-abort-other');
    gateway.handleConnection(owner as unknown as Socket);
    gateway.handleConnection(other as unknown as Socket);
    await gateway.handleSubscribe(owner as unknown as Socket, {
      sessionId: 'session-abort-owner',
    });
    await gateway.handleResyncRequest(owner as unknown as Socket, {
      sessionId: 'session-abort-owner',
      reason: 'client_write_overflow',
    });

    expect(
      gateway.handleResyncAbort(owner as unknown as Socket, {
        sessionId: 'session-abort-owner',
        recoveryEpoch: 1,
        capturedSequence: 7,
      }),
    ).toBe(false);
    expect(
      gateway.handleResyncAbort(owner as unknown as Socket, {
        sessionId: 'session-abort-owner',
        recoveryEpoch: 0,
      }),
    ).toBe(false);
    expect(
      gateway.handleResyncAbort(owner as unknown as Socket, {
        sessionId: 'session-abort-other',
        recoveryEpoch: 1,
      }),
    ).toBe(false);
    expect(
      gateway.handleResyncAbort(other as unknown as Socket, {
        sessionId: 'session-abort-owner',
        recoveryEpoch: 1,
      }),
    ).toBe(false);
    expect(sendScheduler.removeLane).not.toHaveBeenCalled();

    gateway.handleResyncComplete(owner as unknown as Socket, {
      sessionId: 'session-abort-owner',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    expect(sendScheduler.markSynchronized).toHaveBeenCalledWith(owner.id, 'session-abort-owner', 1);
  });

  it('module unit: isolates simultaneous recovery lanes on one socket and keeps unrelated live traffic admitted', async () => {
    const drain = new GatewayDrainAdapter();
    const scheduler = new TerminalSendSchedulerService(
      drain as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 4096, batchBytes: 512 },
    );
    const { gateway, seedService, streamService } = createGateway({ sendScheduler: scheduler });
    const client = createMockSocket('shared-recovery-socket');
    drain.setWritable(client, false);
    gateway.handleConnection(client);

    for (const sessionId of ['session-a', 'session-b', 'session-c']) {
      await gateway.handleSubscribe(client, { sessionId, rows: 24, cols: 80 });
    }
    (seedService.emitSeedToClient as jest.Mock).mockImplementation(
      async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
        const recovery = seedOptions.recovery;
        if (!recovery) return undefined;
        const capturedSequence = recovery.getCurrentSequence();
        recovery.onCapturedSequence?.(capturedSequence);
        seedOptions.deliver(
          createEnvelope(`terminal/${seedOptions.sessionId}`, 'seed_ansi', {
            data: `seed-${seedOptions.sessionId}`,
            chunk: 0,
            totalChunks: 1,
            recoveryEpoch: recovery.recoveryEpoch,
            capturedSequence,
          }),
        );
        return { recoveryEpoch: recovery.recoveryEpoch, capturedSequence };
      },
    );
    (streamService.getFramesSince as jest.Mock).mockReturnValue({
      status: 'covered',
      frames: [],
      currentSequence: 7,
    });

    await Promise.all([
      gateway.handleResyncRequest(client, {
        sessionId: 'session-a',
        reason: 'client_write_overflow',
      }),
      gateway.handleResyncRequest(client, {
        sessionId: 'session-b',
        reason: 'client_write_overflow',
      }),
    ]);

    let queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.lanes['session-a']).toMatchObject({
      desynchronized: true,
      recoveryActive: true,
      recoveryEpoch: 1,
    });
    expect(queue.lanes['session-b']).toMatchObject({
      desynchronized: true,
      recoveryActive: true,
      recoveryEpoch: 1,
    });
    expect(queue.lanes['session-a'].queuedBytes).toBeGreaterThan(0);
    expect(queue.lanes['session-b'].queuedBytes).toBeGreaterThan(0);

    drain.setWritable(client, true);
    drain.complete(client);
    drain.complete(client);
    expect(new Set(drain.sent.slice(0, 2).map((envelope) => envelope.topic))).toEqual(
      new Set(['terminal/session-a', 'terminal/session-b']),
    );

    gateway.handleResyncComplete(client, {
      sessionId: 'session-a',
      recoveryEpoch: 0,
      capturedSequence: 7,
    });
    queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.lanes['session-a'].desynchronized).toBe(true);
    expect(queue.lanes['session-b'].desynchronized).toBe(true);

    gateway.handleResyncComplete(client, {
      sessionId: 'session-a',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.lanes['session-a'].desynchronized).toBe(false);
    expect(queue.lanes['session-b'].desynchronized).toBe(true);
    expect(queue.desynchronized).toBe(true);

    gateway.broadcastTerminalData('session-c', 'unrelated-live');
    expect(drain.sent.at(-1)).toMatchObject({
      topic: 'terminal/session-c',
      type: 'data',
    });

    gateway.handleResyncComplete(client, {
      sessionId: 'session-b',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.lanes['session-b'].desynchronized).toBe(false);
    expect(queue.desynchronized).toBe(false);
    expect(scheduler.getStats().terminalDesynchronizedClients).toBe(0);
  });

  it('module unit (real scheduler integration): owns initial-seed aggregate overflow while preserving the sibling lane', async () => {
    const drain = new GatewayDrainAdapter();
    const scheduler = new TerminalSendSchedulerService(
      drain as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 650, batchBytes: 400 },
    );
    const { gateway, seedService, streamService } = createGateway({ sendScheduler: scheduler });
    const client = createMockSocket('shared-initial-seed-overflow');
    drain.setWritable(client, false);
    gateway.handleConnection(client);
    await gateway.handleSubscribe(client, { sessionId: 'sibling-lane' });
    gateway.broadcastTerminalData('sibling-lane', 's'.repeat(160));

    const initialDecisions: TerminalSeedDeliveryDecision[] = [];
    let staleInitialDelivery:
      | Parameters<TerminalSeedService['emitSeedToClient']>[0]['deliver']
      | undefined;
    (seedService.emitSeedToClient as jest.Mock)
      .mockClear()
      .mockImplementation(
        async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
          const recovery = seedOptions.recovery;
          if (!recovery) {
            staleInitialDelivery = seedOptions.deliver;
            for (let chunk = 0; chunk < 3; chunk += 1) {
              const decision = seedOptions.deliver(
                createEnvelope(`terminal/${seedOptions.sessionId}`, 'seed_ansi', {
                  data: 'i'.repeat(160),
                  chunk,
                  totalChunks: 3,
                }),
              );
              if (decision) initialDecisions.push(decision);
              if (decision === TerminalSeedDelivery.Abort) break;
            }
            return undefined;
          }

          const capturedSequence = recovery.getCurrentSequence();
          recovery.onCapturedSequence?.(capturedSequence);
          seedOptions.deliver(
            createEnvelope(`terminal/${seedOptions.sessionId}`, 'seed_ansi', {
              data: 'recovered',
              chunk: 0,
              totalChunks: 1,
              recoveryEpoch: recovery.recoveryEpoch,
              capturedSequence,
            }),
          );
          return { recoveryEpoch: recovery.recoveryEpoch, capturedSequence };
        },
      );
    (streamService.getFramesSince as jest.Mock).mockReturnValue({
      status: 'covered',
      frames: [],
      currentSequence: 7,
    });

    await gateway.handleSubscribe(client, { sessionId: 'new-lane' });

    expect(initialDecisions).toEqual([TerminalSeedDelivery.Continue, TerminalSeedDelivery.Abort]);
    expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(2);
    let queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.queuedBytes).toBeLessThanOrEqual(650);
    expect(queue.lanes['sibling-lane']).toMatchObject({
      desynchronized: false,
      recoveryActive: false,
    });
    expect(queue.lanes['new-lane']).toMatchObject({
      desynchronized: true,
      recoveryActive: true,
      recoveryEpoch: 1,
    });

    const queuedBeforeStaleDelivery = queue.queuedBytes;
    expect(
      staleInitialDelivery?.(
        createEnvelope('terminal/new-lane', 'seed_ansi', {
          data: 'stale-after-escalation',
          chunk: 2,
          totalChunks: 3,
        }),
      ),
    ).toBe(TerminalSeedDelivery.Abort);
    expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(2);
    expect(scheduler.getStats().terminalQueues[client.id].queuedBytes).toBe(
      queuedBeforeStaleDelivery,
    );

    drain.setWritable(client, true);
    drain.complete(client);
    drain.complete(client);
    expect(
      drain.sentTo(client).find((envelope) => envelope.topic === 'terminal/sibling-lane'),
    ).toMatchObject({ type: 'data', payload: expect.objectContaining({ data: 's'.repeat(160) }) });
    expect(
      drain.sentTo(client).filter((envelope) => envelope.topic === 'terminal/new-lane'),
    ).toEqual([
      expect.objectContaining({
        type: 'seed_ansi',
        payload: expect.objectContaining({ data: 'recovered', recoveryEpoch: 1 }),
      }),
    ]);

    gateway.handleResyncComplete(client, {
      sessionId: 'new-lane',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.lanes['new-lane'].desynchronized).toBe(false);
    expect(queue.lanes['sibling-lane'].desynchronized).toBe(false);

    const sentBeforeCompletedRecoveryStaleDelivery = drain.sentTo(client).length;
    expect(
      staleInitialDelivery?.(
        createEnvelope('terminal/new-lane', 'seed_ansi', {
          data: 'stale-after-completed-recovery',
          chunk: 2,
          totalChunks: 3,
        }),
      ),
    ).toBe(TerminalSeedDelivery.Abort);
    expect(drain.sentTo(client)).toHaveLength(sentBeforeCompletedRecoveryStaleDelivery);
    expect(scheduler.getStats().terminalQueues[client.id].lanes['new-lane'].desynchronized).toBe(
      false,
    );
    expect(client.conn.close).not.toHaveBeenCalled();
  });

  it('module unit (real scheduler integration): rejects an in-flight initial-seed callback after disconnect cleanup', async () => {
    const drain = new GatewayDrainAdapter();
    const scheduler = new TerminalSendSchedulerService(
      drain as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 650, batchBytes: 400 },
    );
    const { gateway, seedService } = createGateway({ sendScheduler: scheduler });
    const client = createMockSocket('initial-seed-disconnect');
    drain.setWritable(client, false);
    gateway.handleConnection(client);

    let staleDelivery:
      | Parameters<TerminalSeedService['emitSeedToClient']>[0]['deliver']
      | undefined;
    let markSeedStarted!: () => void;
    let finishSeed!: () => void;
    const seedStarted = new Promise<void>((resolve) => {
      markSeedStarted = resolve;
    });
    const seedFinished = new Promise<void>((resolve) => {
      finishSeed = resolve;
    });
    (seedService.emitSeedToClient as jest.Mock).mockImplementationOnce(
      async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
        staleDelivery = seedOptions.deliver;
        markSeedStarted();
        await seedFinished;
        return undefined;
      },
    );

    const subscribe = gateway.handleSubscribe(client, { sessionId: 'disconnect-lane' });
    await seedStarted;
    gateway.handleDisconnect(client);

    expect(
      staleDelivery?.(
        createEnvelope('terminal/disconnect-lane', 'seed_ansi', {
          data: 'must-not-recreate-the-lane',
          chunk: 0,
          totalChunks: 1,
        }),
      ),
    ).toBe(TerminalSeedDelivery.Abort);
    expect(scheduler.getStats().terminalQueues[client.id]).toBeUndefined();

    finishSeed();
    await subscribe;
    expect(scheduler.getStats().terminalQueues[client.id]).toBeUndefined();
  });

  it('recovers one overflowed stalled viewer through a bounded seed and gap-free tail while another viewer stays current', async () => {
    const drain = new GatewayDrainAdapter();
    const scheduler = new TerminalSendSchedulerService(
      drain as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 400, batchBytes: 320 },
    );
    const { gateway, seedService, streamService } = createGateway({ sendScheduler: scheduler });
    const stalled = createMockSocket('overflow-stalled');
    const current = createMockSocket('overflow-current');
    drain.setWritable(stalled, false);
    drain.setWritable(current, true);
    gateway.handleConnection(stalled);
    gateway.handleConnection(current);
    await gateway.handleSubscribe(stalled, { sessionId: 'overflow-session' });
    await gateway.handleSubscribe(current, { sessionId: 'overflow-session' });

    let sequence = 0;
    const frames: ReturnType<typeof createEnvelope>[] = [];
    (streamService.addFrame as jest.Mock).mockImplementation((sessionId: string, data: string) => {
      const frame = createEnvelope(`terminal/${sessionId}`, 'data', {
        data,
        sequence: ++sequence,
      });
      frames.push(frame);
      return [frame];
    });
    (streamService.getCurrentSequence as jest.Mock).mockImplementation(() => sequence);
    (streamService.getFramesSince as jest.Mock).mockImplementation(
      (_sessionId: string, afterSequence: number) => ({
        status: 'covered',
        frames: frames.filter(
          (frame) => (frame.payload as { sequence: number }).sequence > afterSequence,
        ),
        currentSequence: sequence,
      }),
    );
    (seedService.emitSeedToClient as jest.Mock)
      .mockClear()
      .mockImplementation(
        async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
          const recovery = seedOptions.recovery;
          if (!recovery) return undefined;
          const capturedSequence = recovery.getCurrentSequence();
          recovery.onCapturedSequence?.(capturedSequence);
          seedOptions.deliver(
            createEnvelope(`terminal/${seedOptions.sessionId}`, 'seed_ansi', {
              data: 'fresh-overflow-seed',
              chunk: 0,
              totalChunks: 1,
              recoveryEpoch: recovery.recoveryEpoch,
              capturedSequence,
            }),
          );
          return { recoveryEpoch: recovery.recoveryEpoch, capturedSequence };
        },
      );

    gateway.broadcastTerminalData('overflow-session', 'a'.repeat(100));
    drain.complete(current);
    gateway.broadcastTerminalData('overflow-session', 'b'.repeat(200));
    drain.complete(current);
    await Promise.resolve();

    expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(1);
    const stalledQueue = scheduler.getStats().terminalQueues[stalled.id];
    expect(stalledQueue.queuedBytes).toBeLessThanOrEqual(400);
    expect(stalledQueue.lanes['overflow-session']).toMatchObject({
      desynchronized: true,
      recoveryActive: true,
      recoveryEpoch: 1,
    });
    expect(scheduler.getStats().terminalQueues[current.id].desynchronized).toBe(false);

    gateway.broadcastTerminalData('overflow-session', 'during-recovery');
    drain.complete(current);
    expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(1);

    drain.setWritable(stalled, true);
    drain.complete(stalled);
    gateway.handleResyncComplete(stalled, {
      sessionId: 'overflow-session',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 2,
    });
    drain.complete(stalled);

    const stalledDeliveries = drain.sentTo(stalled);
    expect(stalledDeliveries.map((envelope) => envelope.type)).toEqual(['seed_ansi', 'data']);
    expect((stalledDeliveries[1].payload as { sequence: number }).sequence).toBe(3);
    expect(
      drain.sentTo(current).map((envelope) => (envelope.payload as { sequence: number }).sequence),
    ).toEqual([1, 2, 3]);
    expect(scheduler.getStats().terminalQueues[stalled.id].desynchronized).toBe(false);
    expect(stalled.disconnect).not.toHaveBeenCalled();
    expect(stalled.conn.close).not.toHaveBeenCalled();
    expect(current.disconnect).not.toHaveBeenCalled();
    expect(current.conn.close).not.toHaveBeenCalled();
  });

  it('disconnects and cleans only the affected viewer when bounded recovery cannot be admitted, then accepts a clean reconnect', async () => {
    const drain = new GatewayDrainAdapter();
    const scheduler = new TerminalSendSchedulerService(
      drain as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 400, batchBytes: 320 },
    );
    const { gateway, seedService } = createGateway({ sendScheduler: scheduler });
    const stalled = createMockSocket('unrecoverable-stalled');
    const current = createMockSocket('unrecoverable-current');
    drain.setWritable(stalled, false);
    drain.setWritable(current, true);
    gateway.handleConnection(stalled);
    gateway.handleConnection(current);
    await gateway.handleSubscribe(stalled, { sessionId: 'fallback-session' });
    await gateway.handleSubscribe(current, { sessionId: 'fallback-session' });

    (seedService.emitSeedToClient as jest.Mock)
      .mockClear()
      .mockImplementation(
        async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
          if (!seedOptions.recovery) {
            seedOptions.deliver(
              createEnvelope(`terminal/${seedOptions.sessionId}`, 'seed_ansi', {
                data: 'clean-reconnect-seed',
                chunk: 0,
                totalChunks: 1,
              }),
            );
            return undefined;
          }
          const capturedSequence = seedOptions.recovery.getCurrentSequence();
          seedOptions.recovery.onCapturedSequence?.(capturedSequence);
          for (let chunk = 0; chunk < 2; chunk += 1) {
            seedOptions.deliver(
              createEnvelope(`terminal/${seedOptions.sessionId}`, 'seed_ansi', {
                data: 'x'.repeat(400),
                chunk,
                totalChunks: 2,
                recoveryEpoch: seedOptions.recovery.recoveryEpoch,
                capturedSequence,
              }),
            );
          }
          return { recoveryEpoch: seedOptions.recovery.recoveryEpoch, capturedSequence };
        },
      );

    gateway.broadcastTerminalData('fallback-session', 'a'.repeat(100));
    drain.complete(current);
    gateway.broadcastTerminalData('fallback-session', 'b'.repeat(200));
    drain.complete(current);
    await Promise.resolve();
    await Promise.resolve();

    expect(stalled.conn.close).toHaveBeenCalledTimes(1);
    expect(current.disconnect).not.toHaveBeenCalled();
    expect(current.conn.close).not.toHaveBeenCalled();
    expect(scheduler.getStats().terminalQueues[stalled.id]).toBeUndefined();
    expect(scheduler.getStats().terminalQueues[current.id].desynchronized).toBe(false);

    const replacement = createMockSocket('unrecoverable-replacement');
    drain.setWritable(replacement, true);
    gateway.handleConnection(replacement);
    await gateway.handleSubscribe(replacement, { sessionId: 'fallback-session' });
    expect(drain.sentTo(replacement).at(-1)?.type).toBe('seed_ansi');
    drain.complete(replacement);

    gateway.broadcastTerminalData('fallback-session', 'after-reconnect');
    drain.complete(current);
    expect(drain.sentTo(replacement).at(-1)?.type).toBe('data');
    expect(drain.sentTo(current).at(-1)?.type).toBe('data');
  });

  it('recovers only the overflowed lane on a shared socket and rejects stale completion and callbacks across newer epochs', async () => {
    const drain = new GatewayDrainAdapter();
    const scheduler = new TerminalSendSchedulerService(
      drain as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 500, batchBytes: 256 },
    );
    const { gateway, seedService } = createGateway({ sendScheduler: scheduler });
    const client = createMockSocket('shared-overflow-socket');
    drain.setWritable(client, false);
    gateway.handleConnection(client);
    await gateway.handleSubscribe(client, { sessionId: 'lane-a' });
    await gateway.handleSubscribe(client, { sessionId: 'lane-b' });

    (seedService.emitSeedToClient as jest.Mock)
      .mockClear()
      .mockImplementation(
        async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
          const recovery = seedOptions.recovery;
          if (!recovery) return undefined;
          const capturedSequence = recovery.getCurrentSequence();
          recovery.onCapturedSequence?.(capturedSequence);
          seedOptions.deliver(
            createEnvelope(`terminal/${seedOptions.sessionId}`, 'seed_ansi', {
              data: `seed-${recovery.recoveryEpoch}`,
              chunk: 0,
              totalChunks: 1,
              recoveryEpoch: recovery.recoveryEpoch,
              capturedSequence,
            }),
          );
          return { recoveryEpoch: recovery.recoveryEpoch, capturedSequence };
        },
      );

    gateway.broadcastTerminalData('lane-b', 'b'.repeat(100));
    gateway.broadcastTerminalData('lane-a', 'a'.repeat(100));
    gateway.broadcastTerminalData('lane-a', 'x'.repeat(200));
    gateway.broadcastTerminalData('lane-a', 'suppressed');
    await Promise.resolve();

    let queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.queuedBytes).toBeLessThanOrEqual(500);
    expect(queue.lanes['lane-a']).toMatchObject({
      desynchronized: true,
      recoveryActive: true,
      recoveryEpoch: 1,
    });
    expect(queue.lanes['lane-b'].queuedBytes).toBeGreaterThan(0);
    expect(queue.lanes['lane-b'].desynchronized).toBe(false);
    expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(1);

    drain.setWritable(client, true);
    drain.complete(client);
    expect(new Set(drain.sent.slice(0, 2).map((envelope) => envelope.topic))).toEqual(
      new Set(['terminal/lane-a', 'terminal/lane-b']),
    );
    drain.complete(client);

    gateway.handleResyncComplete(client, {
      sessionId: 'lane-a',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    await gateway.handleResyncRequest(client, {
      sessionId: 'lane-a',
      reason: 'client_write_overflow',
    });
    gateway.handleResyncComplete(client, {
      sessionId: 'lane-a',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 1,
      capturedSequence: 7,
    });
    queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.lanes['lane-a']).toMatchObject({
      desynchronized: true,
      recoveryActive: true,
      recoveryEpoch: 2,
    });
    expect(queue.lanes['lane-b'].desynchronized).toBe(false);

    drain.complete(client);
    gateway.handleResyncComplete(client, {
      sessionId: 'lane-a',
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      recoveryEpoch: 2,
      capturedSequence: 7,
    });
    queue = scheduler.getStats().terminalQueues[client.id];
    expect(queue.queuedBytes).toBeLessThanOrEqual(500);
    expect(queue.lanes['lane-a'].desynchronized).toBe(false);
    expect(queue.lanes['lane-b'].desynchronized).toBe(false);

    const staleCallback = jest.fn(() => scheduler.markSynchronized(client.id, 'lane-a', 3));
    scheduler.beginRecovery(client, 'lane-a', 3);
    scheduler.enqueueRecovery(
      client,
      createEnvelope('terminal/lane-a', 'data', { data: 'epoch-3-tail', sequence: 8 }),
      staleCallback,
    );
    scheduler.beginRecovery(client, 'lane-a', 4);
    drain.complete(client);
    queue = scheduler.getStats().terminalQueues[client.id];
    expect(staleCallback).not.toHaveBeenCalled();
    expect(queue.lanes['lane-a']).toMatchObject({
      desynchronized: true,
      recoveryActive: true,
      recoveryEpoch: 4,
    });
    expect(queue.lanes['lane-b'].desynchronized).toBe(false);
    expect(queue.queuedBytes).toBeLessThanOrEqual(500);
    expect(scheduler.markSynchronized(client.id, 'lane-a', 4)).toBe(true);
    expect(scheduler.getStats().terminalQueues[client.id].desynchronized).toBe(false);
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.conn.close).not.toHaveBeenCalled();
  });

  it('keeps recovery epochs monotonic when the same session reconnects on a new socket', async () => {
    const { gateway, seedService } = createGateway();
    const epochs: number[] = [];
    (seedService.emitSeedToClient as jest.Mock).mockImplementation(
      async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
        if (!seedOptions.recovery) return undefined;
        const recovery = seedOptions.recovery;
        epochs.push(recovery.recoveryEpoch);
        const capturedSequence = recovery.getCurrentSequence();
        recovery.onCapturedSequence?.(capturedSequence);
        return { recoveryEpoch: recovery.recoveryEpoch, capturedSequence };
      },
    );

    const first = createMockSocket('reconnect-first');
    gateway.handleConnection(first as unknown as Socket);
    await gateway.handleSubscribe(first as unknown as Socket, { sessionId: 'reconnect-session' });
    await gateway.handleResyncRequest(first as unknown as Socket, {
      sessionId: 'reconnect-session',
      reason: 'client_write_overflow',
    });
    gateway.handleDisconnect(first as unknown as Socket);

    const second = createMockSocket('reconnect-second');
    gateway.handleConnection(second as unknown as Socket);
    await gateway.handleSubscribe(second as unknown as Socket, { sessionId: 'reconnect-session' });
    await gateway.handleResyncRequest(second as unknown as Socket, {
      sessionId: 'reconnect-session',
      reason: 'client_write_overflow',
    });

    expect(epochs).toEqual([1, 2]);
  });
});

describe('TerminalGateway initial-geometry authority latch', () => {
  it('two interleaved subscribes apply pty geometry exactly once (latch collapses the burst)', async () => {
    const { gateway, ptyService, registry } = createGateway();
    const a = createMockSocket('client-int-a');
    const b = createMockSocket('client-int-b');

    gateway.handleConnection(a as unknown as Socket);
    gateway.handleConnection(b as unknown as Socket);

    // Fire both WITHOUT awaiting so they interleave across handleSubscribe's internal awaits.
    const pa = gateway.handleSubscribe(a as unknown as Socket, {
      sessionId: 'int-sess',
      rows: 30,
      cols: 120,
    });
    const pb = gateway.handleSubscribe(b as unknown as Socket, {
      sessionId: 'int-sess',
      rows: 24,
      cols: 80,
    });
    await Promise.all([pa, pb]);

    const resizeCalls = (ptyService.resize as jest.Mock).mock.calls.filter(
      ([sid]: [string]) => sid === 'int-sess',
    );
    expect(resizeCalls).toHaveLength(1);
    // A single client owns authority; the pty was flipped to that winner's width only.
    const session = registry.get('int-sess')!;
    expect(session.getAuthority()).not.toBeNull();
    expect([
      [120, 30],
      [80, 24],
    ]).toContainEqual([resizeCalls[0][1], resizeCalls[0][2]]);
  });

  it('reconnect burst applies pty geometry exactly once', async () => {
    const { gateway, ptyService } = createGateway();
    const clients = ['r1', 'r2', 'r3', 'r4'].map((id) => createMockSocket(id));
    clients.forEach((c) => gateway.handleConnection(c as unknown as Socket));

    await Promise.all(
      clients.map((c, i) =>
        gateway.handleSubscribe(c as unknown as Socket, {
          sessionId: 'burst-sess',
          lastSequence: 5 + i,
          rows: 24,
          cols: 80,
        }),
      ),
    );

    const resizeCalls = (ptyService.resize as jest.Mock).mock.calls.filter(
      ([sid]: [string]) => sid === 'burst-sess',
    );
    expect(resizeCalls).toHaveLength(1);
  });

  it('first-attach latch loser neither resizes nor invalidates the seed cache', async () => {
    const { gateway, ptyService, seedService, registry } = createGateway();
    const winner = createMockSocket('client-fa-win');
    const loser = createMockSocket('client-fa-lose');

    gateway.handleConnection(winner as unknown as Socket);
    gateway.handleConnection(loser as unknown as Socket);

    // Winner claims the latch first and applies its geometry.
    await gateway.handleSubscribe(winner as unknown as Socket, {
      sessionId: 'fa-sess',
      rows: 30,
      cols: 120,
    });
    (ptyService.resize as jest.Mock).mockClear();
    (seedService.invalidateCache as jest.Mock).mockClear();

    // Loser is ALSO a first attach but the latch is already held → no resize, no invalidation,
    // no 50ms settle; it seeds at the winner's width.
    await gateway.handleSubscribe(loser as unknown as Socket, {
      sessionId: 'fa-sess',
      rows: 24,
      cols: 80,
    });

    expect(ptyService.resize).not.toHaveBeenCalled();
    expect(seedService.invalidateCache).not.toHaveBeenCalled();
    expect(registry.get('fa-sess')!.getAuthority()).toBe('client-fa-win');
  });

  it('bails without subscribing when the client disconnects inside the 50ms seed window', async () => {
    const { gateway, registry } = createGateway({ seedSettleMs: 50 });
    const client = createMockSocket('client-midwindow');

    gateway.handleConnection(client as unknown as Socket);

    // Start the subscribe but do not await — it wins the latch, applies resize, then parks on
    // the 50ms seed settle before wiring/subscribing.
    const pending = gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'midwindow-sess',
      rows: 24,
      cols: 80,
    });
    // Flush microtasks past sessionExists + ensurePtyStreaming so we are inside the 50ms window.
    await new Promise((r) => setTimeout(r, 5));

    const session = registry.get('midwindow-sess')!;
    expect(session.getAuthority()).toBe('client-midwindow'); // latched
    const cs = (
      gateway as unknown as { clientSessions: Map<string, { subscriptions: Set<string> }> }
    ).clientSessions.get('client-midwindow')!;
    // Only session/<id> is held mid-window — terminal/<id> is added after the settle.
    expect(cs.subscriptions.has('session/midwindow-sess')).toBe(true);
    expect(cs.subscriptions.has('terminal/midwindow-sess')).toBe(false);

    // Client dies mid-window; the sweep must clear the latched authority via session/<id>.
    gateway.handleDisconnect(client as unknown as Socket);
    expect(session.getAuthority()).toBeNull();

    await pending; // resumes, hits the liveness guard, and bails
    expect(session.hasSubscriber('client-midwindow')).toBe(false);
  });
});

describe('TerminalGateway disconnect authority sweep', () => {
  it('clears authority on ALL of a multi-session socket, not just the last one', async () => {
    const { gateway, registry } = createGateway();
    const client = createMockSocket('client-multi-disc');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'md-a',
      rows: 24,
      cols: 80,
    });
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'md-b',
      rows: 24,
      cols: 80,
    });

    const a = registry.get('md-a')!;
    const b = registry.get('md-b')!;
    expect(a.getAuthority()).toBe('client-multi-disc');
    expect(b.getAuthority()).toBe('client-multi-disc');

    gateway.handleDisconnect(client as unknown as Socket);

    expect(a.getAuthority()).toBeNull();
    expect(b.getAuthority()).toBeNull();
  });

  it('is idempotent — a second disconnect is a harmless no-op', async () => {
    const { gateway, registry } = createGateway();
    const client = createMockSocket('client-idem');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'idem-sess',
      rows: 24,
      cols: 80,
    });
    const session = registry.get('idem-sess')!;

    gateway.handleDisconnect(client as unknown as Socket);
    expect(session.getAuthority()).toBeNull();

    expect(() => gateway.handleDisconnect(client as unknown as Socket)).not.toThrow();
    expect(session.getAuthority()).toBeNull();
  });

  it('heartbeat timeout closes the transport for reconnect and sweeps authority', async () => {
    jest.useFakeTimers();
    const { gateway, registry } = createGateway();
    try {
      const client = createMockSocket('client-hb');
      gateway.server.sockets.sockets.set(client.id, client);

      gateway.handleConnection(client as unknown as Socket);
      // Dimensionless subscribe → no 50ms latch settle to advance past; subscribe() still grants
      // first-subscriber authority.
      await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'hb-sess' });
      const session = registry.get('hb-sess')!;
      expect(session.getAuthority()).toBe('client-hb');

      gateway.afterInit(); // starts the heartbeat interval
      // Two interval ticks (30s each) → elapsed since lastHeartbeat exceeds HEARTBEAT_TIMEOUT (45s).
      jest.advanceTimersByTime(60_001);

      expect(client.conn.close).toHaveBeenCalledTimes(1);
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(session.getAuthority()).toBeNull();
      expect(
        (gateway as unknown as { clientSessions: Map<string, unknown> }).clientSessions.has(
          'client-hb',
        ),
      ).toBe(false);
    } finally {
      gateway.onModuleDestroy();
      jest.useRealTimers();
    }
  });
});

describe('TerminalGateway focus event ordering + cardinality (R2)', () => {
  it('first subscribe emits exactly one focus_changed', async () => {
    const { gateway, roomEmit } = createGateway();
    const client = createMockSocket('client-focus-1');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-focus',
      rows: 24,
      cols: 80,
    });

    const focusCalls = (roomEmit as jest.Mock).mock.calls.filter(
      ([, envelope]: [string, { type?: string }]) => envelope?.type === 'focus_changed',
    );
    expect(focusCalls).toHaveLength(1);
    expect(focusCalls[0][1]).toEqual(
      expect.objectContaining({
        type: 'focus_changed',
        payload: expect.objectContaining({ clientId: 'client-focus-1', granted: true }),
      }),
    );
  });

  it('authority claim emits exactly one focus_changed (not two)', async () => {
    const { gateway, roomEmit } = createGateway();
    const clientA = createMockSocket('client-A');
    const clientB = createMockSocket('client-B');

    gateway.handleConnection(clientA as unknown as Socket);
    gateway.handleConnection(clientB as unknown as Socket);

    await gateway.handleSubscribe(clientA as unknown as Socket, {
      sessionId: 'session-authority',
      rows: 24,
      cols: 80,
    });
    await gateway.handleSubscribe(clientB as unknown as Socket, {
      sessionId: 'session-authority',
      rows: 24,
      cols: 80,
    });

    (roomEmit as jest.Mock).mockClear();

    gateway.handleFocus(clientB as unknown as Socket, { sessionId: 'session-authority' });

    const focusCalls = (roomEmit as jest.Mock).mock.calls.filter(
      ([, envelope]: [string, { type?: string }]) => envelope?.type === 'focus_changed',
    );
    expect(focusCalls).toHaveLength(1);
  });

  it('unsubscribe handover emits exactly one focus_changed for new holder', async () => {
    const { gateway, registry, roomEmit } = createGateway();
    const clientA = createMockSocket('client-unsub-A');
    const clientB = createMockSocket('client-unsub-B');

    gateway.handleConnection(clientA as unknown as Socket);
    gateway.handleConnection(clientB as unknown as Socket);

    await gateway.handleSubscribe(clientA as unknown as Socket, {
      sessionId: 'session-handover',
      rows: 24,
      cols: 80,
    });
    await gateway.handleSubscribe(clientB as unknown as Socket, {
      sessionId: 'session-handover',
      rows: 24,
      cols: 80,
    });

    (roomEmit as jest.Mock).mockClear();

    const session = registry.get('session-handover')!;
    session.claimAuthority('client-unsub-A');
    (roomEmit as jest.Mock).mockClear();

    gateway.handleDisconnect(clientA as unknown as Socket);

    const focusCalls = (roomEmit as jest.Mock).mock.calls.filter(
      ([, envelope]: [string, { type?: string }]) => envelope?.type === 'focus_changed',
    );
    expect(focusCalls).toHaveLength(1);
    expect(focusCalls[0][1]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ clientId: 'client-unsub-B', granted: true }),
      }),
    );
  });

  it('wireFrameListener is called before session.subscribe (listener-first invariant)', async () => {
    const { gateway, registry } = createGateway();
    const client = createMockSocket('client-order');

    gateway.handleConnection(client as unknown as Socket);

    const session = registry.get('session-order')!;
    const focusEvents: unknown[] = [];
    session.stream.on('frame', (frame) => {
      if (frame.type === 'focus_changed') focusEvents.push(frame);
    });

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-order',
      rows: 24,
      cols: 80,
    });

    expect(focusEvents).toHaveLength(1);
  });
});

describe('TerminalGateway activity routing', () => {
  it('keeps pushFrame, activity, and mobile viewport triggers live with zero web subscribers', () => {
    jest.useFakeTimers();
    try {
      const { gateway, registry, streamService, roomEmit } = createGateway();
      const session = registry.get('session-activity')!;
      const pushSpy = jest.spyOn(session, 'pushFrame');
      const viewportDirty = jest.fn();
      const viewport = new TerminalViewportFacade(registry, {} as never);
      const detachViewport = viewport.onData('session-activity', viewportDirty);

      gateway.broadcastTerminalData('session-activity', 'terminal output');

      expect(pushSpy).toHaveBeenCalledWith('terminal output');
      expect(viewportDirty).toHaveBeenCalledTimes(1);
      expect(streamService.addFrame).not.toHaveBeenCalled();
      expect(streamService.markDiscontinuous).toHaveBeenCalledWith('session-activity');
      expect(roomEmit).not.toHaveBeenCalled();
      expect(session.getActivityState().busySince).not.toBeNull();

      jest.advanceTimersByTime(30_000);
      expect(session.getActivityState().idleSince).not.toBeNull();
      detachViewport();
    } finally {
      jest.useRealTimers();
    }
  });

  it('broadcastTerminalData schedules each subscribed socket without a room emit', () => {
    const { gateway, registry, roomEmit, sendScheduler } = createGateway();
    try {
      const client = createMockSocket('web-viewer');
      gateway.handleConnection(client);
      const tracked = (
        gateway as unknown as { clientSessions: Map<string, { subscriptions: Set<string> }> }
      ).clientSessions.get(client.id)!;
      tracked.subscriptions.add('terminal/session-emit');
      registry.get('session-emit')!.subscribe(client.id);

      gateway.broadcastTerminalData('session-emit', 'data chunk');

      expect(sendScheduler.enqueueLive).toHaveBeenCalledWith(
        client,
        expect.objectContaining({ type: 'data' }),
      );
      expect(roomEmit).not.toHaveBeenCalled();
    } finally {
      registry.dispose('session-emit');
    }
  });

  it('gates fallback replay and room delivery when no web socket tracks the session', () => {
    const { gateway, registry, streamService, roomEmit } = createGateway();
    registry.get = () => undefined;

    expect(() => gateway.broadcastTerminalData('no-session', 'data')).not.toThrow();
    expect(streamService.addFrame).not.toHaveBeenCalled();
    expect(streamService.markDiscontinuous).toHaveBeenCalledWith('no-session');
    expect(roomEmit).not.toHaveBeenCalled();
  });

  it('uses the socket subscription map when a fallback session has a web viewer', async () => {
    const { gateway, registry, streamService, roomEmit, sendScheduler } = createGateway();
    registry.get = () => undefined;
    const client = createMockSocket('fallback-viewer');
    gateway.handleConnection(client);
    await gateway.handleSubscribe(client, { sessionId: 'fallback-session' });
    (streamService.addFrame as jest.Mock).mockClear();
    roomEmit.mockClear();

    gateway.broadcastTerminalData('fallback-session', 'visible output');

    expect(streamService.addFrame).toHaveBeenCalledWith('fallback-session', 'visible output');
    expect(sendScheduler.enqueueLive).toHaveBeenCalledTimes(1);
  });

  it('handleInput calls session.signalInput for activity tracking', async () => {
    const { gateway, registry } = createGateway();
    const client = createMockSocket('client-input');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-input',
      rows: 24,
      cols: 80,
    });

    const session = registry.get('session-input')!;
    const signalSpy = jest.spyOn(session, 'signalInput');

    await gateway.handleInput(client as unknown as Socket, {
      sessionId: 'session-input',
      data: 'hello',
    });

    expect(signalSpy).toHaveBeenCalled();
    const state = session.getActivityState();
    expect(state.lastInputAt).toBeGreaterThan(0);
    expect(state.busySince).not.toBeNull();
  });

  it('broadcasts every ordered chunk returned by the replay stream', () => {
    const { gateway, streamService, registry, sendScheduler } = createGateway();
    try {
      const session = registry.get('session-chunked-broadcast')!;
      const client = createMockSocket('web-viewer');
      gateway.handleConnection(client);
      const tracked = (
        gateway as unknown as { clientSessions: Map<string, { subscriptions: Set<string> }> }
      ).clientSessions.get(client.id)!;
      tracked.subscriptions.add('terminal/session-chunked-broadcast');
      session.subscribe(client.id);
      const pushSpy = jest.spyOn(session, 'pushFrame');
      const chunks = ['first🙂', '\u001b[31msecond\u001b[0m'];
      (streamService.addFrame as jest.Mock).mockReturnValue(
        chunks.map((data, index) =>
          createEnvelope('terminal/session-chunked-broadcast', 'data', {
            data,
            sequence: index + 1,
          }),
        ),
      );

      gateway.broadcastTerminalData('session-chunked-broadcast', chunks.join(''));

      expect(pushSpy.mock.calls.map(([data]) => data)).toEqual(chunks);
      expect(
        (sendScheduler.enqueueLive as jest.Mock).mock.calls.map(
          ([, envelope]) => (envelope as { payload: { data: string } }).payload.data,
        ),
      ).toEqual(chunks);
    } finally {
      registry.dispose('session-chunked-broadcast');
    }
  });

  it('forces one targeted seed on the first reconnect after gated output', async () => {
    const { gateway, registry, streamService, seedService } = createGateway({
      replayResult: {
        status: 'gap',
        currentSequence: 8,
        discontinuitySequence: 8,
      },
    });
    try {
      registry.get('session-gated')!;
      gateway.broadcastTerminalData('session-gated', 'unwatched output');
      const client = createMockSocket('returning-viewer');
      gateway.handleConnection(client);

      await gateway.handleSubscribe(client, {
        sessionId: 'session-gated',
        lastSequence: 7,
      });

      expect(streamService.markDiscontinuous).toHaveBeenCalledTimes(1);
      expect(seedService.emitSeedToClient).toHaveBeenCalledTimes(1);
      expect(client.emit).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({ type: 'resync_required' }),
      );
    } finally {
      registry.dispose('session-gated');
    }
  });

  it('does not reseed covered reconnects during rapid subscriber cycling without output', async () => {
    const { gateway, streamService, seedService } = createGateway();
    const client = createMockSocket('cycling-viewer');
    gateway.handleConnection(client);
    await gateway.handleSubscribe(client, { sessionId: 'session-cycle' });
    (seedService.emitSeedToClient as jest.Mock).mockClear();

    for (let cycle = 0; cycle < 5; cycle += 1) {
      gateway.handleUnsubscribe(client, { sessionId: 'session-cycle' });
      await gateway.handleSubscribe(client, {
        sessionId: 'session-cycle',
        lastSequence: 7,
        sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      });
    }

    expect(streamService.markDiscontinuous).not.toHaveBeenCalled();
    expect(seedService.emitSeedToClient).not.toHaveBeenCalled();
  });
});

describe('TerminalGateway dead-tmux detection', () => {
  it.each(['subscribe', 'resize', 'input'] as const)(
    '%s reports a crashed session when tmux is dead',
    async (entry) => {
      const { gateway, terminalIO, sessionTerminalRuntime, ptyService } = createGateway();
      const client = createMockSocket('dead-client');
      gateway.handleConnection(client);
      if (entry === 'input') {
        await gateway.handleSubscribe(client, { sessionId: 'dead-session', rows: 24, cols: 80 });
        gateway.handleFocus(client, { sessionId: 'dead-session' });
      }
      (terminalIO.sessionExists as jest.Mock).mockResolvedValue(false);
      if (entry === 'subscribe')
        await gateway.handleSubscribe(client, { sessionId: 'dead-session' });
      else if (entry === 'resize')
        await gateway.handleResize(client, { sessionId: 'dead-session', rows: 24, cols: 80 });
      else await gateway.handleInput(client, { sessionId: 'dead-session', data: 'x' });
      expect(sessionTerminalRuntime.retireConfirmedLoss).toHaveBeenCalledWith(
        'dead-session',
        expect.any(String),
      );
      if (entry === 'subscribe')
        expect(ptyService.stopStreaming).toHaveBeenCalledWith('dead-session');
      expect(client.emit).toHaveBeenCalledWith(
        'message',
        expect.objectContaining({
          type: 'state_change',
          payload: expect.objectContaining({ status: 'crashed', sessionId: 'dead-session' }),
        }),
      );
    },
  );

  it('subscribe: does not mark failed when tmux is alive', async () => {
    const { gateway, terminalIO, sessionTerminalRuntime } = createGateway();
    (terminalIO.sessionExists as jest.Mock).mockResolvedValue(true);

    const client = createMockSocket('client-alive-subscribe');
    gateway.handleConnection(client);

    await gateway.handleSubscribe(client, { sessionId: 'alive-session' });

    expect(sessionTerminalRuntime.retireConfirmedLoss).not.toHaveBeenCalled();
  });
});

describe('TerminalGateway lifecycle cleanup parity', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['crashed', 'dead-tmux'] as const)(
    '%s immediately frees replay, seed cache, sequence state, and terminal state',
    async (event) => {
      const { gateway, streamService, seedService, ptyService, registry } = createGateway({
        autoCreateRegistrySessions: false,
      });
      const sessionId = `cleanup-${event}`;
      registry.create(sessionId, `tmux_${sessionId}`);

      if (event === 'crashed') {
        gateway.handleSessionCrashed({ sessionId, sessionName: `tmux_${sessionId}` });
      } else {
        const client = createMockSocket('cleanup-dead-client');
        await (
          gateway as unknown as {
            handleDeadTmuxSession(id: string, socket: Socket): Promise<void>;
          }
        ).handleDeadTmuxSession(sessionId, client);
      }

      expect(streamService.clearBuffer).toHaveBeenCalledWith(sessionId);
      expect(seedService.invalidateCache).toHaveBeenCalledWith(sessionId);
      expect(ptyService.stopStreaming).toHaveBeenCalledWith(sessionId);
      expect(registry.get(sessionId)).toBeUndefined();
    },
  );

  it('a standalone terminal end frees terminal state at once and tells attached views', () => {
    const { gateway, streamService, seedService, ptyService, registry, roomEmit } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('standalone-1', 'devchain-aux_1_standalone-1');

    gateway.endStandaloneTerminal('standalone-1', 'Login stored.');

    expect(streamService.clearBuffer).toHaveBeenCalledWith('standalone-1');
    expect(seedService.invalidateCache).toHaveBeenCalledWith('standalone-1');
    expect(ptyService.stopStreaming).toHaveBeenCalledWith('standalone-1');
    expect(registry.get('standalone-1')).toBeUndefined();
    expect(gateway.server.to).toHaveBeenCalledWith('session:standalone-1');
    expect(roomEmit).toHaveBeenCalledWith(
      'message',
      expect.objectContaining({
        topic: 'session/standalone-1',
        type: 'state_change',
        payload: { sessionId: 'standalone-1', status: 'ended', message: 'Login stored.' },
      }),
    );
  });

  it('stopped invalidates capture immediately but retains replay for exactly 60 seconds', () => {
    jest.useFakeTimers();
    const { gateway, streamService, seedService, ptyService } = createGateway();

    gateway.handleSessionStopped({ sessionId: 'cleanup-stopped' });

    expect(seedService.invalidateCache).toHaveBeenCalledWith('cleanup-stopped');
    expect(streamService.clearBuffer).not.toHaveBeenCalled();
    expect(ptyService.stopStreaming).not.toHaveBeenCalled();

    jest.advanceTimersByTime(59999);
    expect(streamService.clearBuffer).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(streamService.clearBuffer).toHaveBeenCalledWith('cleanup-stopped');

    gateway.onModuleDestroy();
  });

  it('restore inside the retention window cancels the cleanup timer so the domain survives without a buffer reset', () => {
    jest.useFakeTimers();
    const { gateway, streamService } = createGateway({ autoCreateRegistrySessions: false });

    gateway.handleSessionStopped({ sessionId: 'restore-before-expiry' });
    expect(streamService.clearBuffer).not.toHaveBeenCalled();

    // A restore inside the 60s window must cancel the pending clearBuffer so the live
    // sequence-domain (epoch/current sequence/recovery counter) is retained, not reset.
    jest.advanceTimersByTime(30_000);
    gateway.handleSessionRestored({
      sessionId: 'restore-before-expiry',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionName: 'tmux_restore-before-expiry',
      providerName: 'claude',
    });

    // Advance well beyond the original deadline: the buffer must never be cleared.
    jest.advanceTimersByTime(60_000);
    expect(streamService.clearBuffer).not.toHaveBeenCalled();

    gateway.onModuleDestroy();
  });
});

describe('TerminalGateway sequence-domain recovery isolation (Task 2)', () => {
  it('retires a recovery started in the retention window so its late old-domain callbacks cannot touch the new domain', async () => {
    jest.useFakeTimers();
    try {
      const { gateway, streamService, seedService, sendScheduler } = createGateway();
      const client = createMockSocket('window-recovery');
      gateway.handleConnection(client as unknown as Socket);

      // Domain A: subscribe records the terminal subscription and samples epoch A.
      (streamService.getSequenceEpoch as jest.Mock).mockReturnValue('epoch-A');
      (streamService.sampleCursor as jest.Mock).mockReturnValue({
        sequenceEpoch: 'epoch-A',
        currentSequence: 5,
      });
      // Dimensionless subscribe → no 50ms seed-settle timer to advance past under fake timers.
      await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'window-sess' });

      // A deliberately pending recovery: capture its seed callbacks without completing it.
      let lateDeliver!: (
        envelope: ReturnType<typeof createEnvelope>,
      ) => TerminalSeedDeliveryDecision;
      let lateCaptured: ((sequence: number) => void) | undefined;
      let recoveryEpochA = 0;
      (seedService.emitSeedToClient as jest.Mock).mockImplementation(
        async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
          const recovery = seedOptions.recovery!;
          recoveryEpochA = recovery.recoveryEpoch;
          lateDeliver = seedOptions.deliver;
          lateCaptured = recovery.onCapturedSequence;
          return {
            sequenceEpoch: recovery.sequenceEpoch,
            recoveryEpoch: recovery.recoveryEpoch,
            capturedSequence: 5,
          };
        },
      );

      // Stop schedules the 60s retention timer but leaves the terminal subscription recorded, so the
      // client can still start a recovery in the window.
      gateway.handleSessionStopped({ sessionId: 'window-sess' });
      await gateway.handleResyncRequest(client as unknown as Socket, {
        sessionId: 'window-sess',
        reason: 'client_write_overflow',
      });
      expect(seedService.emitSeedToClient).toHaveBeenCalled();

      (sendScheduler.enqueueRecovery as jest.Mock).mockClear();
      (sendScheduler.markSynchronized as jest.Mock).mockClear();

      // Timer expiry clears domain A and retires recovery A; a new domain B then establishes.
      jest.advanceTimersByTime(60_000);
      expect(streamService.clearBuffer).toHaveBeenCalledWith('window-sess');
      (streamService.getSequenceEpoch as jest.Mock).mockReturnValue('epoch-B');

      // Every late old-domain callback must no-op against domain B.
      expect(
        lateDeliver(
          createEnvelope('terminal/window-sess', 'seed_ansi', {
            data: 'late-A',
            chunk: 0,
            totalChunks: 1,
          }),
        ),
      ).toBe(TerminalSeedDelivery.Abort);
      lateCaptured?.(999);
      gateway.handleResyncComplete(client as unknown as Socket, {
        sessionId: 'window-sess',
        sequenceEpoch: 'epoch-A',
        recoveryEpoch: recoveryEpochA,
        capturedSequence: 5,
      });

      expect(sendScheduler.enqueueRecovery).not.toHaveBeenCalled();
      expect(sendScheduler.markSynchronized).not.toHaveBeenCalled();

      gateway.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an abort or completion whose pair still matches a lingering recovery after the live stream epoch has moved on', async () => {
    const { gateway, streamService, seedService, sendScheduler } = createGateway();
    const client = createMockSocket('stale-domain-complete');
    gateway.handleConnection(client as unknown as Socket);

    (streamService.getSequenceEpoch as jest.Mock).mockReturnValue('epoch-A');
    (streamService.sampleCursor as jest.Mock).mockReturnValue({
      sequenceEpoch: 'epoch-A',
      currentSequence: 5,
    });
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'stale-sess' });

    let recoveryEpochA = 0;
    (seedService.emitSeedToClient as jest.Mock).mockImplementation(
      async (seedOptions: Parameters<TerminalSeedService['emitSeedToClient']>[0]) => {
        const recovery = seedOptions.recovery!;
        recoveryEpochA = recovery.recoveryEpoch;
        return {
          sequenceEpoch: recovery.sequenceEpoch,
          recoveryEpoch: recovery.recoveryEpoch,
          capturedSequence: 5,
        };
      },
    );
    await gateway.handleResyncRequest(client as unknown as Socket, {
      sessionId: 'stale-sess',
      reason: 'client_write_overflow',
    });

    // The live stream advances to a new domain B while recovery A still sits in the map (its state
    // pair is unchanged). An abort/completion carrying A's pair must be rejected against the live
    // domain, so it cannot cancel or synchronize the new lane.
    (streamService.getSequenceEpoch as jest.Mock).mockReturnValue('epoch-B');
    (sendScheduler.removeLane as jest.Mock).mockClear();
    (sendScheduler.markSynchronized as jest.Mock).mockClear();

    expect(
      gateway.handleResyncAbort(client as unknown as Socket, {
        sessionId: 'stale-sess',
        sequenceEpoch: 'epoch-A',
        recoveryEpoch: recoveryEpochA,
      }),
    ).toBe(false);
    expect(sendScheduler.removeLane).not.toHaveBeenCalled();

    gateway.handleResyncComplete(client as unknown as Socket, {
      sessionId: 'stale-sess',
      sequenceEpoch: 'epoch-A',
      recoveryEpoch: recoveryEpochA,
      capturedSequence: 5,
    });
    expect(sendScheduler.markSynchronized).not.toHaveBeenCalled();
  });
});

describe('TerminalGateway.handleInput authority guard', () => {
  it('allows input from subscribed authority client (control key)', async () => {
    const { gateway, terminalIO } = createGateway();
    const client = createMockSocket('authority-client');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'auth-session',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'auth-session' });

    await gateway.handleInput(client as unknown as Socket, {
      sessionId: 'auth-session',
      data: '\r',
    });

    expect(terminalIO.sendControl).toHaveBeenCalled();
  });

  it('allows input from subscribed authority client (non-control)', async () => {
    const { gateway, terminalIO } = createGateway();
    const client = createMockSocket('authority-client-nc');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'auth-session-nc',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'auth-session-nc' });

    await gateway.handleInput(client as unknown as Socket, {
      sessionId: 'auth-session-nc',
      data: 'hello',
    });

    expect(terminalIO.deliverImmediate).toHaveBeenCalledWith(
      { name: 'tmux_auth-session-nc' },
      'hello',
      { bracketed: true },
    );
  });

  it('sends TTY paste text after option separator so leading dash stays literal', async () => {
    const { gateway, terminalIO } = createGateway();
    const client = createMockSocket('authority-client-tty-dash');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'auth-session-tty-dash',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'auth-session-tty-dash' });

    await gateway.handleInput(client as unknown as Socket, {
      sessionId: 'auth-session-tty-dash',
      data: '- leading dash paste',
      ttyMode: true,
    });

    expect(terminalIO.sendControl).toHaveBeenCalledWith({ name: 'tmux_auth-session-tty-dash' }, [
      '-l',
      '--',
      '- leading dash paste',
    ]);
    expect(terminalIO.deliverImmediate).not.toHaveBeenCalled();
  });

  it('keeps Backspace behind blocked text and clears the draft after both writes', async () => {
    const { gateway, terminalIO, humanPromptState, eventEmitter } = createGateway();
    const client = createMockSocket('authority-client-pending-text-backspace');
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'pending-text-backspace',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'pending-text-backspace' });

    let release!: () => void;
    const promotion = new Promise<void>((resolve) => {
      release = resolve;
    });
    eventEmitter.on(sessionHumanPromptStateChangedEvent.name, () => promotion);

    const text = gateway.handleInput(client as unknown as Socket, {
      sessionId: 'pending-text-backspace',
      data: 'a',
      ttyMode: true,
    });
    await Promise.resolve();
    const backspace = gateway.handleInput(client as unknown as Socket, {
      sessionId: 'pending-text-backspace',
      data: '\x7f',
      ttyMode: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(terminalIO.sendControl).not.toHaveBeenCalled();
    expect(humanPromptState.getState('tmux_pending-text-backspace').phase).toBe('draft_active');

    release();
    await Promise.all([text, backspace]);
    expect((terminalIO.sendControl as jest.Mock).mock.calls.map((call) => call[1])).toEqual([
      ['-l', '--', 'a'],
      ['BSpace'],
    ]);
    expect(humanPromptState.getState('tmux_pending-text-backspace').phase).toBe(
      'awaiting_stable_idle',
    );
  });

  it('captures the Enter generation before delayed liveness so newer text keeps its draft', async () => {
    const { gateway, terminalIO, humanPromptState } = createGateway();
    const client = createMockSocket('authority-client-enter-liveness-race');
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'enter-liveness-race',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'enter-liveness-race' });
    humanPromptState.recordPromptText('tmux_enter-liveness-race');

    // Delay only Enter's liveness check.
    let releaseLiveness!: (alive: boolean) => void;
    (terminalIO.sessionExists as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseLiveness = resolve;
        }),
    );

    const enter = gateway.handleInput(client as unknown as Socket, {
      sessionId: 'enter-liveness-race',
      data: '\r',
      ttyMode: true,
    });
    await Promise.resolve();

    // Simulate newer input through another prompt-state consumer.
    humanPromptState.recordPromptText('tmux_enter-liveness-race');
    expect(humanPromptState.getState('tmux_enter-liveness-race')).toEqual(
      expect.objectContaining({ phase: 'draft_active', generation: 2 }),
    );
    expect(terminalIO.sendControl).not.toHaveBeenCalled();

    releaseLiveness(true);
    await enter;

    // Enter observed generation 1, so it cannot clear the newer generation-2 draft.
    expect(humanPromptState.getState('tmux_enter-liveness-race')).toEqual(
      expect.objectContaining({ phase: 'draft_active', generation: 2 }),
    );

    expect(terminalIO.sendControl).toHaveBeenCalledWith({ name: 'tmux_enter-liveness-race' }, [
      'Enter',
    ]);
  });

  it('leaves the observed draft unchanged when Enter liveness fails', async () => {
    const { gateway, terminalIO, humanPromptState } = createGateway();
    const client = createMockSocket('authority-client-enter-dead');
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'enter-dead',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'enter-dead' });
    humanPromptState.recordPromptText('tmux_enter-dead');
    (terminalIO.sessionExists as jest.Mock).mockResolvedValueOnce(false);

    await gateway.handleInput(client as unknown as Socket, {
      sessionId: 'enter-dead',
      data: '\r',
      ttyMode: true,
    });

    expect(terminalIO.sendControl).not.toHaveBeenCalled();
    // Dead-session cleanup owns state removal here; Enter itself must never
    // transition the draft to awaiting_stable_idle.
    expect(humanPromptState.getState('tmux_enter-dead').phase).toBe('inactive');
  });

  // Module-unit: the gateway is the cheapest layer for translating socket input into the shared interface.
  it.each([
    {
      data: '\r',
      ttyMode: true,
      input: {
        kind: 'control',
        tmuxKey: 'Enter',
        expectedGeneration: 1,
        providerName: null,
      },
    },
    {
      data: '\x03',
      ttyMode: true,
      input: {
        kind: 'control',
        tmuxKey: 'C-c',
        expectedGeneration: 1,
        providerName: 'codex',
      },
    },
    { data: 'abc', ttyMode: true, input: { kind: 'text', characterCount: 3 } },
    {
      data: '\x1b[999~',
      ttyMode: true,
      input: {
        kind: 'control',
        tmuxKey: 'Unknown',
        expectedGeneration: 1,
        providerName: null,
      },
    },
    { data: 'form prompt', ttyMode: false, input: { kind: 'submit-text' } },
  ])(
    'routes socket input $data through the prompt-input interface',
    async ({ data, ttyMode, input }) => {
      const { gateway, humanPromptInput, humanPromptState, sessionTerminalRuntime, registry } =
        createGateway();
      (sessionTerminalRuntime.getProviderNameAtLaunch as jest.Mock).mockReturnValue('codex');
      const client = createMockSocket('authority-client-input-routing');
      gateway.handleConnection(client as unknown as Socket);
      await gateway.handleSubscribe(client as unknown as Socket, {
        sessionId: 'input-routing',
        rows: 24,
        cols: 80,
      });
      gateway.handleFocus(client as unknown as Socket, { sessionId: 'input-routing' });
      humanPromptState.recordPromptText('tmux_input-routing');
      const run = jest.spyOn(humanPromptInput, 'run');

      await gateway.handleInput(client as unknown as Socket, {
        sessionId: 'input-routing',
        data,
        ttyMode,
      });

      expect(run).toHaveBeenCalledWith(registry.get('input-routing'), input, expect.any(Function));
    },
  );

  it('handles a failed form write without rejecting the socket input', async () => {
    const { gateway, terminalIO } = createGateway();
    const client = createMockSocket('authority-client-form-failure');
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'form-failure',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'form-failure' });
    (terminalIO.deliverImmediate as jest.Mock).mockRejectedValueOnce(new Error('write failed'));

    await expect(
      gateway.handleInput(client as unknown as Socket, {
        sessionId: 'form-failure',
        data: 'unsafe to release',
      }),
    ).resolves.toBeUndefined();
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
  });

  it.each(['\r', 'x'])('rejects unauthorized subscriber input %j', async (data) => {
    const { gateway, terminalIO } = createGateway();
    const authorityClient = createMockSocket('client-a');
    const secondClient = createMockSocket('client-b');

    gateway.handleConnection(authorityClient as unknown as Socket);
    gateway.handleConnection(secondClient as unknown as Socket);

    await gateway.handleSubscribe(authorityClient as unknown as Socket, {
      sessionId: 'shared-session',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(authorityClient as unknown as Socket, { sessionId: 'shared-session' });

    await gateway.handleSubscribe(secondClient as unknown as Socket, {
      sessionId: 'shared-session',
      rows: 24,
      cols: 80,
    });

    await gateway.handleInput(secondClient as unknown as Socket, {
      sessionId: 'shared-session',
      data,
    });

    expect(terminalIO.sendControl).not.toHaveBeenCalled();
    expect(terminalIO.deliverImmediate).not.toHaveBeenCalled();
  });

  it('rejects input from non-subscriber', async () => {
    const { gateway, terminalIO, registry } = createGateway();
    const client = createMockSocket('unsubscribed-client');

    gateway.handleConnection(client as unknown as Socket);

    registry.create('nosub-session', 'tmux_nosub-session');

    await gateway.handleInput(client as unknown as Socket, {
      sessionId: 'nosub-session',
      data: 'x',
    });

    expect(terminalIO.sendControl).not.toHaveBeenCalled();
    expect(terminalIO.deliverImmediate).not.toHaveBeenCalled();
  });
});

describe('TerminalGateway prompt-paste acknowledgement and idempotency', () => {
  const gatewaysToDestroy: TerminalGateway[] = [];

  afterEach(() => {
    for (const gateway of gatewaysToDestroy) gateway.onModuleDestroy();
    gatewaysToDestroy.length = 0;
    jest.useRealTimers();
  });

  async function createAuthorizedPromptClient(
    sessionId: string,
    options?: Parameters<typeof createGateway>[0],
  ) {
    const setup = createGateway(options);
    gatewaysToDestroy.push(setup.gateway);
    const client = createMockSocket(`prompt-client-${sessionId}`);
    setup.gateway.handleConnection(client);
    await setup.gateway.handleSubscribe(client, { sessionId, rows: 24, cols: 80 });
    setup.gateway.handleFocus(client, { sessionId });
    return { ...setup, client };
  }

  it('delivers one bracketed no-submit paste and returns a plain typed ack', async () => {
    const { gateway, client, terminalIO } = await createAuthorizedPromptClient('prompt-success');
    const payload = promptPastePayload('prompt-success');

    const result = await gateway.handleInput(client, payload);

    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
    expect(terminalIO.deliverImmediate).toHaveBeenCalledWith(
      { name: 'tmux_prompt-success' },
      'selected prompt',
      { bracketed: true, submitKeys: [] },
    );
    expect(result).toEqual({ ok: true, code: 'OK', requestId: payload.requestId });
    expect(result).not.toHaveProperty('event');
  });

  it('shares one pending operation for concurrent same-ID attempts', async () => {
    const { gateway, client, terminalIO } = await createAuthorizedPromptClient('prompt-concurrent');
    let releaseExists!: (alive: boolean) => void;
    (terminalIO.sessionExists as jest.Mock).mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseExists = resolve;
      }),
    );
    (terminalIO.sessionExists as jest.Mock).mockClear();
    const payload = promptPastePayload('prompt-concurrent');

    const first = gateway.handleInput(client, payload);
    const second = gateway.handleInput(client, payload);
    for (
      let turn = 0;
      turn < 10 && !(terminalIO.sessionExists as jest.Mock).mock.calls.length;
      turn += 1
    ) {
      await Promise.resolve();
    }
    expect(terminalIO.sessionExists).toHaveBeenCalledTimes(1);
    releaseExists(true);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, code: 'OK', requestId: payload.requestId },
      { ok: true, code: 'OK', requestId: payload.requestId },
    ]);
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
  });

  it('replays the tombstone after a lost ack and rejects changed content', async () => {
    const { gateway, client, terminalIO } = await createAuthorizedPromptClient('prompt-replay');
    const payload = promptPastePayload('prompt-replay');

    const first = await gateway.handleInput(client, payload);
    const replay = await gateway.handleInput(client, payload);
    const conflict = await gateway.handleInput(client, { ...payload, data: 'different prompt' });

    expect(first).toEqual({ ok: true, code: 'OK', requestId: payload.requestId });
    expect(replay).toEqual(first);
    expect(conflict).toEqual({
      ok: false,
      code: 'REQUEST_CONFLICT',
      requestId: payload.requestId,
    });
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
  });

  it('caches a delivery-stage failure because tmux may already have pasted', async () => {
    const { gateway, client, terminalIO } =
      await createAuthorizedPromptClient('prompt-delivery-error');
    (terminalIO.deliverImmediate as jest.Mock).mockRejectedValueOnce(new Error('paste uncertain'));
    const payload = promptPastePayload('prompt-delivery-error');

    const first = await gateway.handleInput(client, payload);
    const replay = await gateway.handleInput(client, payload);

    expect(first).toEqual({
      ok: false,
      code: 'DELIVERY_ERROR',
      requestId: payload.requestId,
    });
    expect(replay).toEqual(first);
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
  });

  // Module-unit: real events plus fake terminal I/O expose admission without a tmux daemon.
  it('prompt-paste to a dead tmux returns TMUX_UNAVAILABLE without activating', async () => {
    const { gateway, client, terminalIO, humanPromptState, eventEmitter } =
      await createAuthorizedPromptClient('prompt-barrier');
    const payload = promptPastePayload('prompt-barrier');
    (terminalIO.sessionExists as jest.Mock).mockClear().mockResolvedValue(false);
    const publish = jest.fn();
    eventEmitter.on(sessionHumanPromptStateChangedEvent.name, publish);

    await expect(gateway.handleInput(client, payload)).resolves.toEqual({
      ok: false,
      code: 'TMUX_UNAVAILABLE',
      requestId: payload.requestId,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(humanPromptState.getState('tmux_prompt-barrier').phase).toBe('inactive');
    expect(terminalIO.deliverImmediate).not.toHaveBeenCalled();
  });

  // Module-unit: real events plus fake terminal I/O expose admission without a tmux daemon.
  it('prompt-paste to a live tmux awaits promotion before writing', async () => {
    const { gateway, client, terminalIO, humanPromptState, eventEmitter } =
      await createAuthorizedPromptClient('prompt-barrier');
    const payload = promptPastePayload('prompt-barrier');
    (terminalIO.sessionExists as jest.Mock).mockClear().mockResolvedValue(true);
    let release!: () => void;
    let activated!: () => void;
    const started = new Promise<void>((resolve) => {
      activated = resolve;
    });
    const promotion = new Promise<void>((resolve) => {
      release = resolve;
    });
    eventEmitter.on(sessionHumanPromptStateChangedEvent.name, () => {
      activated();
      return promotion;
    });

    const result = gateway.handleInput(client, payload);
    await started;
    expect(terminalIO.sessionExists).toHaveBeenCalledTimes(1);
    expect(humanPromptState.getState('tmux_prompt-barrier').phase).toBe('draft_active');
    expect(terminalIO.deliverImmediate).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toEqual({ ok: true, code: 'OK', requestId: payload.requestId });
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
  });

  it('revalidates authority before replaying a completed request', async () => {
    const { gateway, client, terminalIO } =
      await createAuthorizedPromptClient('prompt-reauthorize');
    const payload = promptPastePayload('prompt-reauthorize');
    await gateway.handleInput(client, payload);

    const secondClient = createMockSocket('prompt-new-authority');
    gateway.handleConnection(secondClient);
    await gateway.handleSubscribe(secondClient, {
      sessionId: 'prompt-reauthorize',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(secondClient, { sessionId: 'prompt-reauthorize' });

    await expect(gateway.handleInput(client, payload)).resolves.toEqual({
      ok: false,
      code: 'NOT_AUTHORITY',
      requestId: payload.requestId,
    });
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);
  });

  it('returns typed failures for unknown, non-subscriber, and dead tmux sessions', async () => {
    const unknownSetup = createGateway({ autoCreateRegistrySessions: false });
    gatewaysToDestroy.push(unknownSetup.gateway);
    const unknownClient = createMockSocket('prompt-unknown');
    unknownSetup.gateway.handleConnection(unknownClient);
    const unknownPayload = promptPastePayload('missing-session');
    await expect(unknownSetup.gateway.handleInput(unknownClient, unknownPayload)).resolves.toEqual({
      ok: false,
      code: 'UNKNOWN_SESSION',
      requestId: unknownPayload.requestId,
    });

    unknownSetup.registry.create('prompt-unsubscribed', 'tmux_prompt-unsubscribed');
    const unsubscribedPayload = promptPastePayload('prompt-unsubscribed', 2);
    await expect(
      unknownSetup.gateway.handleInput(unknownClient, unsubscribedPayload),
    ).resolves.toEqual({
      ok: false,
      code: 'NOT_SUBSCRIBER',
      requestId: unsubscribedPayload.requestId,
    });

    const deadSetup = await createAuthorizedPromptClient('prompt-dead');
    (deadSetup.terminalIO.sessionExists as jest.Mock).mockResolvedValue(false);
    const deadPayload = promptPastePayload('prompt-dead', 3);
    await expect(deadSetup.gateway.handleInput(deadSetup.client, deadPayload)).resolves.toEqual({
      ok: false,
      code: 'TMUX_UNAVAILABLE',
      requestId: deadPayload.requestId,
    });
    expect(deadSetup.terminalIO.deliverImmediate).not.toHaveBeenCalled();
  });

  it('rejects queued new IDs at capacity without evicting completed outcomes', async () => {
    const { gateway, client, terminalIO } = await createAuthorizedPromptClient('prompt-capacity');
    let releaseExists!: (alive: boolean) => void;
    const exists = new Promise<boolean>((resolve) => {
      releaseExists = resolve;
    });
    (terminalIO.sessionExists as jest.Mock).mockReturnValue(exists);

    const pending = Array.from({ length: PROMPT_PASTE_MAX_REQUESTS_PER_SESSION }, (_, index) =>
      gateway.handleInput(client, promptPastePayload('prompt-capacity', index + 1)),
    );
    const overflow = promptPastePayload(
      'prompt-capacity',
      PROMPT_PASTE_MAX_REQUESTS_PER_SESSION + 1,
    );

    const overflowResult = gateway.handleInput(client, overflow);
    expect(terminalIO.deliverImmediate).not.toHaveBeenCalled();
    releaseExists(true);
    await expect(overflowResult).resolves.toEqual({
      ok: false,
      code: 'BUSY',
      requestId: overflow.requestId,
    });
    await Promise.all(pending);
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(
      PROMPT_PASTE_MAX_REQUESTS_PER_SESSION,
    );
  });

  it('retains tombstones across stop and restore, then releases capacity after expiry', async () => {
    const { gateway, client, terminalIO } = await createAuthorizedPromptClient('prompt-lifecycle');
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const original = promptPastePayload('prompt-lifecycle');

    await gateway.handleInput(client, original);
    gateway.handleSessionStopped({ sessionId: 'prompt-lifecycle' });
    gateway.handleSessionRestored({
      sessionId: 'prompt-lifecycle',
      epicId: null,
      agentId: 'agent',
      tmuxSessionName: 'tmux_prompt-lifecycle',
      providerName: 'provider',
    });
    gateway.handleFocus(client, { sessionId: 'prompt-lifecycle' });
    await expect(gateway.handleInput(client, original)).resolves.toEqual({
      ok: true,
      code: 'OK',
      requestId: original.requestId,
    });
    expect(terminalIO.deliverImmediate).toHaveBeenCalledTimes(1);

    const fill = Array.from({ length: PROMPT_PASTE_MAX_REQUESTS_PER_SESSION - 1 }, (_, index) =>
      gateway.handleInput(
        client,
        promptPastePayload('prompt-lifecycle', index + 2, `prompt-${index}`),
      ),
    );
    await Promise.all(fill);
    const overflow = promptPastePayload(
      'prompt-lifecycle',
      PROMPT_PASTE_MAX_REQUESTS_PER_SESSION + 1,
    );
    await expect(gateway.handleInput(client, overflow)).resolves.toMatchObject({
      ok: false,
      code: 'BUSY',
    });

    jest.advanceTimersByTime(PROMPT_PASTE_RETRY_WINDOW_MS + 1);
    await expect(gateway.handleInput(client, overflow)).resolves.toMatchObject({
      ok: true,
      code: 'OK',
    });
  });
});

describe('TerminalGateway.handleFocus subscription guard', () => {
  it('rejects focus from non-subscriber', () => {
    const { gateway, registry } = createGateway();
    const client = createMockSocket('unsub-focus');

    gateway.handleConnection(client as unknown as Socket);
    registry.create('focus-session', 'tmux_focus-session');

    gateway.handleFocus(client as unknown as Socket, { sessionId: 'focus-session' });

    const session = registry.get('focus-session')!;
    expect(session.getAuthority()).toBeNull();
  });

  it('grants focus for subscribed client', async () => {
    const { gateway, registry } = createGateway();
    const client = createMockSocket('sub-focus');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'focus-session-2',
      rows: 24,
      cols: 80,
    });

    gateway.handleFocus(client as unknown as Socket, { sessionId: 'focus-session-2' });

    const session = registry.get('focus-session-2')!;
    expect(session.getAuthority()).toBe('sub-focus');
  });

  it('stale focus from disconnected client is a no-op', async () => {
    const { gateway, registry } = createGateway();
    const client = createMockSocket('disc-client');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'disc-session',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'disc-session' });

    gateway.handleDisconnect(client as unknown as Socket);

    const staleClient = createMockSocket('disc-client');
    gateway.handleFocus(staleClient as unknown as Socket, { sessionId: 'disc-session' });

    const session = registry.get('disc-session')!;
    expect(session.getAuthority()).not.toBe('disc-client');
  });
});

describe('TerminalGateway.handleTheme', () => {
  const fg = '#c9d1d9';
  const bg = '#1a1a1a';

  it('applies theme to all sessions the client is subscribed to', async () => {
    const { gateway, terminalIO, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('sess-a', 'tmux_sess-a');
    registry.create('sess-b', 'tmux_sess-b');
    const client = createMockSocket('client-theme-multi');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'sess-a' });
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'sess-b' });

    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(terminalIO.applyWindowTheme).toHaveBeenCalledTimes(2);
    expect(terminalIO.applyWindowTheme).toHaveBeenCalledWith({ name: 'tmux_sess-a' }, fg, bg);
    expect(terminalIO.applyWindowTheme).toHaveBeenCalledWith({ name: 'tmux_sess-b' }, fg, bg);
  });

  it('does not apply theme to sessions the client is not subscribed to', async () => {
    const { gateway, terminalIO, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('subscribed-sess', 'tmux_subscribed-sess');
    registry.create('other-sess', 'tmux_other-sess');
    const client = createMockSocket('client-theme-unsub');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'subscribed-sess' });

    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(terminalIO.applyWindowTheme).toHaveBeenCalledTimes(1);
    expect(terminalIO.applyWindowTheme).toHaveBeenCalledWith(
      { name: 'tmux_subscribed-sess' },
      fg,
      bg,
    );
  });

  it('skips sessions that are not in the registry', async () => {
    const { gateway, terminalIO } = createGateway({ autoCreateRegistrySessions: false });
    const client = createMockSocket('client-theme-noreg');

    gateway.handleConnection(client as unknown as Socket);
    // Manually inject a subscription for a session that has no registry entry
    const cs = (
      gateway as unknown as { clientSessions: Map<string, { subscriptions: Set<string> }> }
    ).clientSessions.get('client-theme-noreg')!;
    cs.subscriptions.add('terminal/ghost-session');

    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(terminalIO.applyWindowTheme).not.toHaveBeenCalled();
  });

  it.each([
    { foregroundHex: 'red', backgroundHex: bg },
    { foregroundHex: fg, backgroundHex: 'rgb(0,0,0)' },
    { foregroundHex: '#fff', backgroundHex: bg },
  ])('rejects invalid theme %j', async (theme) => {
    const { gateway, terminalIO } = createGateway();
    const client = createMockSocket('invalid-theme-client');
    gateway.handleConnection(client);
    await expect(gateway.handleTheme(client, theme)).rejects.toThrow(WsException);
    expect(terminalIO.applyWindowTheme).not.toHaveBeenCalled();
  });

  it('skips apply and does not call terminalIO when style is unchanged (deduplication)', async () => {
    const { gateway, terminalIO, registry, ptyService, sessionTerminalRuntime } = createGateway({
      autoCreateRegistrySessions: false,
    });
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    registry.create('dedupe-sess', 'tmux_dedupe-sess');
    const client = createMockSocket('client-theme-dedupe');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'dedupe-sess' });

    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });
    expect(ptyService.triggerRedraw).toHaveBeenCalledWith('dedupe-sess');
    (ptyService.triggerRedraw as jest.Mock).mockClear();
    (terminalIO.applyWindowTheme as jest.Mock).mockClear();

    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(terminalIO.applyWindowTheme).not.toHaveBeenCalled();
    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('re-applies after a different style is set (cache update)', async () => {
    const { gateway, terminalIO, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('update-sess', 'tmux_update-sess');
    const client = createMockSocket('client-theme-update');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'update-sess' });

    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: '#1d2b3a',
      backgroundHex: '#eaeff5',
    });

    expect(terminalIO.applyWindowTheme).toHaveBeenCalledTimes(2);
  });

  it('clears theme cache for session on session.stopped', async () => {
    const { gateway, terminalIO, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('stopped-sess', 'tmux_stopped-sess');
    const client = createMockSocket('client-theme-stopped');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'stopped-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    gateway.handleSessionStopped({ sessionId: 'stopped-sess' });

    (terminalIO.applyWindowTheme as jest.Mock).mockClear();
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(terminalIO.applyWindowTheme).toHaveBeenCalledTimes(1);
  });

  it('clears theme cache and disposes terminal state on session.crashed', async () => {
    const { gateway, terminalIO, registry, sessionTerminalRuntime, ptyService } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('crashed-sess', 'tmux_crashed-sess');
    const client = createMockSocket('client-theme-crashed');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'crashed-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    gateway.handleSessionCrashed({ sessionId: 'crashed-sess', sessionName: 'tmux_crashed-sess' });

    // Crash cleanup: DB marked failed, streaming stopped, registry entry gone —
    // a stale entry here would block a later restore.
    expect(sessionTerminalRuntime.retireConfirmedLoss).toHaveBeenCalledWith(
      'crashed-sess',
      expect.any(String),
    );
    expect(ptyService.stopStreaming).toHaveBeenCalledWith('crashed-sess');
    expect(registry.get('crashed-sess')).toBeUndefined();

    // Theme cache cleared: once a restore re-creates the entry, the theme is re-applied.
    registry.create('crashed-sess', 'tmux_crashed-sess');
    (terminalIO.applyWindowTheme as jest.Mock).mockClear();
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(terminalIO.applyWindowTheme).toHaveBeenCalledTimes(1);
  });

  it('does not throw and does not disconnect client when tmux apply fails', async () => {
    const { gateway, terminalIO, registry, ptyService, sessionTerminalRuntime } = createGateway({
      autoCreateRegistrySessions: false,
    });
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    registry.create('fail-sess', 'tmux_fail-sess');
    (terminalIO.applyWindowTheme as jest.Mock).mockRejectedValueOnce(new Error('tmux gone'));
    const client = createMockSocket('client-theme-fail');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'fail-sess' });

    await expect(
      gateway.handleTheme(client as unknown as Socket, { foregroundHex: fg, backgroundHex: bg }),
    ).resolves.toBeUndefined();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('triggers redraw after successful theme application', async () => {
    const { gateway, ptyService, sessionTerminalRuntime, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('redraw-sess', 'tmux_redraw-sess');
    // Alt-screen providers (agy/opencode/copilot) keep the redraw jiggle — state intent
    // explicitly so the assertion can't pass vacuously under the non-alt-screen default.
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    const client = createMockSocket('client-redraw');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'redraw-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(ptyService.triggerRedraw).toHaveBeenCalledWith('redraw-sess');
  });

  it('non-alt-screen session: applies tmux window theme but never triggers the redraw jiggle', async () => {
    // The factory descriptor uses the non-alternate-screen policy by default —
    // this is the claude/codex default. The gate must skip ONLY the SIGWINCH jiggle; tmux
    // window style + the dedup cache keep working for every provider.
    const { gateway, terminalIO, ptyService, sessionTerminalRuntime, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('nonalt-sess', 'tmux_nonalt-sess');
    expect(sessionTerminalRuntime.getDescriptor?.('nonalt-sess').usesAlternateScreen).toBe(false);
    const client = createMockSocket('client-nonalt');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'nonalt-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    // Style is applied; the redraw jiggle is gated out.
    expect(terminalIO.applyWindowTheme).toHaveBeenCalledWith({ name: 'tmux_nonalt-sess' }, fg, bg);
    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });
});

describe('TerminalGateway viewport-mode restore (Task 2)', () => {
  it('triggers a redraw for an alt-screen session on terminal:restore_viewport_modes', async () => {
    const { gateway, ptyService, sessionTerminalRuntime, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('alt-sess', 'tmux_alt-sess');
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    const client = createMockSocket('client-alt');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'alt-sess' });
    (ptyService.triggerRedraw as jest.Mock).mockClear();

    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'alt-sess' });

    expect(ptyService.triggerRedraw).toHaveBeenCalledWith('alt-sess');
  });

  it('no-ops the redraw for a non-alt-screen provider from the runtime descriptor', async () => {
    const { gateway, ptyService, sessionTerminalRuntime, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('cli-sess', 'tmux_cli-sess');
    setUsesAlternateScreen(sessionTerminalRuntime, false);
    const client = createMockSocket('client-cli');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'cli-sess' });
    (ptyService.triggerRedraw as jest.Mock).mockClear();

    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'cli-sess' });

    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('ignores a restore request from a client not subscribed to that session', async () => {
    const { gateway, ptyService, sessionTerminalRuntime } = createGateway();
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    const client = createMockSocket('client-unsub');

    gateway.handleConnection(client as unknown as Socket);
    // No subscribe → not a subscriber of terminal/ghost-sess.
    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'ghost-sess' });

    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous restore requests into a single redraw', async () => {
    const { gateway, ptyService, sessionTerminalRuntime, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('coalesce-sess', 'tmux_coalesce-sess');
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    const client = createMockSocket('client-coalesce');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'coalesce-sess' });
    (ptyService.triggerRedraw as jest.Mock).mockClear();

    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'coalesce-sess' });
    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'coalesce-sess' });
    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'coalesce-sess' });

    expect(ptyService.triggerRedraw).toHaveBeenCalledTimes(1);
  });

  it('restores viewport modes server-side on a no-seed (reconnect) attach to an alt-screen session', async () => {
    const { gateway, ptyService, sessionTerminalRuntime, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('reconnect-sess', 'tmux_reconnect-sess');
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    const client = createMockSocket('client-reconnect');

    gateway.handleConnection(client as unknown as Socket);
    // A domain cursor (lastSequence + sequenceEpoch) → covered reconnect, not a first attach → no
    // client seed window, so the server restores viewport modes itself.
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'reconnect-sess',
      lastSequence: 5,
      sequenceEpoch: MOCK_SEQUENCE_EPOCH,
      rows: 24,
      cols: 80,
    });

    expect(ptyService.triggerRedraw).toHaveBeenCalledWith('reconnect-sess');
  });

  it('does NOT server-side redraw on a first (seeded) attach — the client requests it post-seed', async () => {
    const { gateway, ptyService, sessionTerminalRuntime, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('firstattach-sess', 'tmux_firstattach-sess');
    setUsesAlternateScreen(sessionTerminalRuntime, true);
    const client = createMockSocket('client-firstattach');

    gateway.handleConnection(client as unknown as Socket);
    // No lastSequence → first attach → seeded path; a redraw now would be discarded mid-seed.
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'firstattach-sess',
      rows: 24,
      cols: 80,
    });

    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });
});

describe('TerminalGateway input arrival order', () => {
  // Gateway unit tests control the awaits before pane admission, where keys can be reordered.
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function setup() {
    const context = createGateway({ autoCreateRegistrySessions: false });
    const client = createMockSocket('ordered-client');
    for (const id of ['ordered', 'independent']) {
      const session = context.registry.create(id, `tmux_${id}`);
      session.subscribe(client.id);
      session.claimAuthority(client.id);
    }
    return { ...context, client };
  }

  it('writes the first key first even when the second liveness result is ready sooner', async () => {
    const { gateway, client, terminalIO } = await setup();
    const firstAlive = deferred<boolean>();
    const secondAlive = deferred<boolean>();
    (terminalIO.sessionExists as jest.Mock)
      .mockReturnValueOnce(firstAlive.promise)
      .mockReturnValueOnce(secondAlive.promise);
    const first = gateway.handleInput(client, { sessionId: 'ordered', data: 'a', ttyMode: true });
    const second = gateway.handleInput(client, { sessionId: 'ordered', data: 'b', ttyMode: true });
    secondAlive.resolve(true);
    await Promise.resolve();
    expect(terminalIO.sessionExists).toHaveBeenCalledTimes(1);
    expect(terminalIO.sendControl).not.toHaveBeenCalled();
    firstAlive.resolve(true);
    await Promise.all([first, second]);
    expect((terminalIO.sendControl as jest.Mock).mock.calls.map((call) => call[1])).toEqual([
      ['-l', '--', 'a'],
      ['-l', '--', 'b'],
    ]);
    gateway.onModuleDestroy();
  });

  it('keeps Ctrl+C behind printable input waiting for prompt activation', async () => {
    const { gateway, client, terminalIO, eventEmitter } = await setup();
    const promotion = deferred<void>();
    const started = deferred<void>();
    eventEmitter.once(sessionHumanPromptStateChangedEvent.name, () => {
      started.resolve();
      return promotion.promise;
    });
    const first = gateway.handleInput(client, { sessionId: 'ordered', data: 'a', ttyMode: true });
    await started.promise;
    const second = gateway.handleInput(client, { sessionId: 'ordered', data: '\x03' });
    await Promise.resolve();
    expect(terminalIO.sendControl).not.toHaveBeenCalled();
    promotion.resolve();
    await Promise.all([first, second]);
    expect((terminalIO.sendControl as jest.Mock).mock.calls.map((call) => call[1])).toEqual([
      ['-l', '--', 'a'],
      ['C-c'],
    ]);
    gateway.onModuleDestroy();
  });

  it.each(['throw', 'reject'] as const)(
    'continues after a handler dependency can %s',
    async (failure) => {
      const { gateway, client, terminalIO } = await setup();
      (terminalIO.sessionExists as jest.Mock).mockImplementationOnce(() => {
        if (failure === 'throw') throw new Error('liveness failed');
        return Promise.reject(new Error('liveness failed'));
      });
      const first = gateway.handleInput(client, { sessionId: 'ordered', data: 'a', ttyMode: true });
      const second = gateway.handleInput(client, {
        sessionId: 'ordered',
        data: 'b',
        ttyMode: true,
      });
      await expect(first).rejects.toThrow('liveness failed');
      await second;
      expect(terminalIO.sendControl).toHaveBeenCalledTimes(1);
      expect(terminalIO.sendControl).toHaveBeenCalledWith({ name: 'tmux_ordered' }, [
        '-l',
        '--',
        'b',
      ]);
      gateway.onModuleDestroy();
    },
  );

  it('shares one order for typed input, prompt paste, and the following Enter', async () => {
    const { gateway, client, terminalIO } = await setup();
    const alive = deferred<boolean>();
    const paste = deferred<void>();
    const pasteStarted = deferred<void>();
    const writes: string[] = [];
    (terminalIO.sessionExists as jest.Mock).mockReturnValueOnce(alive.promise);
    (terminalIO.sendControl as jest.Mock).mockImplementation(async (_target, keys) => {
      writes.push(keys.at(-1));
    });
    (terminalIO.deliverImmediate as jest.Mock).mockImplementation(() => {
      writes.push('paste');
      pasteStarted.resolve();
      return paste.promise;
    });
    const first = gateway.handleInput(client, { sessionId: 'ordered', data: 'a', ttyMode: true });
    const second = gateway.handleInput(client, promptPastePayload('ordered'));
    const third = gateway.handleInput(client, { sessionId: 'ordered', data: '\r' });
    expect(writes).toEqual([]);
    alive.resolve(true);
    await pasteStarted.promise;
    expect(writes).toEqual(['a', 'paste']);
    paste.resolve();
    await Promise.all([first, second, third]);
    expect(writes).toEqual(['a', 'paste', 'Enter']);
    gateway.onModuleDestroy();
  });

  it('allows another session to finish while one session is blocked', async () => {
    const { gateway, client, terminalIO } = await setup();
    const alive = deferred<boolean>();
    (terminalIO.sessionExists as jest.Mock).mockReturnValueOnce(alive.promise);
    const blocked = gateway.handleInput(client, { sessionId: 'ordered', data: 'a', ttyMode: true });
    await gateway.handleInput(client, { sessionId: 'independent', data: 'b', ttyMode: true });
    expect(terminalIO.sendControl).toHaveBeenCalledTimes(1);
    expect(terminalIO.sendControl).toHaveBeenCalledWith({ name: 'tmux_independent' }, [
      '-l',
      '--',
      'b',
    ]);
    alive.resolve(true);
    await blocked;
    gateway.onModuleDestroy();
  });

  it('retires queued input when a session is removed and releases idle queues', async () => {
    const { gateway, client, terminalIO, registry } = await setup();
    const alive = deferred<boolean>();
    (terminalIO.sessionExists as jest.Mock).mockReturnValueOnce(alive.promise);
    const first = gateway.handleInput(client, { sessionId: 'ordered', data: 'a', ttyMode: true });
    const queued = gateway.handleInput(client, promptPastePayload('ordered'));
    gateway.endStandaloneTerminal('ordered', 'Ended');
    const queues = (gateway as unknown as { inputQueues: Map<string, unknown> }).inputQueues;
    expect(queues.size).toBe(0);
    const restored = registry.create('ordered', 'tmux_ordered');
    restored.subscribe(client.id);
    restored.claimAuthority(client.id);
    alive.resolve(true);
    await first;
    await expect(queued).resolves.toMatchObject({ ok: false, code: 'UNKNOWN_SESSION' });
    expect(terminalIO.deliverImmediate).not.toHaveBeenCalled();
    await gateway.handleInput(client, { sessionId: 'ordered', data: 'b', ttyMode: true });
    expect(queues.size).toBe(0);
    gateway.onModuleDestroy();
  });
});
