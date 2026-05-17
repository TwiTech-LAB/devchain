import { Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveSessionInfo, SessionLaunchError } from '../dtos/active-session-info.dto';
import { SessionsModule } from '../sessions.module';
import { TerminalIOService } from '../../terminal/services/terminal-io/terminal-io.service';
import { ActiveSessionLookup } from './active-session-lookup.service';
import { SessionLauncherFacade } from './session-launcher-facade.service';
import { SessionRuntime } from './session-runtime';

function makeActiveSession(overrides: Partial<ActiveSessionInfo> = {}): ActiveSessionInfo {
  return {
    sessionId: 'session-1',
    agentId: 'agent-1',
    projectId: 'project-1',
    status: 'running',
    tmuxSessionId: 'tmux-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: null,
    activityState: null,
    name: null,
    ...overrides,
  };
}

describe('SessionLauncherFacade', () => {
  let facade: SessionLauncherFacade;
  let activeSessionLookup: jest.Mocked<Pick<ActiveSessionLookup, 'getActiveSession'>>;
  let sessionRuntime: jest.Mocked<Pick<SessionRuntime, 'launch'>>;
  let terminalIO: jest.Mocked<Pick<TerminalIOService, 'sessionExists'>>;

  beforeEach(async () => {
    activeSessionLookup = {
      getActiveSession: jest.fn(),
    };
    sessionRuntime = {
      launch: jest.fn(),
    };
    terminalIO = {
      sessionExists: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionLauncherFacade,
        { provide: ActiveSessionLookup, useValue: activeSessionLookup },
        { provide: SessionRuntime, useValue: sessionRuntime },
        { provide: TerminalIOService, useValue: terminalIO },
      ],
    }).compile();

    facade = module.get(SessionLauncherFacade);
  });

  it('returns an existing active session when its tmux session is live', async () => {
    const existingSession = makeActiveSession();
    activeSessionLookup.getActiveSession.mockResolvedValue(existingSession);
    terminalIO.sessionExists.mockResolvedValue(true);

    await expect(facade.ensureActiveSession('agent-1', 'project-1')).resolves.toBe(existingSession);

    expect(activeSessionLookup.getActiveSession).toHaveBeenCalledTimes(1);
    expect(activeSessionLookup.getActiveSession).toHaveBeenCalledWith('agent-1', 'project-1');
    expect(terminalIO.sessionExists).toHaveBeenCalledWith({ name: 'tmux-1' });
    expect(sessionRuntime.launch).not.toHaveBeenCalled();
  });

  it('launches silently and returns the new active session when none exists', async () => {
    const launchedSession = makeActiveSession({
      sessionId: 'session-new',
      tmuxSessionId: 'tmux-new',
    });
    activeSessionLookup.getActiveSession
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(launchedSession);
    sessionRuntime.launch.mockResolvedValue({
      id: 'session-new',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionId: 'tmux-new',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      epic: null,
      agent: { id: 'agent-1', name: 'Agent', profileId: 'profile-1' },
      project: { id: 'project-1', name: 'Project', rootPath: '/tmp/project' },
    });

    await expect(facade.ensureActiveSession('agent-1', 'project-1')).resolves.toBe(launchedSession);

    expect(terminalIO.sessionExists).not.toHaveBeenCalled();
    expect(sessionRuntime.launch).toHaveBeenCalledWith({
      agentId: 'agent-1',
      projectId: 'project-1',
      options: { silent: true },
    });
    expect(activeSessionLookup.getActiveSession).toHaveBeenCalledTimes(2);
  });

  it('launches silently when the active DB session has no live tmux session', async () => {
    const staleSession = makeActiveSession({ sessionId: 'session-stale' });
    const launchedSession = makeActiveSession({
      sessionId: 'session-new',
      tmuxSessionId: 'tmux-new',
    });
    activeSessionLookup.getActiveSession
      .mockResolvedValueOnce(staleSession)
      .mockResolvedValueOnce(launchedSession);
    terminalIO.sessionExists.mockResolvedValue(false);
    sessionRuntime.launch.mockResolvedValue({
      id: 'session-new',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionId: 'tmux-new',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      epic: null,
      agent: { id: 'agent-1', name: 'Agent', profileId: 'profile-1' },
      project: { id: 'project-1', name: 'Project', rootPath: '/tmp/project' },
    });

    await expect(facade.ensureActiveSession('agent-1', 'project-1')).resolves.toBe(launchedSession);

    expect(terminalIO.sessionExists).toHaveBeenCalledWith({ name: 'tmux-1' });
    expect(sessionRuntime.launch).toHaveBeenCalledWith({
      agentId: 'agent-1',
      projectId: 'project-1',
      options: { silent: true },
    });
  });

  it('throws SessionLaunchError when launch fails', async () => {
    const cause = new Error('provider missing binary');
    activeSessionLookup.getActiveSession.mockResolvedValue(null);
    sessionRuntime.launch.mockRejectedValue(cause);

    await expect(facade.ensureActiveSession('agent-1', 'project-1')).rejects.toMatchObject({
      name: 'SessionLaunchError',
      details: { agentId: 'agent-1', projectId: 'project-1', cause },
    });
  });

  it('throws SessionLaunchError when launch does not produce an active session', async () => {
    activeSessionLookup.getActiveSession.mockResolvedValue(null);
    sessionRuntime.launch.mockResolvedValue({
      id: 'session-new',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionId: 'tmux-new',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      epic: null,
      agent: { id: 'agent-1', name: 'Agent', profileId: 'profile-1' },
      project: { id: 'project-1', name: 'Project', rootPath: '/tmp/project' },
    });

    await expect(facade.ensureActiveSession('agent-1', 'project-1')).rejects.toBeInstanceOf(
      SessionLaunchError,
    );
  });
});

describe('SessionLauncherFacade module export', () => {
  @Module({
    imports: [SessionsModule],
  })
  class ImporterModule {}

  it('resolves from a module importing SessionsModule', async () => {
    const module = await Test.createTestingModule({
      imports: [ImporterModule],
    }).compile();

    expect(module.get(SessionLauncherFacade)).toBeInstanceOf(SessionLauncherFacade);

    await module.close();
  });
});
