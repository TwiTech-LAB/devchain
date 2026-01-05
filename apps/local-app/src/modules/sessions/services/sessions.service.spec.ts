import { SessionsService } from './sessions.service';
import { ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { TmuxService } from '../../terminal/services/tmux.service';
import type { PtyService } from '../../terminal/services/pty.service';
import type { PreflightService } from '../../core/services/preflight.service';
import type { EventsService } from '../../events/services/events.service';
import type { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { ModuleRef } from '@nestjs/core';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';

describe('SessionsService', () => {
  let storage: {
    getAgent: jest.Mock;
    getProject: jest.Mock;
    getEpic: jest.Mock;
    getAgentProfile: jest.Mock;
    getProvider: jest.Mock;
    getPrompt: jest.Mock;
    getInitialSessionPrompt: jest.Mock;
    getFeatureFlags: jest.Mock;
  };
  let tmuxService: {
    createSessionName: jest.Mock;
    createSession: jest.Mock;
    startHealthCheck: jest.Mock;
    sendCommand: jest.Mock;
    sendCommandArgs: jest.Mock;
    pasteAndSubmit: jest.Mock;
    setAlternateScreenOff: jest.Mock;
  };
  let ptyService: { startStreaming: jest.Mock };
  let preflightService: { runChecks: jest.Mock };
  let eventsService: { publish: jest.Mock };
  let sendCoordinator: TerminalSendCoordinatorService;
  let sqlitePrepare: jest.Mock;
  let insertRunMock: jest.Mock;
  let service: SessionsService;

  beforeEach(() => {
    storage = {
      getAgent: jest.fn(),
      getProject: jest.fn(),
      getEpic: jest.fn(),
      getAgentProfile: jest.fn(),
      getProvider: jest.fn(),
      getPrompt: jest.fn(),
      getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
    };

    tmuxService = {
      createSessionName: jest.fn().mockReturnValue('tmux-session'),
      createSession: jest.fn().mockResolvedValue(undefined),
      startHealthCheck: jest.fn(),
      sendCommand: jest.fn().mockResolvedValue(undefined),
      sendCommandArgs: jest.fn().mockResolvedValue(undefined),
      pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
      setAlternateScreenOff: jest.fn().mockResolvedValue(undefined),
    };

    ptyService = {
      startStreaming: jest.fn().mockResolvedValue(undefined),
    };

    preflightService = {
      runChecks: jest.fn().mockResolvedValue({ overall: 'pass', checks: [] }),
    };

    eventsService = {
      publish: jest.fn().mockResolvedValue('event-log-id'),
    };

    sendCoordinator = {
      ensureAgentGap: jest.fn().mockResolvedValue(undefined),
    } as unknown as TerminalSendCoordinatorService;

    insertRunMock = jest.fn();
    sqlitePrepare = jest
      .fn()
      .mockReturnValue({ run: insertRunMock, get: jest.fn(), all: jest.fn().mockReturnValue([]) });

    const dbMock = {
      session: {
        client: {
          prepare: sqlitePrepare,
        },
      },
    } as unknown as BetterSQLite3Database;

    const terminalGateway = {
      broadcastEvent: jest.fn(),
    };
    const moduleRef = {
      get: jest.fn().mockImplementation((token: unknown) => {
        const tokenName = (token as { name?: string })?.name;
        if (tokenName === 'TerminalGateway') {
          return terminalGateway as unknown as TerminalGateway;
        }
        if (tokenName === 'EventsService') {
          return eventsService as unknown as EventsService;
        }
        return null;
      }),
    };

    service = new SessionsService(
      dbMock,
      storage as unknown as StorageService,
      tmuxService as unknown as TmuxService,
      sendCoordinator as unknown as TerminalSendCoordinatorService,
      ptyService as unknown as PtyService,
      preflightService as unknown as PreflightService,
      moduleRef as unknown as ModuleRef,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('launches a session with an epic id', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'My Project',
      rootPath: '/workspace/project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getEpic.mockResolvedValue({
      id: 'epic-1',
      title: 'Handle Sessions',
      description: 'Epic description',
      projectId: 'project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getAgentProfile.mockResolvedValue({
      id: 'profile-1',
      name: 'Helper Profile',
      options: '--model claude-3',
      providerId: 'provider-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
      epicId: 'epic-1',
    });

    await jest.advanceTimersByTimeAsync(5000);
    const result = await launchPromise;

    expect(storage.getEpic).toHaveBeenCalledWith('epic-1');
    expect(tmuxService.createSessionName).toHaveBeenCalledWith(
      'my-project',
      'epic-1',
      'agent-1',
      expect.any(String),
    );
    const sessionId = tmuxService.createSessionName.mock.calls[0][3];
    expect(insertRunMock).toHaveBeenCalledWith(
      sessionId,
      'epic-1',
      'agent-1',
      'tmux-session',
      'running',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
    expect(tmuxService.sendCommandArgs).toHaveBeenCalledWith('tmux-session', [
      '/usr/local/bin/claude',
      '--model',
      'claude-3',
    ]);
    expect(storage.getInitialSessionPrompt).toHaveBeenCalledTimes(1);
    expect(tmuxService.pasteAndSubmit).toHaveBeenCalledWith(
      'tmux-session',
      expect.any(String),
      expect.objectContaining({ bracketed: true, submitKeys: ['Enter'], delayMs: 250 }),
    );
    expect(eventsService.publish).toHaveBeenCalledWith(
      'session.started',
      expect.objectContaining({ epicId: 'epic-1', sessionId }),
    );
    expect(result.id).toBe(sessionId);
    expect(result.epicId).toBe('epic-1');
    expect(result.epic).toEqual(
      expect.objectContaining({ id: 'epic-1', title: 'Handle Sessions', projectId: 'project-1' }),
    );
  });

  it('launches a session without an epic', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-2',
      name: 'Independent Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'My Project',
      rootPath: '/workspace/project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getAgentProfile.mockResolvedValue({
      id: 'profile-1',
      name: 'Helper Profile',
      options: '--model claude-3',
      providerId: 'provider-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-2',
    });

    await jest.advanceTimersByTimeAsync(5000);
    const result = await launchPromise;

    expect(storage.getEpic).not.toHaveBeenCalled();
    expect(tmuxService.createSessionName).toHaveBeenCalledWith(
      'my-project',
      'independent',
      'agent-2',
      expect.any(String),
    );
    const sessionId = tmuxService.createSessionName.mock.calls[0][3];
    expect(insertRunMock).toHaveBeenCalledWith(
      sessionId,
      null,
      'agent-2',
      'tmux-session',
      'running',
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
    expect(tmuxService.sendCommandArgs).toHaveBeenCalledWith('tmux-session', [
      '/usr/local/bin/claude',
      '--model',
      'claude-3',
    ]);
    expect(storage.getInitialSessionPrompt).toHaveBeenCalledTimes(1);
    expect(tmuxService.pasteAndSubmit).toHaveBeenCalledWith(
      'tmux-session',
      expect.any(String),
      expect.objectContaining({ bracketed: true, submitKeys: ['Enter'], delayMs: 250 }),
    );
    expect(eventsService.publish).toHaveBeenCalledWith(
      'session.started',
      expect.objectContaining({ epicId: null, sessionId }),
    );
    expect(result.id).toBe(sessionId);
    expect(result.epicId).toBeNull();
    expect(result.epic).toBeNull();
  });

  it('throws when provider binPath is missing', async () => {
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'My Project',
      rootPath: '/workspace/project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getAgentProfile.mockResolvedValue({
      id: 'profile-1',
      name: 'Helper Profile',
      options: null,
      providerId: 'provider-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    await expect(
      service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects invalid profile options with ValidationError', async () => {
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'My Project',
      rootPath: '/workspace/project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getAgentProfile.mockResolvedValue({
      id: 'profile-1',
      name: 'Helper Profile',
      options: 'bad\noption',
      providerId: 'provider-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    await expect(
      service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('pastes rendered initial prompt content with resolved variables', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'My Project',
      rootPath: '/workspace/project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getAgentProfile.mockResolvedValue({
      id: 'profile-1',
      name: 'Helper Profile',
      options: '--model claude-3',
      providerId: 'provider-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getInitialSessionPrompt.mockResolvedValueOnce({
      id: 'prompt-1',
      projectId: null,
      title: 'Kickoff',
      content: 'Hello {agent_name}, welcome to {project_name}.',
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });

    await jest.advanceTimersByTimeAsync(5000);
    await launchPromise;

    expect(storage.getInitialSessionPrompt).toHaveBeenCalled();
    expect(tmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);
    const rendered = (tmuxService.pasteAndSubmit as jest.Mock).mock.calls[0][1];
    expect(rendered).toContain('Helper Agent');
    expect(rendered).toContain('My Project');
    expect(rendered).not.toContain('{agent_name}');
    expect(rendered).not.toContain('{project_name}');
    jest.useRealTimers();
  });

  it('falls back to default prompt when rendered content exceeds limits', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'My Project',
      rootPath: '/workspace/project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getAgentProfile.mockResolvedValue({
      id: 'profile-1',
      name: 'Helper Profile',
      options: '--model claude-3',
      providerId: 'provider-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getInitialSessionPrompt.mockResolvedValueOnce({
      id: 'prompt-2',
      projectId: null,
      title: 'Verbose',
      content: 'X'.repeat(5000),
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });

    await jest.advanceTimersByTimeAsync(5000);
    await launchPromise;

    const rendered = (tmuxService.pasteAndSubmit as jest.Mock).mock.calls[0][1] as string;
    expect(rendered.startsWith('Session ')).toBe(true);
    expect(rendered.length).toBeLessThan(5000);
    jest.useRealTimers();
  });
});
