import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SessionsService } from '../../sessions/services/sessions.service';
import { TranscriptWatcherService } from './transcript-watcher.service';

/**
 * Re-attaches transcript watchers for sessions that were already RUNNING before
 * the local-app (re)started.
 *
 * WHY THIS EXISTS:
 *   {@link TranscriptWatcherService} only ever starts a watcher in response to the
 *   `session.transcript.discovered` event, which is emitted from `session.started`
 *   — i.e. only when a session is *launched*. On a local-app restart, sessions that
 *   were already running do NOT re-emit `session.started`, so their watchers never
 *   re-attach. The freshness poll never runs, `session.transcript.updated` never
 *   fires, and live transcript updates (mobile + web) silently die for those
 *   sessions until they are reopened (the on-demand catch-up read still works,
 *   which is why "reopen to see new messages" appeared to work).
 *
 *   The terminal session registry is already rehydrated on boot the same way
 *   ({@link TerminalRegistryRehydrator}); transcript watchers were the missing half.
 *
 * SAFETY: {@link TranscriptWatcherService.startWatching} is idempotent (it skips a
 * session whose active watcher already reads the same source, and replaces a watcher
 * of another source) and resolves the source kind itself,
 * so this is safe to run for every provider (file + DB) and safe alongside the
 * normal discovery path.
 */
@Injectable()
export class TranscriptWatcherRehydrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(TranscriptWatcherRehydrator.name);

  constructor(
    private readonly sessions: SessionsService,
    private readonly watcher: TranscriptWatcherService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const running = this.sessions.listRunningTranscriptSessions();
    if (running.length === 0) return;

    this.logger.log(
      { count: running.length },
      'Rehydrating transcript watchers for already-running sessions',
    );

    let attached = 0;
    for (const session of running) {
      try {
        await this.watcher.startWatching(
          session.sessionId,
          session.transcriptPath,
          session.providerName,
          session.providerSessionId ?? undefined,
        );
        attached += 1;
      } catch (error) {
        this.logger.warn(
          { error, sessionId: session.sessionId },
          'Failed to rehydrate transcript watcher for running session',
        );
      }
    }

    this.logger.log({ attached, total: running.length }, 'Transcript watcher rehydration complete');
  }
}
