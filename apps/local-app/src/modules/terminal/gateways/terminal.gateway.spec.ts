import { TerminalGateway } from './terminal.gateway';
import { WsException } from '@nestjs/websockets';

import { TerminalStreamService } from '../services/terminal-stream.service';
import {
  SettingsService,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
} from '../../settings/services/settings.service';
import { PtyService } from '../services/pty.service';
import { TerminalSeedService } from '../services/terminal-seed.service';
import { ModuleRef } from '@nestjs/core';
import { createEnvelope } from '../dtos/ws-envelope.dto';
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
  };

  const seedService: Partial<TerminalSeedService> = {
    resolveSeedingConfig: jest.fn().mockReturnValue({
      maxBytes: options?.seedMaxBytes ?? DEFAULT_TERMINAL_SEED_MAX_BYTES,
    }),
    emitSeedToClient: jest.fn().mockResolvedValue(undefined),
    invalidateCache: jest.fn(),
  };

  const moduleRef = {} as ModuleRef;

  const gateway = new TerminalGateway(
    streamService as TerminalStreamService,
    settingsService as SettingsService,
    ptyService as PtyService,
    moduleRef,
    seedService as TerminalSeedService,
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
  } as unknown as typeof gateway.server;

  return {
    gateway,
    streamService,
    settingsService,
    ptyService,
    seedService,
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

describe('TerminalGateway.handleSubscribe', () => {
  it('emits seed snapshot on first attach using tmux-first seeding', async () => {
    const { gateway, seedService, ptyService } = createGateway({
      snapshot: 'ansi-seed',
      bufferedFrames: [],
    });
    const client = createMockSocket('client-1');

    gateway.handleConnection(client as unknown as Socket);

    await gateway.handleSubscribe(client as unknown as Socket, {
      sessionId: 'session-1',
      rows: 30,
      cols: 120,
    });

    // Seeding always happens via seedService (tmux-first with emulator fallback)
    expect(seedService.resolveSeedingConfig).toHaveBeenCalled();
    expect(seedService.emitSeedToClient).toHaveBeenCalled();
    expect(ptyService.resize).toHaveBeenCalledWith('session-1', 120, 30);

    const confirmCall = (client.emit as jest.Mock).mock.calls.find(
      ([event, envelope]) =>
        event === 'message' && (envelope as { type?: string }).type === 'subscribed',
    );
    expect(confirmCall).toBeTruthy();
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
