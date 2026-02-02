import { Injectable, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import * as pty from 'node-pty';
import { createLogger } from '../../../common/logging/logger';
import { TerminalGateway } from '../gateways/terminal.gateway';
import { TerminalActivityService } from '../../mcp/services/terminal-activity.service';
import { TmuxService } from './tmux.service';
import { SettingsService } from '../../settings/services/settings.service';
import { AltAwareAnsiSanitizer, stripAlternateScreenSequences } from '../utils/ansi-sanitizer';

const logger = createLogger('PtyService');

/** Activity suppression window after startStreaming/resize to ignore spurious output (ms) */
const ACTIVITY_SUPPRESSION_MS = 750;

interface PtySession {
  sessionId: string;
  tmuxSessionName: string;
  ptyProcess: pty.IPty;
  cols: number;
  rows: number;
  sanitizer: AltAwareAnsiSanitizer;
  sanitizeMode: 'off' | 'strip_alt' | 'normalize';
  loggedPath?: boolean;
  suppressActivityUntil: number;
}

/**
 * PTY Service
 * Manages pseudo-terminal processes that attach to tmux sessions
 * and stream output through MarkerParser before broadcasting to clients
 */
@Injectable()
export class PtyService implements OnModuleDestroy {
  private activeSessions: Map<string, PtySession> = new Map();
  // Enable PTY resizing so server matches client terminal size
  private readonly RESIZE_DISABLED: boolean = false;
  private readonly sanitizerMode: 'off' | 'strip_alt' | 'normalize';

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway: TerminalGateway,
    @Inject(forwardRef(() => TerminalActivityService))
    private readonly terminalActivity: TerminalActivityService,
    @Inject(forwardRef(() => TmuxService))
    private readonly tmuxService: TmuxService,
    private readonly settingsService: SettingsService,
  ) {
    // Strip alt-screen toggles before data reaches the browser terminal so TUIs
    // write into a single scrollback buffer. We leave scroll regions unchanged
    // to avoid breaking apps that rely heavily on DECSTBM layout.
    this.sanitizerMode = 'strip_alt';
    let engine = 'xterm';
    try {
      const stored = this.settingsService.getSetting('terminal.engine');
      if (stored && typeof stored === 'string') engine = stored.trim().toLowerCase();
    } catch {}
    logger.info(
      { engine, sanitizerMode: this.sanitizerMode },
      'PtyService initialized with ANSI sanitization (strip_alt)',
    );
  }

  /** Expose whether server-side ANSI sanitization is enabled globally. */
  isSanitizerEnabled(): boolean {
    return this.sanitizerMode !== 'off';
  }

  onModuleDestroy() {
    // Clean up all PTY processes
    for (const session of this.activeSessions.values()) {
      this.stopStreaming(session.sessionId);
    }
  }

  /**
   * Start streaming terminal output from a tmux session
   * Attaches to the tmux session and pipes output through MarkerParser
   */
  async startStreaming(sessionId: string, tmuxSessionName: string): Promise<void> {
    if (this.activeSessions.has(sessionId)) {
      logger.warn({ sessionId }, 'PTY session already active');
      return;
    }

    try {
      logger.info({ sessionId, tmuxSessionName }, 'Starting PTY streaming');

      // Spawn a process that attaches to the tmux session in interactive mode
      // Use = prefix for exact match to avoid colon interpretation
      const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', `=${tmuxSessionName}`], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as { [key: string]: string },
      });

      // Store the session
      const useMode = this.sanitizerMode;
      this.activeSessions.set(sessionId, {
        sessionId,
        tmuxSessionName,
        ptyProcess,
        cols: 80,
        rows: 24,
        sanitizer: new AltAwareAnsiSanitizer(useMode === 'normalize' ? 'normalize' : 'strip_alt'),
        sanitizeMode: useMode,
        loggedPath: false,
        suppressActivityUntil: Date.now() + ACTIVITY_SUPPRESSION_MS,
      });

      // NOTE: We DO NOT disable tmux alternate-screen anymore.
      // Allowing alt-screen to work properly preserves the separation between
      // primary buffer (command history) and alternate buffer (TUI apps).
      // This prevents TUI apps from overwriting scrollback history.

      // Listen to data from the PTY
      ptyProcess.onData((data: string) => {
        const sess = this.activeSessions.get(sessionId);
        if (!sess) {
          // Session was removed (e.g., disconnected) but PTY still firing events
          return;
        }
        if (!sess.loggedPath) {
          logger.info(
            { sessionId, sanitizeMode: sess.sanitizeMode },
            'PTY data path selected (sanitize indicates server-side ANSI transform)',
          );
          sess.loggedPath = true;
        }
        try {
          // Observe activity based on non-empty output, but suppress during suppression window
          if (Date.now() >= sess.suppressActivityUntil) {
            this.terminalActivity.observeChunk(sessionId, data);
          }
        } catch (error) {
          logger.warn({ sessionId, error }, 'Activity observer failed');
        }
        // Sanitize based on mode
        const sanitized =
          sess.sanitizeMode === 'normalize'
            ? sess.sanitizer.process(data)
            : sess.sanitizeMode === 'strip_alt'
              ? stripAlternateScreenSequences(data)
              : data;
        // Broadcast sanitized data so client xterm also preserves scrollback
        this.terminalGateway.broadcastTerminalData(sessionId, sanitized);
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode, signal }) => {
        logger.info({ sessionId, exitCode, signal }, 'PTY process exited');
        this.activeSessions.delete(sessionId);
        this.terminalActivity.clearSession(sessionId);
      });

      logger.info({ sessionId, tmuxSessionName }, 'PTY streaming started successfully');
    } catch (error) {
      logger.error({ sessionId, tmuxSessionName, error }, 'Failed to start PTY streaming');
      throw error;
    }
  }

  /**
   * Stop streaming for a session
   */
  stopStreaming(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'No active PTY session to stop');
      return;
    }

    try {
      logger.info({ sessionId }, 'Stopping PTY streaming');

      // Kill the PTY process
      session.ptyProcess.kill();

      // Clean up
      this.activeSessions.delete(sessionId);
      this.terminalActivity.clearSession(sessionId);

      logger.info({ sessionId }, 'PTY streaming stopped');
    } catch (error) {
      logger.error({ sessionId, error }, 'Error stopping PTY streaming');
    }
  }

  /**
   * Resize the PTY terminal
   */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Cannot resize: no active PTY session');
      return;
    }

    try {
      // Allow ONE initial resize to set correct size, then disable to avoid duplicates
      const isInitialResize = session.cols === 80 && session.rows === 24;

      if (this.RESIZE_DISABLED && !isInitialResize) {
        logger.info({ sessionId, cols, rows }, 'Dynamic resize disabled; skipping PTY resize');
        return;
      }

      if (session.cols === cols && session.rows === rows) {
        logger.debug({ sessionId, cols, rows }, 'Skip PTY resize (dimensions unchanged)');
      } else {
        session.ptyProcess.resize(cols, rows);
        session.cols = cols;
        session.rows = rows;
        // Suppress activity after resize to ignore tmux redraw burst
        session.suppressActivityUntil = Date.now() + ACTIVITY_SUPPRESSION_MS;
        logger.info({ sessionId, cols, rows, isInitial: isInitialResize }, 'PTY resized');
      }
    } catch (error) {
      logger.error({ sessionId, cols, rows, error }, 'Error resizing PTY');
    }
  }

  /**
   * Send input to the PTY (for future use if needed)
   */
  write(sessionId: string, data: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'Cannot write: no active PTY session');
      return;
    }

    try {
      session.ptyProcess.write(data);
    } catch (error) {
      logger.error({ sessionId, error }, 'Error writing to PTY');
    }
  }

  /**
   * Check if a session is actively streaming
   */
  isStreaming(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /**
   * Get active session count for monitoring
   */
  getActiveSessionCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Get current dimensions (cols/rows) for a session
   */
  getDimensions(sessionId: string): { cols: number; rows: number } | null {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return null;
    }
    return { cols: session.cols, rows: session.rows };
  }
}
