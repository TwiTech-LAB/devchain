import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { ActivityTrackerService } from '../../sessions/services/activity-tracker.service';

const logger = createLogger('TerminalActivityService');

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
   * New PTY observer entrypoint: detect non-empty output and signal activity
   */
  observeChunk(sessionId: string, data: string): void {
    try {
      if (typeof data === 'string' && data.trim().length > 0) {
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

  clearSession(_sessionId: string): void {
    // No-op in activity-only mode
  }

  getBufferSize(_sessionId: string): number {
    return 0;
  }
}
