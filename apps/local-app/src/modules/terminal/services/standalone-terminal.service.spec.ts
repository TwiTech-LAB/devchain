import type { TerminalGateway } from '../gateways/terminal.gateway';
import type { ProcessExecutor } from './process-executor/process-executor.port';
import type { PtyService } from './pty.service';
import { StandaloneTerminalService } from './standalone-terminal.service';
import type { TerminalIOService } from './terminal-io/terminal-io.service';
import type { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';

describe('StandaloneTerminalService', () => {
  let terminalIO: {
    createEmptySession: jest.Mock;
    setAlternateScreen: jest.Mock;
    destroyExpectedSession: jest.Mock;
    sessionExists: jest.Mock;
    listAllSessionNames: jest.Mock;
  };
  let registry: { create: jest.Mock; bind: jest.Mock; dispose: jest.Mock };
  let pty: { startStreaming: jest.Mock };
  let gateway: { endStandaloneTerminal: jest.Mock };
  let executor: { run: jest.Mock };
  const ok = (stdout = '') => ({
    success: true,
    exitCode: 0,
    stdout,
    stderr: '',
    timedOut: false,
    truncated: false,
  });
  let service: StandaloneTerminalService;

  beforeEach(() => {
    terminalIO = {
      createEmptySession: jest.fn().mockResolvedValue(undefined),
      setAlternateScreen: jest.fn().mockResolvedValue(undefined),
      destroyExpectedSession: jest.fn().mockResolvedValue({ outcome: 'destroyed' }),
      sessionExists: jest.fn().mockResolvedValue(true),
      listAllSessionNames: jest.fn().mockResolvedValue(new Set()),
    };
    registry = { create: jest.fn(), bind: jest.fn(), dispose: jest.fn() };
    pty = { startStreaming: jest.fn().mockResolvedValue(undefined) };
    gateway = { endStandaloneTerminal: jest.fn() };
    executor = { run: jest.fn().mockResolvedValue(ok('0\n')) };
    service = new StandaloneTerminalService(
      terminalIO as unknown as TerminalIOService,
      registry as unknown as TerminalSessionRegistry,
      pty as unknown as PtyService,
      gateway as unknown as TerminalGateway,
      executor as unknown as ProcessExecutor,
    );
  });

  it('runs argv as the pane process, keeps the pane after exit, and registers it for the web terminal', async () => {
    const terminal = await service.start(['/usr/bin/env', 'codex', 'login'], { cwd: '/tmp/x' });

    const name = terminal.tmuxSessionName;
    expect(name).toBe(`devchain-aux_${process.pid}_${terminal.sessionId}`);
    expect(terminalIO.createEmptySession).toHaveBeenCalledWith(name, { cwd: '/tmp/x' });
    expect(executor.run.mock.calls.map(([options]) => options.argv)).toEqual([
      ['tmux', 'set-option', '-w', '-t', `=${name}:`, 'remain-on-exit', 'on'],
      [
        'tmux',
        'respawn-pane',
        '-k',
        '-t',
        `=${name}:`,
        '-c',
        '/tmp/x',
        '/usr/bin/env',
        'codex',
        'login',
      ],
    ]);
    expect(registry.create).toHaveBeenCalledWith(terminal.sessionId, terminal.tmuxSessionName, {
      normalizeCapturedLineEndings: true,
    });
    expect(pty.startStreaming).toHaveBeenCalledWith(terminal.sessionId, terminal.tmuxSessionName);
    expect(registry.bind).toHaveBeenCalledWith(terminal.sessionId, terminalIO);
    await expect(service.isRunning(terminal.sessionId)).resolves.toBe(true);
    executor.run.mockResolvedValue(ok('1\n'));
    await expect(service.isRunning(terminal.sessionId)).resolves.toBe(false);
  });

  it('removes the tmux session and registry entry when streaming cannot start', async () => {
    pty.startStreaming.mockRejectedValue(new Error('no handler'));

    await expect(service.start(['true'], { cwd: '/tmp' })).rejects.toThrow('no handler');

    const name = terminalIO.createEmptySession.mock.calls[0][0];
    expect(registry.dispose).toHaveBeenCalled();
    expect(terminalIO.destroyExpectedSession).toHaveBeenCalledWith(
      { name },
      { onUnknownError: 'retire' },
    );
  });

  it('end tells attached views, then destroys the tmux session once', async () => {
    const terminal = await service.start(['true'], { cwd: '/tmp' });

    await service.end(terminal.sessionId, 'Login stored.');
    await service.end(terminal.sessionId, 'Login stored.');

    expect(gateway.endStandaloneTerminal).toHaveBeenCalledTimes(1);
    expect(gateway.endStandaloneTerminal).toHaveBeenCalledWith(terminal.sessionId, 'Login stored.');
    expect(terminalIO.destroyExpectedSession).toHaveBeenCalledTimes(1);
    await expect(service.isRunning(terminal.sessionId)).resolves.toBe(false);
  });

  it('on start destroys only terminals of processes that no longer run', async () => {
    terminalIO.listAllSessionNames.mockResolvedValue(
      new Set([
        'devchain-aux_999999999_dead',
        `devchain-aux_${process.pid}_live`,
        'devchain_agent_session',
        'someone-else',
      ]),
    );

    await service.onModuleInit();

    expect(terminalIO.destroyExpectedSession).toHaveBeenCalledTimes(1);
    expect(terminalIO.destroyExpectedSession).toHaveBeenCalledWith(
      { name: 'devchain-aux_999999999_dead' },
      { onUnknownError: 'retire' },
    );
  });
});
