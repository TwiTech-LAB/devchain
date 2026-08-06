import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type { McpResponse, ProjectsListParams, SessionContext } from '../../dtos/mcp.dto';
import type { ProjectToolContext } from './project-context';
import { resolveSessionContext } from '../utils/session-context-helpers';

export async function handleProjectsList(
  ctx: ProjectToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ProjectsListParams;

  try {
    const sessionCtxResult = await resolveSessionContext(ctx, validated.sessionId);
    if (!sessionCtxResult.success) return sessionCtxResult;
    const sessionCtx = sessionCtxResult.data as SessionContext;
    const callerAgentId = sessionCtx.type === 'agent' ? (sessionCtx.agent?.id ?? null) : null;
    const outcome = await ctx.projectCommunicationService.listTargets(callerAgentId, {
      limit: validated.limit,
      offset: validated.offset,
    });

    return 'error' in outcome
      ? { success: false, error: outcome.error }
      : { success: true, data: outcome.result };
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return {
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE', message: error.message },
      };
    }
    throw error;
  }
}
