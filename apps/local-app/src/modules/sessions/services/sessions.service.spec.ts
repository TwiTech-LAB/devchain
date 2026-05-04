jest.mock('../utils/claude-config', () => ({
  checkClaudeAutoCompact: jest.fn(),
}));

const mockSessionsLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../common/logging/logger', () => ({
  createLogger: jest.fn(() => mockSessionsLogger),
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
import type { HooksConfigService } from '../../hooks/services/hooks-config.service';
import type { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
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
    waitForOutput: jest.Mock;
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
  let providerAdapterFactory: { getAdapter: jest.Mock };
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
      waitForOutput: jest.fn().mockResolvedValue({ ready: true, elapsedMs: 2500 }),
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
    mockCheckClaudeAutoCompact.mockResolvedValue({
      autoCompactEnabled: false,
      configState: 'valid',
    });

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

    const hooksConfigService = {
      ensureHooksConfig: jest.fn().mockResolvedValue(undefined),
    };

    providerAdapterFactory = {
      getAdapter: jest.fn().mockReturnValue({
        providerName: 'claude',
        launchInitialPromptBehavior: undefined,
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
      hooksConfigService as unknown as HooksConfigService,
      providerAdapterFactory as unknown as ProviderAdapterFactory,
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
      'claude',
      expect.any(String),
      expect.any(String),
    );
    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    // Verify DEVCHAIN env vars are injected for Claude provider
    expect(sendArgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DEVCHAIN_API_URL='),
        expect.stringContaining('DEVCHAIN_PROJECT_ID=project-1'),
        expect.stringContaining('DEVCHAIN_AGENT_ID=agent-1'),
      ]),
    );
    // Verify the actual command args follow the env vars
    expect(sendArgs).toEqual(
      expect.arrayContaining(['/usr/local/bin/claude', '--model', 'claude-3']),
    );
    expect(tmuxService.waitForOutput).toHaveBeenCalledWith('tmux-session', {
      pollIntervalMs: 500,
      timeoutMs: 30000,
      settleMs: 1000,
    });
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
      'claude',
      expect.any(String),
      expect.any(String),
    );
    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    // Verify DEVCHAIN env vars are injected for Claude provider
    expect(sendArgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DEVCHAIN_API_URL='),
        expect.stringContaining('DEVCHAIN_PROJECT_ID=project-1'),
        expect.stringContaining('DEVCHAIN_AGENT_ID=agent-2'),
      ]),
    );
    expect(sendArgs).toEqual(
      expect.arrayContaining(['/usr/local/bin/claude', '--model', 'claude-3']),
    );
    expect(tmuxService.waitForOutput).toHaveBeenCalledWith('tmux-session', {
      pollIntervalMs: 500,
      timeoutMs: 30000,
      settleMs: 1000,
    });
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

  it('replaces existing model flags with agent modelOverride on launch', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-override',
      name: 'Override Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
      modelOverride: 'anthropic/claude-sonnet-4-5',
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
    storage.getProfileProviderConfig.mockResolvedValue({
      id: 'config-1',
      profileId: 'profile-1',
      providerId: 'provider-1',
      options: '--model old-a -m old-b --model=old-c -m=old-d --max-tokens 4000',
      env: null,
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

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-override',
    });

    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    const binaryIndex = sendArgs.indexOf('/usr/local/bin/claude');
    expect(binaryIndex).toBeGreaterThan(-1);
    expect(sendArgs.slice(binaryIndex + 1)).toEqual([
      '--model',
      'anthropic/claude-sonnet-4-5',
      '--max-tokens',
      '4000',
    ]);
  });

  it('keeps parsed options unchanged when modelOverride is null', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-no-override',
      name: 'No Override Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
      modelOverride: null,
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
    storage.getProfileProviderConfig.mockResolvedValue({
      id: 'config-1',
      profileId: 'profile-1',
      providerId: 'provider-1',
      options: '-m existing-model --max-tokens 2000',
      env: null,
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

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-no-override',
    });

    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    const binaryIndex = sendArgs.indexOf('/usr/local/bin/claude');
    expect(binaryIndex).toBeGreaterThan(-1);
    expect(sendArgs.slice(binaryIndex + 1)).toEqual([
      '-m',
      'existing-model',
      '--max-tokens',
      '2000',
    ]);
  });

  it('continues launch and logs warning when waitForOutput times out', async () => {
    jest.useFakeTimers();
    tmuxService.waitForOutput.mockResolvedValueOnce({ ready: false, elapsedMs: 30000 });

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

    expect(result.id).toBeDefined();
    expect(tmuxService.waitForOutput).toHaveBeenCalledWith('tmux-session', {
      pollIntervalMs: 500,
      timeoutMs: 30000,
      settleMs: 1000,
    });
    expect(mockSessionsLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        tmuxSessionName: 'tmux-session',
        elapsedMs: 30000,
      }),
      'CLI output detection timed out, proceeding anyway',
    );
    expect(eventsService.publish).toHaveBeenCalledWith(
      'session.started',
      expect.objectContaining({ sessionId: result.id }),
    );
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

  it('broadcasts session_recommendation when Claude auto-compact is disabled (non-blocking)', async () => {
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
    mockCheckClaudeAutoCompact.mockResolvedValue({
      autoCompactEnabled: false,
      configState: 'valid',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await expect(launchPromise).resolves.toBeDefined();

    // Non-blocking: broadcasts recommendation but session proceeds
    expect(terminalGateway.broadcastEvent).toHaveBeenCalledWith(
      'system',
      'session_recommendation',
      {
        reason: 'claude_auto_compact_disabled',
        agentId: 'agent-1',
        agentName: 'Helper Agent',
        providerId: 'provider-1',
        providerName: 'claude',
        silent: false,
        bootId: expect.any(String),
      },
    );
    expect(preflightService.runChecks).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('does not broadcast recommendation when Claude auto-compact is enabled', async () => {
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
    mockCheckClaudeAutoCompact.mockResolvedValue({
      autoCompactEnabled: true,
      configState: 'valid',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await expect(launchPromise).resolves.toBeDefined();

    // No recommendation when auto-compact is already enabled
    expect(terminalGateway.broadcastEvent).not.toHaveBeenCalledWith(
      'system',
      'session_recommendation',
      expect.anything(),
    );
    jest.useRealTimers();
  });

  it('does not broadcast recommendation when config is malformed', async () => {
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
    mockCheckClaudeAutoCompact.mockResolvedValue({
      autoCompactEnabled: false,
      configState: 'malformed',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await expect(launchPromise).resolves.toBeDefined();

    // No recommendation when config is malformed (avoid false triggers)
    expect(terminalGateway.broadcastEvent).not.toHaveBeenCalledWith(
      'system',
      'session_recommendation',
      expect.anything(),
    );
    jest.useRealTimers();
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

  it('injects CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when provider has autoCompactThreshold', async () => {
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
      autoCompactThreshold: 10,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    expect(sendArgs).toEqual(
      expect.arrayContaining([expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10')]),
    );
  });

  it('does not inject CLAUDE_AUTOCOMPACT_PCT_OVERRIDE when provider threshold is null', async () => {
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
      autoCompactThreshold: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    const autoCompactArg = sendArgs.find((a: string) =>
      a.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'),
    );
    expect(autoCompactArg).toBeUndefined();
  });

  it('does not overwrite CLAUDE_AUTOCOMPACT_PCT_OVERRIDE from provider config env', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
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
    storage.getProfileProviderConfig.mockResolvedValue({
      id: 'config-1',
      profileId: 'profile-1',
      providerId: 'provider-1',
      options: '--model claude-3',
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50' },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      autoCompactThreshold: 10,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    // User override (50) should win over provider threshold (10)
    expect(sendArgs).toEqual(
      expect.arrayContaining([expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50')]),
    );
    // Should NOT contain the provider default of 10
    const matchingArgs = sendArgs.filter((a: string) =>
      a.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=10'),
    );
    expect(matchingArgs).toHaveLength(0);
  });

  describe('model-aware threshold resolution', () => {
    it('injects 1M threshold when opus model with 1M enabled and autoCompactThreshold1m set', async () => {
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
          options: '--model opus --dangerously-skip-permissions',
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
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const launchPromise = service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      });
      await jest.runAllTimersAsync();
      await launchPromise;

      const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
      expect(sendArgs).toEqual(
        expect.arrayContaining([expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50')]),
      );
    });

    it('injects standard threshold when sonnet model with 1M enabled', async () => {
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
          options: '--model sonnet --dangerously-skip-permissions',
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
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const launchPromise = service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      });
      await jest.runAllTimersAsync();
      await launchPromise;

      const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
      expect(sendArgs).toEqual(
        expect.arrayContaining([expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=95')]),
      );
      const matchingArgs = sendArgs.filter((a: string) =>
        a.includes('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50'),
      );
      expect(matchingArgs).toHaveLength(0);
    });

    it('injects 1M threshold when no model flag with 1M enabled (rewritten to opus[1m])', async () => {
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
          options: '--dangerously-skip-permissions',
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
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const launchPromise = service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      });
      await jest.runAllTimersAsync();
      await launchPromise;

      const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
      // No model flag + 1M enabled: rewriteModelTo1m() adds opus[1m] → 1M threshold applies
      expect(sendArgs.join(' ')).toContain('--model opus[1m]');
      expect(sendArgs).toEqual(
        expect.arrayContaining([expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50')]),
      );
    });

    it('injects standard threshold when 1M is disabled regardless of model', async () => {
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
          options: '--model opus --dangerously-skip-permissions',
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
        autoCompactThreshold: 85,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });

      const launchPromise = service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      });
      await jest.runAllTimersAsync();
      await launchPromise;

      const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
      expect(sendArgs).toEqual(
        expect.arrayContaining([expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=85')]),
      );
      // 1M disabled: model should not be rewritten
      expect(sendArgs.join(' ')).not.toContain('opus[1m]');
    });
  });

  it('rewrites model to opus[1m] when Claude provider has 1M enabled and --model opus', async () => {
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
        options: '--model opus',
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
      oneMillionContextEnabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    expect(sendArgs.join(' ')).toContain('--model opus[1m]');
    // No CLAUDE_CODE_DISABLE_1M_CONTEXT in env
    expect(sendArgs.join(' ')).not.toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT');
  });

  it('defaults to --model opus[1m] when Claude provider has 1M enabled and no model flag', async () => {
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
        options: null,
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
      oneMillionContextEnabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    expect(sendArgs.join(' ')).toContain('--model opus[1m]');
  });

  it('preserves claude-opus-4-6[1m] full ID and still applies 1M auto-compact threshold', async () => {
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
        options: '--model claude-opus-4-6[1m] --dangerously-skip-permissions',
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
      autoCompactThreshold: 95,
      autoCompactThreshold1m: 50,
      oneMillionContextEnabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    const sendArgsJoined = sendArgs.join(' ');
    // Full-ID [1m] pin preserved verbatim; NOT collapsed to the short alias.
    expect(sendArgsJoined).toContain('--model claude-opus-4-6[1m]');
    expect(sendArgsJoined).not.toContain('--model opus[1m]');
    // Invariant: detectClaudeModelFamily still matches "opus" in the preserved
    // full ID, so the 1M auto-compact threshold is still routed correctly.
    expect(sendArgs).toEqual(
      expect.arrayContaining([expect.stringContaining('CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50')]),
    );
    expect(sendArgsJoined).not.toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT');
  });

  it('does not rewrite sonnet model when Claude provider has 1M enabled', async () => {
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
        options: '--model sonnet',
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
      oneMillionContextEnabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    expect(sendArgs.join(' ')).toContain('--model sonnet');
    expect(sendArgs.join(' ')).not.toContain('sonnet[1m]');
  });

  it('does not rewrite model when Claude provider has 1M disabled', async () => {
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
        options: '--model opus',
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
      oneMillionContextEnabled: false,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    // Model should remain as-is (no [1m] rewrite)
    expect(sendArgs.join(' ')).toContain('--model opus');
    expect(sendArgs.join(' ')).not.toContain('opus[1m]');
    // No CLAUDE_CODE_DISABLE_1M_CONTEXT in env
    expect(sendArgs.join(' ')).not.toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT');
  });

  it('does not rewrite model for non-Claude provider regardless of 1M setting', async () => {
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
        options: '--model opus',
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'codex',
      binPath: '/usr/local/bin/codex',
      mcpConfigured: false,
      oneMillionContextEnabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    // Non-Claude provider: model should NOT be rewritten
    expect(sendArgs.join(' ')).toContain('--model opus');
    expect(sendArgs.join(' ')).not.toContain('opus[1m]');
  });

  it('does not rewrite unknown Claude model family even with 1M enabled', async () => {
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
        options: '--model claude-haiku-4-5',
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
      oneMillionContextEnabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    // Unknown model family (haiku): should NOT be rewritten to [1m] alias
    expect(sendArgs.join(' ')).toContain('--model claude-haiku-4-5');
    expect(sendArgs.join(' ')).not.toContain('[1m]');
  });

  describe('provider-level env merge at session launch', () => {
    const agentBase = {
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const projectBase = {
      id: 'project-1',
      name: 'My Project',
      rootPath: '/workspace/project-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    const profileBase = {
      id: 'profile-1',
      name: 'Helper Profile',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };

    it('Claude: merges { ...devchainEnv, ...providerEnv, ...configEnv } — config wins on collision', async () => {
      jest.useFakeTimers();
      storage.getAgent.mockResolvedValue(agentBase);
      storage.getProject.mockResolvedValue(projectBase);
      storage.getAgentProfile.mockResolvedValue(profileBase);
      storage.getProfileProviderConfig.mockResolvedValue({
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model opus',
        env: { SHARED: 'from-config', CONFIG_ONLY: 'cval' },
      });
      storage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        env: { SHARED: 'from-provider', PROVIDER_ONLY: 'pval' },
      });

      const launchPromise = service.launchSession({ projectId: 'project-1', agentId: 'agent-1' });
      await jest.runAllTimersAsync();
      await launchPromise;

      const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
      const joined = sendArgs.join(' ');
      // Config wins on collision
      expect(joined).toContain('SHARED=from-config');
      expect(joined).not.toContain('SHARED=from-provider');
      // Provider-only key present
      expect(joined).toContain('PROVIDER_ONLY=pval');
      // Config-only key present
      expect(joined).toContain('CONFIG_ONLY=cval');
      // Devchain env keys present (bottom of precedence)
      expect(joined).toContain('DEVCHAIN_API_URL=');
      expect(joined).toContain('DEVCHAIN_PROJECT_ID=project-1');
      expect(joined).toContain('DEVCHAIN_AGENT_ID=agent-1');
    });

    it('non-Claude: merges { ...providerEnv, ...configEnv } — no devchain keys', async () => {
      jest.useFakeTimers();
      storage.getAgent.mockResolvedValue(agentBase);
      storage.getProject.mockResolvedValue(projectBase);
      storage.getAgentProfile.mockResolvedValue(profileBase);
      storage.getProfileProviderConfig.mockResolvedValue({
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: null,
        env: { SHARED: 'from-config', CONFIG_ONLY: 'cval' },
      });
      storage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'opencode',
        binPath: '/usr/local/bin/opencode',
        mcpConfigured: true,
        env: { SHARED: 'from-provider', PROVIDER_ONLY: 'pval' },
      });
      providerAdapterFactory.getAdapter.mockReturnValue({
        providerName: 'opencode',
        launchInitialPromptBehavior: undefined,
      });

      const launchPromise = service.launchSession({ projectId: 'project-1', agentId: 'agent-1' });
      await jest.runAllTimersAsync();
      await launchPromise;

      const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
      const joined = sendArgs.join(' ');
      // Config wins on collision
      expect(joined).toContain('SHARED=from-config');
      expect(joined).not.toContain('SHARED=from-provider');
      // Provider-only and config-only keys present
      expect(joined).toContain('PROVIDER_ONLY=pval');
      expect(joined).toContain('CONFIG_ONLY=cval');
      // No devchain env keys for non-Claude
      expect(joined).not.toContain('DEVCHAIN_API_URL');
      expect(joined).not.toContain('DEVCHAIN_PROJECT_ID');
    });

    it('provider.env = null behaves identically to before (no extra env)', async () => {
      jest.useFakeTimers();
      storage.getAgent.mockResolvedValue(agentBase);
      storage.getProject.mockResolvedValue(projectBase);
      storage.getAgentProfile.mockResolvedValue(profileBase);
      storage.getProfileProviderConfig.mockResolvedValue({
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model opus',
        env: { MY_VAR: 'val' },
      });
      storage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        env: null,
      });

      const launchPromise = service.launchSession({ projectId: 'project-1', agentId: 'agent-1' });
      await jest.runAllTimersAsync();
      await launchPromise;

      const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
      const joined = sendArgs.join(' ');
      // Config env present
      expect(joined).toContain('MY_VAR=val');
      // Devchain env present
      expect(joined).toContain('DEVCHAIN_API_URL=');
    });

    it('CLAUDE_CODE_DISABLE_1M_CONTEXT is deleted from merged result even if in provider env', async () => {
      jest.useFakeTimers();
      storage.getAgent.mockResolvedValue(agentBase);
      storage.getProject.mockResolvedValue(projectBase);
      storage.getAgentProfile.mockResolvedValue(profileBase);
      storage.getProfileProviderConfig.mockResolvedValue({
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: '--model opus',
        env: null,
      });
      storage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'claude',
        binPath: '/usr/local/bin/claude',
        mcpConfigured: true,
        oneMillionContextEnabled: true,
        env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
      });

      const launchPromise = service.launchSession({ projectId: 'project-1', agentId: 'agent-1' });
      await jest.runAllTimersAsync();
      await launchPromise;

      const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
      expect(sendArgs.join(' ')).not.toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT');
    });
  });

  it('strips stale CLAUDE_CODE_DISABLE_1M_CONTEXT from provider-config env', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
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
    storage.getProfileProviderConfig.mockResolvedValue({
      id: 'config-1',
      profileId: 'profile-1',
      providerId: 'provider-1',
      options: '--model opus',
      env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '0' },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: '/usr/local/bin/claude',
      mcpConfigured: true,
      oneMillionContextEnabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    const sendArgs = tmuxService.sendCommandArgs.mock.calls[0][1] as string[];
    // Stale env var should be stripped entirely
    expect(sendArgs.join(' ')).not.toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT');
    // Model should be rewritten since 1M is enabled
    expect(sendArgs.join(' ')).toContain('--model opus[1m]');
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

  it('continues session launch when initial prompt paste fails (non-fatal)', async () => {
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
    storage.getInitialSessionPrompt.mockResolvedValueOnce({
      id: 'prompt-1',
      projectId: null,
      title: 'Kickoff',
      content: 'Hello {agent_name}',
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // Make pasteAndSubmit fail (simulates Enter key not sent)
    tmuxService.pasteAndSubmit.mockRejectedValueOnce(new Error('sendKeys failed twice'));

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });

    await jest.runAllTimersAsync();

    // Session launch should succeed despite prompt failure
    const result = await launchPromise;
    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
  });

  it('forwards Claude launch handshake preKeys and preDelayMs to pasteAndSubmit', async () => {
    jest.useFakeTimers();
    // Configure adapter to return Claude handshake metadata
    providerAdapterFactory.getAdapter.mockReturnValue({
      providerName: 'claude',
      launchInitialPromptBehavior: { preKeys: ['Enter'], preDelayMs: 2000 },
    });
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
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    expect(tmuxService.pasteAndSubmit).toHaveBeenCalledWith(
      'tmux-session',
      expect.any(String),
      expect.objectContaining({
        bracketed: true,
        submitKeys: ['Enter'],
        delayMs: 250,
        preKeys: ['Enter'],
        preDelayMs: 2000,
      }),
    );
  });

  it('does not pass preKeys to pasteAndSubmit when provider has no launch handshake', async () => {
    jest.useFakeTimers();
    // Configure adapter to return no handshake metadata (e.g., opencode)
    providerAdapterFactory.getAdapter.mockReturnValue({
      providerName: 'opencode',
      launchInitialPromptBehavior: undefined,
    });
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
        options: null,
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'opencode',
      binPath: '/usr/local/bin/opencode',
      mcpConfigured: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();
    await launchPromise;

    expect(tmuxService.pasteAndSubmit).toHaveBeenCalledWith(
      'tmux-session',
      expect.any(String),
      expect.objectContaining({
        bracketed: true,
        submitKeys: ['Enter'],
        delayMs: 250,
        preKeys: undefined,
        preDelayMs: undefined,
      }),
    );
  });

  it('continues launch when adapter resolution fails (unsupported provider)', async () => {
    jest.useFakeTimers();
    // Adapter factory throws for unknown provider
    providerAdapterFactory.getAdapter.mockImplementation(() => {
      throw new Error('Unsupported provider: custom');
    });
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
        options: null,
        env: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]);
    storage.getProvider.mockResolvedValue({
      id: 'provider-1',
      name: 'custom',
      binPath: '/usr/local/bin/custom',
      mcpConfigured: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });
    await jest.runAllTimersAsync();

    // Launch should succeed — adapter resolution failure is non-fatal
    const result = await launchPromise;
    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
    // pasteAndSubmit should still be called without preKeys
    expect(tmuxService.pasteAndSubmit).toHaveBeenCalledWith(
      'tmux-session',
      expect.any(String),
      expect.objectContaining({
        bracketed: true,
        submitKeys: ['Enter'],
        delayMs: 250,
        preKeys: undefined,
        preDelayMs: undefined,
      }),
    );
  });

  it('includes team context in initial prompt when TeamsService is available', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
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
    storage.getInitialSessionPrompt.mockResolvedValue({
      id: 'prompt-1',
      title: 'Init',
      content: '{{#if team_name}}Team: {{team_name}}{{/if}}',
    });

    const teamsServiceMock = {
      listTeamsByAgent: jest.fn().mockResolvedValue([
        {
          id: 't1',
          name: 'Backend',
          teamLeadAgentId: 'agent-1',
          projectId: 'project-1',
          description: null,
          maxMembers: 10,
          maxConcurrentTasks: 3,
          allowTeamLeadCreateAgents: false,
          createdAt: '',
          updatedAt: '',
        },
      ]),
    };

    const dbMock = {
      session: {
        client: {
          prepare: sqlitePrepare,
        },
      },
    } as unknown as BetterSQLite3Database;

    const moduleRefWithTeams = {
      get: jest.fn().mockImplementation((token: unknown) => {
        const tokenName = (token as { name?: string })?.name;
        if (tokenName === 'TerminalGateway') return terminalGateway;
        if (tokenName === 'EventsService') return eventsService;
        if (tokenName === 'TeamsService') return teamsServiceMock;
        return null;
      }),
    };

    const serviceWithTeams = new SessionsService(
      dbMock,
      storage as never,
      tmuxService as never,
      sendCoordinator,
      ptyService as never,
      preflightService as never,
      mcpEnsureService as never,
      sessionCoordinator as never,
      { getHooksConfig: jest.fn().mockReturnValue(null) } as never,
      providerAdapterFactory as never,
      moduleRefWithTeams as never,
    );

    const launchPromise = serviceWithTeams.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });

    await jest.runAllTimersAsync();
    await launchPromise;

    expect(teamsServiceMock.listTeamsByAgent).toHaveBeenCalledWith('agent-1');
    const rendered = (tmuxService.pasteAndSubmit as jest.Mock).mock.calls[0][1] as string;
    expect(rendered).toContain('Team: Backend');

    jest.useRealTimers();
  });

  it('delivers initial prompt with teamless context when moduleRef.get throws', async () => {
    jest.useFakeTimers();
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      name: 'Helper Agent',
      projectId: 'project-1',
      profileId: 'profile-1',
      createdAt: '2024-01-01T00:00:00.000Z',
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

    const dbMock = {
      session: {
        client: {
          prepare: sqlitePrepare,
        },
      },
    } as unknown as BetterSQLite3Database;

    const moduleRefThrows = {
      get: jest.fn().mockImplementation((token: unknown) => {
        const tokenName = (token as { name?: string })?.name;
        if (tokenName === 'TerminalGateway') return terminalGateway;
        if (tokenName === 'EventsService') return eventsService;
        if (tokenName === 'TeamsService') throw new Error('Provider not found');
        return null;
      }),
    };

    const serviceThrows = new SessionsService(
      dbMock,
      storage as never,
      tmuxService as never,
      sendCoordinator,
      ptyService as never,
      preflightService as never,
      mcpEnsureService as never,
      sessionCoordinator as never,
      { getHooksConfig: jest.fn().mockReturnValue(null) } as never,
      providerAdapterFactory as never,
      moduleRefThrows as never,
    );

    const launchPromise = serviceThrows.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });

    await jest.runAllTimersAsync();
    const result = await launchPromise;

    expect(result.id).toBeDefined();
    expect(tmuxService.pasteAndSubmit).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
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

  it('inserts session row before sendCommandArgs so hook events can resolve the session', async () => {
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
      options: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: null,
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
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // Track call order: INSERT (via insertRunMock) vs sendCommandArgs
    const callOrder: string[] = [];
    insertRunMock.mockImplementation(() => {
      callOrder.push('db_insert');
    });
    tmuxService.sendCommandArgs.mockImplementation(async () => {
      callOrder.push('send_command');
    });

    const launchPromise = service.launchSession({
      projectId: 'project-1',
      agentId: 'agent-1',
    });

    await jest.runAllTimersAsync();
    await launchPromise;

    // DB insert must happen before sendCommandArgs
    expect(callOrder.indexOf('db_insert')).toBeLessThan(callOrder.indexOf('send_command'));
  });

  it('cleans up session row and tmux when sendCommandArgs fails', async () => {
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
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    storage.listProfileProviderConfigsByProfile.mockResolvedValue([
      {
        id: 'config-1',
        profileId: 'profile-1',
        providerId: 'provider-1',
        options: null,
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
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    // Make sendCommandArgs fail
    tmuxService.sendCommandArgs.mockRejectedValue(new Error('tmux send failed'));

    // Track DELETE calls via sqlitePrepare
    const deleteRunMock = jest.fn();
    sqlitePrepare.mockImplementation((sql: string) => {
      if (sql.includes('DELETE FROM sessions')) {
        return { run: deleteRunMock };
      }
      return { run: insertRunMock, get: jest.fn(), all: jest.fn().mockReturnValue([]) };
    });

    await expect(
      service.launchSession({
        projectId: 'project-1',
        agentId: 'agent-1',
      }),
    ).rejects.toThrow('tmux send failed');

    // Verify session row was inserted then deleted
    expect(insertRunMock).toHaveBeenCalled();
    expect(deleteRunMock).toHaveBeenCalledWith(expect.any(String));

    // Verify tmux session was destroyed
    expect(tmuxService.destroySession).toHaveBeenCalledWith('tmux-session');
  });
});

// ---------------------------------------------------------------------------
// restoreSession tests
// ---------------------------------------------------------------------------

describe('SessionsService.restoreSession', () => {
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
    sendCommandArgs: jest.Mock;
    destroySession: jest.Mock;
    hasSession: jest.Mock;
    setAlternateScreenOff: jest.Mock;
    pasteAndSubmit: jest.Mock;
  };
  let ptyService: { startStreaming: jest.Mock };
  let eventsService: { publish: jest.Mock };
  let sessionCoordinator: { withAgentLock: jest.Mock };
  let sqlitePrepare: jest.Mock;
  let sqliteGetMock: jest.Mock;
  let sqliteRunMock: jest.Mock;
  let sqliteAllMock: jest.Mock;
  let terminalGateway: { broadcastEvent: jest.Mock };
  let providerAdapterFactory: { getAdapter: jest.Mock };
  let service: SessionsService;

  const stoppedSessionRow = {
    id: 'sess-1',
    epic_id: 'epic-1',
    agent_id: 'agent-1',
    tmux_session_id: 'old-tmux',
    status: 'stopped',
    started_at: '2026-04-30T10:00:00.000Z',
    ended_at: '2026-04-30T12:00:00.000Z',
    transcript_path: '/home/user/.claude/session.jsonl',
    provider_session_id: 'provider-uuid-123',
    provider_name_at_launch: 'claude',
    created_at: '2026-04-30T10:00:00.000Z',
    updated_at: '2026-04-30T12:00:00.000Z',
  };

  beforeEach(() => {
    jest.clearAllMocks();

    storage = {
      getAgent: jest.fn().mockResolvedValue({
        id: 'agent-1',
        projectId: 'proj-1',
        profileId: 'prof-1',
        providerConfigId: 'cfg-1',
        name: 'Agent 1',
        modelOverride: null,
      }),
      getProject: jest.fn().mockResolvedValue({
        id: 'proj-1',
        name: 'My Project',
        rootPath: '/home/user/project',
      }),
      getEpic: jest.fn().mockResolvedValue({
        id: 'epic-1',
        title: 'Test Epic',
        projectId: 'proj-1',
      }),
      getAgentProfile: jest.fn().mockResolvedValue({
        id: 'prof-1',
        name: 'default',
      }),
      getProvider: jest.fn().mockResolvedValue({
        id: 'prov-1',
        name: 'claude',
        binPath: '/usr/bin/claude',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
        env: null,
        createdAt: '',
        updatedAt: '',
      }),
      getPrompt: jest.fn(),
      getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
      getProfileProviderConfig: jest.fn().mockResolvedValue({
        id: 'cfg-1',
        providerId: 'prov-1',
        options: null,
        env: null,
      }),
    };

    tmuxService = {
      createSessionName: jest.fn().mockReturnValue('tmux-restored'),
      createSession: jest.fn().mockResolvedValue(undefined),
      startHealthCheck: jest.fn(),
      sendCommandArgs: jest.fn().mockResolvedValue(undefined),
      destroySession: jest.fn().mockResolvedValue(undefined),
      hasSession: jest.fn().mockResolvedValue(false),
      setAlternateScreenOff: jest.fn().mockResolvedValue(undefined),
      pasteAndSubmit: jest.fn().mockResolvedValue(undefined),
    };

    ptyService = { startStreaming: jest.fn().mockResolvedValue(undefined) };
    eventsService = { publish: jest.fn().mockResolvedValue('event-log-id') };

    sessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation((_agentId: string, fn: () => unknown) => fn()),
    };

    sqliteGetMock = jest.fn().mockReturnValue(stoppedSessionRow);
    sqliteRunMock = jest.fn();
    sqliteAllMock = jest.fn().mockReturnValue([]);
    sqlitePrepare = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes("status = 'running'") && sql.includes('agent_id')) {
        return {
          get: jest.fn().mockReturnValue(undefined),
          run: sqliteRunMock,
          all: sqliteAllMock,
        };
      }
      return { get: sqliteGetMock, run: sqliteRunMock, all: sqliteAllMock };
    });

    const dbMock = {
      session: { client: { prepare: sqlitePrepare } },
    } as unknown as BetterSQLite3Database;

    terminalGateway = { broadcastEvent: jest.fn() };

    providerAdapterFactory = {
      getAdapter: jest.fn().mockReturnValue({
        providerName: 'claude',
        launchInitialPromptBehavior: undefined,
        buildLaunchArgs: jest.fn().mockReturnValue({
          argv: ['--resume', 'provider-uuid-123'],
        }),
      }),
    };

    const moduleRef = {
      get: jest.fn().mockImplementation((token: unknown) => {
        const tokenName = (token as { name?: string })?.name;
        if (tokenName === 'TerminalGateway') return terminalGateway as unknown as TerminalGateway;
        if (tokenName === 'EventsService') return eventsService as unknown as EventsService;
        return null;
      }),
    };

    service = new SessionsService(
      dbMock,
      storage as unknown as StorageService,
      tmuxService as unknown as TmuxService,
      {} as unknown as TerminalSendCoordinatorService,
      ptyService as unknown as PtyService,
      {} as unknown as PreflightService,
      {} as unknown as ProviderMcpEnsureService,
      sessionCoordinator as unknown as SessionCoordinatorService,
      { ensureHooksConfig: jest.fn() } as unknown as HooksConfigService,
      providerAdapterFactory as unknown as ProviderAdapterFactory,
      moduleRef as unknown as ModuleRef,
    );
  });

  it('restores a stopped session and emits session.restored', async () => {
    const result = await service.restoreSession('sess-1', 'proj-1');

    expect(result.id).toBe('sess-1');
    expect(result.status).toBe('running');
    expect(result.startedAt).toBe('2026-04-30T10:00:00.000Z');
    expect(result.endedAt).toBeNull();
    expect(result.tmuxSessionId).toBe('tmux-restored');

    expect(eventsService.publish).toHaveBeenCalledWith(
      'session.restored',
      expect.objectContaining({
        sessionId: 'sess-1',
        agentId: 'agent-1',
      }),
    );
    expect(eventsService.publish).not.toHaveBeenCalledWith('session.started', expect.anything());
  });

  it('re-emits session.transcript.discovered when transcript_path exists', async () => {
    await service.restoreSession('sess-1', 'proj-1');

    expect(eventsService.publish).toHaveBeenCalledWith(
      'session.transcript.discovered',
      expect.objectContaining({
        sessionId: 'sess-1',
        transcriptPath: '/home/user/.claude/session.jsonl',
      }),
    );
  });

  it('uses buildLaunchArgs with mode: restore', async () => {
    await service.restoreSession('sess-1', 'proj-1');

    const adapter = providerAdapterFactory.getAdapter('claude');
    expect(adapter.buildLaunchArgs).toHaveBeenCalledWith({
      mode: 'restore',
      providerSessionId: 'provider-uuid-123',
      profileOptionArgs: expect.any(Array),
    });
  });

  it('does NOT call pasteAndSubmit (no initial prompt on restore)', async () => {
    await service.restoreSession('sess-1', 'proj-1');

    expect(tmuxService.pasteAndSubmit).not.toHaveBeenCalled();
  });

  it('throws 404 when session not found', async () => {
    sqliteGetMock.mockReturnValue(undefined);

    await expect(service.restoreSession('nonexistent', 'proj-1')).rejects.toThrow(
      'Session not found',
    );
  });

  it('throws 403 PROJECT_MISMATCH when agent belongs to different project', async () => {
    storage.getAgent.mockResolvedValue({
      id: 'agent-1',
      projectId: 'other-project',
      profileId: 'prof-1',
      providerConfigId: 'cfg-1',
      name: 'Agent 1',
      modelOverride: null,
    });

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toThrow('PROJECT_MISMATCH');
  });

  it('throws 409 INVALID_SESSION_STATE with details.code when session is running', async () => {
    sqliteGetMock.mockReturnValue({ ...stoppedSessionRow, status: 'running' });

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'INVALID_SESSION_STATE' }),
    });
  });

  it('throws 409 NO_PROVIDER_SESSION_ID with details.code when provider_session_id is null', async () => {
    sqliteGetMock.mockReturnValue({ ...stoppedSessionRow, provider_session_id: null });

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'NO_PROVIDER_SESSION_ID' }),
    });
  });

  it('throws 409 PROVIDER_MISMATCH with details.code when provider differs', async () => {
    storage.getProvider.mockResolvedValue({
      id: 'prov-1',
      name: 'codex',
      binPath: '/usr/bin/codex',
      mcpConfigured: true,
      mcpEndpoint: null,
      mcpRegisteredAt: null,
      autoCompactThreshold: null,
      autoCompactThreshold1m: null,
      oneMillionContextEnabled: false,
      env: null,
      createdAt: '',
      updatedAt: '',
    });

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'PROVIDER_MISMATCH' }),
    });
  });

  it('rolls back on sendCommandArgs failure', async () => {
    tmuxService.sendCommandArgs.mockRejectedValue(new Error('CLI launch failed'));

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toThrow('RESTORE_FAILED');

    // Verify rollback UPDATE was called
    const updateCalls = sqlitePrepare.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === 'string' && sql.includes('UPDATE sessions') && sql.includes('status = ?'),
    );
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);

    // Verify tmux session was destroyed
    expect(tmuxService.destroySession).toHaveBeenCalledWith('tmux-restored');

    // Verify presence was NOT broadcast
    expect(terminalGateway.broadcastEvent).not.toHaveBeenCalledWith(
      expect.stringContaining('agent/'),
      'presence',
      expect.anything(),
    );
  });

  it('rolls back on tmux creation failure', async () => {
    tmuxService.createSession.mockRejectedValue(new Error('tmux error'));

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toThrow('RESTORE_FAILED');

    // Verify presence was NOT broadcast
    expect(terminalGateway.broadcastEvent).not.toHaveBeenCalledWith(
      expect.stringContaining('agent/'),
      'presence',
      expect.anything(),
    );
  });

  it('acquires per-agent lock via sessionCoordinator', async () => {
    await service.restoreSession('sess-1', 'proj-1');

    expect(sessionCoordinator.withAgentLock).toHaveBeenCalledWith('agent-1', expect.any(Function));
  });

  it('preserves original started_at and created_at', async () => {
    const result = await service.restoreSession('sess-1', 'proj-1');

    expect(result.startedAt).toBe('2026-04-30T10:00:00.000Z');
    expect(result.createdAt).toBe('2026-04-30T10:00:00.000Z');
  });

  it('injects DEVCHAIN_SESSION_ID with the source session id (not a new one)', async () => {
    await service.restoreSession('sess-1', 'proj-1');

    const sendCall = tmuxService.sendCommandArgs.mock.calls[0];
    const commandArgs = sendCall[1] as string[];
    const envArg = commandArgs.find((a: string) => a.startsWith('DEVCHAIN_SESSION_ID='));
    expect(envArg).toBe('DEVCHAIN_SESSION_ID=sess-1');
  });

  it('fails with no DB mutation when adapter lookup throws', async () => {
    providerAdapterFactory.getAdapter.mockImplementation(() => {
      throw new Error('Unknown provider');
    });

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toThrow('Unknown provider');

    expect(tmuxService.createSession).not.toHaveBeenCalled();
    expect(tmuxService.sendCommandArgs).not.toHaveBeenCalled();
    // No UPDATE for status flip (the SET status = 'running' UPDATE should not exist)
    const statusFlipCalls = sqlitePrepare.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === 'string' && sql.includes('UPDATE') && sql.includes("SET status = 'running'"),
    );
    expect(statusFlipCalls).toHaveLength(0);
  });

  it('fails with no DB mutation when buildLaunchArgs throws', async () => {
    const adapter = providerAdapterFactory.getAdapter('claude');
    adapter.buildLaunchArgs.mockImplementation(() => {
      throw new Error('buildLaunchArgs failed');
    });

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toThrow(
      'buildLaunchArgs failed',
    );

    expect(tmuxService.createSession).not.toHaveBeenCalled();
    const statusFlipCalls = sqlitePrepare.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === 'string' && sql.includes('UPDATE') && sql.includes("SET status = 'running'"),
    );
    expect(statusFlipCalls).toHaveLength(0);
  });

  it('fails when restore argv does not include providerSessionId', async () => {
    const adapter = providerAdapterFactory.getAdapter('claude');
    adapter.buildLaunchArgs.mockReturnValue({ argv: ['--some-flag'] });

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toThrow(
      'Restore argv does not include provider session ID',
    );

    expect(tmuxService.createSession).not.toHaveBeenCalled();
    const statusFlipCalls = sqlitePrepare.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === 'string' && sql.includes('UPDATE') && sql.includes("SET status = 'running'"),
    );
    expect(statusFlipCalls).toHaveLength(0);
  });

  it('throws PROVIDER_MISMATCH when in-lock resolveLaunchTarget returns different provider (TOCTOU)', async () => {
    // Pre-check passes: currentProvider (outside lock) matches provider_name_at_launch
    // But inside the lock, resolveLaunchTarget returns a different provider (simulating concurrent config change)
    let callCount = 0;
    storage.getProvider.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) {
        // First call (outside lock — Step 4 pre-check): matches 'claude'
        return Promise.resolve({
          id: 'prov-1',
          name: 'claude',
          binPath: '/usr/bin/claude',
          mcpConfigured: true,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          autoCompactThreshold: null,
          autoCompactThreshold1m: null,
          oneMillionContextEnabled: false,
          env: null,
          createdAt: '',
          updatedAt: '',
        });
      }
      // Second call (inside lock — resolveLaunchTarget): returns 'codex' (concurrent swap)
      return Promise.resolve({
        id: 'prov-2',
        name: 'codex',
        binPath: '/usr/bin/codex',
        mcpConfigured: true,
        mcpEndpoint: null,
        mcpRegisteredAt: null,
        autoCompactThreshold: null,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
        env: null,
        createdAt: '',
        updatedAt: '',
      });
    });

    await expect(service.restoreSession('sess-1', 'proj-1')).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'PROVIDER_MISMATCH' }),
    });

    expect(tmuxService.createSession).not.toHaveBeenCalled();
    expect(tmuxService.sendCommandArgs).not.toHaveBeenCalled();
    const statusFlipCalls = sqlitePrepare.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === 'string' && sql.includes('UPDATE') && sql.includes("SET status = 'running'"),
    );
    expect(statusFlipCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Launch helper unit tests
// ---------------------------------------------------------------------------

describe('SessionsService launch helpers', () => {
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
  let preflightService: { runChecks: jest.Mock };
  let mcpEnsureService: { ensureMcp: jest.Mock };
  let hooksConfigService: { ensureHooksConfig: jest.Mock };
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

    preflightService = {
      runChecks: jest.fn().mockResolvedValue({ overall: 'pass', checks: [], providers: [] }),
    };

    mcpEnsureService = {
      ensureMcp: jest.fn().mockResolvedValue({ success: true, action: 'already_configured' }),
    };

    hooksConfigService = {
      ensureHooksConfig: jest.fn().mockResolvedValue(undefined),
    };

    const dbMock = {
      session: {
        client: {
          prepare: jest.fn().mockReturnValue({
            run: jest.fn(),
            get: jest.fn(),
            all: jest.fn().mockReturnValue([]),
          }),
        },
      },
    } as unknown as BetterSQLite3Database;

    service = new SessionsService(
      dbMock,
      storage as unknown as StorageService,
      {} as unknown as TmuxService,
      {} as unknown as TerminalSendCoordinatorService,
      {} as unknown as PtyService,
      preflightService as unknown as PreflightService,
      mcpEnsureService as unknown as ProviderMcpEnsureService,
      { withAgentLock: jest.fn() } as unknown as SessionCoordinatorService,
      hooksConfigService as unknown as HooksConfigService,
      { getAdapter: jest.fn() } as unknown as ProviderAdapterFactory,
      { get: jest.fn() } as unknown as ModuleRef,
    );
  });

  describe('resolveLaunchTarget', () => {
    it('resolves agent, project, epic, profile, and provider via config', async () => {
      const agent = { id: 'a1', projectId: 'p1', profileId: 'prof1', providerConfigId: 'cfg1' };
      const project = { id: 'p1', name: 'proj', rootPath: '/root' };
      const epic = { id: 'e1', title: 'epic', projectId: 'p1' };
      const profile = { id: 'prof1', name: 'default' };
      const provider = { id: 'prov1', name: 'claude', binPath: '/usr/bin/claude' };
      const config = {
        id: 'cfg1',
        providerId: 'prov1',
        options: '--model opus',
        env: { KEY: 'val' },
      };

      storage.getAgent.mockResolvedValue(agent);
      storage.getProject.mockResolvedValue(project);
      storage.getEpic.mockResolvedValue(epic);
      storage.getAgentProfile.mockResolvedValue(profile);
      storage.getProfileProviderConfig.mockResolvedValue(config);
      storage.getProvider.mockResolvedValue(provider);

      const result = await service.resolveLaunchTarget({
        agentId: 'a1',
        projectId: 'p1',
        epicId: 'e1',
      });

      expect(result.agent).toEqual(agent);
      expect(result.project).toEqual(project);
      expect(result.epic).toEqual(epic);
      expect(result.provider).toEqual(provider);
      expect(result.options).toBe('--model opus');
      expect(result.configEnv).toEqual({ KEY: 'val' });
    });

    it('throws when agent does not belong to project', async () => {
      storage.getAgent.mockResolvedValue({
        id: 'a1',
        projectId: 'other-project',
        profileId: 'prof1',
      });
      storage.getProject.mockResolvedValue({ id: 'p1', name: 'proj', rootPath: '/root' });

      await expect(service.resolveLaunchTarget({ agentId: 'a1', projectId: 'p1' })).rejects.toThrow(
        ValidationError,
      );
    });

    it('falls back to first profile config when no providerConfigId', async () => {
      storage.getAgent.mockResolvedValue({
        id: 'a1',
        projectId: 'p1',
        profileId: 'prof1',
        providerConfigId: null,
      });
      storage.getProject.mockResolvedValue({ id: 'p1', name: 'proj', rootPath: '/root' });
      storage.getAgentProfile.mockResolvedValue({ id: 'prof1', name: 'default' });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        { id: 'cfg1', providerId: 'prov1', options: null, env: null },
      ]);
      storage.getProvider.mockResolvedValue({
        id: 'prov1',
        name: 'codex',
        binPath: '/usr/bin/codex',
      });

      const result = await service.resolveLaunchTarget({ agentId: 'a1', projectId: 'p1' });

      expect(result.provider.name).toBe('codex');
      expect(result.epic).toBeNull();
    });

    it('throws when profile has no configs', async () => {
      storage.getAgent.mockResolvedValue({
        id: 'a1',
        projectId: 'p1',
        profileId: 'prof1',
        providerConfigId: null,
      });
      storage.getProject.mockResolvedValue({ id: 'p1', name: 'proj', rootPath: '/root' });
      storage.getAgentProfile.mockResolvedValue({ id: 'prof1', name: 'default' });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);

      await expect(service.resolveLaunchTarget({ agentId: 'a1', projectId: 'p1' })).rejects.toThrow(
        'has no provider configs',
      );
    });
  });

  describe('verifyProviderBinary', () => {
    it('passes when binPath is set', () => {
      expect(() =>
        service.verifyProviderBinary({ id: 'p1', name: 'claude', binPath: '/usr/bin/claude' }),
      ).not.toThrow();
    });

    it('throws PROVIDER_BINARY_NOT_FOUND when binPath is null', () => {
      expect(() =>
        service.verifyProviderBinary({ id: 'p1', name: 'claude', binPath: null }),
      ).toThrow(ValidationError);

      try {
        service.verifyProviderBinary({ id: 'p1', name: 'claude', binPath: null });
      } catch (e) {
        expect((e as ValidationError).details).toMatchObject({ code: 'PROVIDER_BINARY_NOT_FOUND' });
      }
    });
  });

  describe('composeLaunchEnv', () => {
    it('returns DEVCHAIN_* env for Claude provider', () => {
      const result = service.composeLaunchEnv({
        sessionId: 'sess-1',
        tmuxSessionName: 'tmux-1',
        projectId: 'p1',
        agentId: 'a1',
        provider: {
          id: 'prov1',
          name: 'claude',
          binPath: '/usr/bin/claude',
          mcpConfigured: false,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          autoCompactThreshold: null,
          autoCompactThreshold1m: null,
          oneMillionContextEnabled: false,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        configEnv: null,
        optionArgs: ['--model', 'opus'],
      });

      expect(result.envVars).toMatchObject({
        DEVCHAIN_SESSION_ID: 'sess-1',
        DEVCHAIN_TMUX_SESSION_NAME: 'tmux-1',
        DEVCHAIN_PROJECT_ID: 'p1',
        DEVCHAIN_AGENT_ID: 'a1',
      });
    });

    it('returns null envVars for non-Claude provider with no env', () => {
      const result = service.composeLaunchEnv({
        sessionId: 'sess-1',
        tmuxSessionName: 'tmux-1',
        projectId: 'p1',
        agentId: 'a1',
        provider: {
          id: 'prov1',
          name: 'codex',
          binPath: '/usr/bin/codex',
          mcpConfigured: false,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          autoCompactThreshold: null,
          autoCompactThreshold1m: null,
          oneMillionContextEnabled: false,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        configEnv: null,
        optionArgs: [],
      });

      expect(result.envVars).toBeNull();
    });

    it('accepts sessionId parameter for restore use-case', () => {
      const result = service.composeLaunchEnv({
        sessionId: 'restored-session-id',
        tmuxSessionName: 'tmux-restored',
        projectId: 'p1',
        agentId: 'a1',
        provider: {
          id: 'prov1',
          name: 'claude',
          binPath: '/usr/bin/claude',
          mcpConfigured: false,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          autoCompactThreshold: null,
          autoCompactThreshold1m: null,
          oneMillionContextEnabled: false,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        configEnv: null,
        optionArgs: [],
      });

      expect(result.envVars!.DEVCHAIN_SESSION_ID).toBe('restored-session-id');
    });

    it('removes stale CLAUDE_CODE_DISABLE_1M_CONTEXT', () => {
      const result = service.composeLaunchEnv({
        sessionId: 'sess-1',
        tmuxSessionName: 'tmux-1',
        projectId: 'p1',
        agentId: 'a1',
        provider: {
          id: 'prov1',
          name: 'claude',
          binPath: '/usr/bin/claude',
          mcpConfigured: false,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          autoCompactThreshold: null,
          autoCompactThreshold1m: null,
          oneMillionContextEnabled: false,
          env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' },
          createdAt: '',
          updatedAt: '',
        },
        configEnv: null,
        optionArgs: [],
      });

      expect(result.envVars!.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
    });

    it('rewrites model to 1m when oneMillionContextEnabled', () => {
      const result = service.composeLaunchEnv({
        sessionId: 'sess-1',
        tmuxSessionName: 'tmux-1',
        projectId: 'p1',
        agentId: 'a1',
        provider: {
          id: 'prov1',
          name: 'claude',
          binPath: '/usr/bin/claude',
          mcpConfigured: false,
          mcpEndpoint: null,
          mcpRegisteredAt: null,
          autoCompactThreshold: 80,
          autoCompactThreshold1m: 50,
          oneMillionContextEnabled: true,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        configEnv: null,
        optionArgs: ['--model', 'opus'],
      });

      expect(result.processedOptionArgs).toContain('opus[1m]');
      expect(result.envVars!.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('50');
    });
  });

  describe('ensureMcpConfig', () => {
    it('returns preflight result when MCP is already configured', async () => {
      const preflightResult = {
        overall: 'pass' as const,
        checks: [],
        providers: [],
        supportedMcpProviders: [],
        timestamp: '',
      };
      preflightService.runChecks.mockResolvedValue(preflightResult);

      const result = await service.ensureMcpConfig({ id: 'p1', name: 'claude' }, '/project');

      expect(result).toEqual(preflightResult);
      expect(mcpEnsureService.ensureMcp).not.toHaveBeenCalled();
    });

    it('auto-ensures MCP and re-checks when not configured', async () => {
      preflightService.runChecks
        .mockResolvedValueOnce({
          overall: 'pass',
          checks: [],
          supportedMcpProviders: [],
          timestamp: '',
          providers: [{ id: 'p1', mcpStatus: 'fail' }],
        })
        .mockResolvedValueOnce({
          overall: 'pass',
          checks: [],
          supportedMcpProviders: [],
          timestamp: '',
          providers: [{ id: 'p1', mcpStatus: 'pass' }],
        });

      await service.ensureMcpConfig({ id: 'p1', name: 'claude' }, '/project');

      expect(mcpEnsureService.ensureMcp).toHaveBeenCalled();
      expect(preflightService.runChecks).toHaveBeenCalledTimes(2);
    });

    it('throws when MCP still not configured after auto-ensure', async () => {
      preflightService.runChecks.mockResolvedValue({
        overall: 'fail',
        checks: [],
        supportedMcpProviders: [],
        timestamp: '',
        providers: [{ id: 'p1', mcpStatus: 'fail', mcpMessage: 'not found' }],
      });
      mcpEnsureService.ensureMcp.mockResolvedValue({ success: false, message: 'failed' });

      await expect(
        service.ensureMcpConfig({ id: 'p1', name: 'claude' }, '/project'),
      ).rejects.toThrow('Provider MCP is not configured');
    });

    it('calls ensureMcp for Gemini with project path even when preflight passes', async () => {
      preflightService.runChecks.mockResolvedValue({
        overall: 'pass',
        checks: [],
        providers: [{ id: 'gemini-1', mcpStatus: 'pass' }],
        supportedMcpProviders: [],
        timestamp: '',
      });

      await service.ensureMcpConfig({ id: 'gemini-1', name: 'gemini' }, '/project');

      expect(mcpEnsureService.ensureMcp).toHaveBeenCalledWith(
        { id: 'gemini-1', name: 'gemini' },
        '/project',
      );
    });

    it('skips ensureMcp for Gemini without project path when preflight passes', async () => {
      preflightService.runChecks.mockResolvedValue({
        overall: 'pass',
        checks: [],
        providers: [{ id: 'gemini-1', mcpStatus: 'pass' }],
        supportedMcpProviders: [],
        timestamp: '',
      });

      await service.ensureMcpConfig({ id: 'gemini-1', name: 'gemini' }, '');

      expect(mcpEnsureService.ensureMcp).not.toHaveBeenCalled();
    });

    it('skips ensureMcp for non-Gemini provider when preflight passes', async () => {
      preflightService.runChecks.mockResolvedValue({
        overall: 'pass',
        checks: [],
        providers: [{ id: 'p1', mcpStatus: 'pass' }],
        supportedMcpProviders: [],
        timestamp: '',
      });

      await service.ensureMcpConfig({ id: 'p1', name: 'claude' }, '/project');

      expect(mcpEnsureService.ensureMcp).not.toHaveBeenCalled();
    });
  });

  describe('setupHooksConfig', () => {
    it('calls ensureHooksConfig for Claude provider', async () => {
      await service.setupHooksConfig({ name: 'claude' }, '/project');
      expect(hooksConfigService.ensureHooksConfig).toHaveBeenCalledWith('/project');
    });

    it('skips non-Claude providers', async () => {
      await service.setupHooksConfig({ name: 'codex' }, '/project');
      expect(hooksConfigService.ensureHooksConfig).not.toHaveBeenCalled();
    });

    it('does not throw when ensureHooksConfig fails', async () => {
      hooksConfigService.ensureHooksConfig.mockRejectedValue(new Error('hooks error'));

      await expect(
        service.setupHooksConfig({ name: 'claude' }, '/project'),
      ).resolves.toBeUndefined();
    });
  });
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
