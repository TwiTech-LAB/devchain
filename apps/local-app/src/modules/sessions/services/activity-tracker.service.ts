import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import { SettingsService } from '../../settings/services/settings.service';

const logger = createLogger('ActivityTrackerService');

@Injectable()
export class ActivityTrackerService {
  private sqlite: Database.Database;
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly IDLE_AFTER_MS: number;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    @Inject(forwardRef(() => TerminalGateway)) private readonly terminalGateway: TerminalGateway,
    private readonly settingsService: SettingsService,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.sqlite = (db as any).session?.client ?? db;
    const configured = Number(this.settingsService.getSetting('activity.idleTimeoutMs'));
    this.IDLE_AFTER_MS = Number.isFinite(configured) && configured > 0 ? configured : 30000;
  }
  /**
   * Signal terminal activity for a session. Busy/Idle persistence will be added later.
   */
  signal(sessionId: string): void {
    const now = new Date().toISOString();

    // Update last_activity_at immediately
    this.sqlite
      .prepare(`UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, sessionId);

    // Promote to busy if not already busy
    const row = this.sqlite
      .prepare(`SELECT activity_state, busy_since FROM sessions WHERE id = ?`)
      .get(sessionId) as { activity_state: string | null; busy_since: string | null } | undefined;

    if (!row || row.activity_state !== 'busy') {
      this.sqlite
        .prepare(
          `UPDATE sessions SET activity_state = 'busy', busy_since = ?, updated_at = ? WHERE id = ?`,
        )
        .run(now, now, sessionId);

      try {
        this.terminalGateway.broadcastEvent(`session/${sessionId}`, 'activity', {
          state: 'busy',
          lastActivityAt: now,
          busySince: now,
        });
      } catch (error) {
        logger.warn({ sessionId, error }, 'Failed to broadcast busy activity event');
      }
    } else {
      // already busy: still broadcast lastActivityAt updates at low verbosity if needed (skip to reduce noise)
    }

    // Reset idle timer
    const prior = this.idleTimers.get(sessionId);
    if (prior) clearTimeout(prior);
    const timeout = setTimeout(() => {
      this.transitionToIdle(sessionId);
    }, this.IDLE_AFTER_MS);
    this.idleTimers.set(sessionId, timeout);
  }

  private transitionToIdle(sessionId: string): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(`UPDATE sessions SET activity_state = 'idle', updated_at = ? WHERE id = ?`)
      .run(now, sessionId);
    try {
      this.terminalGateway.broadcastEvent(`session/${sessionId}`, 'activity', {
        state: 'idle',
        lastActivityAt: this.getLastActivityAt(sessionId),
        busySince: this.getBusySince(sessionId),
      });
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to broadcast idle activity event');
    }
  }

  private getLastActivityAt(sessionId: string): string | null {
    const row = this.sqlite
      .prepare(`SELECT last_activity_at FROM sessions WHERE id = ?`)
      .get(sessionId) as { last_activity_at: string | null } | undefined;
    return row?.last_activity_at ?? null;
  }

  private getBusySince(sessionId: string): string | null {
    const row = this.sqlite
      .prepare(`SELECT busy_since FROM sessions WHERE id = ?`)
      .get(sessionId) as { busy_since: string | null } | undefined;
    return row?.busy_since ?? null;
  }
}
