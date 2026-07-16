import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../../common/logging/logger';
import { TerminalDataPayload, WsEnvelope, createEnvelope } from '../dtos/ws-envelope.dto';
import { MetricsService } from '../../metrics/services/metrics.service';
import { estimateObjectBytes } from '../../metrics/helpers/byte-accounting.helper';
import type { FrameBufferStats } from '../../metrics/types/metrics.types';

const logger = createLogger('TerminalStreamService');

/**
 * One sequence-domain. `sequenceEpoch` is opaque and restart-unique: a cleared-then-recreated
 * buffer receives a NEW epoch, so a client comparing its retained (epoch, sequence) cursor can tell
 * "same domain, replay by number" from "fresh domain, accept the lower numbers". `currentSequence`
 * and `recoveryCounter` are domain-local: both survive a quick stop→restore (the buffer is retained)
 * and reset only when the buffer is cleared and a new domain is minted.
 */
interface FrameBuffer {
  frames: WsEnvelope[];
  bytes: number;
  maxSize: number;
  sequenceEpoch: string;
  currentSequence: number;
  recoveryCounter: number;
}

export const MAX_TERMINAL_FRAME_BYTES = 64 * 1024;
export const MAX_REPLAY_BUFFER_BYTES = 1024 * 1024;

/** Atomic snapshot of a domain's cursor: the epoch and its live sequence read together. */
export interface SequenceCursor {
  sequenceEpoch: string;
  currentSequence: number;
}

/** A reconnect cursor as sent by the client — the epoch it holds plus its last-seen sequence. */
export interface ReconnectCursor {
  sequenceEpoch: string;
  sequence: number;
}

export type FrameReplayResult =
  | {
      status: 'covered';
      frames: WsEnvelope[];
      currentSequence: number;
    }
  | {
      status: 'gap';
      currentSequence: number;
      earliestAvailableSequence?: number;
      discontinuitySequence?: number;
    };

/**
 * Epoch-aware reconnect classification: the same shape as a same-domain replay plus the live
 * domain's `sequenceEpoch` (so the caller's `subscribed` ack and its replay decision come from one
 * atomic read) and a `domainMismatch` flag when the client's epoch belongs to a retired domain.
 */
export type ReconnectReplayResult = FrameReplayResult & {
  sequenceEpoch: string;
  domainMismatch?: boolean;
};

/**
 * Service for managing terminal frame buffering and replay
 */
@Injectable()
export class TerminalStreamService implements OnModuleInit, OnModuleDestroy {
  private frameBuffers: Map<string, FrameBuffer> = new Map();
  private discontinuitySequences: Map<string, number> = new Map();
  private retentionPaused: Set<string> = new Set();
  private readonly MAX_BUFFER_SIZE = 100;
  /**
   * Pending stopped-session replay-retention clears, owned here because this service owns the
   * FrameBuffer they clear (the sequence-domain). Scheduling/cancelling lives on the domain owner so
   * a restore can cancel it SYNCHRONOUSLY at its true start — an event-published cancel arrives too
   * late and would clear a domain the restore is reusing.
   */
  private readonly scheduledClears = new Map<string, { timer: NodeJS.Timeout; delayMs: number }>();
  /** Gateway-owned side effect run when a scheduled clear actually expires (see setClearExpiryHandler). */
  private clearExpiryHandler?: (sessionId: string) => void;

  constructor(private readonly metricsService: MetricsService) {}

  onModuleInit(): void {
    this.metricsService.registerStatsProvider('frameBuffers', () => this.getFrameBufferStats());
  }

  onModuleDestroy(): void {
    for (const { timer } of this.scheduledClears.values()) clearTimeout(timer);
    this.scheduledClears.clear();
  }

  getFrameBufferStats(): FrameBufferStats {
    let totalFrames = 0;
    let bytesEstimated = 0;
    for (const buffer of this.frameBuffers.values()) {
      totalFrames += buffer.frames.length;
      bytesEstimated += estimateObjectBytes(buffer.frames);
    }
    return {
      sessions: this.frameBuffers.size,
      totalFrames,
      bytesEstimated,
      maxBufferCapacity: this.MAX_BUFFER_SIZE,
    };
  }

  /**
   * Initialize frame buffer for session. A newly minted buffer receives a fresh opaque
   * `sequenceEpoch` (restart-unique) with `currentSequence` and `recoveryCounter` at 0 — i.e. a new
   * sequence-domain. Idempotent: an existing buffer (including one retained across a quick
   * stop→restore) keeps its epoch, sequence, and recovery counter.
   */
  initializeBuffer(sessionId: string): void {
    this.ensureBuffer(sessionId);
  }

