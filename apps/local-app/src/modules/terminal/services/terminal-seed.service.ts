import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  SettingsService,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
  MIN_TERMINAL_SEED_MAX_BYTES,
  MAX_TERMINAL_SEED_MAX_BYTES,
} from '../../settings/services/settings.service';
import { TerminalIOService } from './terminal-io/terminal-io.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import {
  createEnvelope,
  TerminalSeedPayload,
  TerminalSeedEmptyPayload,
} from '../dtos/ws-envelope.dto';
import type { WsEnvelope } from '../dtos/ws-envelope.dto';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import { normalizeLineEndings, stripFinalLineEnding } from '../utils/normalize-line-endings';

const logger = createLogger('TerminalSeedService');

interface CaptureCache {
  snapshot: string;
  timestamp: number;
  cols: number;
  rows: number;
}

export interface TerminalRecoverySeedWatermark {
  sequenceEpoch: string;
  recoveryEpoch: number;
  capturedSequence: number;
}

export const TerminalSeedDelivery = {
  Continue: 'continue',
  Abort: 'abort',
} as const;

export type TerminalSeedDeliveryDecision =
  (typeof TerminalSeedDelivery)[keyof typeof TerminalSeedDelivery];

export type TerminalSeedDeliver = (envelope: WsEnvelope) => TerminalSeedDeliveryDecision;

/**
 * Service responsible for terminal seeding logic:
 * - Config resolution (maxBytes from settings)
 * - Capture caching (2s TTL to reduce expensive tmux captures)
 * - Snapshot preparation (capture, strip newlines, chunk into 64KB pieces)
 * - Seed delivery through the caller-owned socket scheduler
 *
 * Seeding uses tmux ANSI capture exclusively. A successful empty initial capture emits a
 * non-writing `seed_empty` completion; a failed capture is skipped; resync may emit one
 * empty `seed_ansi` to clear stale client output.
 */
@Injectable()
export class TerminalSeedService {
  private readonly captureCache = new Map<string, CaptureCache>();
  private seedCaptureCount = 0;
  private readonly CAPTURE_CACHE_TTL = 2000; // 2 seconds
  private readonly SEED_CHUNK_SIZE = 64 * 1024; // 64KB chunks

  constructor(
    private readonly settingsService: SettingsService,
    private readonly terminalSessionRegistry: TerminalSessionRegistry,
    @Inject(forwardRef(() => TerminalIOService))
    private readonly terminalIO: TerminalIOService,
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
  ) {}

