import { Test, TestingModule } from '@nestjs/testing';
import { ActiveSessionLookup } from './active-session-lookup.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { SessionsReadModule } from '../sessions-read.module';

interface MockStatement {
  get: jest.Mock;
  all: jest.Mock;
}

function makeSessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'session-1',
    agent_id: 'agent-1',
    project_id: 'project-1',
    tmux_session_id: 'tmux-1',
    status: 'running',
    started_at: '2026-01-01T00:00:00.000Z',
    last_activity_at: '2026-01-01T00:01:00.000Z',
    activity_state: 'busy',
    name: 'Working session',
    ...overrides,
  };
}

describe('ActiveSessionLookup', () => {
  let service: ActiveSessionLookup;
  let db: { prepare: jest.Mock };
  let statement: MockStatement;

  beforeEach(async () => {
    statement = {
      get: jest.fn(),
      all: jest.fn(),
    };
    db = {
      prepare: jest.fn().mockReturnValue(statement),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ActiveSessionLookup, { provide: DB_CONNECTION, useValue: db }],
    }).compile();

    service = module.get(ActiveSessionLookup);
  });

  it('returns null when no active session exists for the agent in the project', async () => {
    statement.get.mockReturnValue(undefined);

    await expect(service.getActiveSession('agent-1', 'project-1')).resolves.toBeNull();

    expect(statement.get).toHaveBeenCalledWith('agent-1', 'project-1');
  });

  it('returns the newest active session for the agent in the project', async () => {
    statement.get.mockReturnValue(makeSessionRow());

    await expect(service.getActiveSession('agent-1', 'project-1')).resolves.toEqual({
      sessionId: 'session-1',
      agentId: 'agent-1',
      projectId: 'project-1',
      status: 'running',
      tmuxSessionId: 'tmux-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:01:00.000Z',
      activityState: 'busy',
      name: 'Working session',
    });
  });

  it('returns empty array when the project has no active sessions', async () => {
    statement.all.mockReturnValue([]);

    await expect(service.listActiveSessions('project-empty')).resolves.toEqual([]);

    expect(statement.all).toHaveBeenCalledWith('project-empty');
  });

  it('returns active sessions for the requested project only', async () => {
    statement.all.mockReturnValue([
      makeSessionRow({ id: 'session-2', agent_id: 'agent-2', project_id: 'project-1' }),
      makeSessionRow({ id: 'session-1', agent_id: 'agent-1', project_id: 'project-1' }),
    ]);

    await expect(service.listActiveSessions('project-1')).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'session-2',
        agentId: 'agent-2',
        projectId: 'project-1',
      }),
      expect.objectContaining({
        sessionId: 'session-1',
        agentId: 'agent-1',
        projectId: 'project-1',
      }),
    ]);
  });

  it('does not return an agent session from another project', async () => {
    statement.get.mockReturnValue(undefined);

    await expect(service.getActiveSession('agent-1', 'project-2')).resolves.toBeNull();

    expect(statement.get).toHaveBeenCalledWith('agent-1', 'project-2');
  });
});

describe('SessionsReadModule', () => {
  it('compiles standalone and resolves ActiveSessionLookup', async () => {
    const db = {
      prepare: jest.fn().mockReturnValue({ get: jest.fn(), all: jest.fn() }),
    };

    const module = await Test.createTestingModule({
      imports: [SessionsReadModule],
    })
      .overrideProvider(DB_CONNECTION)
      .useValue(db)
      .compile();

    expect(module.get(ActiveSessionLookup)).toBeInstanceOf(ActiveSessionLookup);
  });
});