  private ensureBuffer(sessionId: string): FrameBuffer {
    let buffer = this.frameBuffers.get(sessionId);
    if (!buffer) {
      buffer = {
        frames: [],
        bytes: 0,
        maxSize: this.MAX_BUFFER_SIZE,
        sequenceEpoch: randomUUID(),
        currentSequence: 0,
        recoveryCounter: 0,
      };
      this.frameBuffers.set(sessionId, buffer);
      logger.info({ sessionId, sequenceEpoch: buffer.sequenceEpoch }, 'Initialized frame buffer');
    }
    return buffer;
  }

  /**
   * Add frame to buffer with sequence number
   */
  addFrame(sessionId: string, data: string): WsEnvelope[] {
    const buffer = this.ensureBuffer(sessionId);
    const envelopes: WsEnvelope[] = [];

    for (const chunk of this.chunkUtf8(data)) {
      const sequence = this.nextSequence(buffer);
      const payload: TerminalDataPayload = { data: chunk, sequence };
      const envelope = createEnvelope(`terminal/${sessionId}`, 'data', payload);
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      buffer.frames.push(envelope);
      buffer.bytes += chunkBytes;
      envelopes.push(envelope);

      while (buffer.frames.length > buffer.maxSize || buffer.bytes > MAX_REPLAY_BUFFER_BYTES) {
        const evicted = buffer.frames.shift();
        if (!evicted) break;
        buffer.bytes -= Buffer.byteLength((evicted.payload as TerminalDataPayload).data, 'utf8');
      }
    }

    return envelopes;
  }

  /** Reserve one missing sequence for a gated period; repeated unwatched output shares it. */
  markDiscontinuous(sessionId: string): number {
    const buffer = this.ensureBuffer(sessionId);
    const existing = this.discontinuitySequences.get(sessionId);
    if (this.retentionPaused.has(sessionId) && existing !== undefined) return existing;

    const discontinuitySequence = this.nextSequence(buffer);
    this.discontinuitySequences.set(sessionId, discontinuitySequence);
    this.retentionPaused.add(sessionId);
    return discontinuitySequence;
  }

  resumeRetention(sessionId: string): void {
    this.retentionPaused.delete(sessionId);
  }

