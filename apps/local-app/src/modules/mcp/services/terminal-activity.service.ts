import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { ActivityTrackerService } from '../../sessions/services/activity-tracker.service';

const logger = createLogger('TerminalActivityService');

/**
 * Strip ANSI escape sequences from terminal output.
 * Removes CSI (Control Sequence Introducer) and OSC (Operating System Command) sequences.
 * CSI: ESC [ ... (0x1B 0x5B)
 * OSC: ESC ] ... BEL or ESC \ (0x1B 0x5D terminated by 0x07 or 0x1B 0x5C)
 */
function stripAnsiSequences(data: string): string {
  // Remove CSI sequences: ESC[ followed by parameter bytes and intermediate bytes, ending with final byte
  // Final bytes are 0x40-0x7E (ASCII @ through ~)
  const csiRegex = /\x1B\[[\x20-\x3F]*[\x40-\x7E]/g;
  // Remove OSC sequences: ESC] ... terminated by BEL (\x07) or ST (ESC \ = \x1B\)
  // Uses non-capturing group to properly consume the 2-byte ST terminator
  const oscRegex = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
  // Remove simple escape sequences like ESC M (reverse line feed)
  const simpleEscRegex = /\x1B[\x40-\x5F]/g;

  return data.replace(csiRegex, '').replace(oscRegex, '').replace(simpleEscRegex, '');
}

/**
 * Strip control characters (0x00-0x1F) except newline (0x0A) and tab (0x09).
 * Preserves printable text while removing terminal control codes.
 */
function stripControlChars(data: string): string {
  // Remove chars 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F (keep \n=0x0A, \t=0x09)
  return data.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '');
}

/**
 * Check if data contains non-whitespace characters (Unicode-safe).
 * Returns true if there's any printable/visible character present.
 */
function hasNonWhitespace(data: string): boolean {
  // \S matches any non-whitespace character (Unicode-aware)
  return /\S/.test(data);
}

/**
 * Terminal Activity Service (temporary: retains marker parsing until removed in next steps)
 * NOTE: Subsequent refactor will strip MCP marker parsing and expose observeChunk().
 */
@Injectable()
export class TerminalActivityService {
  constructor(
    @Inject(forwardRef(() => ActivityTrackerService))
    private readonly activityTracker: ActivityTrackerService,
  ) {
    logger.info('TerminalActivityService initialized');
  }

  /**
   * New PTY observer entrypoint: detect real agent activity and signal.
   *
   * Filters out ANSI escape sequences and control characters before checking
   * for non-whitespace content to avoid false positives from terminal redraws.
   */
  observeChunk(sessionId: string, data: string): void {
    try {
      if (typeof data !== 'string') {
        return;
      }
      // Strip ANSI sequences and control characters, then check for non-whitespace
      const cleaned = stripControlChars(stripAnsiSequences(data));
      if (hasNonWhitespace(cleaned)) {
        this.activityTracker.signal(sessionId);
      }
    } catch (error) {
      logger.warn({ sessionId, error }, 'Failed to signal activity');
    }
  }

  /**
   * Legacy compatibility: return data unchanged and signal activity.
   * PtyService will be updated to call observeChunk() and broadcast raw data.
   */
  async processChunk(sessionId: string, data: string): Promise<string> {
    this.observeChunk(sessionId, data);
    return data;
  }

  clearSession(sessionId: string): void {
    // Delegate to ActivityTrackerService to clean up idle timers
    this.activityTracker.clearSession(sessionId);
  }

  getBufferSize(_sessionId: string): number {
    return 0;
  }
}
