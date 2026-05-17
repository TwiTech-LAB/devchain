const mockWarn = jest.fn();

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: mockWarn,
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  }),
}));

import { TerminalGateway } from './terminal.gateway';
import { TerminalStreamService } from '../services/terminal-stream.service';
import { SettingsService } from '../../settings/services/settings.service';
import { PtyService } from '../services/pty.service';
import { TerminalSeedService } from '../services/terminal-seed.service';
import { TerminalIOService } from '../services/terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from '../services/terminal-session/terminal-session-registry';
import { SessionsService } from '../../sessions/services/sessions.service';
import type { Socket } from 'socket.io';

function createMockSocket(id: string): Socket {
  return {
    id,
    emit: jest.fn(),
    join: jest.fn(),
    connected: true,
    conn: { transport: { name: 'websocket' } },
    on: jest.fn().mockReturnThis(),
    off: jest.fn().mockReturnThis(),
  } as unknown as Socket;
}

function createGateway() {
  const streamService: Partial<TerminalStreamService> = {
    initializeBuffer: jest.fn(),
    getFramesSince: jest.fn().mockReturnValue([]),
    getCurrentSequence: jest.fn().mockReturnValue(0),
    addFrame: jest.fn(),
  };

  const settingsService: Partial<SettingsService> = {
    getSetting: jest.fn().mockReturnValue(undefined),
    getScrollbackLines: jest.fn().mockReturnValue(10000),
  };

  const ptyService: Partial<PtyService> = {
    resize: jest.fn(),
    startStreaming: jest.fn(),
    isStreaming: jest.fn().mockReturnValue(true),
    stopStreaming: jest.fn(),
  };

  const seedService: Partial<TerminalSeedService> = {
    resolveSeedingConfig: jest.fn().mockReturnValue({ maxBytes: 4194304 }),
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
  };

  const sessionsService: Partial<SessionsService> = {
    markSessionFailed: jest.fn(),
  };

  const registry = new TerminalSessionRegistry();
  const originalGet = registry.get.bind(registry);
  registry.get = (sessionId: string) => {
    let session = originalGet(sessionId);
    if (!session) {
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

  gateway.server = {
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    sockets: { adapter: { rooms: new Map() }, sockets: new Map() },
    emit: jest.fn(),
  } as unknown as typeof gateway.server;

  return { gateway, registry };
}

async function setupAuthorizedClient(
  gateway: TerminalGateway,
  clientId: string,
  sessionId: string,
) {
  const client = createMockSocket(clientId);
  gateway.handleConnection(client);
  await gateway.handleSubscribe(client, { sessionId, rows: 24, cols: 80 });
  gateway.handleFocus(client, { sessionId });
  return client;
}

describe('TerminalGateway input-rate telemetry', () => {
  let nowValue: number;
  const originalDateNow = Date.now;

  beforeEach(() => {
    mockWarn.mockClear();
    nowValue = 1000;
    Date.now = () => nowValue;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  it('does NOT log warn for input under threshold', async () => {
    const { gateway } = createGateway();
    const client = await setupAuthorizedClient(gateway, 'client-slow', 'session-slow');

    // Send 50 messages over 5 seconds (10/sec — well under 100/sec threshold)
    for (let i = 0; i < 50; i++) {
      await gateway.handleInput(client, { sessionId: 'session-slow', data: 'x' });
      nowValue += 100;
    }

    // Advance past window
    nowValue += 5000;

    // Trigger window check
    await gateway.handleInput(client, { sessionId: 'session-slow', data: 'x' });

    const rateWarns = mockWarn.mock.calls.filter(
      (args) => typeof args[1] === 'string' && args[1].includes('Input rate threshold'),
    );
    expect(rateWarns).toHaveLength(0);
  });

  it('logs warn when message rate exceeds threshold over 5s window', async () => {
    const { gateway } = createGateway();
    const client = await setupAuthorizedClient(gateway, 'client-fast', 'session-fast');

    // Send 600 messages at same timestamp (simulates burst)
    for (let i = 0; i < 600; i++) {
      await gateway.handleInput(client, { sessionId: 'session-fast', data: 'x' });
    }

    // Advance past the 5-second window
    nowValue += 5100;

    // Next message triggers the window check
    await gateway.handleInput(client, { sessionId: 'session-fast', data: 'x' });

    const rateWarns = mockWarn.mock.calls.filter(
      (args) => typeof args[1] === 'string' && args[1].includes('Input rate threshold'),
    );
    expect(rateWarns).toHaveLength(1);

    const logData = rateWarns[0][0];
    expect(logData.clientId).toBe('client-fast');
    expect(logData.sessionId).toBe('session-fast');
    expect(logData.msgRate).toBeGreaterThan(100);
    expect(logData.byteRate).toBeDefined();
    expect(logData.messages).toBeGreaterThan(500);
  });

  it('does NOT log warn for bracketed paste (single large frame)', async () => {
    const { gateway } = createGateway();
    const client = await setupAuthorizedClient(gateway, 'client-paste', 'session-paste');

    // Single large paste: 200KB in one frame (1 message, under msg threshold)
    const largePaste = 'x'.repeat(200 * 1024);
    await gateway.handleInput(client, { sessionId: 'session-paste', data: largePaste });

    // Advance past window
    nowValue += 5100;

    // Trigger window check
    await gateway.handleInput(client, { sessionId: 'session-paste', data: 'y' });

    const rateWarns = mockWarn.mock.calls.filter(
      (args) => typeof args[1] === 'string' && args[1].includes('Input rate threshold'),
    );
    expect(rateWarns).toHaveLength(0);
  });

  it('does NOT log input content in any warn output', async () => {
    const { gateway } = createGateway();
    const client = await setupAuthorizedClient(gateway, 'client-content', 'session-content');

    const secretInput = 'super-secret-password-12345';

    // Send enough to trigger threshold
    for (let i = 0; i < 600; i++) {
      await gateway.handleInput(client, { sessionId: 'session-content', data: secretInput });
    }

    nowValue += 5100;
    await gateway.handleInput(client, { sessionId: 'session-content', data: secretInput });

    // Check ALL warn calls for content leakage
    for (const call of mockWarn.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secretInput);
    }
  });
});