  private chunkUtf8(data: string): string[] {
    if (Buffer.byteLength(data, 'utf8') <= MAX_TERMINAL_FRAME_BYTES) return [data];
    const chunks: string[] = [];
    let chunk = '';
    let chunkBytes = 0;

    for (const codePoint of data) {
      const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
      if (chunkBytes + codePointBytes > MAX_TERMINAL_FRAME_BYTES && chunk.length > 0) {
        chunks.push(chunk);
        chunk = '';
        chunkBytes = 0;
      }
      chunk += codePoint;
      chunkBytes += codePointBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
  }

  /**
   * Get buffered frames since sequence number (for replay)
   */
  getFramesSince(sessionId: string, lastSequence?: number): FrameReplayResult {
    const buffer = this.frameBuffers.get(sessionId);
    const currentSequence = this.getCurrentSequence(sessionId);
    if (!buffer) {
      return lastSequence === undefined || lastSequence === currentSequence
        ? { status: 'covered', frames: [], currentSequence }
        : { status: 'gap', currentSequence };
    }

    if (lastSequence === undefined) {
      return { status: 'covered', frames: [...buffer.frames], currentSequence };
    }

    const firstFrame = buffer.frames[0];
    const earliestAvailableSequence = firstFrame
      ? (firstFrame.payload as TerminalDataPayload).sequence
      : undefined;
    const hasMissingPrefix =
      earliestAvailableSequence !== undefined && lastSequence < earliestAvailableSequence - 1;
    const predatesUnretainedOutput = buffer.frames.length === 0 && lastSequence < currentSequence;
    const isAheadOfStream = lastSequence > currentSequence;
    const discontinuitySequence = this.discontinuitySequences.get(sessionId);
    const predatesDiscontinuity =
      discontinuitySequence !== undefined && lastSequence < discontinuitySequence;

    if (hasMissingPrefix || predatesUnretainedOutput || isAheadOfStream || predatesDiscontinuity) {
      return {
        status: 'gap',
        currentSequence,
        ...(earliestAvailableSequence !== undefined && { earliestAvailableSequence }),
        ...(predatesDiscontinuity && { discontinuitySequence }),
      };
    }

    return {
      status: 'covered',
      currentSequence,
      frames: buffer.frames.filter((frame) => {
        const payload = frame.payload as TerminalDataPayload;
        return payload.sequence !== undefined && payload.sequence > lastSequence;
      }),
    };
  }

  /**
   * Clear buffer for session. This retires the sequence-domain: the next `initializeBuffer` mints a
   * fresh `sequenceEpoch` and resets the sequence and recovery counter, so a client still holding
   * the old epoch is treated as a domain mismatch rather than replayed by stale number.
   */
  clearBuffer(sessionId: string): void {
    this.frameBuffers.delete(sessionId);
    this.discontinuitySequences.delete(sessionId);
    this.retentionPaused.delete(sessionId);
    logger.info({ sessionId }, 'Cleared frame buffer');
  }

  /**
   * Register the side effect to run when a scheduled clear actually EXPIRES (as opposed to being
   * cancelled) — the gateway uses this to retire in-flight recoveries bound to the now-retired
   * sequence-domain. Registered as a runtime callback rather than a constructor dependency so the
   * gateway → stream-service direction stays acyclic.
   */
  setClearExpiryHandler(handler: (sessionId: string) => void): void {
    this.clearExpiryHandler = handler;
  }

  /**
   * Schedule a delayed buffer clear (stopped-session replay retention). Re-arming replaces any
   * pending clear for the session. On expiry the buffer is cleared — retiring the sequence-domain —
   * and the registered expiry handler runs. The single-threaded event loop makes a later
   * cancelScheduledClear atomic with respect to this firing, so the documented invariant "cancelled
   * synchronously before any await" holds without extra locking.
   */
  scheduleClear(sessionId: string, delayMs: number): void {
    this.cancelScheduledClear(sessionId);
    const timer = setTimeout(() => {
      this.scheduledClears.delete(sessionId);
      this.clearBuffer(sessionId);
      this.clearExpiryHandler?.(sessionId);
    }, delayMs);
    timer.unref();
    this.scheduledClears.set(sessionId, { timer, delayMs });
  }

  /**
   * Cancel a pending scheduled clear. Returns the retention delay that was pending — so a caller
   * (e.g. a restore rollback) can re-arm the same retention without owning the duration — or null
   * when nothing was scheduled. Idempotent.
   */
  cancelScheduledClear(sessionId: string): number | null {
    const pending = this.scheduledClears.get(sessionId);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.scheduledClears.delete(sessionId);
    return pending.delayMs;
  }

  /** Whether a delayed clear is currently pending for the session. */
  hasScheduledClear(sessionId: string): boolean {
    return this.scheduledClears.has(sessionId);
  }

  /**
   * Get current sequence number for session (0 when no domain exists yet).
   */
  getCurrentSequence(sessionId: string): number {
    return this.frameBuffers.get(sessionId)?.currentSequence ?? 0;
  }

  /**
   * Get the current sequence-domain epoch, or `undefined` when no domain exists yet.
   */
  getSequenceEpoch(sessionId: string): string | undefined {
    return this.frameBuffers.get(sessionId)?.sequenceEpoch;
  }

  /**
   * Atomically sample the live cursor (epoch + sequence read from one buffer). Callers that emit the
   * `subscribed` ack or a `full_history`/recovery watermark MUST use this instead of reading the
   * epoch and sequence separately, so an intervening domain reset cannot pair a new epoch with a
   * stale sequence. Ensures a domain exists (mints one if absent).
   */
  sampleCursor(sessionId: string): SequenceCursor {
    const buffer = this.ensureBuffer(sessionId);
    return { sequenceEpoch: buffer.sequenceEpoch, currentSequence: buffer.currentSequence };
  }

  /**
   * Allocate the next recovery counter within the current domain. Retained across a quick
   * stop→restore (the buffer survives) and reset to 0 only when the buffer is cleared — so
   * recovery A/6 then quick restore allocates A/7, while a fresh domain restarts at B/1.
   */
  nextRecoveryCounter(sessionId: string): number {
    const buffer = this.ensureBuffer(sessionId);
    buffer.recoveryCounter += 1;
    return buffer.recoveryCounter;
  }

  /**
   * Epoch-aware reconnect classification. A cursor whose `sequenceEpoch` matches the live domain is
   * replayed by number (current covered/gap semantics); a cursor from a retired domain is a
   * deterministic gap (`domainMismatch`), so its stale-but-higher sequence never suppresses fresh
   * lower-numbered output. Ensures a domain exists so the returned epoch is always concrete.
   */
  getReconnectReplay(sessionId: string, cursor: ReconnectCursor): ReconnectReplayResult {
    const buffer = this.ensureBuffer(sessionId);
    if (cursor.sequenceEpoch !== buffer.sequenceEpoch) {
      return {
        status: 'gap',
        currentSequence: buffer.currentSequence,
        sequenceEpoch: buffer.sequenceEpoch,
        domainMismatch: true,
      };
    }
    return {
      ...this.getFramesSince(sessionId, cursor.sequence),
      sequenceEpoch: buffer.sequenceEpoch,
    };
  }

  private nextSequence(buffer: FrameBuffer): number {
    buffer.currentSequence += 1;
    return buffer.currentSequence;
  }

  /**
   * Get buffer stats for monitoring
   */
  getBufferStats(sessionId: string): { size: number; bytes: number; sequence: number } | null {
    const buffer = this.frameBuffers.get(sessionId);
    if (!buffer) {
      return null;
    }

    return {
      size: buffer.frames.length,
      bytes: buffer.bytes,
      sequence: buffer.currentSequence,
    };
  }
}
