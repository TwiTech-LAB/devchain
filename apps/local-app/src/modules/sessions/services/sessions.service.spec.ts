jest.mock('../utils/claude-config', () => ({
  checkClaudeAutoCompact: jest.fn(),
}));

import { SessionsService } from './sessions.service';
import { ValidationError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { TmuxService } from '../../terminal/services/tmux.service';
import type { PtyService } from '../../terminal/services/pty.service';
import type { PreflightService } from '../../core/services/preflight.service';
import type { ProviderMcpEnsureService } from '../../core/services/provider-mcp-ensure.service';
import type { EventsService } from '../../events/services/events.service';
import type { TerminalSendCoordinatorService } from '../../terminal/services/terminal-send-coordinator.service';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { ModuleRef } from '@nestjs/core';
import { SessionCoordinatorService } from './session-coordinator.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import { checkClaudeAutoCompact } from '../utils/claude-config';

const mockCheckClaudeAutoCompact = checkClaudeAutoCompact as jest.MockedFunction<
  typeof checkClaudeAutoCompact
>;

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
    listProfileProviderConfigsByProfile: jest.Mock;
    getProfileProviderConfig: jest.Mock;
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
  let mcpEnsureService: { ensureMcp: jest.Mock };
  let eventsService: { publish: jest.Mock };
  let sendCoordinator: TerminalSendCoordinatorService;
  let sessionCoordinator: { withAgentLock: jest.Mock };
  let sqlitePrepare: jest.Mock;
  let insertRunMock: jest.Mock;
  let terminalGateway: { broadcastEvent: jest.Mock };
  let service: SessionsService;

  beforeEach(() => {
    jest.clearAllMocks();

    storage = {
      getAgent: jest.fn(),
      getProject: jest.fn(),
      getEpic: jest.fn(),
      getAgentProfile: jest.fn(),
      getProvider: jest.fn(),
      getPrompt: jest.fn(),
      getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
      getProfileProviderConfig: jest.fn(),
    };

    tmuxService = {
      createSessionName: jest.fn().mockReturnValue('tmux-session'),
      createSession: jest.fn().mockResolvedValue(undefined),
      startHealthCheck: jest.fn(),
      sendCommand: jest.fn().mockResolvedValue(undefined),
      sendCommandArgs: jest.fn().mockResolvedValue(undefined),
      pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
      setAlternateScreenOff: jest.fn().mockResolvedValue(undefined),
      destroySession: jest.fn().mockResolvedValue(undefined),
      hasSession: jest.fn().mockResolvedValue(true),
    };

    ptyService = {
      startStreaming: jest.fn().mockResolvedValue(undefined),
    };

    preflightService = {
      runChecks: jest.fn().mockResolvedValue({ overall: 'pass', checks: [] }),
    };
    mockCheckClaudeAutoCompact.mockResolvedValue({ autoCompactEnabled: false });

    mcpEnsureService = {
      ensureMcp: jest.fn().mockResolvedValue({ success: true, action: 'already_configured' }),
    };

    eventsService = {
      publish: jest.fn().mockResolvedValue('event-log-id'),
    };

    sendCoordinator = {
      ensureAgentGap: jest.fn().mockResolvedValue(undefined),
    } as unknown as TerminalSendCoordinatorService;

    sessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation((agentId: string, fn: () => unknown) => fn()),
    };

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

    terminalGateway = {
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
      mcpEnsureService as unknown as ProviderMcpEnsureService,
      sessionCoordinator as unknown as SessionCoordinatorService,
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
      mcpConfigured: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    // Mock a matching provider config for the fallback path
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model claude-3',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
      epicId: 'epic-1',
    });

    await jest.runAllTimersAsync();
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
      mcpConfigured: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    // Mock a matching provider config for the fallback path
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model claude-3',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-2',
    });

    await jest.runAllTimersAsync();
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
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
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

  it('throws when provider MCP is not configured and auto-ensure fails', async () => {
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
      // Note: providerId/options removed in Phase 4
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    // Provider config now provides provider and options
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model claude-3',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const preflightResult = {
      overall: 'pass',
      checks: [],
      providers: [
        {
          id: 'provider-1',
          name: 'claude',
          status: 'warn',
          message: "MCP alias 'devchain' not found.",
          binPath: '/usr/local/bin/claude',
          binaryStatus: 'pass',
          binaryMessage: 'Binary found',
          mcpStatus: 'warn',
          mcpMessage: "MCP alias 'devchain' not found.",
        },
      ],
      supportedMcpProviders: ['claude'],
      timestamp: new Date().toISOString(),
    };

    // Preflight always returns same result (MCP not configured)
    preflightService.runChecks.mockResolvedValue(preflightResult);

    // Auto-ensure fails
    mcpEnsureService.ensureMcp.mockResolvedValue({
      success: false,
      action: 'error',
      message: 'Failed to register MCP',
    });

    await expect(
      service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      }),
    ).rejects.toThrow(ValidationError);

    // Verify the error has the correct details
    try {
      await service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toBe('Provider MCP is not configured');
      expect((error as ValidationError).details).toEqual({
        code: 'MCP_NOT_CONFIGURED',
        providerId: 'provider-1',
        providerName: 'claude',
        mcpMessage: "MCP alias 'devchain' not found.",
        mcpStatus: 'warn',
      });
    }

    // Verify auto-ensure was attempted
    expect(mcpEnsureService.ensureMcp).toHaveBeenCalled();
  });

  it('blocks Claude launch when auto-compact is enabled and broadcasts session_blocked first', async () => {
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
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model claude-3',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    mockCheckClaudeAutoCompact.mockResolvedValue({ autoCompactEnabled: true });

    await expect(
      service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      }),
    ).rejects.toMatchObject({
      message: 'Claude auto-compact is enabled',
      details: {
        code: 'CLAUDE_AUTO_COMPACT_ENABLED',
        providerId: 'provider-1',
        providerName: 'claude',
      },
    });

    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith('system', 'session_blocked', {
      reason: 'claude_auto_compact',
      agentId: 'agent-1',
      agentName: 'Helper Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: false,
    });
    expect(preflightService.runChecks).not.toHaveBeenCalled();
  });

  it('broadcasts session_blocked with silent=true when launch options request silent mode', async () => {
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
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model claude-3',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    mockCheckClaudeAutoCompact.mockResolvedValue({ autoCompactEnabled: true });

    await expect(
      service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
        options: { silent: true },
      }),
    ).rejects.toMatchObject({
      message: 'Claude auto-compact is enabled',
      details: {
        code: 'CLAUDE_AUTO_COMPACT_ENABLED',
        providerId: 'provider-1',
        providerName: 'claude',
      },
    });

    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith('system', 'session_blocked', {
      reason: 'claude_auto_compact',
      agentId: 'agent-1',
      agentName: 'Helper Agent',
      providerId: 'provider-1',
      providerName: 'claude',
      silent: true,
    });
  });

  it('allows Claude launch when auto-compact is disabled', async () => {
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
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model claude-3',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await expect(launchPromise).resolves.toBeDefined();

    expect(mockCheckClaudeAutoCompact).toHaveBeenCalledTimes(1);
    expect(preflightService.runChecks).toHaveBeenCalledTimes(1);
  });

  it('skips auto-compact check for non-Claude providers', async () => {
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
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model gpt-5',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'codex',
      binPath: '/usr/local/bin/codex',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await expect(launchPromise).resolves.toBeDefined();

    expect(mockCheckClaudeAutoCompact).not.toHaveBeenCalled();
    expect(preflightService.runChecks).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid config options with ValidationError', async () => {
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
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    // Mock a config with invalid options (contains newline)
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: 'bad\noption',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);

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
      // Note: providerId/options removed in Phase 4
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    // Provider config now provides provider and options
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model claude-3',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
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

    await jest.runAllTimersAsync();
    await launchPromise;

    expect(storage.getInitialSessionPrompt).toHaveBeenCalled();
    expect(tmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);
    const rendered = (tmuxService.pasteAndSubmit as jest.Mock).mock.calls[0][1];
    expect(rendered).toContain('Helper Agent');
    expect(rendered).toContain('My Project');
    expect(rendered).not.toContain('{agent_name}');
    expect(rendered).not.toContain('{project_name}');
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
      // Note: providerId/options removed in Phase 4
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    // Provider config now provides provider and options
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model claude-3',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
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

    await jest.runAllTimersAsync();
    await launchPromise;

    const rendered = (tmuxService.pasteAndSubmit as jest.Mock).mock.calls[0][1] as string;
    expect(rendered.startsWith('Session ')).toBe(true);
    expect(rendered.length).toBeLessThan(5000);
  });

  it('returns existing session when agent already has active session (idempotent)', async () => {
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
      title: 'Test Epic',
      projectId: 'project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // Mock getActiveSessionForAgent to return an existing session
    const existingSessionId = 'existing-session-123';
    const existingTmuxId = 'tmux-existing';
    // The service calls getSession which is a real method that queries sqlite
    // We need to mock the sqlite prepare to return the existing session
    sqlitePrepare.mockReturnValue({
      run: insertRunMock,
      get: jest.fn().mockReturnValue({
        id: existingSessionId,
        epic_id: 'epic-1',
        agent_id: 'agent-1',
        tmux_session_id: existingTmuxId,
        status: 'running',
        started_at: '2024-01-01T00:00:00.000Z',
        ended_at: null,
        last_activity_at: null,
        activity_state: null,
        busy_since: null,
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      }),
      all: jest.fn().mockReturnValue([]),
    });

    const result = await service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
      epicId: 'epic-1',
    });

    // Should return the existing session, not create a new one
    expect(result.id).toBe(existingSessionId);
    expect(result.tmuxSessionId).toBe(existingTmuxId);
    expect(result.status).toBe('running');
    expect(result.agent).toEqual({
      id: 'agent-1',
      name: 'Helper Agent',
      profileId: 'profile-1',
    });
    expect(result.epic).toEqual({
      id: 'epic-1',
      title: 'Test Epic',
      projectId: 'project-1',
    });

    // Should not have called tmux createSession since we're returning existing
    expect(tmuxService.createSession).not.toHaveBeenCalled();
  });

  it('cleans up orphaned tmux session and returns existing session on unique constraint violation', async () => {
    // Note: Don't use fake timers - the 7s wait will cause issues with them
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: null,
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
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);
    storage.getProject.mockResolvedValue({
      id: 'project-1',
      name: 'My Project',
      rootPath: '/workspace/project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getEpic.mockResolvedValue({
      id: 'epic-1',
      title: 'Test Epic',
      projectId: 'project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getPrompt.mockResolvedValue(null);
    storage.getInitialSessionPrompt.mockResolvedValue(null);

    // Add a provider config so the session can launch
    const providerConfigId = 'config-1';
    storage.getAgentProfile.mockResolvedValue({
      id: 'profile-1',
      name: 'Helper Profile',
      options: null,
      providerId: 'provider-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProfileProviderConfig.mockResolvedValue({
      id: providerConfigId,
      profileId: 'profile-1',
      name: 'Config 1',
      providerId: 'provider-1',
      options: null,
      env: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/bin/claude',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // Update the agent mock to include providerConfigId
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: providerConfigId,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // Mock getActiveSessionForAgent:
    // First call (idempotent check): returns null so we proceed with insert
    // Second call (after constraint error): returns existing session
    const existingSessionId = 'existing-session-456';
    const existingTmuxId = 'tmux-existing-456';
    const existingSessionRow = {
      id: existingSessionId,
      epic_id: 'epic-1',
      agent_id: 'agent-1',
      tmux_session_id: existingTmuxId,
      status: 'running',
      started_at: '2024-01-01T00:00:00.000Z',
      ended_at: null,
      last_activity_at: null,
      activity_state: null,
      busy_since: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };

    const runMock = jest.fn();
    sqlitePrepare.mockReturnValue({
      run: runMock,
      get: jest
        .fn()
        .mockImplementationOnce(() => null)
        .mockImplementationOnce(() => existingSessionRow),
      all: jest.fn().mockReturnValue([]),
    });

    // First call to sqlite.prepare will throw constraint error
    const constraintError = { code: 'SQLITE_CONSTRAINT', message: 'UNIQUE constraint failed' };
    runMock.mockImplementationOnce(() => {
      throw constraintError;
    });

    // Spy on destroySession to verify cleanup
    const destroySpy = jest.spyOn(tmuxService, 'destroySession');

    const result = await service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
      epicId: 'epic-1',
    });

    // Should have cleaned up the orphaned tmux session
    expect(destroySpy).toHaveBeenCalledWith('tmux-session');

    // Should return the existing session
    expect(result.id).toBe(existingSessionId);
    expect(result.tmuxSessionId).toBe(existingTmuxId);
    expect(result.status).toBe('running');
  }, 15000); // 15 second timeout for the 7s wait
});

