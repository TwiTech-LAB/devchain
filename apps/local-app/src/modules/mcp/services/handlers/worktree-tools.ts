import { AppError } from '../../../../common/errors/error-types';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type {
  McpResponse,
  SessionContext,
  WorktreesCreateParams,
  WorktreesListParams,
  WorktreesCommitParams,
  WorktreesMergeParams,
  WorktreesRemoveParams,
} from '../../dtos/mcp.dto';
import { resolveSessionContext } from '../utils/session-context-helpers';
import type { WorktreeToolContext } from './worktree-context';

async function runWorktreeOperation(
  ctx: WorktreeToolContext,
  sessionId: string,
  operation: (projectId: string, leadAgentId: string) => Promise<unknown>,
): Promise<McpResponse> {
  const resolved = await resolveSessionContext(ctx, sessionId);
  if (!resolved.success) return resolved;
  const session = resolved.data as SessionContext;
  if (session.type === 'guest') {
    return {
      success: false,
      error: {
        code: 'AGENT_CONTEXT_REQUIRED',
        message: 'This tool requires an agent session context',
      },
    };
  }
  if (!session.agent) {
    return {
      success: false,
      error: { code: 'AGENT_REQUIRED', message: 'No agent associated with this session' },
    };
  }
  if (!session.project) {
    return {
      success: false,
      error: { code: 'PROJECT_NOT_FOUND', message: 'No project associated with this session' },
    };
  }
  try {
    return { success: true, data: await operation(session.project.id, session.agent.id) };
  } catch (error) {
    if (error instanceof AppError) {
      return {
        success: false,
        error: { code: error.code, message: error.message, data: error.details },
      };
    }
    if (error instanceof ServiceUnavailableError) {
      return { success: false, error: { code: 'SERVICE_UNAVAILABLE', message: error.message } };
    }
    throw error;
  }
}

export function handleWorktreesCreate(
  ctx: WorktreeToolContext,
  params: unknown,
): Promise<McpResponse> {
  const parsed = params as WorktreesCreateParams;
  return runWorktreeOperation(ctx, parsed.sessionId, (projectId, leadAgentId) =>
    ctx.worktreesService.create(projectId, leadAgentId, {
      name: parsed.name,
      baseRef: parsed.baseRef,
      epicId: parsed.epicId,
    }),
  );
}

export function handleWorktreesList(
  ctx: WorktreeToolContext,
  params: unknown,
): Promise<McpResponse> {
  const parsed = params as WorktreesListParams;
  return runWorktreeOperation(ctx, parsed.sessionId, (projectId, leadAgentId) =>
    ctx.worktreesService.list(projectId, leadAgentId, parsed.name),
  );
}

export function handleWorktreesCommit(
  ctx: WorktreeToolContext,
  params: unknown,
): Promise<McpResponse> {
  const parsed = params as WorktreesCommitParams;
  return runWorktreeOperation(ctx, parsed.sessionId, (projectId, leadAgentId) =>
    ctx.worktreesService.commit(projectId, leadAgentId, parsed.name, parsed.message),
  );
}

export function handleWorktreesMerge(
  ctx: WorktreeToolContext,
  params: unknown,
): Promise<McpResponse> {
  const parsed = params as WorktreesMergeParams;
  return runWorktreeOperation(ctx, parsed.sessionId, (projectId, leadAgentId) =>
    ctx.worktreesService.merge(projectId, leadAgentId, parsed.name, parsed.expectedHead),
  );
}

export function handleWorktreesRemove(
  ctx: WorktreeToolContext,
  params: unknown,
): Promise<McpResponse> {
  const parsed = params as WorktreesRemoveParams;
  return runWorktreeOperation(ctx, parsed.sessionId, (projectId, leadAgentId) =>
    ctx.worktreesService.remove(projectId, leadAgentId, parsed.name),
  );
}
