import { createLogger } from '../../../../common/logging/logger';
import { ValidationError } from '../../../../common/errors/error-types';
import {
  McpResponse,
  ListSessionsResponse,
  SessionSummary,
  RegisterGuestResponse,
  type RegisterGuestParams,
} from '../../dtos/mcp.dto';
import type { SessionToolContext } from './session-context';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';

const logger = createLogger('McpService');

function sessionServiceUnavailable(): McpResponse {
  return {
    success: false,
    error: {
      code: 'SERVICE_UNAVAILABLE',
      message: 'Session operations require full app context (not available in standalone MCP mode)',
    },
  };
}

function catchSessionUnavailable(error: unknown): McpResponse {
  if (error instanceof ServiceUnavailableError) {
    return sessionServiceUnavailable();
  }
  throw error;
}

export async function handleListSessions(
  ctx: SessionToolContext,
  _params: unknown,
): Promise<McpResponse> {
  try {
    const activeSessions = await ctx.sessionsService.listActiveSessions();

    const agentIds = [
      ...new Set(activeSessions.map((s) => s.agentId).filter((id): id is string => !!id)),
    ];
    const agentResults = await Promise.all(
      agentIds.map((id) =>
        ctx.storage
          .getAgent(id)
          .catch(() => null as { id: string; name: string; projectId: string } | null),
      ),
    );
    const agentMap = new Map(
      agentResults.filter((a): a is NonNullable<typeof a> => a !== null).map((a) => [a.id, a]),
    );

    const projectIds = [
      ...new Set(
        Array.from(agentMap.values())
          .map((a) => a.projectId)
          .filter((id): id is string => !!id),
      ),
    ];
    const projectResults = await Promise.all(
      projectIds.map((id) =>
        ctx.storage.getProject(id).catch(() => null as { id: string; name: string } | null),
      ),
    );
    const projectMap = new Map(
      projectResults.filter((p): p is NonNullable<typeof p> => p !== null).map((p) => [p.id, p]),
    );

    const sessions: SessionSummary[] = activeSessions.map((session) => {
      const agent = session.agentId ? agentMap.get(session.agentId) : undefined;
      const project = agent?.projectId ? projectMap.get(agent.projectId) : undefined;

      return {
        sessionIdShort: session.id.slice(0, 8),
        agentName: agent?.name ?? 'Unknown',
        projectName: agent ? (project?.name ?? 'Unknown') : '',
        status: session.status,
        startedAt: session.startedAt,
      };
    });

    const response: ListSessionsResponse = { sessions };
    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return sessionServiceUnavailable();
    }
    logger.error({ error }, 'listSessions failed');
    return {
      success: false,
      error: {
        code: 'LIST_SESSIONS_FAILED',
        message: error instanceof Error ? error.message : 'Failed to list sessions',
      },
    };
  }
}

export async function handleRegisterGuest(
  ctx: SessionToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as RegisterGuestParams;

  try {
    const result = await ctx.guestsService.register({
      name: validated.name,
      tmuxSessionId: validated.tmuxSessionId,
      description: validated.description,
    });

    const response: RegisterGuestResponse = {
      guestId: result.guestId,
    };

    logger.info(
      { guestId: result.guestId, projectId: result.projectId, isSandbox: result.isSandbox },
      'Guest registered successfully',
    );

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof ValidationError) {
      return {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          data: error.details,
        },
      };
    }
    if (error instanceof Error && error.name === 'ConflictError') {
      return {
        success: false,
        error: {
          code: 'CONFLICT',
          message: error.message,
          data: (error as { data?: unknown }).data,
        },
      };
    }
    return catchSessionUnavailable(error);
  }
}
