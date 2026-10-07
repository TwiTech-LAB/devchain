import { TerminalRegistryRehydrator } from './terminal-registry-rehydrator.service';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import { SessionTerminalRuntimeService } from '../../session-terminal-runtime/session-terminal-runtime.service';

function createRehydrator(options?: {
  metas?: Array<{ sessionId: string; tmuxSessionName: string }>;
  sessionExistsResults?: Map<string, boolean>;
}) {
  const sessionTerminalRuntime: Partial<SessionTerminalRuntimeService> = {
    listStartupSessions: jest.fn().mockReturnValue(options?.metas ?? []),
    retireConfirmedLoss: jest.fn(),
    reconcileCodexStartup: jest.fn().mockResolvedValue(undefined),
  };

  const terminalIO: Partial<TerminalIOService> = {
    sessionExists: jest.fn().mockImplementation(async (target: { name: string }) => {
      return options?.sessionExistsResults?.get(target.name) ?? true;
    }),
    startHealthCheck: jest.fn(),
  };

  const registry = new TerminalSessionRegistry();

  const rehydrator = new TerminalRegistryRehydrator(
    sessionTerminalRuntime as SessionTerminalRuntimeService,
    registry,
    terminalIO as TerminalIOService,
  );

  return { rehydrator, sessionTerminalRuntime, registry, terminalIO };
}

describe('TerminalRegistryRehydrator', () => {
  it('populates registry from running sessions on bootstrap', async () => {
    const { rehydrator, registry } = createRehydrator({
      metas: [
        { sessionId: 'session-1', tmuxSessionName: 'tmux_1' },
        { sessionId: 'session-2', tmuxSessionName: 'tmux_2' },
      ],
    });

    await rehydrator.onApplicationBootstrap();

    expect(registry.get('session-1')).toBeDefined();
    expect(registry.get('session-1')!.tmuxSessionName).toBe('tmux_1');
    expect(registry.get('session-2')).toBeDefined();
    expect(registry.get('session-2')!.tmuxSessionName).toBe('tmux_2');
  });

  it('marks dead-tmux sessions as failed at bootstrap, preserving alive sessions', async () => {
    const { rehydrator, registry, sessionTerminalRuntime } = createRehydrator({
      metas: [
        { sessionId: 'alive', tmuxSessionName: 'tmux_alive' },
        { sessionId: 'dead', tmuxSessionName: 'tmux_dead' },
      ],
      sessionExistsResults: new Map([
        ['tmux_alive', true],
        ['tmux_dead', false],
      ]),
    });

    await rehydrator.onApplicationBootstrap();

    expect(sessionTerminalRuntime.retireConfirmedLoss).toHaveBeenCalledWith(
      'dead',
      expect.stringContaining('bootstrap'),
    );
    expect(sessionTerminalRuntime.retireConfirmedLoss).not.toHaveBeenCalledWith(
      'alive',
      expect.anything(),
    );
    expect(registry.get('alive')).toBeDefined();
    expect(registry.get('dead')).toBeUndefined();
  });

  it('starts a health check for rehydrated sessions but not for dead ones', async () => {
    const { rehydrator, terminalIO } = createRehydrator({
      metas: [
        { sessionId: 'alive', tmuxSessionName: 'tmux_alive' },
        { sessionId: 'dead', tmuxSessionName: 'tmux_dead' },
      ],
      sessionExistsResults: new Map([
        ['tmux_alive', true],
        ['tmux_dead', false],
      ]),
    });

    await rehydrator.onApplicationBootstrap();

    expect(terminalIO.startHealthCheck).toHaveBeenCalledWith('tmux_alive', 'alive');
    expect(terminalIO.startHealthCheck).not.toHaveBeenCalledWith('tmux_dead', 'dead');
  });

  it('verifies sessions already in registry without double-create', async () => {
    const { rehydrator, registry, terminalIO } = createRehydrator({
      metas: [{ sessionId: 'existing', tmuxSessionName: 'tmux_existing' }],
    });

    registry.create('existing', 'tmux_existing');

    await rehydrator.onApplicationBootstrap();

    expect(registry.size).toBe(1);
    expect(terminalIO.sessionExists).toHaveBeenCalledWith({ name: 'tmux_existing' });
  });

  it('is a no-op when no running sessions exist', async () => {
    const { rehydrator, registry, terminalIO } = createRehydrator({
      metas: [],
    });

    await rehydrator.onApplicationBootstrap();

    expect(registry.size).toBe(0);
    expect(terminalIO.sessionExists).not.toHaveBeenCalled();
  });

  it('survives concurrent rehydration race (registry.create throws already exists)', async () => {
    const { rehydrator, registry, terminalIO } = createRehydrator({
      metas: [{ sessionId: 'race', tmuxSessionName: 'tmux_race' }],
    });

    (terminalIO.sessionExists as jest.Mock).mockImplementation(async () => {
      registry.create('race', 'tmux_race');
      registry.bind('race', terminalIO as TerminalIOService);
      return true;
    });

    await expect(rehydrator.onApplicationBootstrap()).resolves.not.toThrow();

    expect(registry.get('race')).toBeDefined();
    expect(registry.get('race')!.tmuxSessionName).toBe('tmux_race');
  });

  it('normalizes full-history line endings through captured-output policy', async () => {
    const { rehydrator, registry, terminalIO } = createRehydrator({
      metas: [{ sessionId: 'raw', tmuxSessionName: 'tmux_raw' }],
    });
    (terminalIO as Partial<TerminalIOService>).captureHistory = jest
      .fn()
      .mockResolvedValue({ ok: true, output: 'one\ntwo' });

    await rehydrator.onApplicationBootstrap();

    const session = registry.get('raw');
    expect(session).toBeDefined();

    const frames: Array<{ type: string; payload: unknown }> = [];
    session!.stream.on('frame', (frame) => frames.push(frame));

    await session!.requestFullHistory();

    const historyFrame = frames.find((f) => f.type === 'full_history');
    expect(historyFrame).toBeDefined();
    expect((historyFrame!.payload as { ansi: string }).ansi).toBe('one\r\ntwo');
  });

  it('reconciles last with exactly the set of sessions proved dead', async () => {
    const { rehydrator, sessionTerminalRuntime, terminalIO } = createRehydrator({
      metas: [
        { sessionId: 'alive', tmuxSessionName: 'tmux_alive' },
        { sessionId: 'dead-a', tmuxSessionName: 'tmux_dead_a' },
        { sessionId: 'dead-b', tmuxSessionName: 'tmux_dead_b' },
      ],
      sessionExistsResults: new Map([
        ['tmux_alive', true],
        ['tmux_dead_a', false],
        ['tmux_dead_b', false],
      ]),
    });

    await rehydrator.onApplicationBootstrap();

    expect(sessionTerminalRuntime.reconcileCodexStartup).toHaveBeenCalledWith(
      new Set(['dead-a', 'dead-b']),
    );
    const reconcileOrder = (sessionTerminalRuntime.reconcileCodexStartup as jest.Mock).mock
      .invocationCallOrder[0];
    expect(reconcileOrder).toBeGreaterThan(
      Math.max(...(terminalIO.sessionExists as jest.Mock).mock.invocationCallOrder),
    );
    expect(reconcileOrder).toBeGreaterThan(
      Math.max(
        ...(sessionTerminalRuntime.retireConfirmedLoss as jest.Mock).mock.invocationCallOrder,
      ),
    );
  });
});