  /**
   * Resolve terminal payload configuration from settings.
   *
   * Returns the `maxBytes` limit used to cap WebSocket payload sizes for both:
   * - **Terminal seeding**: Initial terminal state sent on client connection
   * - **Full-history requests**: User-initiated scroll-up history loading
   *
   * Both paths share the same `terminal.seeding.maxBytes` setting by design:
   * - Default: 1MB (1,048,576 bytes)
   * - Minimum: 64KB (MIN_TERMINAL_SEED_MAX_BYTES)
   * - Maximum: 4MB (MAX_TERMINAL_SEED_MAX_BYTES)
   *
   * @returns Configuration object with maxBytes limit
   */
  resolveSeedingConfig(): { maxBytes: number } {
    let maxBytes = DEFAULT_TERMINAL_SEED_MAX_BYTES;
    try {
      const stored = this.settingsService.getSetting('terminal.seeding.maxBytes');
      if (stored) {
        const parsed = Number(stored);
        if (Number.isFinite(parsed)) {
          maxBytes = Math.max(
            MIN_TERMINAL_SEED_MAX_BYTES,
            Math.min(parsed, MAX_TERMINAL_SEED_MAX_BYTES),
          );
        } else {
          logger.warn({ stored }, 'Invalid terminal seed max bytes value; using default');
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to read terminal seed max bytes; using default');
    }

    return { maxBytes };
  }

  /**
   * Get tmux capture with short-lived caching.
   * Cache is per-session and expires after 2 seconds.
   * This prevents expensive captures when multiple clients subscribe simultaneously.
   */
  private async getCachedCapture(
    sessionId: string,
    tmuxSessionId: string,
    scrollbackLines: number,
  ): Promise<string | null> {
    const cached = this.captureCache.get(sessionId);
    const now = Date.now();

    // Return cached if recent
    if (cached && now - cached.timestamp < this.CAPTURE_CACHE_TTL) {
      logger.debug({ sessionId, age: now - cached.timestamp }, 'Using cached tmux capture');
      return cached.snapshot;
    }

    // Capture fresh
    try {
      this.seedCaptureCount += 1;
      const result = await this.terminalIO.captureHistory(
        { name: tmuxSessionId },
        scrollbackLines,
        true,
      );
      const snapshot = result.ok ? result.output : null;

      if (snapshot && snapshot.length > 0) {
        // Cache for future requests
        this.captureCache.set(sessionId, {
          snapshot,
          timestamp: now,
          cols: 80, // Default, could extract from PTY
          rows: 24,
        });

        logger.debug({ sessionId, bytes: snapshot.length }, 'Cached fresh tmux capture');
      }
      return snapshot;
    } catch (error) {
      logger.warn({ sessionId, error }, 'tmux capture failed');
    }

    return null;
  }

  getCaptureStats(): { terminalSeedCaptures: number } {
    return { terminalSeedCaptures: this.seedCaptureCount };
  }

  /**
   * Truncate snapshot from the start (oldest lines) to fit within maxBytes.
   * Returns the truncated snapshot and whether truncation occurred.
   *
   * **SHARED USAGE:** This function is used by both:
   * - Terminal seeding (TerminalSeedService.generateSeed)
   * - Full-history responses (TerminalGateway.handleRequestFullHistory)
   *
   * **Performance Characteristics:**
   * - Uses `split(/\r?\n/)` which allocates O(n) where n = content byte length
   * - Then walks lines from end O(lines) to find byte boundary
   * - Acceptable under current maxBytes limits (64KB-4MB)
   * - At 1MB content, truncation completes in <10ms on typical hardware
   *
   * **If limits need to increase significantly (>4MB):**
   * - Consider streaming/chunked approach instead of full split
   * - Or use byte-offset search without full line parsing
   *
   * @see MAX_TERMINAL_SEED_MAX_BYTES for configured maximum (4MB)
   * @see Performance test: terminal-seed.service.spec.ts "truncation performance"
   */
  truncateToMaxBytes(
    snapshot: string,
    maxBytes: number,
  ): { truncated: string; wasTruncated: boolean } {
    const byteLength = Buffer.byteLength(snapshot, 'utf-8');
    if (byteLength <= maxBytes) {
      return { truncated: snapshot, wasTruncated: false };
    }

    // Find line boundary to truncate from start (preserve newest lines at bottom)
    const separator = snapshot.includes('\r\n') ? '\r\n' : '\n';
    const separatorBytes = Buffer.byteLength(separator, 'utf-8');
    const lines = snapshot.split(/\r?\n/);
    let currentBytes = 0;
    let startLineIndex = 0;

    // Walk from end (newest) to find how many lines fit
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes =
        Buffer.byteLength(lines[i], 'utf-8') + (i < lines.length - 1 ? separatorBytes : 0);
      if (currentBytes + lineBytes > maxBytes) {
        startLineIndex = i + 1;
        break;
      }
      currentBytes += lineBytes;
    }

    let truncated = lines.slice(startLineIndex).join(separator);

    // Fallback: if no complete lines fit (single very long line), use byte-based truncation
    // This preserves the newest content (from the end) even when line-based fails
    if (truncated === '' && lines.length > 0) {
      // Find the last non-empty line (trailing newlines create empty elements)
      let targetLine = '';
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].length > 0) {
          targetLine = lines[i];
          break;
        }
      }

      if (targetLine === '') {
        // All lines are empty - shouldn't happen but handle gracefully
        return { truncated: '', wasTruncated: true };
      }

      const characters = Array.from(targetLine);
      let suffixBytes = 0;
      let startCharacter = characters.length;
      for (let i = characters.length - 1; i >= 0; i -= 1) {
        const characterBytes = Buffer.byteLength(characters[i], 'utf-8');
        if (suffixBytes + characterBytes > maxBytes) break;
        suffixBytes += characterBytes;
        startCharacter = i;
      }
      truncated = characters.slice(startCharacter).join('');

      logger.info(
        {
          originalBytes: byteLength,
          truncatedBytes: Buffer.byteLength(truncated, 'utf-8'),
          maxBytes,
          fallback: 'byte-based',
        },
        'Used byte-based fallback truncation (single long line)',
      );

