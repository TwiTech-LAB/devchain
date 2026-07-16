import { Injectable, OnModuleDestroy, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import * as pty from 'node-pty';
import { createLogger } from '../../../common/logging/logger';
import { TerminalGateway } from '../gateways/terminal.gateway';
import { TerminalActivityService } from './terminal-activity.service';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import { SettingsService } from '../../settings/services/settings.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { stripAlternateScreenSequences } from '../utils/ansi-sanitizer';
import { normalizeLineEndings } from '../utils/normalize-line-endings';
import { MetricsService } from '../../metrics/services/metrics.service';
import type { PtyStats } from '../../metrics/types/metrics.types';

const logger = createLogger('PtyService');

/** Activity suppression window after startStreaming/resize to ignore spurious output (ms) */
const ACTIVITY_SUPPRESSION_MS = 750;

interface PtySession {
  sessionId: string;
  tmuxSessionName: string;
  ptyProcess: pty.IPty;
  needsLfNormalize: boolean;
  /** Resolved once at startStreaming: full-screen TUI provider → skip the alt-screen strip. */
  usesAlternateScreen: boolean;
  loggedPath?: boolean;
}

/**
 * PTY Service
 * Manages pseudo-terminal processes that attach to tmux sessions
 * and stream output through MarkerParser before broadcasting to clients
 */
@Injectable()
export class PtyService implements OnModuleDestroy, OnModuleInit {
  private activeSessions: Map<string, PtySession> = new Map();

  constructor(
    @Inject(forwardRef(() => TerminalGateway))
    private readonly terminalGateway: TerminalGateway,
    private readonly terminalActivity: TerminalActivityService,
    @Inject(forwardRef(() => TerminalIOService))
    private readonly terminalIO: TerminalIOService,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly metricsService: MetricsService,
  ) {
    let engine = 'xterm';
    try {
      const stored = this.settingsService.getSetting('terminal.engine');
      if (stored && typeof stored === 'string') engine = stored.trim().toLowerCase();
    } catch {}
    logger.info({ engine }, 'PtyService initialized (per-provider alt-screen policy)');
  }

  onModuleInit(): void {
    this.metricsService.registerStatsProvider('pty', () => this.getPtyStats());
  }

  getPtyStats(): PtyStats {
    return { activeSessions: this.activeSessions.size };
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
  async startStreaming(
    sessionId: string,
    tmuxSessionName: string,
    options?: { cols?: number; rows?: number },
  ): Promise<void> {
    if (this.activeSessions.has(sessionId)) {
      logger.warn({ sessionId }, 'PTY session already active');
      return;
    }

    const initialCols = options?.cols && options.cols > 0 ? options.cols : 80;
    const initialRows = options?.rows && options.rows > 0 ? options.rows : 24;

    try {
      logger.info(
        { sessionId, tmuxSessionName, cols: initialCols, rows: initialRows },
        'Starting PTY streaming',
      );

      // Spawn a process that attaches to the tmux session in interactive mode
      // Use = prefix for exact match to avoid colon interpretation
      const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', `=${tmuxSessionName}`], {
        name: 'xterm-256color',
        cols: initialCols,
        rows: initialRows,
        cwd: process.cwd(),
        env: process.env as { [key: string]: string },
      });

      // Store the session. Both per-provider terminal policies are resolved ONCE here
      // (never per-frame in the onData hot path): LF normalization, and whether this
      // provider is a full-screen TUI that keeps the alternate screen.
      const usesAlternateScreen = this.sessionsService.usesAlternateScreenFor(sessionId);
      this.activeSessions.set(sessionId, {
        sessionId,
        tmuxSessionName,
        ptyProcess,
        needsLfNormalize: this.sessionsService.shouldNormalizeLfFor(sessionId),
        usesAlternateScreen,
        loggedPath: false,
      });

      // Alt-screen policy is PER-PROVIDER (set on the tmux window by the launch/restore
      // pipeline via setAlternateScreen). For non-TUI providers (the default) we ALSO
      // strip the `?1049/?1047/?47` DECSET toggles from the stream below so output stays
      // on the primary buffer and accumulates scrollback. For TUI providers
      // (usesAlternateScreen=true, e.g. OpenCode) we keep alt-screen on AND skip that
      // strip, preserving the combined `?1049;1000h` so mouse-tracking survives.

      // Subscribe to FrameStream for activity detection (data frames drive busy/idle state)
      this.terminalActivity.watchSession(sessionId, Date.now() + ACTIVITY_SUPPRESSION_MS);

      // Listen to data from the PTY
      ptyProcess.onData((data: string) => {
        const sess = this.activeSessions.get(sessionId);
        if (!sess) {
          // Session was removed (e.g., disconnected) but PTY still firing events
          return;
        }
        if (!sess.loggedPath) {
          logger.info(
            {
              sessionId,
              lfNormalize: sess.needsLfNormalize,
              usesAlternateScreen: sess.usesAlternateScreen,
            },
            sess.usesAlternateScreen
              ? 'PTY data flowing (alt-screen preserved — strip skipped for TUI provider)'
              : 'PTY data flowing (alt-screen strip active)',
          );
          sess.loggedPath = true;
        }
        // Skip the strip for full-screen TUI providers so the combined `?1049;1000h`
        // (alt-screen + mouse-tracking) is preserved; strip for everyone else.
        let processed = sess.usesAlternateScreen ? data : stripAlternateScreenSequences(data);
        if (sess.needsLfNormalize) {
          processed = normalizeLineEndings(processed);
        }
        // Broadcast so client xterm also preserves scrollback
        this.terminalGateway.broadcastTerminalData(sessionId, processed);
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
      session.ptyProcess.resize(cols, rows);
      // Suppress activity after resize to ignore tmux redraw burst
      this.terminalActivity.updateSuppression(sessionId, Date.now() + ACTIVITY_SUPPRESSION_MS);
      logger.info({ sessionId, cols, rows }, 'PTY resized');
    } catch (error) {
      logger.error({ sessionId, cols, rows, error }, 'Error resizing PTY');
    }
  }

  /**
   * Check if a session is actively streaming
   */
  isStreaming(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  /**
   * Send a brief resize jiggle (shrink then restore) to prompt the TUI to repaint with
   * the new theme colors. Best-effort: skipped when dimensions are unavailable, errors
   * are logged and swallowed. Note: some TUIs that do not honor SIGWINCH may still require
   * a manual redraw or restart to adopt the new theme.
   */
  async triggerRedraw(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const { cols, rows } = session.ptyProcess;
    if (!cols || cols <= 0 || !rows || rows <= 0) return;

    try {
      session.ptyProcess.resize(cols, Math.max(1, rows - 1));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      session.ptyProcess.resize(cols, rows);
      this.terminalActivity.updateSuppression(sessionId, Date.now() + ACTIVITY_SUPPRESSION_MS);
      logger.debug({ sessionId, cols, rows }, 'terminal_theme_redraw_triggered');
    } catch (error) {
      logger.debug({ sessionId, error: String(error) }, 'terminal_theme_redraw_failed');
    }
  }
}
