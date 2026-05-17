import { Injectable, Inject, forwardRef, OnApplicationBootstrap } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { SessionsService } from '../../sessions/services/sessions.service';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import { TerminalIOService } from './terminal-io/terminal-io.service';

const logger = createLogger('TerminalRegistryRehydrator');

@Injectable()
export class TerminalRegistryRehydrator implements OnApplicationBootstrap {
  constructor(
    @Inject(forwardRef(() => SessionsService))
    private readonly sessionsService: SessionsService,
    private readonly registry: TerminalSessionRegistry,
    private readonly terminalIO: TerminalIOService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const metas = this.sessionsService.listRunningSessionMetas();
    if (metas.length === 0) return;

    logger.info({ count: metas.length }, 'Rehydrating terminal session registry');

    for (const meta of metas) {
      if (this.registry.get(meta.sessionId)) continue;

      const alive = await this.terminalIO.sessionExists({ name: meta.tmuxSessionName });
      if (!alive) {
        logger.warn(
          { sessionId: meta.sessionId, tmuxSessionName: meta.tmuxSessionName },
          'Dead tmux orphan at bootstrap — marking session failed',
        );
        this.sessionsService.markSessionFailed(
          meta.sessionId,
          'tmux session no longer exists at bootstrap',
        );
        continue;
      }

      try {
        this.registry.create(meta.sessionId, meta.tmuxSessionName, {
          normalizeCapturedLineEndings: true,
        });
        this.registry.bind(meta.sessionId, this.terminalIO);
        logger.info(
          { sessionId: meta.sessionId, tmuxSessionName: meta.tmuxSessionName },
          'Rehydrated registry entry',
        );
      } catch {
        logger.debug({ sessionId: meta.sessionId }, 'Concurrent rehydration; entry already exists');
      }
    }
  }
}