/**
 * Regression tests for nested lock deadlock prevention.
 *
 * These tests use a REAL SessionCoordinatorService (not mocked) to verify
 * that the lock behavior works correctly and doesn't cause deadlocks.
 *
 * Background: launchSession() wraps itself in withAgentLock(). Previously,
 * some callers also wrapped launchSession() with withAgentLock(), causing
 * nested non-reentrant locks → deadlock. The fix removed outer locks from callers.
 */
describe('SessionCoordinatorService - nested lock deadlock regression', () => {
  it('single lock completes without deadlock', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const agentId = 'agent-single-lock';

    // This simulates what launchSession does - single lock around the operation
    const result = await realCoordinator.withAgentLock(agentId, async () => {
      // Simulate some async work
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'completed';
    });

    expect(result).toBe('completed');
  });

  it('demonstrates that nested locks on same agent cause deadlock (timeout test)', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const agentId = 'agent-deadlock-test';

    // Simulate what would happen if launchSession() has internal lock
    // AND the caller also wraps with lock (the old buggy pattern)
    const innerOperation = async () => {
      // This simulates launchSession's internal withAgentLock
      return realCoordinator.withAgentLock(agentId, async () => {
        return 'inner-completed';
      });
    };

    // This is the problematic pattern: outer lock wrapping inner lock on same agent
    const nestedLockPromise = realCoordinator.withAgentLock(agentId, async () => {
      // The inner lock will wait for outer lock to release (which never happens)
      return innerOperation();
    });

    // Use Promise.race with a timeout to detect deadlock
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 500); // 500ms should be enough for non-deadlock
    });

    const result = await Promise.race([nestedLockPromise, timeoutPromise]);

    // This SHOULD timeout because nested locks deadlock
    expect(result).toBe('timeout');
  }, 2000);

  it('sequential locks on same agent work correctly (no deadlock)', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const agentId = 'agent-sequential-test';
    const results: string[] = [];

    // First lock
    await realCoordinator.withAgentLock(agentId, async () => {
      results.push('first');
    });

    // Second lock (after first completes) - should work fine
    await realCoordinator.withAgentLock(agentId, async () => {
      results.push('second');
    });

    expect(results).toEqual(['first', 'second']);
  });

  it('concurrent locks on different agents work correctly (no blocking)', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const results: string[] = [];

    // Concurrent operations on different agents should not block each other
    await Promise.all([
      realCoordinator.withAgentLock('agent-a', async () => {
        await new Promise((r) => setTimeout(r, 50));
        results.push('agent-a');
      }),
      realCoordinator.withAgentLock('agent-b', async () => {
        results.push('agent-b');
      }),
    ]);

    // agent-b should complete before agent-a (no blocking between different agents)
    expect(results).toEqual(['agent-b', 'agent-a']);
  });

  it('concurrent locks on same agent serialize correctly', async () => {
    const realCoordinator = new SessionCoordinatorService();
    const agentId = 'agent-concurrent-test';
    const results: string[] = [];

    // Two concurrent operations on same agent should serialize
    await Promise.all([
      realCoordinator.withAgentLock(agentId, async () => {
        await new Promise((r) => setTimeout(r, 50));
        results.push('first');
      }),
      realCoordinator.withAgentLock(agentId, async () => {
        results.push('second');
      }),
    ]);

    // Even though second was started later, first should complete first due to serialization
    expect(results).toEqual(['first', 'second']);
  });
});
