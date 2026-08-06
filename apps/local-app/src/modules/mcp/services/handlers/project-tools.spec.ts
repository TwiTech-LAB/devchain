import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type { AgentSessionContext, GuestSessionContext } from '../../dtos/mcp.dto';
import { handleProjectsList } from './project-tools';
import type { ProjectToolContext } from './project-context';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'agent-1';

function agentContext(): AgentSessionContext {
  return {
    type: 'agent',
    session: { id: SESSION_ID, agentId: AGENT_ID, status: 'active', startedAt: '2026-01-01' },
    agent: { id: AGENT_ID, name: 'Owner', projectId: 'source-project' },
    project: { id: 'source-project', name: 'Source', rootPath: '/private/source' },
  };
}

function guestContext(): GuestSessionContext {
  return {
    type: 'guest',
    guest: { id: 'guest-1', name: 'Guest', projectId: 'source-project', tmuxSessionId: 'tmux' },
    project: { id: 'source-project', name: 'Source', rootPath: '/private/source' },
  };
}

function makeContext(
  sessionContext: AgentSessionContext | GuestSessionContext = agentContext(),
): ProjectToolContext {
  return {
    projectCommunicationService: {
      listTargets: jest.fn().mockResolvedValue({
        result: {
          projects: [
            {
              id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              shortId: 'aaaaaaaa',
              name: 'Target',
              description: null,
              hasProjectOwner: true,
            },
          ],
          total: 1,
          limit: 25,
          offset: 0,
        },
      }),
    } as never,
    resolveSessionContext: jest.fn().mockResolvedValue({ success: true, data: sessionContext }),
  };
}

describe('project-tools handlers', () => {
  it('delegates the caller and pagination and returns the safe directory result', async () => {
    const ctx = makeContext();

    const result = await handleProjectsList(ctx, {
      sessionId: SESSION_ID,
      limit: 25,
      offset: 0,
    });

    expect(ctx.projectCommunicationService.listTargets).toHaveBeenCalledWith(AGENT_ID, {
      limit: 25,
      offset: 0,
    });
    expect(result).toEqual({
      success: true,
      data: {
        projects: [
          {
            id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            shortId: 'aaaaaaaa',
            name: 'Target',
            description: null,
            hasProjectOwner: true,
          },
        ],
        total: 1,
        limit: 25,
        offset: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain('rootPath');
  });

  it('delegates guest context as null and maps domain errors', async () => {
    const ctx = makeContext(guestContext());
    (ctx.projectCommunicationService.listTargets as jest.Mock).mockResolvedValue({
      error: { code: 'AGENT_CONTEXT_REQUIRED', message: 'Agent required' },
    });

    const result = await handleProjectsList(ctx, {
      sessionId: SESSION_ID,
      limit: 100,
      offset: 0,
    });

    expect(ctx.projectCommunicationService.listTargets).toHaveBeenCalledWith(null, {
      limit: 100,
      offset: 0,
    });
    expect(result).toEqual({
      success: false,
      error: { code: 'AGENT_CONTEXT_REQUIRED', message: 'Agent required' },
    });
  });

  it('maps an unavailable optional service to SERVICE_UNAVAILABLE', async () => {
    const ctx = makeContext();
    (ctx.projectCommunicationService.listTargets as jest.Mock).mockRejectedValue(
      new ServiceUnavailableError('ProjectCommunicationService'),
    );

    const result = await handleProjectsList(ctx, {
      sessionId: SESSION_ID,
      limit: 100,
      offset: 0,
    });

    expect(result).toEqual({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: expect.any(String),
      },
    });
  });
});
