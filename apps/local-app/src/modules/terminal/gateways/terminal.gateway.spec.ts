import { TerminalGateway } from './terminal.gateway';
import { WsException } from '@nestjs/websockets';

import { TerminalStreamService } from '../services/terminal-stream.service';
import {
  SettingsService,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
} from '../../settings/services/settings.service';
import { PtyService } from '../services/pty.service';
import { TerminalSeedService } from '../services/terminal-seed.service';
import { TerminalIOService } from '../services/terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from '../services/terminal-session/terminal-session-registry';
import { createEnvelope } from '../dtos/ws-envelope.dto';
import { SessionsService } from '../../sessions/services/sessions.service';
import type { Socket } from 'socket.io';

function createMockSocket(
  id: string,
): Socket & { trigger: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  const base = {
    id,
    emit: jest.fn(),
    join: jest.fn(),
    disconnect: jest.fn(),
    connected: true,
    conn: {
      transport: {
        name: 'websocket',
      },
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
  scrollbackLines?: number;
  autoCreateRegistrySessions?: boolean;
}) => {
  const streamService: Partial<TerminalStreamService> = {
    initializeBuffer: jest.fn(),
    getFramesSince: jest.fn().mockReturnValue(options?.bufferedFrames ?? []),
    getCurrentSequence: jest.fn().mockReturnValue(7),
    addFrame: jest.fn(),
  };

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
    emitSeedToClient: jest.fn().mockResolvedValue(undefined),
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
  const gateway = new TerminalGateway(
    streamService as TerminalStreamService,
    settingsService as SettingsService,
    ptyService as PtyService,
    seedService as TerminalSeedService,
    terminalIO as TerminalIOService,
    registry,
    sessionsService as SessionsService,
    mockRealtimeBroadcast as never,
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
  it('SeedStrategy drives seeding on first attach — no legacy emitSeedToClient for registry sessions', async () => {
    const { gateway, seedService, ptyService, registry } = createGateway({
      bufferedFrames: [],
    });
    const client = createMockSocket('client-1');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-1',
      rows: 30,
      cols: 120,
    });

    expect(seedService.emitSeedToClient).not.toHaveBeenCalled();
    expect(ptyService.resize).toHaveBeenCalledWith('session-1', 120, 30);

    const session = registry.get('session-1')!;
    expect(session.hasSubscriber('client-1')).toBe(true);
  });

  it('forwards seed_ansi from TerminalSession frame stream to socket room (integration)', async () => {
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

    expect(roomEmit).toHaveBeenCalledWith(
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
      type: 'seed_ansi',
      sessionId: 'session-restore',
      payload: { data: 'old seed', chunk: 0, totalChunks: 1 },
    });
    newSession.stream.emit('frame', {
      type: 'seed_ansi',
      sessionId: 'session-restore',
      payload: { data: 'new seed', chunk: 0, totalChunks: 1 },
    });

    const seedCalls = roomEmit.mock.calls.filter(
      ([, envelope]: [string, { type?: string; payload?: { data?: string } }]) =>
        envelope?.type === 'seed_ansi',
    );
    expect(seedCalls).toHaveLength(1);
    expect(seedCalls[0][1]).toEqual(
      expect.objectContaining({
        type: 'seed_ansi',
        payload: expect.objectContaining({ data: 'new seed' }),
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
      type: 'seed_ansi',
      sessionId: 'session-stopped-unwire',
      payload: { data: 'late seed', chunk: 0, totalChunks: 1 },
    });

    expect(roomEmit).not.toHaveBeenCalledWith(
      'message',
      expect.objectContaining({ type: 'seed_ansi' }),
    );
  });

  it('does not duplicate frame forwarding for multiple subscribers on the same session', async () => {
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
      type: 'seed_ansi',
      sessionId: 'session-multi',
      payload: { data: 'one seed', chunk: 0, totalChunks: 1 },
    });

    const seedCalls = roomEmit.mock.calls.filter(
      ([, envelope]: [string, { type?: string }]) => envelope?.type === 'seed_ansi',
    );
    expect(seedCalls).toHaveLength(1);
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
      payload: { reason: 'option_a_seed' },
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
    });

    // On reconnection, no seeding should happen
    expect(seedService.emitSeedToClient).not.toHaveBeenCalled();
    expect(streamService.getFramesSince).toHaveBeenCalledWith('session-3', 42);
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

describe('TerminalGateway activity routing (R3)', () => {
  it('broadcastTerminalData routes data through session.pushFrame (activity tracking)', () => {
    const { gateway, registry } = createGateway();
    const session = registry.get('session-activity')!;
    const pushSpy = jest.spyOn(session, 'pushFrame');

    gateway.broadcastTerminalData('session-activity', 'terminal output');

    expect(pushSpy).toHaveBeenCalledWith('terminal output');
    const state = session.getActivityState();
    expect(state.lastDataAt).toBeGreaterThan(0);
    expect(state.busySince).not.toBeNull();
  });

  it('broadcastTerminalData still emits to socket room when session exists', () => {
    const { gateway, roomEmit } = createGateway();

    gateway.broadcastTerminalData('session-emit', 'data chunk');

    expect(roomEmit).toHaveBeenCalled();
  });

  it('broadcastTerminalData works without registry entry (fallback)', () => {
    const { gateway, registry, roomEmit } = createGateway();
    registry.get = () => undefined;

    expect(() => gateway.broadcastTerminalData('no-session', 'data')).not.toThrow();
    expect(roomEmit).toHaveBeenCalled();
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

  it('wire contract preserved: one data envelope per broadcastTerminalData call', () => {
    const { gateway, roomEmit } = createGateway();

    gateway.broadcastTerminalData('session-wire', 'chunk-1');
    gateway.broadcastTerminalData('session-wire', 'chunk-2');

    const dataCalls = (roomEmit as jest.Mock).mock.calls;
    expect(dataCalls).toHaveLength(2);
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

  it('clears theme cache for session on session.crashed', async () => {
    const { gateway, terminalIO, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('crashed-sess', 'tmux_crashed-sess');
    const client = createMockSocket('client-theme-crashed');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'crashed-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    gateway.handleSessionCrashed({ sessionId: 'crashed-sess', sessionName: 'tmux_crashed-sess' });

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
    const { gateway, ptyService, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('redraw-sess', 'tmux_redraw-sess');
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
    const { gateway, ptyService, registry } = createGateway({ autoCreateRegistrySessions: false });
    registry.create('nodedup-sess', 'tmux_nodedup-sess');
    const client = createMockSocket('client-nodedup');

    gateway.handleConnection(client as unknown as Socket);
    await gateway.handleSubscribe(client as unknown as Socket, { sessionId: 'nodedup-sess' });
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    (ptyService.triggerRedraw as jest.Mock).mockClear();

    // Second call with same colors — skipped by cache, no redraw
    await gateway.handleTheme(client as unknown as Socket, {
      foregroundHex: fg,
      backgroundHex: bg,
    });

    expect(ptyService.triggerRedraw).not.toHaveBeenCalled();
  });

  it('does not trigger redraw when applyWindowTheme fails', async () => {
    const { gateway, terminalIO, ptyService, registry } = createGateway({
      autoCreateRegistrySessions: false,
    });
    registry.create('failredraw-sess', 'tmux_failredraw-sess');
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
});
