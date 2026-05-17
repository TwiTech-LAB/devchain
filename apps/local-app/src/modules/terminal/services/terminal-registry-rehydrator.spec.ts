import { TerminalRegistryRehydrator } from './terminal-registry-rehydrator.service';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import { SessionsService } from '../../sessions/services/sessions.service';

function createRehydrator(options?: {
  metas?: Array<{ sessionId: string; tmuxSessionName: string; providerName: string }>;
  sessionExistsResults?: Map<string, boolean>;
}) {
  const sessionsService: Partial<SessionsService> = {
    listRunningSessionMetas: jest.fn().mockReturnValue(options?.metas ?? []),
    markSessionFailed: jest.fn(),
    shouldNormalizeLfFor: jest.fn().mockReturnValue(true),
  };

  const terminalIO: Partial<TerminalIOService> = {
    sessionExists: jest.fn().mockImplementation(async (target: { name: string }) => {
      return options?.sessionExistsResults?.get(target.name) ?? true;
    }),
  };

  const registry = new TerminalSessionRegistry();

  const rehydrator = new TerminalRegistryRehydrator(
    sessionsService as SessionsService,
    registry,
    terminalIO as TerminalIOService,
  );

  return { rehydrator, sessionsService, registry, terminalIO };
}

describe('TerminalRegistryRehydrator', () => {
  it('populates registry from running sessions on bootstrap', async () => {
    const { rehydrator, registry } = createRehydrator({
      metas: [
        { sessionId: 'session-1', tmuxSessionName: 'tmux_1', providerName: 'Claude' },
        { sessionId: 'session-2', tmuxSessionName: 'tmux_2', providerName: 'codex' },
      ],
    });

    await rehydrator.onApplicationBootstrap();

    expect(registry.get('session-1')).toBeDefined();
    expect(registry.get('session-1')!.tmuxSessionName).toBe('tmux_1');
    expect(registry.get('session-2')).toBeDefined();
    expect(registry.get('session-2')!.tmuxSessionName).toBe('tmux_2');
  });

  it('skips sessions whose tmux process is dead', async () => {
    const { rehydrator, registry } = createRehydrator({
      metas: [
        { sessionId: 'alive', tmuxSessionName: 'tmux_alive', providerName: 'claude' },
        { sessionId: 'dead', tmuxSessionName: 'tmux_dead', providerName: 'claude' },
      ],
      sessionExistsResults: new Map([
        ['tmux_alive', true],
        ['tmux_dead', false],
      ]),
    });

    await rehydrator.onApplicationBootstrap();

    expect(registry.get('alive')).toBeDefined();
    expect(registry.get('dead')).toBeUndefined();
  });

  it('marks dead-tmux sessions as failed at bootstrap, preserving alive sessions', async () => {
    const { rehydrator, registry, sessionsService } = createRehydrator({
      metas: [
        { sessionId: 'alive', tmuxSessionName: 'tmux_alive', providerName: 'claude' },
        { sessionId: 'dead', tmuxSessionName: 'tmux_dead', providerName: 'claude' },
      ],
      sessionExistsResults: new Map([
        ['tmux_alive', true],
        ['tmux_dead', false],
      ]),
    });

    await rehydrator.onApplicationBootstrap();

    expect(sessionsService.markSessionFailed).toHaveBeenCalledWith(
      'dead',
      expect.stringContaining('bootstrap'),
    );
    expect(sessionsService.markSessionFailed).not.toHaveBeenCalledWith('alive', expect.anything());
    expect(registry.get('alive')).toBeDefined();
    expect(registry.get('dead')).toBeUndefined();
  });

  it('skips sessions already in registry (no double-create)', async () => {
    const { rehydrator, registry, terminalIO } = createRehydrator({
      metas: [{ sessionId: 'existing', tmuxSessionName: 'tmux_existing', providerName: 'claude' }],
    });

    registry.create('existing', 'tmux_existing');

    await rehydrator.onApplicationBootstrap();

    expect(registry.size).toBe(1);
    expect(terminalIO.sessionExists).not.toHaveBeenCalled();
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
      metas: [{ sessionId: 'race', tmuxSessionName: 'tmux_race', providerName: 'claude' }],
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

  it('normalizes captured line endings through captured-output policy', async () => {
    const { rehydrator, registry, terminalIO } = createRehydrator({
      metas: [{ sessionId: 'raw', tmuxSessionName: 'tmux_raw', providerName: 'claude' }],
    });
    (terminalIO as Partial<TerminalIOService>).captureHistory = jest
      .fn()
      .mockResolvedValue({ ok: true, output: 'one\ntwo' });

    await rehydrator.onApplicationBootstrap();

    const session = registry.get('raw');
    expect(session).toBeDefined();

    const frames: Array<{ type: string; payload: unknown }> = [];
    session!.stream.on('frame', (frame) => frames.push(frame));

    session!.subscribe('client-1');

    await new Promise((r) => setTimeout(r, 50));

    const seedFrame = frames.find((f) => f.type === 'seed_ansi');
    expect(seedFrame).toBeDefined();
    expect((seedFrame!.payload as { data: string }).data).toBe('one\r\ntwo');
  });
});
