import type { McpResponse, SessionContext } from '../../dtos/mcp.dto';

const PROJECT_NOT_FOUND: McpResponse = {
  success: false,
  error: {
    code: 'PROJECT_NOT_FOUND',
    message: 'No project associated with this session',
  },
};

export function requireProject(
  sessionCtxResult: McpResponse,
):
  | { project: NonNullable<SessionContext['project']>; sessionContext: SessionContext }
  | McpResponse {
  if (!sessionCtxResult.success) return sessionCtxResult;
  const sessionContext = sessionCtxResult.data as SessionContext;
  const project = sessionContext.project;
  if (!project) return PROJECT_NOT_FOUND;
  return { project, sessionContext };
}
