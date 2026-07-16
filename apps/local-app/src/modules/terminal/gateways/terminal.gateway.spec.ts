import { TerminalGateway } from './terminal.gateway';
import { WsException } from '@nestjs/websockets';

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
import { SessionsService } from '../../sessions/services/sessions.service';
import type { Socket } from 'socket.io';
import { TerminalViewportFacade } from '../services/terminal-viewport/terminal-viewport.facade';
import {
  TerminalSendAdmission,
  TerminalSendSchedulerService,
} from '../services/terminal-send-scheduler.service';
import { TerminalSocketDrainAdapter } from '../services/terminal-socket-drain.adapter';

/** The stable sequence-domain epoch the mock stream service reports for every session. */
const MOCK_SEQUENCE_EPOCH = 'epoch-1';

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

  const sessionsService: Partial<SessionsService> = {
    markSessionFailed: jest.fn(),
    shouldNormalizeLfFor: jest.fn().mockReturnValue(true),
    usesAlternateScreenFor: jest.fn().mockReturnValue(false),
  };

  const registry = new TerminalSessionRegistry();
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
  const gateway = new TerminalGateway(
    streamService as TerminalStreamService,
    settingsService as SettingsService,
    ptyService as PtyService,
    seedService as TerminalSeedService,
    terminalIO as TerminalIOService,
    registry,
    sessionsService as SessionsService,
    mockRealtimeBroadcast as never,
    options?.sendScheduler ?? (sendScheduler as never),
    mockMetricsService,
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
    sessionsService,
    registry,
    roomEmit,
    sendScheduler,
  };
};

