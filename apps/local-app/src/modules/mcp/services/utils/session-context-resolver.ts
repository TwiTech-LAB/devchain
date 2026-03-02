import { createLogger } from '../../../../common/logging/logger';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { GuestsService } from '../../../guests/services/guests.service';
import type { TmuxService } from '../../../terminal/services/tmux.service';
import type { AgentSessionContext, GuestSessionContext, McpResponse } from '../../dtos/mcp.dto';

const logger = createLogger('McpService');

function redactSessionId(sessionId: string | undefined): string {
  if (!sessionId) return '(none)';
  return sessionId.slice(0, 4) + '****';
}

export class SessionContextResolver {
  constructor(
    private readonly storage: StorageService,
    private readonly sessionsService?: SessionsService,
    private readonly guestsService?: GuestsService,
    private readonly tmuxService?: TmuxService,
  ) {}

  async resolve(sessionId: string): Promise<McpResponse> {
    if (!this.sessionsService) {
      return {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message:
            'Session resolution requires full app context (not available in standalone MCP mode)',
        },
      };
    }

    if (!sessionId || sessionId.length < 8) {
      return {
        success: false,
        error: {
          code: 'INVALID_SESSION_ID',
          message: 'Session ID must be at least 8 characters (full UUID or prefix)',
        },
      };
    }

    try {
      const activeSessions = await this.sessionsService.listActiveSessions();

      const matchingSessions =
        sessionId.length === 36
          ? activeSessions.filter((session) => session.id === sessionId)
          : activeSessions.filter((session) => session.id.startsWith(sessionId));

      if (matchingSessions.length === 0) {
        const guestContext = await this.tryResolveGuestContext(sessionId);
        if (guestContext) {
          return { success: true, data: guestContext };
        }

        return {
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: `No active session or guest found matching '${sessionId}'`,
          },
        };
      }

      if (matchingSessions.length > 1) {
        const prefixLength = 12;
        const matchingPrefixes = matchingSessions.map((session) =>
          session.id.slice(0, prefixLength),
        );
        return {
          success: false,
          error: {
            code: 'AMBIGUOUS_SESSION',
            message: `Multiple active sessions match prefix '${sessionId}': ${matchingPrefixes.join(', ')}. Use a longer prefix (e.g., 12+ chars) or full UUID.`,
            data: {
              matchingSessionIdPrefixes: matchingPrefixes,
            },
          },
        };
      }

      const session = matchingSessions[0];

      let agent: AgentSessionContext['agent'] = null;
      if (session.agentId) {
        try {
          const agentEntity = await this.storage.getAgent(session.agentId);
          agent = {
            id: agentEntity.id,
            name: agentEntity.name,
            projectId: agentEntity.projectId,
          };
        } catch {
          logger.warn(
            { sessionId: redactSessionId(session.id), agentId: session.agentId },
            'Agent not found for session',
          );
        }
      }

      let project: AgentSessionContext['project'] = null;
      if (agent?.projectId) {
        try {
          const projectEntity = await this.storage.getProject(agent.projectId);
          project = {
            id: projectEntity.id,
            name: projectEntity.name,
            rootPath: projectEntity.rootPath,
          };
        } catch {
          logger.warn(
            { sessionId: redactSessionId(session.id), projectId: agent.projectId },
            'Project not found for session',
          );
        }
      }

      const context: AgentSessionContext = {
        type: 'agent',
        session: {
          id: session.id,
          agentId: session.agentId,
          status: session.status,
          startedAt: session.startedAt,
        },
        agent,
        project,
      };

      return { success: true, data: context };
    } catch (error) {
      logger.error(
        { error, sessionId: redactSessionId(sessionId) },
        'resolveSessionContext failed',
      );
      return {
        success: false,
        error: {
          code: 'SESSION_RESOLUTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to resolve session context',
        },
      };
    }
  }

  private async tryResolveGuestContext(guestId: string): Promise<GuestSessionContext | null> {
    if (!this.guestsService || !this.tmuxService) {
      return null;
    }

    try {
      let guest;
      if (guestId.length === 36) {
        guest = await this.storage.getGuest(guestId);
      } else {
        const matches = await this.storage.getGuestsByIdPrefix(guestId);
        if (matches.length === 1) {
          guest = matches[0];
        } else {
          return null;
        }
      }

      const sessionAlive = await this.tmuxService.hasSession(guest.tmuxSessionId);
      if (!sessionAlive) {
        logger.warn(
          { guestId: guest.id, tmuxSessionId: guest.tmuxSessionId },
          'Guest tmux session no longer exists',
        );
        return null;
      }

      const project = await this.storage.getProject(guest.projectId);

      const context: GuestSessionContext = {
        type: 'guest',
        guest: {
          id: guest.id,
          name: guest.name,
          projectId: guest.projectId,
          tmuxSessionId: guest.tmuxSessionId,
        },
        project: {
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
        },
      };

      return context;
    } catch (error) {
      logger.debug(
        { guestId: redactSessionId(guestId), error: String(error) },
        'Failed to resolve guest context',
      );
      return null;
    }
  }
}