      return { truncated, wasTruncated: true };
    }

    logger.info(
      {
        originalBytes: byteLength,
        truncatedBytes: Buffer.byteLength(truncated, 'utf-8'),
        maxBytes,
        linesRemoved: startLineIndex,
      },
      'Truncated snapshot to fit maxBytes',
    );

    return { truncated, wasTruncated: true };
  }

  /**
   * Emit seed to client with snapshot generation
   */
  async emitSeedToClient(options: {
    deliver: TerminalSeedDeliver;
    sessionId: string;
    maxBytes: number;
    cols?: number;
    rows?: number;
    allowEmpty?: boolean;
    /**
     * Samples the live sequence AFTER capture for the non-writing empty-completion path
     * (successful empty initial capture, no recovery). Required for that path to carry a
     * baseline sequence; ignored when a non-empty snapshot or a recovery context is present.
     */
    getCurrentSequence?: () => number;
    recovery?: {
      sequenceEpoch: string;
      recoveryEpoch: number;
      getCurrentSequence: () => number;
      onCapturedSequence?: (capturedSequence: number) => void;
    };
  }): Promise<TerminalRecoverySeedWatermark | undefined> {
    const { deliver, sessionId, maxBytes, allowEmpty = false } = options;
    return this.emitSeed(
      deliver,
      sessionId,
      maxBytes,
      allowEmpty,
      options.recovery,
      options.getCurrentSequence,
    );
  }

  /**
   * Invalidate cache for a session
   */
  invalidateCache(sessionId: string): void {
    this.captureCache.delete(sessionId);
  }

  /**
   * Capture tmux snapshot and emit seed to client. A failed capture is skipped. A
   * successful empty capture emits a non-writing `seed_empty` completion (initial attach)
   * or an empty `seed_ansi` replacement (recovery, to clear stale client output).
   */
  private async emitSeed(
    deliver: TerminalSeedDeliver,
    sessionId: string,
    maxBytes: number,
    allowEmpty: boolean,
    recovery?: {
      sequenceEpoch: string;
      recoveryEpoch: number;
      getCurrentSequence: () => number;
      onCapturedSequence?: (capturedSequence: number) => void;
    },
    getCurrentSequence?: () => number,
  ): Promise<TerminalRecoverySeedWatermark | undefined> {
    let snapshot: string | null = null;
    let captureSucceeded = false;
    let tmuxCursorX: number | undefined;
    let tmuxCursorY: number | undefined;
    let wasTruncated = false;
    let recoveryWatermark: TerminalRecoverySeedWatermark | undefined;
    let emptyCompletionSequence: number | undefined;

    try {
      const session = this.sessionsService.getSession(sessionId);
      if (session?.tmuxSessionId) {
        const scrollbackLines = this.settingsService.getScrollbackLines();
        logger.info(
          {
            sessionId,
            tmuxSessionId: session.tmuxSessionId,
            scrollbackLines,
            source: 'tmux-ansi',
          },
          'Capturing tmux ANSI scrollback for seed',
        );

        // Use cached capture if available (2s TTL)
        snapshot = await this.getCachedCapture(sessionId, session.tmuxSessionId, scrollbackLines);
        captureSucceeded = snapshot !== null;
        // Sample the sequence AFTER capture completes: frames stamped while capture-pane
        // ran are already inside the snapshot, so the baseline must sit at or below them.
        if (captureSucceeded && recovery) {
          recoveryWatermark = {
            sequenceEpoch: recovery.sequenceEpoch,
            recoveryEpoch: recovery.recoveryEpoch,
            capturedSequence: recovery.getCurrentSequence(),
          };
          recovery.onCapturedSequence?.(recoveryWatermark.capturedSequence);
        } else if (captureSucceeded && getCurrentSequence) {
          emptyCompletionSequence = getCurrentSequence();
        }

        // Strip tmux capture-pane's final separator and capture cursor position for metadata.
        if (snapshot && snapshot.length > 0) {
          snapshot = normalizeLineEndings(stripFinalLineEnding(snapshot));

          const truncateResult = this.truncateToMaxBytes(snapshot, maxBytes);
          snapshot = truncateResult.truncated;
          wasTruncated = truncateResult.wasTruncated;

          const cursorPos = await this.terminalIO.getCursorPosition({
            name: session.tmuxSessionId,
          });
          if (cursorPos) {
            tmuxCursorX = cursorPos.x;
            tmuxCursorY = cursorPos.y;

            logger.info(
              { sessionId, cursorX: tmuxCursorX, cursorY: tmuxCursorY },
              'Captured cursor position (stripped trailing newlines)',
            );
          }

          logger.info(
            { sessionId, snapshotBytes: snapshot.length, source: 'tmux-ansi', wasTruncated },
            'Got tmux ANSI scrollback (cached or fresh)',
          );
        }
      }
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to capture tmux scrollback');
    }

    if ((!snapshot || snapshot.length === 0) && !(allowEmpty && captureSucceeded)) {
      logger.info({ sessionId }, 'No tmux content yet, skipping seed');
      return undefined;
    }

    // Get actual terminal dimensions to include in seed
    let actualCols: number | undefined;
    let actualRows: number | undefined;
    let usesAlternateScreen = false;
    try {
      const dims = this.terminalSessionRegistry.get(sessionId)?.getDimensions() ?? null;
      if (dims) {
        actualCols = dims.cols;
        actualRows = dims.rows;
      }
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to get terminal dimensions for seed');
    }
    try {
      usesAlternateScreen = this.sessionsService.usesAlternateScreenFor(sessionId);
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to resolve terminal output behavior for seed');
    }

    // Successful empty capture, no recovery: complete the client's seed attempt without
    // writing. Recovery instead emits an empty `seed_ansi` (below) to clear stale output.
    if ((!snapshot || snapshot.length === 0) && !recovery) {
      this.emitEmptyCompletion(
        deliver,
        sessionId,
        emptyCompletionSequence ?? 0,
        actualCols,
        actualRows,
      );
      return undefined;
    }

    this.emitSeedSnapshot(
      deliver,
      sessionId,
      snapshot ?? '',
      maxBytes,
      actualCols,
      actualRows,
      tmuxCursorX,
      tmuxCursorY,
      wasTruncated,
      usesAlternateScreen,
      allowEmpty,
      recoveryWatermark,
    );
    return recoveryWatermark;
  }

  /**
   * Emit a non-writing completion for a successful empty initial capture through the
   * caller-owned delivery guard. Distinct from `seed_ansi`: it carries no data, so the
   * client completes its seed attempt without resetting xterm or dropping live rows.
   */
  private emitEmptyCompletion(
    deliver: TerminalSeedDeliver,
    sessionId: string,
    capturedSequence: number,
    cols?: number,
    rows?: number,
  ): void {
    const payload: TerminalSeedEmptyPayload = {
      capturedSequence,
      ...(cols !== undefined && { cols }),
      ...(rows !== undefined && { rows }),
    };
    logger.info({ sessionId, capturedSequence }, 'Emitting empty seed completion');
    deliver(createEnvelope(`terminal/${sessionId}`, 'seed_empty', payload));
  }

  /**
   * Emit seed snapshot in chunks to client
   *
   * @param wasTruncated - True when oldest content was removed to satisfy maxBytes.
   */
  private emitSeedSnapshot(
    deliver: TerminalSeedDeliver,
    sessionId: string,
    snapshot: string,
    _maxBytes: number,
    cols?: number,
    rows?: number,
    cursorX?: number,
    cursorY?: number,
    wasTruncated: boolean = false,
    usesAlternateScreen: boolean = false,
    allowEmpty: boolean = false,
    recoveryWatermark?: TerminalRecoverySeedWatermark,
  ): void {
    const buffer = Buffer.from(snapshot, 'utf8');
    if (buffer.length === 0 && !allowEmpty) {
      logger.debug({ sessionId }, 'Seed snapshot empty; skipping emit');
      return;
    }

    const totalChunks = Math.max(1, Math.ceil(buffer.length / this.SEED_CHUNK_SIZE));

    // Calculate metadata from the actual snapshot content
    // Count lines by splitting on newlines (both \n and \r\n)
    const lines = snapshot.split(/\r?\n/);
    const totalLines = lines.length;

    // Alternate-screen captures have no loadable primary-buffer history, even when truncated.
    const hasHistory = wasTruncated && !usesAlternateScreen;

    logger.info(
      {
        sessionId,
        bytes: buffer.length,
        totalChunks,
        totalLines,
        hasHistory,
        wasTruncated,
        cols,
        rows,
      },
      'Sending seed snapshot',
    );

    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * this.SEED_CHUNK_SIZE;
      const end = Math.min(start + this.SEED_CHUNK_SIZE, buffer.length);
      const chunkBuffer = buffer.subarray(start, end);

      const payload: TerminalSeedPayload = {
        data: chunkBuffer.toString('utf8'),
        chunk: chunkIndex,
        totalChunks,
        ...recoveryWatermark,
        // Include metadata only in the LAST chunk
        ...(chunkIndex === totalChunks - 1 && {
          totalLines,
          hasHistory,
          cols,
          rows,
          cursorX,
          cursorY,
        }),
      };
      const envelope = createEnvelope(`terminal/${sessionId}`, 'seed_ansi', payload);
      if (deliver(envelope) === TerminalSeedDelivery.Abort) return;
    }
  }
}
