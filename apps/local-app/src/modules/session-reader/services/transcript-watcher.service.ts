import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { SessionCacheService } from './session-cache.service';
import { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import { EventsService } from '../../events/services/events.service';
import type { SessionTranscriptDiscoveredEventPayload } from '../../events/catalog/session.transcript.discovered';
import type { SessionStoppedEventPayload } from '../../events/catalog/session.stopped';
import type { SessionCrashedEventPayload } from '../../events/catalog/session.crashed';

/** Debounce window for coalescing rapid JSONL appends */
const DEBOUNCE_MS = 100;

/** Stat-poll fallback interval (covers fs.watch gaps on some platforms) */
const STAT_POLL_INTERVAL_MS = 3_000;

/** Max incremental delta before logging a warning (10 MB) */
const MAX_INCREMENTAL_BYTES = 10 * 1024 * 1024;

interface MetricsSnapshot {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  messageCount: number;
}

interface WatcherState {
  sessionId: string;
  filePath: string;
  providerName: string;
  fsWatcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout;
  debounceTimer: NodeJS.Timeout | null;
  lastIno: number;
  lastSize: number;
  lastMessageCount: number;
  lastMetrics: MetricsSnapshot;
}

@Injectable()
export class TranscriptWatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(TranscriptWatcherService.name);
  private readonly watchers = new Map<string, WatcherState>();

  constructor(
    private readonly cacheService: SessionCacheService,
    private readonly adapterFactory: SessionReaderAdapterFactory,
    private readonly events: EventsService,
  ) {}

  onModuleDestroy(): void {
    const sessionIds = [...this.watchers.keys()];
    for (const sessionId of sessionIds) {
      this.cleanupResources(sessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Event listeners
  // ---------------------------------------------------------------------------

  @OnEvent('session.transcript.discovered', { async: true })
  async handleTranscriptDiscovered(
    payload: SessionTranscriptDiscoveredEventPayload,
  ): Promise<void> {
    try {
      await this.startWatching(payload.sessionId, payload.transcriptPath, payload.providerName);
    } catch (error) {
      this.logger.error(
        { error, sessionId: payload.sessionId },
        'Failed to start transcript watcher',
      );
    }
  }

  @OnEvent('session.stopped', { async: true })
  async handleSessionStopped(payload: SessionStoppedEventPayload): Promise<void> {
    await this.stopWatching(payload.sessionId, 'session.stopped');
  }

  @OnEvent('session.crashed', { async: true })
  async handleSessionCrashed(payload: SessionCrashedEventPayload): Promise<void> {
    await this.stopWatching(payload.sessionId, 'session.crashed');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async startWatching(sessionId: string, filePath: string, providerName: string): Promise<void> {
    if (this.watchers.has(sessionId)) {
      this.logger.debug({ sessionId }, 'Watcher already active — skipping');
      return;
    }

    let stat: fs.Stats;
    try {
      stat = await fsPromises.stat(filePath);
    } catch {
      this.logger.warn({ sessionId, filePath }, 'Cannot stat transcript file — skipping watcher');
      return;
    }

    // Primary: fs.watch (may fail on some platforms/mounts)
    let fsWatcher: fs.FSWatcher | null = null;
    try {
      fsWatcher = this.createFsWatcher(sessionId, filePath);
    } catch {
      this.logger.warn({ sessionId }, 'fs.watch failed to start — using stat-poll only');
    }

    // Fallback: stat-poll every 3s
    const pollTimer = setInterval(() => {
      this.checkStatPoll(sessionId).catch((error) => {
        this.logger.error({ error, sessionId }, 'Stat-poll error');
      });
    }, STAT_POLL_INTERVAL_MS);

    this.watchers.set(sessionId, {
      sessionId,
      filePath,
      providerName,
      fsWatcher,
      pollTimer,
      debounceTimer: null,
      lastIno: stat.ino,
      lastSize: stat.size,
      lastMessageCount: 0,
      lastMetrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
    });

    this.logger.log({ sessionId, filePath, hasFsWatch: !!fsWatcher }, 'Started transcript watcher');
  }

  async stopWatching(
    sessionId: string,
    endReason:
      | 'session.stopped'
      | 'session.crashed'
      | 'watcher.closed'
      | 'file.deleted' = 'session.stopped',
  ): Promise<void> {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    const { filePath, providerName, lastMetrics } = state;

    // Cleanup first to prevent double-stop and stop timers
    this.cleanupResources(sessionId);

    // Final parse for up-to-date metrics (best effort)
    let finalMetrics: MetricsSnapshot = lastMetrics;
    try {
      const adapter = this.adapterFactory.getAdapter(providerName);
      if (adapter) {
        const session = await this.cacheService.getOrParse(sessionId, filePath, adapter);
        finalMetrics = {
          totalTokens: session.metrics.totalTokens,
          inputTokens: session.metrics.inputTokens,
          outputTokens: session.metrics.outputTokens,
          costUsd: session.metrics.costUsd,
          messageCount: session.metrics.messageCount,
        };
      }
    } catch (error) {
      this.logger.warn({ error, sessionId }, 'Final parse failed — using last known metrics');
    }

    try {
      await this.events.publish('session.transcript.ended', {
        sessionId,
        transcriptPath: filePath,
        finalMetrics,
        endReason,
      });
    } catch (error) {
      this.logger.error({ error, sessionId }, 'Failed to emit transcript ended event');
    }
  }

  /** Number of active watchers. */
  get activeWatcherCount(): number {
    return this.watchers.size;
  }

  // ---------------------------------------------------------------------------
  // Private: Debounce & Change Detection
  // ---------------------------------------------------------------------------

  private scheduleDebounce(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      this.handleFileChanged(sessionId).catch((error) => {
        this.logger.error({ error, sessionId }, 'Error in debounced file change handler');
      });
    }, DEBOUNCE_MS);
  }

  private async checkStatPoll(sessionId: string): Promise<void> {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    let stat: fs.Stats;
    try {
      stat = await fsPromises.stat(state.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.warn({ sessionId }, 'Transcript file deleted — stopping watcher');
        await this.stopWatching(sessionId, 'file.deleted');
        return;
      }
      throw error;
    }

    // Inode rotation detection
    if (stat.ino !== state.lastIno) {
      this.logger.debug({ sessionId }, 'Inode rotation detected via stat-poll');
      this.reopenFsWatcher(state);
      state.lastIno = stat.ino;
    }

    // Size change → trigger debounced handler
    if (stat.size !== state.lastSize) {
      this.scheduleDebounce(sessionId);
    }
  }

  private async handleFileChanged(sessionId: string): Promise<void> {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    try {
      let stat: fs.Stats;
      try {
        stat = await fsPromises.stat(state.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.logger.warn({ sessionId }, 'Transcript file deleted during change handling');
          await this.stopWatching(sessionId, 'file.deleted');
          return;
        }
        throw error;
      }

      // Inode rotation
      if (stat.ino !== state.lastIno) {
        this.logger.debug({ sessionId }, 'Inode rotation detected');
        this.reopenFsWatcher(state);
        state.lastIno = stat.ino;
      }

      // No size change — skip
      if (stat.size === state.lastSize) return;

      // Bounded read warning
      const delta = stat.size - state.lastSize;
      if (delta > MAX_INCREMENTAL_BYTES) {
        this.logger.warn(
          { sessionId, delta, maxBytes: MAX_INCREMENTAL_BYTES },
          'Incremental delta exceeds 10MB bound — proceeding with parse',
        );
      }

      const adapter = this.adapterFactory.getAdapter(state.providerName);
      if (!adapter) {
        this.logger.error({ sessionId, providerName: state.providerName }, 'No adapter found');
        return;
      }

      const session = await this.cacheService.getOrParse(sessionId, state.filePath, adapter);

      const newMessageCount = session.metrics.messageCount - state.lastMessageCount;

      // Update watcher state
      state.lastSize = stat.size;
      state.lastIno = stat.ino;
      state.lastMessageCount = session.metrics.messageCount;
      state.lastMetrics = {
        totalTokens: session.metrics.totalTokens,
        inputTokens: session.metrics.inputTokens,
        outputTokens: session.metrics.outputTokens,
        costUsd: session.metrics.costUsd,
        messageCount: session.metrics.messageCount,
      };

      // Publish update event only if new messages were found
      if (newMessageCount > 0) {
        await this.events.publish('session.transcript.updated', {
          sessionId,
          transcriptPath: state.filePath,
          newMessageCount,
          metrics: state.lastMetrics,
        });
      }
    } catch (error) {
      // Watcher isolation: log error but don't propagate to other watchers
      this.logger.error({ error, sessionId }, 'File change handler failed — watcher continues');
    }
  }

  // ---------------------------------------------------------------------------
  // Private: fs.watch lifecycle
  // ---------------------------------------------------------------------------

  private createFsWatcher(sessionId: string, filePath: string): fs.FSWatcher {
    const watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change' || eventType === 'rename') {
        this.scheduleDebounce(sessionId);
      }
    });

    watcher.on('error', (err) => {
      this.logger.warn({ error: err, sessionId }, 'fs.watch error — relying on stat-poll fallback');
      const state = this.watchers.get(sessionId);
      if (state?.fsWatcher) {
        state.fsWatcher.close();
        state.fsWatcher = null;
      }
    });

    return watcher;
  }

  private reopenFsWatcher(state: WatcherState): void {
    if (state.fsWatcher) {
      state.fsWatcher.close();
      state.fsWatcher = null;
    }

    try {
      state.fsWatcher = this.createFsWatcher(state.sessionId, state.filePath);
    } catch {
      this.logger.warn(
        { sessionId: state.sessionId },
        'Failed to reopen fs.watch after inode rotation',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Resource cleanup
  // ---------------------------------------------------------------------------

  private cleanupResources(sessionId: string): void {
    const state = this.watchers.get(sessionId);
    if (!state) return;

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    clearInterval(state.pollTimer);
    if (state.fsWatcher) state.fsWatcher.close();

    this.watchers.delete(sessionId);
    this.logger.debug({ sessionId }, 'Cleaned up transcript watcher');
  }
}
