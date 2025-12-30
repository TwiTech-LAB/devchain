import { Injectable, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../../common/logging/logger';
import { IOError, NotFoundError } from '../../../common/errors/error-types';
import { EventsService } from '../../events/services/events.service';

// Create execAsync with larger maxBuffer for tmux captures
// 5MB buffer prevents failure on large scrollback captures
const MAX_EXEC_BUFFER = 5 * 1024 * 1024; // 5MB
const execAsync = promisify(exec);
const logger = createLogger('TmuxService');

export interface TmuxSessionInfo {
  name: string;
  projectSlug: string;
  epicId: string;
  agentId: string;
  sessionId: string;
}

@Injectable()
export class TmuxService implements OnModuleDestroy {
  private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    @Inject(forwardRef(() => EventsService)) private readonly eventsService: EventsService,
  ) {}

  onModuleDestroy() {
    // Clean up all health check intervals
    for (const interval of this.healthCheckIntervals.values()) {
      clearInterval(interval);
    }
    this.healthCheckIntervals.clear();
  }

  /**
   * Create tmux session name following pattern:
   * devchain_<projectSlug>_<epicId>_<agentId>_<sessionId>
   * Using underscores instead of colons to avoid tmux window/pane syntax conflicts
   */
  createSessionName(
    projectSlug: string,
    epicId: string,
    agentId: string,
    sessionId: string,
  ): string {
    return `devchain_${projectSlug}_${epicId}_${agentId}_${sessionId}`;
  }

  /**
   * Create a new tmux session
   */
  async createSession(sessionName: string, workingDirectory: string): Promise<void> {
    try {
      const cmd = `tmux new-session -d -s "${sessionName}" -c "${workingDirectory}"`;
      await execAsync(cmd);

      // NOTE: We leave tmux alternate-screen at its default (on).
      // This allows TUI apps to use the alternate buffer without overwriting
      // the primary buffer's command history. When the TUI exits, the user
      // can still scroll through their command history.

      // Disable status bar for cleaner chat terminal display
      await execAsync(`tmux set-option -t "${sessionName}" status off`);

      logger.info(
        { sessionName, workingDirectory },
        'Tmux session created with alt-screen support and status off',
      );
    } catch (error) {
      logger.error({ error, sessionName }, 'Failed to create tmux session');
      throw new IOError('Failed to create tmux session', {
        sessionName,
        error: String(error),
      });
    }
  }

  /**
   * Ensure alternate-screen is disabled for a session window.
   * Useful on attach to guarantee scrollback behavior even if session
   * was created before the default was applied.
   */
  async setAlternateScreenOff(sessionName: string): Promise<void> {
    try {
      await execAsync(`tmux set-window-option -t "=${sessionName}" alternate-screen off`);
      logger.info({ sessionName }, 'tmux alternate-screen disabled');
    } catch (error) {
      logger.warn({ error, sessionName }, 'Failed to set tmux alternate-screen off');
    }
  }

  /**
   * Check if tmux session exists
   */
  async hasSession(sessionName: string): Promise<boolean> {
    try {
      // Use = prefix for exact match to avoid colon interpretation
      await execAsync(`tmux has-session -t "=${sessionName}"`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attach to existing tmux session (returns pane info)
   */
  async attachSession(sessionName: string): Promise<string> {
    try {
      const exists = await this.hasSession(sessionName);
      if (!exists) {
        throw new NotFoundError('Tmux session', sessionName);
      }

      // Get pane ID for the session - use = prefix for exact match
      const { stdout } = await execAsync(`tmux list-panes -t "=${sessionName}" -F "#{pane_id}"`);
      const paneId = stdout.trim();

      logger.info({ sessionName, paneId }, 'Attached to tmux session');
      return paneId;
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.error({ error, sessionName }, 'Failed to attach to tmux session');
      throw new IOError('Failed to attach to tmux session', {
        sessionName,
        error: String(error),
      });
    }
  }

  /**
   * Destroy tmux session
   */
  async destroySession(sessionName: string): Promise<void> {
    try {
      // Use = prefix for exact match to avoid colon interpretation
      await execAsync(`tmux kill-session -t "=${sessionName}"`);
      logger.info({ sessionName }, 'Tmux session destroyed');

      // Stop health check if running
      this.stopHealthCheck(sessionName);
    } catch (error) {
      logger.error({ error, sessionName }, 'Failed to destroy tmux session');
      throw new IOError('Failed to destroy tmux session', {
        sessionName,
        error: String(error),
      });
    }
  }

  /**
   * List all devchain tmux sessions
   */
  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"');
      const sessions = stdout
        .trim()
        .split('\n')
        .filter((name) => name.startsWith('devchain_'));
      return sessions;
    } catch (error) {
      // No sessions running
      return [];
    }
  }

  /**
   * Capture pane content (scrollback + screen) from tmux
   * lines: number of lines from top (-S -lines)
   * includeEscapes: when true, attempts to include formatting escapes (-e, if supported)
   */
  async capturePane(sessionName: string, lines: number, includeEscapes = true): Promise<string> {
    const start = `-${Math.max(0, Math.floor(lines))}`;
    const base = `tmux capture-pane -p -S ${start} -t "=${sessionName}:"`;
    const cmdPreferred = includeEscapes ? `${base} -e` : base;
    try {
      // Use larger maxBuffer to prevent failure on large scrollback captures
      const { stdout } = await execAsync(cmdPreferred, { maxBuffer: MAX_EXEC_BUFFER });
      return stdout ?? '';
    } catch (error) {
      // If -e unsupported, retry without it
      const msg = String(error ?? '');
      if (includeEscapes && /unknown option|invalid option/i.test(msg)) {
        try {
          const { stdout } = await execAsync(base, { maxBuffer: MAX_EXEC_BUFFER });
          return stdout ?? '';
        } catch (err2) {
          logger.warn({ sessionName, error: String(err2) }, 'Fallback capture-pane failed');
          return '';
        }
      }
      logger.warn({ sessionName, error: msg }, 'capture-pane failed');
      return '';
    }
  }

  /**
   * Get cursor position from tmux pane
   * Returns {x, y} where both are 0-indexed
   */
  async getCursorPosition(sessionName: string): Promise<{ x: number; y: number } | null> {
    try {
      const { stdout } = await execAsync(
        `tmux display-message -p -t "=${sessionName}:" '#{cursor_x} #{cursor_y}'`,
      );
      const parts = (stdout ?? '').trim().split(/\s+/);
      if (parts.length >= 2) {
        const x = parseInt(parts[0], 10);
        const y = parseInt(parts[1], 10);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return { x, y };
        }
      }
      logger.warn({ sessionName, stdout }, 'Failed to parse cursor position from tmux');
      return null;
    } catch (error) {
      logger.warn({ sessionName, error: String(error) }, 'Failed to get cursor position from tmux');
      return null;
    }
  }

  /**
   * Send command to tmux session
   */
  async sendCommand(sessionName: string, command: string): Promise<void> {
    try {
      // Use send-keys to execute command
      await execAsync(
        `tmux send-keys -t "=${sessionName}:" '${command.replace(/'/g, "'\\''")}' Enter`,
      );
      logger.info({ sessionName, command }, 'Sent command to tmux session');
    } catch (error) {
      logger.error({ error, sessionName, command }, 'Failed to send command to tmux session');
      throw new IOError('Failed to send command to tmux session', {
        sessionName,
        command,
        error: String(error),
      });
    }
  }

  /**
   * Send argv-style command to tmux session (no shell evaluation)
   */
  async sendCommandArgs(sessionName: string, argv: string[]): Promise<void> {
    if (!argv.length) {
      throw new IOError('Attempted to send empty argv command', { sessionName });
    }

    const quoted = argv
      .map((arg) => {
        if (arg.length === 0) {
          return "''";
        }
        return `'${arg.replace(/'/g, "'\\''")}'`;
      })
      .join(' ');

    await this.sendCommand(sessionName, quoted);
  }

  /**
   * Load a named tmux paste buffer from stdin (bypasses shell).
   */
  private async loadBuffer(bufferName: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('tmux', ['load-buffer', '-b', bufferName, '-']);
      let stderr = '';

      child.on('error', (error) => {
        logger.error({ error, bufferName }, 'Failed to spawn tmux load-buffer');
        reject(
          new IOError('Failed to load tmux buffer', {
            bufferName,
            error: String(error),
          }),
        );
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code !== 0) {
          logger.error({ code, stderr, bufferName }, 'tmux load-buffer exited with error');
          reject(
            new IOError('Failed to load tmux buffer', {
              bufferName,
              code,
              stderr,
            }),
          );
          return;
        }
        resolve();
      });

      child.stdin.end(content);
    });
  }

  /**
   * Paste raw text into tmux session using load-buffer/paste-buffer.
   *
   * When bracketed=true, embeds bracketed paste markers directly in the buffer:
   * `ESC[200~` + content + `ESC[201~`. The entire payload is loaded into a tmux
   * buffer via spawn (to preserve raw ESC bytes) and then pasted atomically.
   * This matches how real terminals send bracketed paste and avoids timing issues
   * from sending markers separately.
   */
  async pasteText(
    sessionName: string,
    text: string,
    options?: { bracketed?: boolean },
  ): Promise<void> {
    // Use a unique buffer per paste to avoid cross-event collisions
    const safeSession = sessionName.replace(/[^a-zA-Z0-9_-]/g, '');
    const bufferName = `devchain-${safeSession}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2, 8)}`;

    // Match xterm.js paste behavior: normalize newlines to CR (carriage return).
    // See @xterm/xterm Clipboard.prepareTextForTerminal().
    const prepared = text.replace(/\r?\n/g, '\r');

    try {
      // Build payload with bracketed paste markers embedded if requested.
      // ESC[200~ = start bracket, ESC[201~ = end bracket
      const payload = options?.bracketed ? `\x1b[200~${prepared}\x1b[201~` : prepared;

      // Load buffer and paste
      await this.loadBuffer(bufferName, payload);
      await execAsync(`tmux paste-buffer -b "${bufferName}" -t "${sessionName}"`);

      // Clean up buffer
      try {
        await execAsync(`tmux delete-buffer -b "${bufferName}"`);
      } catch {
        // Ignore cleanup errors
      }

      logger.info(
        { sessionName, bracketed: !!options?.bracketed },
        'Pasted text into tmux session',
      );
    } catch (error) {
      logger.error({ error, sessionName }, 'Failed to paste text into tmux session');
      throw new IOError('Failed to paste text into tmux session', {
        sessionName,
        error: String(error),
      });
    }
  }

  /**
   * Send raw key chords to the target tmux pane, e.g. Enter, C-j, C-d.
   * Keys are passed as tmux send-keys arguments (e.g., 'Enter', 'C-j').
   */
  async sendKeys(sessionName: string, keys: string[]): Promise<void> {
    if (!keys.length) return;

    // Properly escape each argument for the shell to prevent issues with spaces and special chars
    const shellEscape = (arg: string): string => {
      // If the argument is empty or contains special characters, wrap in single quotes
      // and escape any single quotes within
      if (arg === '' || /[ \t\n'"$`\\!*?[\](){}|&;<>]/.test(arg)) {
        return "'" + arg.replace(/'/g, "'\\''") + "'";
      }
      return arg;
    };

    const args = keys.map(shellEscape).join(' ');
    try {
      await execAsync(`tmux send-keys -t "=${sessionName}:" ${args}`);
      logger.debug({ sessionName, keys }, 'Sent keys to tmux session');
    } catch (error) {
      logger.error({ error, sessionName, keys }, 'Failed to send keys');
      throw new IOError('Failed to send keys', { sessionName, keys, error: String(error) });
    }
  }

  /**
   * Paste text and submit with optional keys (default Enter).
   * Bracketed paste is enabled by default for better TUI compatibility.
   */
  async pasteAndSubmit(
    sessionName: string,
    text: string,
    options?: { bracketed?: boolean; submitKeys?: string[]; delayMs?: number },
  ): Promise<void> {
    const bracketed = options?.bracketed ?? true;
    const delayMs = options?.delayMs ?? 250;
    const submitKeys = options?.submitKeys ?? ['Enter'];

    await this.pasteText(sessionName, text, { bracketed });
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      if (submitKeys.length > 0) {
        await this.sendKeys(sessionName, submitKeys);
      }
    } catch (error) {
      logger.warn(
        { sessionName, error, submitKeys, bracketed },
        'Failed to send submit keys after paste',
      );
    }
  }

  /**
   * Type literal text into the tmux pane (simulates user typing).
   * Useful for CLIs that don't submit reliably with paste-buffer.
   */
  async typeText(sessionName: string, text: string): Promise<void> {
    // Escape single quotes for safe shell wrapping
    const escaped = text.replace(/'/g, "'\\''");
    const cmd = `tmux send-keys -t "=${sessionName}:" -l -- '${escaped}'`;
    try {
      await execAsync(cmd);
      logger.debug({ sessionName, length: text.length }, 'Typed text into tmux session');
    } catch (error) {
      logger.error({ error, sessionName }, 'Failed to type text into tmux session');
      throw new IOError('Failed to type text into tmux session', {
        sessionName,
        error: String(error),
      });
    }
  }

  /**
   * Start health check polling for session
   * Emits 'session.crashed' event if session is lost
   */
  startHealthCheck(sessionName: string, sessionId: string, intervalMs: number = 5000): void {
    // Stop existing health check if any
    this.stopHealthCheck(sessionName);

    const interval = setInterval(async () => {
      const exists = await this.hasSession(sessionName);
      if (!exists) {
        logger.warn({ sessionName, sessionId }, 'Tmux session lost - emitting crashed event');
        await this.eventsService.publish('session.crashed', { sessionId, sessionName });
        this.stopHealthCheck(sessionName);
      }
    }, intervalMs);

    this.healthCheckIntervals.set(sessionName, interval);
    logger.info({ sessionName, intervalMs }, 'Started health check');
  }

  /**
   * Stop health check polling for session
   */
  stopHealthCheck(sessionName: string): void {
    const interval = this.healthCheckIntervals.get(sessionName);
    if (interval) {
      clearInterval(interval);
      this.healthCheckIntervals.delete(sessionName);
      logger.info({ sessionName }, 'Stopped health check');
    }
  }
}
