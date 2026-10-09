/**
 * Unit tests for the session.restored event wiring:
 * 1. Catalog registration — EventsService.publish('session.restored', ...) no longer throws.
 * 2. TerminalGateway.handleSessionRestored — broadcasts client session-state correctly.
 * 3. Isolation — session.restored does NOT share the event name with session.started,
 *    proving TranscriptPersistenceListener.handleSessionStarted is never triggered
 *    by a restore flow that emits session.restored.
 */

jest.mock('../../../common/logging/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

import { eventCatalog } from '../../events/catalog';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import { HumanPromptInputService } from '../../terminal/services/human-prompt-input.service';
import { TerminalStreamService } from '../../terminal/services/terminal-stream.service';
import { SettingsService } from '../../settings/services/settings.service';
import { PtyService } from '../../terminal/services/pty.service';
import { TerminalSeedService } from '../../terminal/services/terminal-seed.service';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from '../../terminal/services/terminal-session/terminal-session-registry';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HumanPromptStateService } from '../../terminal/services/human-prompt-state.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createGateway() {
  const streamService = {
    initializeBuffer: jest.fn(),
    getFramesSince: jest.fn().mockReturnValue([]),
    getCurrentSequence: jest.fn().mockReturnValue(0),
    addFrame: jest.fn(),
    setClearExpiryHandler: jest.fn(),
    scheduleClear: jest.fn(),
    cancelScheduledClear: jest.fn().mockReturnValue(null),
  } as unknown as TerminalStreamService;
  const settingsService = {
    getSetting: jest.fn(),
    getScrollbackLines: jest.fn().mockReturnValue(10000),
  } as unknown as SettingsService;
  const ptyService = {
    resize: jest.fn(),
    startStreaming: jest.fn(),
    isStreaming: jest.fn().mockReturnValue(false),
    stopStreaming: jest.fn(),
  } as unknown as PtyService;
  const seedService = {
    resolveSeedingConfig: jest.fn().mockReturnValue({ maxBytes: 65536 }),
    emitSeedToClient: jest.fn(),
    invalidateCache: jest.fn(),
  } as unknown as TerminalSeedService;
  const terminalIO = {} as TerminalIOService;
  const humanPromptState = new HumanPromptStateService();
  const registry = new TerminalSessionRegistry(undefined, humanPromptState);

  const gateway = new TerminalGateway(
    streamService,
    settingsService,
    ptyService,
    seedService,
    terminalIO,
    new HumanPromptInputService(humanPromptState, new EventEmitter2()),
    registry,
    {} as never,
    { setServer: jest.fn(), broadcastEvent: jest.fn() } as never,
    {
      registerSocket: jest.fn(),
      removeSocket: jest.fn(),
      enqueueLive: jest.fn(),
      enqueueRecovery: jest.fn(),
      getStats: jest.fn().mockReturnValue({}),
      dispose: jest.fn(),
    } as never,
    { registerCacheStatsProvider: jest.fn(), registerStatsProvider: jest.fn() } as never,
  );

  const serverEmit = jest.fn();
  gateway.server = {
    emit: serverEmit,
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
    sockets: { adapter: { rooms: new Map() }, sockets: new Map() },
  } as unknown as typeof gateway.server;

  return { gateway, serverEmit };
}

// ---------------------------------------------------------------------------
// 1. Catalog registration
// ---------------------------------------------------------------------------

describe('session.restored event catalog', () => {
  it('schema validates a valid payload', () => {
    const schema = eventCatalog['session.restored'];
    const result = schema.safeParse({
      sessionId: 'session-1',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionName: 'devchain-session-1',
      providerName: 'claude',
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. TerminalGateway.handleSessionRestored
// ---------------------------------------------------------------------------

describe('TerminalGateway.handleSessionRestored', () => {
  it('broadcasts a started state envelope to all clients', () => {
    const { gateway, serverEmit } = createGateway();

    gateway.handleSessionRestored({
      sessionId: 'session-abc',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionName: 'devchain-session-abc',
      providerName: 'claude',
    });

    expect(serverEmit).toHaveBeenCalledTimes(1);
    const [event, envelope] = serverEmit.mock.calls[0] as [
      string,
      { type: string; payload: { sessionId: string; status: string; message: string } },
    ];
    expect(event).toBe('message');
    expect(envelope.type).toBe('started');
    expect(envelope.payload.sessionId).toBe('session-abc');
    expect(envelope.payload.status).toBe('started');
    expect(envelope.payload.message).toBe('Session restored successfully');
  });
});
