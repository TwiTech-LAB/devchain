import type { GuestsService } from '../../../guests/services/guests.service';
import type { SessionsService } from '../../../sessions/services/sessions.service';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { TerminalIOService } from '../../../terminal/services/terminal-io/terminal-io.service';
import { SessionContextResolver } from './session-context-resolver';

const SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const INHERITED_ID = 'deadbeef-1111-4111-8111-111111111111';
const SECOND_INHERITED_ID = 'deadbeef-2222-4222-8222-222222222222';
const OTHER_AGENT_SESSION_ID = 'deadbeef-3333-4333-8333-333333333333';
const PROJECT_ID = 'project-1';
const AGENT_ID = 'agent-1';

function session(
  id = SESSION_ID,
  agentId: string | null = AGENT_ID,
  inheritedSessionIds: string[] = [],
) {
  return {
    id,
    agentId,
    status: 'running' as const,
    startedAt: '2024-01-01T00:00:00Z',
    inheritedSessionIds,
  };
}

function createStorage(): jest.Mocked<StorageService> {
  return {
    getAgent: jest.fn().mockResolvedValue({ id: AGENT_ID, name: 'Coder', projectId: PROJECT_ID }),
    getProject: jest.fn().mockResolvedValue({
      id: PROJECT_ID,
      name: 'Project',
      rootPath: '/project',
    }),
    getGuest: jest.fn(),
    getGuestsByIdPrefix: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<StorageService>;
}

function createSessions(active = [session()]) {
  return {
    listRunningSessionIdentities: jest.fn().mockReturnValue(active),
  } as unknown as SessionsService;
}

describe('SessionContextResolver', () => {
  it('returns SERVICE_UNAVAILABLE without the full sessions service', async () => {
    const resolver = new SessionContextResolver(createStorage());

    await expect(resolver.resolve(SESSION_ID)).resolves.toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
  });

  it.each(['', 'short'])('rejects invalid session id %p', async (sessionId) => {
    const resolver = new SessionContextResolver(createStorage(), createSessions());

    await expect(resolver.resolve(sessionId)).resolves.toMatchObject({
      success: false,
      error: { code: 'INVALID_SESSION_ID' },
    });
  });

  it('resolves a full UUID with agent and project context', async () => {
    const resolver = new SessionContextResolver(createStorage(), createSessions());

    await expect(resolver.resolve(SESSION_ID)).resolves.toMatchObject({
      success: true,
      data: {
        type: 'agent',
        session: { id: SESSION_ID },
        agent: { id: AGENT_ID, name: 'Coder' },
        project: { id: PROJECT_ID, name: 'Project' },
      },
    });
  });

  const resolved = { success: true, data: { session: { id: SESSION_ID } } };
  it.each([
    {
      name: 'resolves the current row by its eight-character prefix',
      input: SESSION_ID.slice(0, 8),
      running: [session()],
      expected: resolved,
    },
    {
      name: 'resolves a full inherited ID to the current row',
      input: INHERITED_ID,
      running: [
        session(SESSION_ID, AGENT_ID, [INHERITED_ID]),
        session(OTHER_AGENT_SESSION_ID, 'agent-2'),
      ],
      expected: resolved,
    },
    {
      name: 'resolves the eight-character prefix of an inherited ID',
      input: INHERITED_ID.slice(0, 8),
      running: [session(SESSION_ID, AGENT_ID, [INHERITED_ID])],
      expected: resolved,
    },
    {
      name: 'counts a row once when two inherited IDs match',
      input: INHERITED_ID.slice(0, 8),
      running: [session(SESSION_ID, AGENT_ID, [INHERITED_ID, SECOND_INHERITED_ID])],
      expected: resolved,
    },
    {
      name: 'returns AMBIGUOUS_SESSION when an inherited ID and another row ID match',
      input: INHERITED_ID.slice(0, 8),
      running: [
        session(SESSION_ID, AGENT_ID, [INHERITED_ID]),
        session(OTHER_AGENT_SESSION_ID, 'agent-2'),
      ],
      expected: {
        success: false,
        error: {
          code: 'AMBIGUOUS_SESSION',
          data: { matchingSessionIdPrefixes: ['a1b2c3d4-e5f', 'deadbeef-333'] },
        },
      },
    },
    {
      name: 'returns SESSION_NOT_FOUND when no running row carries the inherited ID',
      input: INHERITED_ID,
      running: [session()],
      expected: { success: false, error: { code: 'SESSION_NOT_FOUND' } },
    },
  ])('$name', async ({ input, running, expected }) => {
    const resolver = new SessionContextResolver(createStorage(), createSessions(running));

    await expect(resolver.resolve(input)).resolves.toMatchObject(expected);
  });

  it('keeps null agent and project context for an unassigned session', async () => {
    const storage = createStorage();
    const resolver = new SessionContextResolver(
      storage,
      createSessions([session(SESSION_ID, null)]),
    );

    await expect(resolver.resolve(SESSION_ID)).resolves.toMatchObject({
      success: true,
      data: { agent: null, project: null },
    });
    expect(storage.getAgent).not.toHaveBeenCalled();
  });

  it('degrades a deleted agent to null context', async () => {
    const storage = createStorage();
    storage.getAgent.mockRejectedValue(new Error('deleted'));
    const resolver = new SessionContextResolver(storage, createSessions());

    await expect(resolver.resolve(SESSION_ID)).resolves.toMatchObject({
      success: true,
      data: { agent: null, project: null },
    });
  });

  it('degrades a deleted project without discarding agent context', async () => {
    const storage = createStorage();
    storage.getProject.mockRejectedValue(new Error('deleted'));
    const resolver = new SessionContextResolver(storage, createSessions());

    await expect(resolver.resolve(SESSION_ID)).resolves.toMatchObject({
      success: true,
      data: { agent: { id: AGENT_ID }, project: null },
    });
  });

  it('resolves a live guest by prefix when no active session matches', async () => {
    const storage = createStorage();
    storage.getGuestsByIdPrefix.mockResolvedValue([
      {
        id: 'guest000-0000-0000-0000-000000000001',
        name: 'Guest',
        description: null,
        projectId: PROJECT_ID,
        tmuxSessionId: 'guest-tmux',
        lastSeenAt: '2024-01-01T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
    ]);
    const terminal = {
      sessionExists: jest.fn().mockResolvedValue(true),
    } as unknown as TerminalIOService;
    const resolver = new SessionContextResolver(
      storage,
      createSessions([]),
      {} as GuestsService,
      terminal,
    );

    await expect(resolver.resolve('guest000')).resolves.toMatchObject({
      success: true,
      data: { type: 'guest', guest: { name: 'Guest' }, project: { id: PROJECT_ID } },
    });
  });

  it('maps active-session lookup failures to SESSION_RESOLUTION_FAILED', async () => {
    const sessions = {
      listRunningSessionIdentities: jest.fn(() => {
        throw new Error('session store down');
      }),
    } as unknown as SessionsService;
    const resolver = new SessionContextResolver(createStorage(), sessions);

    await expect(resolver.resolve(SESSION_ID)).resolves.toEqual({
      success: false,
      error: { code: 'SESSION_RESOLUTION_FAILED', message: 'session store down' },
    });
  });
});