describe('TerminalGateway.handleRequestFullHistory', () => {
  it('accepts maxLines larger than scrollback (clamping happens internally)', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-clamp');

    // Set scrollback to 5000
    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(5000);

    gateway.handleConnection(client as unknown as Socket);

    // Subscribe first to pass the subscription check
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-clamp',
      rows: 24,
      cols: 80,
    });

    // Request 50000 lines (more than scrollback allows) - should not throw
    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-clamp',
        maxLines: 50000,
      }),
    ).resolves.not.toThrow();

    // Verify client received a full_history response (empty or not)
    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
  });

  it('accepts maxLines within scrollback limit', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-no-clamp');

    // Set scrollback to 10000
    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-no-clamp',
      rows: 24,
      cols: 80,
    });

    // Request 5000 lines (less than scrollback) - should not throw
    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-no-clamp',
        maxLines: 5000,
      }),
    ).resolves.not.toThrow();

    // Verify client received a full_history response
    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
  });

  it('throws WsException for maxLines: 0', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-zero');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);
    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-zero',
      rows: 24,
      cols: 80,
    });

    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-zero',
        maxLines: 0,
      }),
    ).rejects.toThrow(WsException);
  });

  it('throws WsException for maxLines: -1', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-negative');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);
    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-negative',
      rows: 24,
      cols: 80,
    });

    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-negative',
        maxLines: -1,
      }),
    ).rejects.toThrow(WsException);
  });

  it('throws WsException for non-numeric maxLines string', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-string');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);
    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-string',
      rows: 24,
      cols: 80,
    });

    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-string',
        maxLines: 'abc' as unknown as number,
      }),
    ).rejects.toThrow(WsException);
  });

  it('coerces float maxLines to integer', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-float');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-float',
      rows: 24,
      cols: 80,
    });

    // 3.7 should be coerced to 3 - should not throw
    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-float',
        maxLines: 3.7,
      }),
    ).resolves.not.toThrow();

    // Verify client received a full_history response
    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
  });

  it('uses default when maxLines is undefined', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-undefined');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-undefined',
      rows: 24,
      cols: 80,
    });

    // No maxLines provided - should use default, not throw
    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-undefined',
      }),
    ).resolves.not.toThrow();

    // Verify client received a full_history response
    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
  });

  it('uses default when maxLines is null', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-null');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-null',
      rows: 24,
      cols: 80,
    });

    // Null maxLines - should use default, not throw
    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-null',
        maxLines: null as unknown as number,
      }),
    ).resolves.not.toThrow();

    // Verify client received a full_history response
    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
  });

  it('accepts valid positive integer', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-valid');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-valid',
      rows: 24,
      cols: 80,
    });

    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-valid',
        maxLines: 100,
      }),
    ).resolves.not.toThrow();

    // Verify client received a full_history response
    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
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

  it('coerces numeric string maxLines to integer', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-string-num');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-string-num',
      rows: 24,
      cols: 80,
    });

    // "100" (string) should be coerced to 100 (number) - should not throw
    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-string-num',
        maxLines: '100' as unknown as number,
      }),
    ).resolves.not.toThrow();

    // Verify client received a full_history response
    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
  });

  it('coerces float string maxLines to floored integer', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-float-string');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-float-string',
      rows: 24,
      cols: 80,
    });

    // "100.7" (string) should be coerced to 100 (floored) - should not throw
    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-float-string',
        maxLines: '100.7' as unknown as number,
      }),
    ).resolves.not.toThrow();

    // Verify client received a full_history response
    const historyCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'full_history',
    );
    expect(historyCall).toBeTruthy();
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

  it('uses shared maxBytes setting from resolveSeedingConfig (same as seeding)', async () => {
    // P1: Verify full-history uses the same maxBytes config as terminal seeding
    const customMaxBytes = 512 * 1024; // 512KB
    const { gateway, seedService, settingsService } = createGateway({
      seedMaxBytes: customMaxBytes,
    });
    const client = createMockSocket('client-shared-maxbytes');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-shared-maxbytes',
      rows: 24,
      cols: 80,
    });

    await gateway.handleRequestFullHistory(client as unknown as Socket, {
      sessionId: 'session-shared-maxbytes',
      maxLines: 1000,
    });

    // Verify resolveSeedingConfig was called to get the shared maxBytes
    expect(seedService.resolveSeedingConfig).toHaveBeenCalled();
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

  it('throws WsException for a non-string correlationId', async () => {
    const { gateway, settingsService } = createGateway();
    const client = createMockSocket('client-bad-correlate');

    (settingsService.getScrollbackLines as jest.Mock).mockReturnValue(10000);
    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-bad-correlate',
      rows: 24,
      cols: 80,
    });

    await expect(
      gateway.handleRequestFullHistory(client as unknown as Socket, {
        sessionId: 'session-bad-correlate',
        maxLines: 1000,
        correlationId: 123 as unknown as string,
      }),
    ).rejects.toThrow(WsException);
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

  const findSubscribed = (client: { emit: jest.Mock }) =>
    (client.emit as jest.Mock).mock.calls
      .filter(([event]) => event === 'message')
      .map(([, envelope]) => envelope)
      .find((envelope) => (envelope as { type?: string }).type === 'subscribed') as
      | { payload: Record<string, unknown> }
      | undefined;

  it('publishes historyRefreshable=true for a line-oriented provider on the subscribed ack', async () => {
    const { gateway, sessionsService } = createGateway();
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(false);
    const client = createMockSocket('client-refreshable');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-refreshable',
      rows: 24,
      cols: 80,
    });

    expect(findSubscribed(client)?.payload).toMatchObject({
      replayStatus: 'seed',
      historyRefreshable: true,
    });
  });

  it('publishes historyRefreshable=false for an alternate-screen provider on the subscribed ack', async () => {
    const { gateway, sessionsService } = createGateway();
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
    const client = createMockSocket('client-altscreen');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-altscreen',
      rows: 24,
      cols: 80,
    });

    expect(findSubscribed(client)?.payload).toMatchObject({ historyRefreshable: false });
  });

  it('publishes historyRefreshable on the fallback (no-registry) subscribed ack', async () => {
    const { gateway, sessionsService, registry } = createGateway();
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
    registry.get = () => undefined;
    const client = createMockSocket('client-fallback-cap');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-fallback-cap',
      rows: 24,
      cols: 80,
    });

    expect(findSubscribed(client)?.payload).toMatchObject({ historyRefreshable: false });
  });

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
    const { gateway, seedService, registry } = createGateway();
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
        payload: expect.objectContaining({ replayStatus: 'seed' }),
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
    const { gateway, registry } = createGateway();
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

  it('heartbeat timeout sweeps authority through the same release helper', async () => {
    jest.useFakeTimers();
    try {
      const { gateway, registry } = createGateway();
      const client = createMockSocket('client-hb');

      gateway.handleConnection(client as unknown as Socket);
      // Dimensionless subscribe → no 50ms latch settle to advance past; subscribe() still grants
      // first-subscriber authority.
      await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'hb-sess' });
      const session = registry.get('hb-sess')!;
      expect(session.getAuthority()).toBe('client-hb');

      gateway.afterInit(); // starts the heartbeat interval
      // Two interval ticks (30s each) → elapsed since lastHeartbeat exceeds HEARTBEAT_TIMEOUT (45s).
      jest.advanceTimersByTime(60_001);

      expect(session.getAuthority()).toBeNull();
      expect(
        (gateway as unknown as { clientSessions: Map<string, unknown> }).clientSessions.has(
          'client-hb',
        ),
      ).toBe(false);
    } finally {
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

  it('passes one ordered data envelope per broadcast call to the socket scheduler', () => {
    const { gateway, registry, sendScheduler } = createGateway();
    const client = createMockSocket('web-viewer');
    gateway.handleConnection(client);
    const tracked = (
      gateway as unknown as { clientSessions: Map<string, { subscriptions: Set<string> }> }
    ).clientSessions.get(client.id)!;
    tracked.subscriptions.add('terminal/session-wire');
    registry.get('session-wire')!.subscribe(client.id);

    gateway.broadcastTerminalData('session-wire', 'chunk-1');
    gateway.broadcastTerminalData('session-wire', 'chunk-2');

    const dataCalls = (sendScheduler.enqueueLive as jest.Mock).mock.calls;
    expect(dataCalls).toHaveLength(2);
  });

  it('broadcasts every ordered chunk returned by the replay stream', () => {
    const { gateway, streamService, registry, sendScheduler } = createGateway();
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
  });

  it('forces one targeted seed on the first reconnect after gated output', async () => {
    const { gateway, registry, streamService, seedService } = createGateway({
      replayResult: {
        status: 'gap',
        currentSequence: 8,
        discontinuitySequence: 8,
      },
    });
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
  it('subscribe: emits state_change(crashed) and marks session failed when tmux is dead', async () => {
    const { gateway, terminalIO, sessionsService, ptyService } = createGateway();
    (terminalIO.sessionExists as jest.Mock).mockResolvedValue(false);

    const client = createMockSocket('client-dead-subscribe');
    gateway.handleConnection(client);

    await gateway.handleSubscribe(client, { sessionId: 'dead-session' });

    expect(sessionsService.markSessionFailed).toHaveBeenCalledWith(
      'dead-session',
      expect.any(String),
    );
    expect(ptyService.stopStreaming).toHaveBeenCalledWith('dead-session');

    const emitted = (client.emit as jest.Mock).mock.calls
      .filter(([event]: [string]) => event === 'message')
      .map(([, envelope]: [string, { type?: string; payload?: unknown }]) => envelope);
    const stateChange = emitted.find((e) => e.type === 'state_change');
    expect(stateChange).toBeDefined();
    expect((stateChange!.payload as { status: string; sessionId: string }).status).toBe('crashed');
    expect((stateChange!.payload as { status: string; sessionId: string }).sessionId).toBe(
      'dead-session',
    );
  });

  it('subscribe: does not mark failed when tmux is alive', async () => {
    const { gateway, terminalIO, sessionsService } = createGateway();
    (terminalIO.sessionExists as jest.Mock).mockResolvedValue(true);

    const client = createMockSocket('client-alive-subscribe');
    gateway.handleConnection(client);

    await gateway.handleSubscribe(client, { sessionId: 'alive-session' });

    expect(sessionsService.markSessionFailed).not.toHaveBeenCalled();
  });

  it('resize: emits state_change(crashed) when tmux is dead', async () => {
    const { gateway, terminalIO, sessionsService } = createGateway();
    (terminalIO.sessionExists as jest.Mock).mockResolvedValue(false);

    const client = createMockSocket('client-dead-resize');
    gateway.handleConnection(client);

    await gateway.handleResize(client, { sessionId: 'dead-resize', rows: 24, cols: 80 });

    expect(sessionsService.markSessionFailed).toHaveBeenCalledWith(
      'dead-resize',
      expect.any(String),
    );
    const emitted = (client.emit as jest.Mock).mock.calls
      .filter(([event]: [string]) => event === 'message')
      .map(([, envelope]: [string, { type?: string; payload?: unknown }]) => envelope);
    const stateChange = emitted.find((e) => e.type === 'state_change');
    expect(stateChange).toBeDefined();
    expect((stateChange!.payload as { status: string }).status).toBe('crashed');
  });

  it('input: emits state_change(crashed) when tmux is dead', async () => {
    const { gateway, terminalIO, sessionsService } = createGateway();

    const client = createMockSocket('client-dead-input');
    gateway.handleConnection(client);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'dead-input',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(client as unknown as Socket, { sessionId: 'dead-input' });

    (terminalIO.sessionExists as jest.Mock).mockResolvedValue(false);

    await gateway.handleInput(client, { sessionId: 'dead-input', data: 'x' });

    expect(sessionsService.markSessionFailed).toHaveBeenCalledWith(
      'dead-input',
      expect.any(String),
    );
    const emitted = (client.emit as jest.Mock).mock.calls
      .filter(([event]: [string]) => event === 'message')
      .map(([, envelope]: [string, { type?: string; payload?: unknown }]) => envelope);
    const stateChange = emitted.find((e) => e.type === 'state_change');
    expect(stateChange).toBeDefined();
    expect((stateChange!.payload as { status: string }).status).toBe('crashed');
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
      let lateDeliver!: (envelope: ReturnType<typeof createEnvelope>) => TerminalSeedDelivery;
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

    expect(terminalIO.deliverImmediate).toHaveBeenCalled();
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

  it('rejects control key input from subscriber without authority', async () => {
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
      data: '\r',
    });

    expect(terminalIO.sendControl).not.toHaveBeenCalled();
  });

  it('rejects non-control input from subscriber without authority', async () => {
    const { gateway, terminalIO } = createGateway();
    const authorityClient = createMockSocket('client-a2');
    const secondClient = createMockSocket('client-b2');

    gateway.handleConnection(authorityClient as unknown as Socket);
    gateway.handleConnection(secondClient as unknown as Socket);

    await gateway.handleSubscribe(authorityClient as unknown as Socket, {
      sessionId: 'shared-session-2',
      rows: 24,
      cols: 80,
    });
    gateway.handleFocus(authorityClient as unknown as Socket, { sessionId: 'shared-session-2' });

    await gateway.handleSubscribe(secondClient as unknown as Socket, {
      sessionId: 'shared-session-2',
      rows: 24,
      cols: 80,
    });

    await gateway.handleInput(secondClient as unknown as Socket, {
      sessionId: 'shared-session-2',
      data: 'x',
    });

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

  it('throws WsException for invalid foregroundHex', async () => {
    const { gateway } = createGateway();
    const client = createMockSocket('client-theme-invalid-fg');
    gateway.handleConnection(client as unknown as Socket);

    await expect(
      gateway.handleTheme(client as unknown as Socket, { foregroundHex: 'red', backgroundHex: bg }),
    ).rejects.toThrow(WsException);
  });

  it('throws WsException for invalid backgroundHex', async () => {
    const { gateway } = createGateway();
    const client = createMockSocket('client-theme-invalid-bg');
    gateway.handleConnection(client as unknown as Socket);

    await expect(
      gateway.handleTheme(client as unknown as Socket, {
        foregroundHex: fg,
        backgroundHex: 'rgb(0,0,0)',
      }),
    ).rejects.toThrow(WsException);
  });

  it('throws WsException for 3-digit shorthand hex', async () => {
    const { gateway } = createGateway();
    const client = createMockSocket('client-theme-shorthand');
    gateway.handleConnection(client as unknown as Socket);

    await expect(
      gateway.handleTheme(client as unknown as Socket, {
        foregroundHex: '#fff',
        backgroundHex: bg,
      }),
    ).rejects.toThrow(WsException);
  });

  it('skips apply and does not call terminalIO when style is unchanged (deduplication)', async () => {
    const { gateway, terminalIO, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('dedupe-sess', 'tmux_dedupe-sess');
    const client = createMockSocket('client-theme-dedupe');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'dedupe-sess' });

    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });
    (terminalIO.applyWindowTheme as jest.Mock).mockClear();

    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(terminalIO.applyWindowTheme).not.toHaveBeenCalled();
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
    const { gateway, terminalIO, registry, sessionsService, ptyService } = createGateway({
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
    expect(sessionsService.markSessionFailed).toHaveBeenCalledWith(
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
    const { gateway, terminalIO, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('fail-sess', 'tmux_fail-sess');
    (terminalIO.applyWindowTheme as jest.Mock).mockRejectedValueOnce(new Error('tmux gone'));
    const client = createMockSocket('client-theme-fail');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'fail-sess' });

    await expect(
      gateway.handleTheme(client as unknown as Socket, { foregroundHex: fg, backgroundHex: bg }),
    ).resolves.toBeUndefined();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('triggers redraw after successful theme application', async () => {
    const { gateway, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('redraw-sess', 'tmux_redraw-sess');
    // Alt-screen providers (agy/opencode/copilot) keep the redraw jiggle — state intent
    // explicitly so the assertion can't pass vacuously under the non-alt-screen default.
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
    const client = createMockSocket('client-redraw');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'redraw-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(ptyService.triggerRedraw).toHaveBeenCalledWith('redraw-sess');
  });

  it('does not trigger redraw when theme is unchanged (skipped by dedup cache)', async () => {
    const { gateway, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('nodedup-sess', 'tmux_nodedup-sess');
    // Alt-screen true: the FIRST apply provably redraws, so the SECOND call's no-redraw is
    // genuinely the dedup cache — not the non-alt-screen gate passing vacuously.
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
    const client = createMockSocket('client-nodedup');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'nodedup-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });
    expect(ptyService.triggerRedraw).toHaveBeenCalledWith('nodedup-sess');

    (ptyService.triggerRedraw as jest.Mock).mockClear();

    // Second call with same colors — skipped by cache, no redraw
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('does not trigger redraw when applyWindowTheme fails', async () => {
    const { gateway, terminalIO, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('failredraw-sess', 'tmux_failredraw-sess');
    // Alt-screen true so the apply FAILURE (not the non-alt-screen gate) is what suppresses
    // the redraw — without this the assertion passes vacuously.
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
    (terminalIO.applyWindowTheme as jest.Mock).mockRejectedValueOnce(new Error('gone'));
    const client = createMockSocket('client-failredraw');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'failredraw-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('non-alt-screen session: applies tmux window theme but never triggers the redraw jiggle', async () => {
    // The factory stubs usesAlternateScreenFor to a constant false (spec fixture policy) —
    // this is the claude/codex default. The gate must skip ONLY the SIGWINCH jiggle; tmux
    // window style + the dedup cache keep working for every provider.
    const { gateway, terminalIO, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('nonalt-sess', 'tmux_nonalt-sess');
    expect((sessionsService.usesAlternateScreenFor as jest.Mock)()).toBe(false);
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
    const { gateway, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('alt-sess', 'tmux_alt-sess');
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
    const client = createMockSocket('client-alt');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'alt-sess' });
    (ptyService.triggerRedraw as jest.Mock).mockClear();

    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'alt-sess' });

    expect(ptyService.triggerRedraw).toHaveBeenCalledWith('alt-sess');
  });

  it('no-ops the redraw for a non-alt-screen provider (gated on usesAlternateScreenFor)', async () => {
    const { gateway, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('cli-sess', 'tmux_cli-sess');
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(false);
    const client = createMockSocket('client-cli');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'cli-sess' });
    (ptyService.triggerRedraw as jest.Mock).mockClear();

    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'cli-sess' });

    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('ignores a restore request from a client not subscribed to that session', async () => {
    const { gateway, ptyService, sessionsService } = createGateway();
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
    const client = createMockSocket('client-unsub');

    gateway.handleConnection(client as unknown as Socket);
    // No subscribe → not a subscriber of terminal/ghost-sess.
    gateway.handleRestoreViewportModes(client as unknown as Socket, { sessionId: 'ghost-sess' });

    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous restore requests into a single redraw', async () => {
    const { gateway, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('coalesce-sess', 'tmux_coalesce-sess');
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
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
    const { gateway, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('reconnect-sess', 'tmux_reconnect-sess');
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
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
    const { gateway, ptyService, sessionsService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('firstattach-sess', 'tmux_firstattach-sess');
    (sessionsService.usesAlternateScreenFor as jest.Mock).mockReturnValue(true);
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
