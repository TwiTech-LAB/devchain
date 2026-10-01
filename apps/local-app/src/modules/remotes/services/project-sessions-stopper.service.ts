import { Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { SessionsService } from '../../sessions/services/sessions.service';

const logger = createLogger('ProjectSessionsStopper');

/** Stops every running session of a project's agents before a remote handoff. */
@Injectable()
export class ProjectSessionsStopper {
  constructor(private readonly sessions: SessionsService) {}

  async stop(projectId: string): Promise<number> {
    const running = this.sessions.getActiveSessionsForProject(projectId);
    for (const session of running) {
      await this.sessions.terminateSession(session.id, {
        source: 'remote-operation',
        reason: 'user-requested',
      });
    }
    if (running.length > 0) {
      logger.info({ projectId, count: running.length }, 'Stopped project sessions');
    }
    return running.length;
  }
}
