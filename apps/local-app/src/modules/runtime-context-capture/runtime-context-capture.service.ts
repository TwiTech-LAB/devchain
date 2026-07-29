import { Inject, Injectable, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { getRawSqliteClient } from '../storage/db/sqlite-raw';
import type {
  RuntimeContextCaptureReport,
  RuntimeContextCaptureResult,
  RuntimeContextCaptureSnapshot,
  RuntimeContextCaptureState,
  RuntimeContextConfiguredOverride,
  RuntimeContextWindowLiveState,
} from './runtime-context-capture.types';

interface CaptureEntry {
  epoch: string;
  state: RuntimeContextCaptureState | null;
  configuredOverride: RuntimeContextConfiguredOverride | null;
}

interface SessionEligibilityRow {
  status: string;
  provider_name_at_launch: string | null;
}

export const RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT = 'runtime-context-capture.tuple-changed';

export interface RuntimeContextCaptureTupleChangedPayload {
  readonly sessionId: string;
}

@Injectable()
export class RuntimeContextCaptureService {
  private readonly sqlite: Database.Database;
  private readonly entries = new Map<string, CaptureEntry>();

  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {
    this.sqlite = getRawSqliteClient(db);
  }

  rotateEpoch(
    sessionId: string,
    configuredOverride?: RuntimeContextConfiguredOverride | null,
  ): string {
    const epoch = randomUUID();
    this.entries.set(sessionId, {
      epoch,
      state: null,
      configuredOverride: configuredOverride ? { ...configuredOverride } : null,
    });
    return epoch;
  }

  capture(report: RuntimeContextCaptureReport): RuntimeContextCaptureResult {
    if (!this.isEligibleClaudeSession(report.sessionId)) {
      return { accepted: false, reason: 'session-ineligible' };
    }

    const existing = this.entries.get(report.sessionId);
    if (!existing) {
      const current = this.toState(report);
      this.entries.set(report.sessionId, {
        epoch: report.epoch,
        state: current,
        configuredOverride: null,
      });
      this.emitTupleChanged(report.sessionId);
      return this.acceptedResult('bound', current, null);
    }

    if (existing.epoch !== report.epoch) {
      return { accepted: false, reason: 'epoch-mismatch' };
    }

    if (!existing.state) {
      const current = this.toState(report);
      existing.state = current;
      this.emitTupleChanged(report.sessionId);
      return this.acceptedResult('bound', current, null);
    }

    if (report.sequence <= existing.state.sequence) {
      return { accepted: false, reason: 'sequence-not-increasing' };
    }

    const previous = existing.state;
    const current = this.toState(report);
    existing.state = current;

    const tupleChanged =
      previous.claudeSessionId !== current.claudeSessionId ||
      previous.modelId !== current.modelId ||
      previous.contextWindowTokens !== current.contextWindowTokens;

    if (tupleChanged) {
      this.emitTupleChanged(report.sessionId);
    }

    return this.acceptedResult(
      tupleChanged ? 'tuple-changed' : 'sequence-advanced',
      current,
      previous,
    );
  }

  get(sessionId: string): RuntimeContextCaptureState | null {
    const state = this.entries.get(sessionId)?.state;
    return state ? { ...state } : null;
  }

  getEpoch(sessionId: string): string | null {
    return this.entries.get(sessionId)?.epoch ?? null;
  }

  getLiveContext(sessionId: string): RuntimeContextWindowLiveState | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return {
      configuredOverride: entry.configuredOverride ? { ...entry.configuredOverride } : null,
      claudeCapture: entry.state ? { ...entry.state } : null,
    };
  }

  snapshot(sessionId: string): RuntimeContextCaptureSnapshot | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    return {
      epoch: entry.epoch,
      state: entry.state ? { ...entry.state } : null,
      configuredOverride: entry.configuredOverride ? { ...entry.configuredOverride } : null,
    };
  }

  restoreSnapshot(sessionId: string, snapshot: RuntimeContextCaptureSnapshot | null): void {
    if (!snapshot) {
      this.entries.delete(sessionId);
      return;
    }
    this.entries.set(sessionId, {
      epoch: snapshot.epoch,
      state: snapshot.state ? { ...snapshot.state } : null,
      configuredOverride: snapshot.configuredOverride ? { ...snapshot.configuredOverride } : null,
    });
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  private isEligibleClaudeSession(sessionId: string): boolean {
    const row = this.sqlite
      .prepare(
        `SELECT status, provider_name_at_launch
         FROM sessions
         WHERE id = ?`,
      )
      .get(sessionId) as SessionEligibilityRow | undefined;

    return row?.status === 'running' && row.provider_name_at_launch?.toLowerCase() === 'claude';
  }

  private toState(report: RuntimeContextCaptureReport): RuntimeContextCaptureState {
    return {
      sessionId: report.sessionId,
      epoch: report.epoch,
      sequence: report.sequence,
      claudeSessionId: report.claudeSessionId,
      modelId: report.modelId,
      contextWindowTokens: report.contextWindowTokens,
    };
  }

  private acceptedResult(
    change: 'bound' | 'tuple-changed' | 'sequence-advanced',
    current: RuntimeContextCaptureState,
    previous: RuntimeContextCaptureState | null,
  ): RuntimeContextCaptureResult {
    return {
      accepted: true,
      change,
      tupleChanged: change !== 'sequence-advanced',
      runtimeSessionChanged:
        previous === null || previous.claudeSessionId !== current.claudeSessionId,
      modelChanged: previous === null || previous.modelId !== current.modelId,
      contextWindowChanged:
        previous === null || previous.contextWindowTokens !== current.contextWindowTokens,
      current: { ...current },
    };
  }

  private emitTupleChanged(sessionId: string): void {
    this.eventEmitter?.emit(RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT, { sessionId });
  }
}
