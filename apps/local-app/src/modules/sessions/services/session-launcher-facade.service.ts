import { Injectable, Logger } from '@nestjs/common';
import { ActiveSessionInfo, SessionLaunchError } from '../dtos/active-session-info.dto';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { ActiveSessionLookup } from './active-session-lookup.service';
import { SessionRuntime } from './session-runtime';

@Injectable()
export class SessionLauncherFacade {
  private readonly logger = new Logger(SessionLauncherFacade.name);

  constructor(
    private readonly activeSessionLookup: ActiveSessionLookup,
    private readonly sessionRuntime: SessionRuntime,
    private readonly terminalIO: TerminalIOService,
  ) {}

  async ensureActiveSession(agentId: string, projectId: string): Promise<ActiveSessionInfo> {
    const activeSession = await this.activeSessionLookup.getActiveSession(agentId, projectId);
    if (activeSession && (await this.hasLiveTmuxSession(activeSession))) {
      return activeSession;
    }

    if (activeSession) {
      this.logger.warn(
        `DB shows active session for agent ${agentId} but tmux session is stale; launching replacement`,
      );
    }

    try {
      await this.sessionRuntime.launch({
        agentId,
        projectId,
        options: { silent: true },
      });

      const launchedSession = await this.activeSessionLookup.getActiveSession(agentId, projectId);
      if (!launchedSession) {
        throw new Error('Session launch completed but no active session was found');
      }

      return launchedSession;
    } catch (cause) {
      if (cause instanceof SessionLaunchError) {
        throw cause;
      }
      throw new SessionLaunchError({ agentId, projectId, cause });
    }
  }

  private async hasLiveTmuxSession(session: ActiveSessionInfo): Promise<boolean> {
    if (!session.tmuxSessionId) {
      return false;
    }

    try {
      return await this.terminalIO.sessionExists({ name: session.tmuxSessionId });
    } catch (error) {
      this.logger.warn(
        `Unable to verify tmux session ${session.tmuxSessionId}; treating it as stale`,
      );
      return false;
    }
  }
}
