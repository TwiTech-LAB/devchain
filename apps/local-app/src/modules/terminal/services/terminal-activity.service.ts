import { Injectable, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createLogger } from '../../../common/logging/logger';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { SettingsService } from '../../settings/services/settings.service';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import type { FrameEvent } from './terminal-session/terminal-frame-stream';
import { createMeaningfulOutputPredicate } from '../utils/terminal-activity';

const logger = createLogger('TerminalActivityService');

@Injectable()
export class TerminalActivityService implements OnModuleDestroy {
  private sqlite: ReturnType<typeof getRawSqliteClient>;
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly suppressUntil = new Map<string, number>();
  private readonly frameListeners = new Map<string, (frame: FrameEvent) => void>();
  private readonly IDLE_AFTER_MS: number;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly eventEmitter: EventEmitter2,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => TerminalSessionRegistry))
    private readonly registry: TerminalSessionRegistry,
  ) {
    this.sqlite = getRawSqliteClient(db);
    const configured = Number(this.settingsService.getSetting('activity.idleTimeoutMs'));
    this.IDLE_AFTER_MS = Number.isFinite(configured) && configured > 0 ? configured : 30000;
    logger.info('TerminalActivityService initialized');
  }

  /**
   * Subscribe to a session's FrameStream for activity detection.
   * Call once per session when PTY streaming starts.
   * @param suppressUntil timestamp (ms) before which data frames are ignored — suppresses
   *   initial tmux redraw burst and resize redraws.
   */
  watchSession(sessionId: string, suppressUntil = 0): void {
    const session = this.registry.get(sessionId);
    if (!session) {
      logger.warn({ sessionId }, 'watchSession: session not found in registry');
      return;
    }

    // Idempotent: remove stale listener before re-attaching
    const existing = this.frameListeners.get(sessionId);
    if (existing) {
      session.stream.off('frame', existing);
    }

    this.suppressUntil.set(sessionId, suppressUntil);
    const hasMeaningfulOutput = createMeaningfulOutputPredicate();

    const listener = (frame: FrameEvent) => {
      if (frame.type !== 'data') return;
      const payload = frame.payload as { data?: unknown };
      if (typeof payload?.data !== 'string') return;
      try {
        if (!hasMeaningfulOutput(payload.data)) return;
        if (Date.now() < (this.suppressUntil.get(sessionId) ?? 0)) return;
        this.signal(sessionId);
      } catch (error) {
        logger.warn({ sessionId, error }, 'Failed to signal activity');
      }
    };

    session.stream.on('frame', listener);
    this.frameListeners.set(sessionId, listener);
  }

  /** Extend the activity suppression window for a session (e.g. after PTY resize). */
  updateSuppression(sessionId: string, suppressUntil: number): void {
    this.suppressUntil.set(sessionId, suppressUntil);
  }

  /** Remove frame listener and cancel idle timer for a session. */
  clearSession(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }

    const listener = this.frameListeners.get(sessionId);
    if (listener) {
      const session = this.registry.get(sessionId);
      if (session) {
        session.stream.off('frame', listener);
      }
      this.frameListeners.delete(sessionId);
    }

    this.suppressUntil.delete(sessionId);
  }

  onModuleDestroy(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  getBufferSize(_sessionId: string): number {
    return 0;
  }

  private isSessionRunning(sessionId: string): boolean {
    const row = this.sqlite.prepare(`SELECT status FROM sessions WHERE id = ?`).get(sessionId) as
      | { status: string }
      | undefined;
    return row?.status === 'running';
  }

  private signal(sessionId: string): void {
    if (!this.isSessionRunning(sessionId)) return;

    const now = new Date().toISOString();
    this.sqlite
      .prepare(`UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, sessionId);

    const row = this.sqlite
      .prepare(`SELECT activity_state FROM sessions WHERE id = ?`)
      .get(sessionId) as { activity_state: string | null } | undefined;

    if (!row || row.activity_state !== 'busy') {
      this.sqlite
        .prepare(
          `UPDATE sessions SET activity_state = 'busy', busy_since = ?, updated_at = ? WHERE id = ?`,
        )
        .run(now, now, sessionId);
      this.eventEmitter.emit('session.activity.changed', {
        sessionId,
        state: 'busy',
        lastActivityAt: now,
        busySince: now,
      });
    }

    const prior = this.idleTimers.get(sessionId);
    if (prior) clearTimeout(prior);
    this.idleTimers.set(
      sessionId,
      setTimeout(() => this.transitionToIdle(sessionId), this.IDLE_AFTER_MS),
    );
  }

  private transitionToIdle(sessionId: string): void {
    if (!this.isSessionRunning(sessionId)) return;

    const now = new Date().toISOString();
    this.sqlite
      .prepare(`UPDATE sessions SET activity_state = 'idle', updated_at = ? WHERE id = ?`)
      .run(now, sessionId);
    this.eventEmitter.emit('session.activity.changed', {
      sessionId,
      state: 'idle',
      lastActivityAt: null,
      busySince: null,
    });
  }
}
