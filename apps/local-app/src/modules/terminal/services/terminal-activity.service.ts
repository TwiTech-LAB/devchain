import {
  Injectable,
  Inject,
  forwardRef,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { createLogger } from '../../../common/logging/logger';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { SettingsService } from '../../settings/services/settings.service';
import { DEFAULT_ACTIVITY_IDLE_TIMEOUT_MS } from '../../settings/services/settings.constants';
import { PendingAskUserQuestionService } from '../../hooks/services/pending-ask-user-question.service';
import { providerTraits } from '../../providers/adapters/provider-traits';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import type { FrameEvent } from './terminal-session/terminal-frame-stream';
import { createMeaningfulOutputPredicate } from '../utils/terminal-activity';
import {
  SESSION_TRANSCRIPT_TURN_SIGNAL,
  SESSION_TURN_HOOK_SIGNAL,
  type SessionTranscriptTurnSignal,
  type SessionTurnHookSignal,
} from './session-turn-signals';

const logger = createLogger('TerminalActivityService');

/**
 * A turn that started from turn evidence ends only with turn evidence. If none arrives, the
 * session goes idle after this long without meaningful output or transcript growth.
 */
export const TURN_FALLBACK_IDLE_MS = 10 * 60 * 1000;
/** Copilot repaints its screen right after `Stop`; that output does not start a new turn. */
export const POST_STOP_OUTPUT_GRACE_MS = 2000;

/** What keeps a busy session busy: recent output, or an open turn. */
type BusyHold = 'output' | 'turn';

interface TurnRecord {
  /** Latest proof that a turn opened / ended (epoch ms); orders late or stale evidence. */
  openedAtMs: number;
  closedAtMs: number;
  /** Claude: turn evidence arrived, so output alone no longer starts busy. */
  hasTurnEvidence: boolean;
  /** Latest transcript turn state; null when unknown. */
  transcriptOpen: boolean | null;
  hold: BusyHold | null;
  outputIgnoredUntil: number;
}

interface SessionRow {
  status: string;
  activity_state: string | null;
  provider_name_at_launch: string | null;
}

@Injectable()
export class TerminalActivityService implements OnApplicationBootstrap, OnModuleDestroy {
  private sqlite: ReturnType<typeof getRawSqliteClient>;
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastSignalAt = new Map<string, number>();
  private readonly fallbackTimers = new Map<string, NodeJS.Timeout>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly turns = new Map<string, TurnRecord>();
  private readonly suppressUntil = new Map<string, number>();
  private readonly frameListeners = new Map<string, (frame: FrameEvent) => void>();
  private idleAfterMs: number = DEFAULT_ACTIVITY_IDLE_TIMEOUT_MS;

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    private readonly eventEmitter: EventEmitter2,
    private readonly settingsService: SettingsService,
    @Inject(forwardRef(() => TerminalSessionRegistry))
    private readonly registry: TerminalSessionRegistry,
    @Optional() private readonly pendingQuestions?: PendingAskUserQuestionService,
  ) {
    this.sqlite = getRawSqliteClient(db);
    this.refreshIdleTimeout();
    logger.info('TerminalActivityService initialized');
  }

  /** The idle timeout currently applied to newly scheduled idle transitions. */
  get idleTimeoutMs(): number {
    return this.idleAfterMs;
  }

  /**
   * A stored `busy` survives a restart, but its timers do not. Give each one a deadline: the
   * output timeout for output-driven providers, the turn fallback for turn-evidence providers
   * (their transcript watcher reports the real turn state when it attaches).
   */
  onApplicationBootstrap(): void {
    const rows = this.sqlite
      .prepare(
        `SELECT id, provider_name_at_launch FROM sessions
          WHERE status = 'running' AND activity_state = 'busy'`,
      )
      .all() as Array<{ id: string; provider_name_at_launch: string | null }>;
    for (const row of rows) {
      const traits = providerTraits(row.provider_name_at_launch);
      const turn = this.turnRecord(row.id);
      if (turn.hold !== null) continue;
      if (traits.transcriptTurns) {
        turn.hold = 'turn';
        this.armFallback(row.id);
      } else {
        turn.hold = 'output';
        this.lastSignalAt.set(row.id, Date.now());
        this.scheduleIdle(row.id);
      }
    }
  }

  /**
   * A replica apply may overwrite `activity.idleTimeoutMs` inside its own
   * transaction; `remote.project.synced` is its post-commit wake-up, so the
   * new value takes effect without a restart. Re-reading on every sync is
   * idempotent when the value did not change.
   */
  @OnEvent('remote.project.synced', { async: true })
  handleRemoteProjectSynced(): void {
    this.refreshIdleTimeout();
  }

  @OnEvent(SESSION_TURN_HOOK_SIGNAL)
  handleTurnHook(signal: SessionTurnHookSignal): void {
    try {
      if (signal.kind === 'prompt-submitted') this.promptSubmitted(signal);
      else this.turnStopped(signal);
    } catch (error) {
      logger.warn({ error, sessionId: signal.sessionId }, 'Failed to apply turn hook');
    }
  }

  @OnEvent(SESSION_TRANSCRIPT_TURN_SIGNAL)
  handleTranscriptTurn(signal: SessionTranscriptTurnSignal): void {
    try {
      this.transcriptTurn(signal);
    } catch (error) {
      logger.warn({ error, sessionId: signal.sessionId }, 'Failed to apply transcript turn');
    }
  }

  private refreshIdleTimeout(): void {
    const configured = Number(this.settingsService.getSetting('activity.idleTimeoutMs'));
    const resolved =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ACTIVITY_IDLE_TIMEOUT_MS;
    if (resolved === this.idleAfterMs) return;
    logger.info({ idleTimeoutMs: resolved }, 'Idle timeout refreshed');
    this.idleAfterMs = resolved;
    // Pending idle transitions move to the new deadline, counted from each session's last activity.
    for (const sessionId of this.idleTimers.keys()) this.scheduleIdle(sessionId);
    // armHeartbeat deletes and re-adds its key, which a live key iteration would visit again.
    for (const sessionId of [...this.heartbeatTimers.keys()]) this.armHeartbeat(sessionId);
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

  /** Remove a session's frame listener, timers and turn record. */
  clearSession(sessionId: string): void {
    this.clearTimers(sessionId);
    this.lastSignalAt.delete(sessionId);
    this.turns.delete(sessionId);

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
    for (const timers of [this.idleTimers, this.fallbackTimers, this.heartbeatTimers]) {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    }
  }

  private readSession(sessionId: string): SessionRow | undefined {
    return this.sqlite
      .prepare(`SELECT status, activity_state, provider_name_at_launch FROM sessions WHERE id = ?`)
      .get(sessionId) as SessionRow | undefined;
  }

  private turnRecord(sessionId: string): TurnRecord {
    let turn = this.turns.get(sessionId);
    if (!turn) {
      turn = {
        openedAtMs: Number.NEGATIVE_INFINITY,
        closedAtMs: Number.NEGATIVE_INFINITY,
        hasTurnEvidence: false,
        transcriptOpen: null,
        hold: null,
        outputIgnoredUntil: 0,
      };
      this.turns.set(sessionId, turn);
    }
    return turn;
  }

  /** Meaningful terminal output. */
  private signal(sessionId: string): void {
    const row = this.readSession(sessionId);
    if (row?.status !== 'running') return;
    const turn = this.turnRecord(sessionId);
    const busy = row.activity_state === 'busy';
    const now = Date.now();

    switch (providerTraits(row.provider_name_at_launch).activity) {
      case 'hook-and-transcript':
        // With turn evidence, output inside a turn only proves it is alive, and output after
        // the turn (the input box, a repaint) is not a turn.
        if (turn.hasTurnEvidence) {
          this.touchTurn(sessionId, turn, busy);
          return;
        }
        break;
      case 'transcript':
        if (turn.transcriptOpen === true) {
          this.holdByTurn(sessionId, busy);
          return;
        }
        break;
      case 'stop-hook':
        if (now < turn.outputIgnoredUntil) return;
        break;
      case 'output':
        break;
    }
    this.holdByOutput(sessionId, busy);
  }

  /** Claude accepted a prompt: a turn is open until its end evidence. */
  private promptSubmitted(signal: SessionTurnHookSignal): void {
    const row = this.readSession(signal.sessionId);
    if (row?.status !== 'running') return;
    const turn = this.turnRecord(signal.sessionId);
    // A prompt hook that arrives after a later Stop belongs to an earlier turn.
    if (!this.openClaudeTurn(turn, signal.firedAtMs)) return;
    this.holdByTurn(signal.sessionId, row.activity_state === 'busy');
  }

  private turnStopped(signal: SessionTurnHookSignal): void {
    const row = this.readSession(signal.sessionId);
    if (row?.status !== 'running') return;
    const turn = this.turnRecord(signal.sessionId);
    const policy = providerTraits(row.provider_name_at_launch).activity;
    if (policy === 'hook-and-transcript') {
      // A Stop from before the latest prompt ended the previous turn, not this one.
      if (!this.closeClaudeTurn(turn, signal.firedAtMs)) return;
    } else if (policy === 'stop-hook') {
      turn.outputIgnoredUntil = Date.now() + POST_STOP_OUTPUT_GRACE_MS;
    }
    this.endTurn(signal.sessionId, row.activity_state === 'busy');
  }

  private transcriptTurn(signal: SessionTranscriptTurnSignal): void {
    const row = this.readSession(signal.sessionId);
    if (row?.status !== 'running') return;
    const traits = providerTraits(row.provider_name_at_launch);
    if (!traits.transcriptTurns) return;
    const turn = this.turnRecord(signal.sessionId);
    const busy = row.activity_state === 'busy';
    const state = signal.turn;

    if (!state) {
      if (signal.grew) this.touchTurn(signal.sessionId, turn, busy);
      return;
    }
    turn.transcriptOpen = state.open;

    if (traits.activity === 'transcript') {
      if (state.open) this.holdByTurn(signal.sessionId, busy, signal.grew);
      else this.endTurn(signal.sessionId, busy);
      return;
    }

    const atMs = state.atMs ?? Date.now();
    if (state.open) {
      // An open turn the transcript wrote before the latest Stop is that turn, already ended.
      if (this.openClaudeTurn(turn, atMs)) this.holdByTurn(signal.sessionId, busy, signal.grew);
      return;
    }
    // The end of a turn older than the latest prompt does not end the new turn.
    if (!this.closeClaudeTurn(turn, atMs)) {
      if (signal.grew) this.touchTurn(signal.sessionId, turn, busy);
      return;
    }
    this.endTurn(signal.sessionId, busy);
  }

  /** Claude open evidence at `atMs`; false when a later turn end already covers it. */
  private openClaudeTurn(turn: TurnRecord, atMs: number): boolean {
    turn.hasTurnEvidence = true;
    if (atMs <= turn.closedAtMs) return false;
    turn.openedAtMs = Math.max(turn.openedAtMs, atMs);
    return true;
  }

  /** Claude end evidence at `atMs`; false when it predates the latest prompt. */
  private closeClaudeTurn(turn: TurnRecord, atMs: number): boolean {
    turn.hasTurnEvidence = true;
    if (atMs < turn.openedAtMs) return false;
    turn.closedAtMs = Math.max(turn.closedAtMs, atMs);
    return true;
  }

  /** Busy while output continues; idle after the output timeout. */
  private holdByOutput(sessionId: string, busy: boolean): void {
    const turn = this.turnRecord(sessionId);
    this.clearTurnTimers(sessionId);
    turn.hold = 'output';
    this.markBusy(sessionId, busy);
    this.lastSignalAt.set(sessionId, Date.now());
    this.scheduleIdle(sessionId);
  }

  /**
   * Busy for the whole turn, through quiet tool runs and question waits, until the turn's end
   * evidence (or the fallback). `alive` restarts the fallback window.
   */
  private holdByTurn(sessionId: string, busy: boolean, alive = true): void {
    const turn = this.turnRecord(sessionId);
    const wasHeld = busy && turn.hold === 'turn';
    this.clearTimer(this.idleTimers, sessionId);
    this.lastSignalAt.delete(sessionId);
    turn.hold = 'turn';
    if (!wasHeld) this.markBusy(sessionId, busy);
    if (!wasHeld || alive || !this.fallbackTimers.has(sessionId)) this.armFallback(sessionId);
    if (!this.heartbeatTimers.has(sessionId)) this.armHeartbeat(sessionId);
  }

  /** Output or transcript growth inside a held turn: the turn is alive. */
  private touchTurn(sessionId: string, turn: TurnRecord, busy: boolean): void {
    if (busy && turn.hold === 'turn') this.armFallback(sessionId);
  }

  private endTurn(sessionId: string, busy: boolean): void {
    const turn = this.turnRecord(sessionId);
    const heldByTurn = turn.hold === 'turn';
    this.clearTimers(sessionId);
    this.lastSignalAt.delete(sessionId);
    turn.hold = null;
    // The question belongs to the turn that asked it. If its PostToolUse never arrived, this
    // keeps the entry from holding the next turn open.
    this.pendingQuestions?.clearBySession(sessionId);
    // A turn's busy time runs to its end: stamp it, so agent time stops exactly there.
    if (busy) this.transitionToIdle(sessionId, heldByTurn);
  }

  private markBusy(sessionId: string, busy: boolean): void {
    if (busy) {
      this.stampLastActivity(sessionId);
      return;
    }
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `UPDATE sessions SET activity_state = 'busy', busy_since = ?, last_activity_at = ?,
                updated_at = ? WHERE id = ?`,
      )
      .run(now, now, now, sessionId);
    this.eventEmitter.emit('session.activity.changed', {
      sessionId,
      state: 'busy',
      lastActivityAt: now,
      busySince: now,
    });
  }

  private scheduleIdle(sessionId: string): void {
    const prior = this.idleTimers.get(sessionId);
    if (prior) clearTimeout(prior);
    const elapsed = Date.now() - (this.lastSignalAt.get(sessionId) ?? Date.now());
    this.idleTimers.set(
      sessionId,
      setTimeout(
        () => {
          this.idleTimers.delete(sessionId);
          const turn = this.turns.get(sessionId);
          if (turn) turn.hold = null;
          this.transitionToIdle(sessionId, false);
        },
        Math.max(0, this.idleAfterMs - elapsed),
      ),
    );
  }

  private armFallback(sessionId: string): void {
    this.clearTimer(this.fallbackTimers, sessionId);
    const timer = setTimeout(() => {
      this.fallbackTimers.delete(sessionId);
      // An open question is part of the turn: the provider waits for the answer, not for us.
      if (this.pendingQuestions?.hasPendingQuestion(sessionId)) {
        this.armFallback(sessionId);
        return;
      }
      logger.info({ sessionId }, 'No turn end evidence — idle after the turn fallback');
      const row = this.readSession(sessionId);
      this.endTurn(sessionId, row?.activity_state === 'busy');
    }, TURN_FALLBACK_IDLE_MS);
    timer.unref?.();
    this.fallbackTimers.set(sessionId, timer);
  }

  /**
   * Agent time accounting reads `last_activity_at` and splits on gaps longer than the idle
   * timeout. An open turn stamps it more often than that, so a quiet tool run or a question
   * wait stays one continuous stretch of agent time.
   */
  private armHeartbeat(sessionId: string): void {
    this.clearTimer(this.heartbeatTimers, sessionId);
    const intervalMs = Math.max(1000, Math.floor(this.idleAfterMs / 3));
    const timer = setInterval(() => {
      const row = this.readSession(sessionId);
      if (row?.status !== 'running' || row.activity_state !== 'busy') {
        this.clearTimer(this.heartbeatTimers, sessionId);
        return;
      }
      this.stampLastActivity(sessionId);
    }, intervalMs);
    timer.unref?.();
    this.heartbeatTimers.set(sessionId, timer);
  }

  /** Agent time reads `last_activity_at`; a busy session's activity moves it forward. */
  private stampLastActivity(sessionId: string): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(`UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, sessionId);
  }

  private clearTimer(timers: Map<string, NodeJS.Timeout>, sessionId: string): void {
    const timer = timers.get(sessionId);
    if (timer) clearTimeout(timer);
    timers.delete(sessionId);
  }

  private clearTurnTimers(sessionId: string): void {
    this.clearTimer(this.fallbackTimers, sessionId);
    this.clearTimer(this.heartbeatTimers, sessionId);
  }

  private clearTimers(sessionId: string): void {
    this.clearTimer(this.idleTimers, sessionId);
    this.clearTurnTimers(sessionId);
  }

  private transitionToIdle(sessionId: string, stampActivity: boolean): void {
    const row = this.readSession(sessionId);
    if (row?.status !== 'running') return;

    const now = new Date().toISOString();
    if (stampActivity) {
      this.sqlite
        .prepare(
          `UPDATE sessions SET activity_state = 'idle', last_activity_at = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(now, now, sessionId);
    } else {
      this.sqlite
        .prepare(`UPDATE sessions SET activity_state = 'idle', updated_at = ? WHERE id = ?`)
        .run(now, sessionId);
    }
    this.eventEmitter.emit('session.activity.changed', {
      sessionId,
      state: 'idle',
      lastActivityAt: null,
      busySince: null,
    });
  }
}
