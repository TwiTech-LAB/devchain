import type { ListSessionsResponse, McpResponse } from '../../dtos/mcp.dto';
import { ValidationError } from '../../../../common/errors/error-types';

import type { SessionToolContext } from './session-context';
import { handleListSessions, handleRegisterGuest } from './session-tools';

function createContext(): SessionToolContext {
  return {
    storage: {
      getAgent: jest
        .fn()
        .mockResolvedValue({ id: 'agent-1', name: 'Coder', projectId: 'project-1' }),
      getProject: jest.fn().mockResolvedValue({ id: 'project-1', name: 'Project' }),
    } as unknown as SessionToolContext['storage'],
    sessionsService: {
      listActiveSessions: jest.fn().mockResolvedValue([
        {
          id: '12345678-0000-0000-0000-000000000001',
          agentId: 'agent-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
        },
      ]),
    } as unknown as SessionToolContext['sessionsService'],
    guestsService: {
      register: jest.fn().mockResolvedValue({
        guestId: 'guest-1',
        projectId: 'project-1',
        isSandbox: false,
      }),
    } as unknown as SessionToolContext['guestsService'],
  };
}

/** `McpResponse.data` is `unknown` by design; tests state the payload they expect. */
function dataOf<T>(result: McpResponse): T {
  return result.data as T;
}

describe('session-tools handlers', () => {
  it('lists active sessions with resolved names', async () => {
    const ctx = createContext();

    await expect(handleListSessions(ctx, {})).resolves.toEqual({
      success: true,
      data: {
        sessions: [
          {
            sessionIdShort: '12345678',
            agentName: 'Coder',
            projectName: 'Project',
            status: 'running',
            startedAt: '2024-01-01T00:00:00Z',
          },
        ],
      },
    });
  });

  it.each([
    ['agent', 'getAgent', 'Unknown', ''],
    ['project', 'getProject', 'Coder', 'Unknown'],
  ])(
    'degrades a missing %s name without discarding available context',
    async (_kind, method, agentName, projectName) => {
      const ctx = createContext();
      (ctx.storage[method as keyof typeof ctx.storage] as jest.Mock).mockRejectedValue(
        new Error('missing'),
      );

      const result = await handleListSessions(ctx, {});

      expect(result).toMatchObject({ success: true });
      expect(dataOf<ListSessionsResponse>(result).sessions).toEqual([
        expect.objectContaining({ agentName, projectName }),
      ]);
    },
  );

  it('maps unexpected list failures to LIST_SESSIONS_FAILED', async () => {
    const ctx = createContext();
    (ctx.sessionsService.listActiveSessions as jest.Mock).mockRejectedValue(new Error('failed'));

    await expect(handleListSessions(ctx, {})).resolves.toEqual({
      success: false,
      error: { code: 'LIST_SESSIONS_FAILED', message: 'failed' },
    });
  });

  it('registers a guest and forwards its description', async () => {
    const ctx = createContext();

    await expect(
      handleRegisterGuest(ctx, {
        name: 'Guest',
        tmuxSessionId: 'guest-tmux',
        description: 'External worker',
      }),
    ).resolves.toEqual({ success: true, data: { guestId: 'guest-1' } });
    expect(ctx.guestsService.register).toHaveBeenCalledWith({
      name: 'Guest',
      tmuxSessionId: 'guest-tmux',
      description: 'External worker',
    });
  });

  it('maps guest registration validation failures', async () => {
    const ctx = createContext();
    (ctx.guestsService.register as jest.Mock).mockRejectedValue(
      new ValidationError('invalid guest', { field: 'name' }),
    );

    await expect(
      handleRegisterGuest(ctx, { name: 'Guest', tmuxSessionId: 'guest-tmux' }),
    ).resolves.toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'invalid guest', data: { field: 'name' } },
    });
  });
});
