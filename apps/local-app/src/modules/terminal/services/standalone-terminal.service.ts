import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { TerminalGateway } from '../gateways/terminal.gateway';
import { ProcessExecutor } from './process-executor/process-executor.port';
import { PtyService } from './pty.service';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';

const logger = createLogger('StandaloneTerminalService');

/**
 * Not `devchain_`: session cleanup and the MCP session list treat that prefix
 * as agent sessions. The name carries the owning process id because every
 * DevChain instance of this OS user shares one tmux server.
 */
const TMUX_PREFIX = 'devchain-aux_';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface StandaloneTerminal {
  sessionId: string;
  tmuxSessionName: string;
}

/**
 * A terminal outside any project or agent: a tmux session the web terminal
 * attaches to by `sessionId`, like an agent session, but with no `sessions`
 * row, no restore, and no message delivery. It does not survive a restart.
 */
@Injectable()
export class StandaloneTerminalService implements OnModuleInit {
  private readonly open = new Map<string, StandaloneTerminal>();

  constructor(
    private readonly terminalIO: TerminalIOService,
    private readonly registry: TerminalSessionRegistry,
    private readonly pty: PtyService,
    private readonly gateway: TerminalGateway,
    private readonly executor: ProcessExecutor,
  ) {}

  /** Terminals of a process that no longer runs have no owner any more. */
  async onModuleInit(): Promise<void> {
    try {
      const names = await this.terminalIO.listAllSessionNames();
      for (const name of names) {
        if (!name.startsWith(TMUX_PREFIX)) continue;
        const pid = Number(name.slice(TMUX_PREFIX.length).split('_')[0]);
        if (Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
          await this.terminalIO.destroyExpectedSession({ name }, { onUnknownError: 'retire' });
        }
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'Could not remove leftover standalone terminals');
    }
  }

  /**
   * Runs `argv` (no shell) as the pane's process. The pane stays after the
   * process exits so its last output remains readable; output of a process
   * that exits at once can be lost, so callers check their binaries first.
   */
  async start(argv: string[], options: { cwd: string }): Promise<StandaloneTerminal> {
    const sessionId = randomUUID();
    const tmuxSessionName = `${TMUX_PREFIX}${process.pid}_${sessionId}`;
    const pane = `=${tmuxSessionName}:`;
    await this.terminalIO.createEmptySession(tmuxSessionName, { cwd: options.cwd });
    try {
      // Set before the process starts, or a fast exit closes the pane first.
      await this.tmux(['set-option', '-w', '-t', pane, 'remain-on-exit', 'on']);
      await this.terminalIO.setAlternateScreen({ name: tmuxSessionName }, false);
      await this.tmux(['respawn-pane', '-k', '-t', pane, '-c', options.cwd, ...argv]);
      this.registry.create(sessionId, tmuxSessionName, { normalizeCapturedLineEndings: true });
      await this.pty.startStreaming(sessionId, tmuxSessionName);
      this.registry.bind(sessionId, this.terminalIO);
    } catch (error) {
      this.registry.dispose(sessionId);
      await this.terminalIO.destroyExpectedSession(
        { name: tmuxSessionName },
        { onUnknownError: 'retire' },
      );
      throw error;
    }
    const terminal = { sessionId, tmuxSessionName };
    this.open.set(sessionId, terminal);
    logger.info({ sessionId, tmuxSessionName }, 'Standalone terminal started');
    return terminal;
  }

  /** False once the pane's process exited, or the tmux session is gone. */
  async isRunning(sessionId: string): Promise<boolean> {
    const terminal = this.open.get(sessionId);
    if (!terminal) return false;
    const result = await this.executor.run({
      argv: [
        'tmux',
        'display-message',
        '-p',
        '-t',
        `=${terminal.tmuxSessionName}:`,
        '#{pane_dead}',
      ],
      mode: 'pipe',
    });
    return result.success && result.stdout.trim() === '0';
  }

  private async tmux(args: string[]): Promise<void> {
    const result = await this.executor.run({ argv: ['tmux', ...args], mode: 'pipe' });
    if (!result.success || result.timedOut) {
      throw new Error(`tmux ${args[0]} failed: ${result.stderr.trim() || result.exitCode}`);
    }
  }

  async end(sessionId: string, message: string): Promise<void> {
    const terminal = this.open.get(sessionId);
    if (!terminal) return;
    this.open.delete(sessionId);
    this.gateway.endStandaloneTerminal(sessionId, message);
    const result = await this.terminalIO.destroyExpectedSession(
      { name: terminal.tmuxSessionName },
      { onUnknownError: 'retire' },
    );
    if (result.outcome === 'unknown-error') {
      logger.warn(
        { sessionId, error: result.error.message },
        'Could not destroy standalone terminal',
      );
    }
  }
}
