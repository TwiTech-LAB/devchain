import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Socket } from 'socket.io';
import { createLogger } from '../../../common/logging/logger';
import {
  SettingsService,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
  MIN_TERMINAL_SEED_MAX_BYTES,
  MAX_TERMINAL_SEED_MAX_BYTES,
} from '../../settings/services/settings.service';
import { TmuxService } from './tmux.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { createEnvelope, TerminalSeedPayload } from '../dtos/ws-envelope.dto';
import { PtyService } from './pty.service';

const logger = createLogger('TerminalSeedService');

interface CaptureCache {
  snapshot: string;
  timestamp: number;
  cols: number;
  rows: number;
}

/**
 * Service responsible for terminal seeding logic:
 * - Config resolution (maxBytes from settings)
 * - Capture caching (2s TTL to reduce expensive tmux captures)
 * - Snapshot preparation (capture, strip newlines, chunk into 64KB pieces)
 * - Seed emission to WebSocket clients
 *
 * Seeding uses tmux ANSI capture exclusively. Empty snapshots are handled
 * gracefully - clients receive live PTY data as it arrives.
 */
@Injectable()
export class TerminalSeedService {
  private readonly captureCache = new Map<string, CaptureCache>();
  private readonly CAPTURE_CACHE_TTL = 2000; // 2 seconds
  private readonly SEED_CHUNK_SIZE = 64 * 1024; // 64KB chunks

  constructor(
    private readonly settingsService: SettingsService,
    private readonly ptyService: PtyService,
    private readonly moduleRef: ModuleRef,
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
      const tmuxService = this.moduleRef.get(TmuxService, { strict: false });
      if (!tmuxService) {
        return null;
      }

      const snapshot = await tmuxService.capturePane(tmuxSessionId, scrollbackLines, true);

      if (snapshot && snapshot.length > 0) {
        // Cache for future requests
        this.captureCache.set(sessionId, {
          snapshot,
          timestamp: now,
          cols: 80, // Default, could extract from PTY
          rows: 24,
        });

        logger.debug({ sessionId, bytes: snapshot.length }, 'Cached fresh tmux capture');

        return snapshot;
      }
    } catch (error) {
      logger.warn({ sessionId, error }, 'tmux capture failed');
    }

    return null;
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
    const lines = snapshot.split(/\r?\n/);
    let currentBytes = 0;
    let startLineIndex = 0;

    // Walk from end (newest) to find how many lines fit
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(lines[i] + '\n', 'utf-8');
      if (currentBytes + lineBytes > maxBytes) {
        startLineIndex = i + 1;
        break;
      }
      currentBytes += lineBytes;
    }

    let truncated = lines.slice(startLineIndex).join('\n');

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

      const buffer = Buffer.from(targetLine, 'utf-8');
      // Take last maxBytes from the line (preserves newest content)
      const truncatedBuffer = buffer.subarray(-maxBytes);
      // toString('utf-8') handles incomplete multi-byte chars gracefully
      // by replacing them with replacement character (�)
      truncated = truncatedBuffer.toString('utf-8');

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
    client: Socket;
    sessionId: string;
    maxBytes: number;
    cols?: number;
    rows?: number;
  }): Promise<void> {
    const { client, sessionId, maxBytes } = options;
    await this.emitSeed(client, sessionId, maxBytes);
  }

  /**
   * Invalidate cache for a session
   */
  invalidateCache(sessionId: string): void {
    this.captureCache.delete(sessionId);
  }

  /**
   * Capture tmux snapshot and emit seed to client.
   * No warmup delay - if no content yet, skip seed and let live PTY data flow.
   */
  private async emitSeed(client: Socket, sessionId: string, maxBytes: number): Promise<void> {
    let snapshot: string | null = null;
    let tmuxCursorX: number | undefined;
    let tmuxCursorY: number | undefined;
    let wasTruncated = false;

    try {
      const sessionsService = this.moduleRef.get(SessionsService, { strict: false });

      if (sessionsService) {
        const session = sessionsService.getSession(sessionId);
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

          // Strip trailing newlines and capture cursor position for metadata
          if (snapshot && snapshot.length > 0) {
            // Strip trailing newlines from snapshot to avoid extra blank lines
            // tmux capture-pane often adds trailing \n which creates duplication
            snapshot = snapshot.replace(/(\r?\n)+$/, '');

            // Apply maxBytes limit to tmux capture path
            const truncateResult = this.truncateToMaxBytes(snapshot, maxBytes);
            snapshot = truncateResult.truncated;
            wasTruncated = truncateResult.wasTruncated;

            const tmuxService = this.moduleRef.get(TmuxService, { strict: false });
            if (tmuxService) {
              const cursorPos = await tmuxService.getCursorPosition(session.tmuxSessionId);
              if (cursorPos) {
                // Store for metadata/logging only
                // Don't append cursor positioning codes due to dimension mismatch between
                // server and client after fit() - causes scrolling/duplication
                tmuxCursorX = cursorPos.x;
                tmuxCursorY = cursorPos.y;

                logger.info(
                  { sessionId, cursorX: tmuxCursorX, cursorY: tmuxCursorY },
                  'Captured cursor position (stripped trailing newlines)',
                );
              }
            }

            logger.info(
              { sessionId, snapshotBytes: snapshot.length, source: 'tmux-ansi', wasTruncated },
              'Got tmux ANSI scrollback (cached or fresh)',
            );
          }
        }
      }
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to capture tmux scrollback');
    }

    // If no snapshot, skip seed - client will receive live PTY data as it arrives
    if (!snapshot || snapshot.length === 0) {
      logger.info({ sessionId }, 'No tmux content yet, skipping seed');
      return;
    }

    // Get actual PTY dimensions to include in seed
    let actualCols: number | undefined;
    let actualRows: number | undefined;
    try {
      const ptyDimensions = this.ptyService.getDimensions(sessionId);
      if (ptyDimensions) {
        actualCols = ptyDimensions.cols;
        actualRows = ptyDimensions.rows;
      }
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to get PTY dimensions for seed');
    }

    this.emitSeedSnapshot(
      client,
      sessionId,
      snapshot,
      maxBytes,
      actualCols,
      actualRows,
      tmuxCursorX,
      tmuxCursorY,
      wasTruncated,
    );
  }

  /**
   * Emit seed snapshot in chunks to client
   *
   * @param wasTruncated - True if snapshot was truncated due to maxBytes limit.
   *   A1 fix: hasHistory now correctly indicates "more history exists beyond seed"
   *   rather than just "seed spans multiple screens"
   */
  private emitSeedSnapshot(
    client: Socket,
    sessionId: string,
    snapshot: string,
    _maxBytes: number,
    cols?: number,
    rows?: number,
    cursorX?: number,
    cursorY?: number,
    wasTruncated: boolean = false,
  ): void {
    const buffer = Buffer.from(snapshot, 'utf8');
    if (buffer.length === 0) {
      logger.debug({ sessionId }, 'Seed snapshot empty; skipping emit');
      return;
    }

    const totalChunks = Math.max(1, Math.ceil(buffer.length / this.SEED_CHUNK_SIZE));

    // Calculate metadata from the actual snapshot content
    // Count lines by splitting on newlines (both \n and \r\n)
    const lines = snapshot.split(/\r?\n/);
    const totalLines = lines.length;

    // A1 fix: hasHistory should indicate "more history exists beyond what was sent in seed"
    // NOT "seed spans multiple screens" (the old incorrect behavior)
    // hasHistory is true only when we truncated the snapshot (meaning more exists)
    const hasHistory = wasTruncated;

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
      client.emit('message', envelope);
    }
  }
}
