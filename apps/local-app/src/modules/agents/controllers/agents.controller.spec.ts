import { Test, TestingModule } from '@nestjs/testing';
import { AgentsController } from './agents.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { Agent, Provider, ProfileProviderConfig } from '../../storage/models/domain.models';

import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';
import { EventsService } from '../../events/services/events.service';
import { SessionRuntime } from '../../sessions/services/session-runtime';
import { SettingsService } from '../../settings/services/settings.service';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('AgentsController', () => {
  let controller: AgentsController;
  let storage: {
    listAgents: jest.Mock;
    listGuests: jest.Mock;
    getAgent: jest.Mock;
    getAgentProfile: jest.Mock;
    getProvider: jest.Mock;
    getProfileProviderConfig: jest.Mock;
    listProfileProviderConfigsByIds: jest.Mock;
    listProvidersByIds: jest.Mock;
    createAgent: jest.Mock;
    updateAgent: jest.Mock;
    deleteAgent: jest.Mock;
  };
  let sessionsService: {
    listActiveSessions: jest.Mock;
    terminateSession: jest.Mock;
    launchSession: jest.Mock;
  };
  let sessionCoordinator: {
    withAgentLock: jest.Mock;
  };
  let mockSessionRuntime: {
    launch: jest.Mock;
    restore: jest.Mock;
  };
  let eventsService: {
    publish: jest.Mock;
  };
  let settingsService: {
    removeAgentFromProjectPresets: jest.Mock;
  };

  const mockAgent: Agent = {
    id: 'agent-1',
    projectId: 'project-1',
    isProjectOwner: false,
    profileId: 'profile-1',
    providerConfigId: 'config-1', // Required after Phase 4
    modelOverride: null,
    effortOverride: null,
    name: 'Test Agent',
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  // mockProfile commented out - currently unused but kept for potential future tests
  // const mockProfile: AgentProfile = {
  //   id: 'profile-1',
  //   projectId: 'project-1',
  //   name: 'Test Profile',
  //   // Note: providerId and options removed in Phase 4
  //   systemPrompt: null,
  //   instructions: null,
  //   temperature: null,
  //   maxTokens: null,
  //   createdAt: '2024-01-01T00:00:00.000Z',
  //   updatedAt: '2024-01-01T00:00:00.000Z',
  // };

  const mockProvider: Provider = {
    id: 'provider-1',
    name: 'claude-code',
    binPath: '/usr/bin/claude',
    mcpConfigured: false,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const mockConfig: ProfileProviderConfig = {
    id: 'config-1',
    profileId: 'profile-1',
    providerId: 'provider-1',
    name: 'default',
    description: null,
    options: '--model opus',
    env: { API_KEY: 'test-key' },
    model: 'claude-sonnet-4-5',
    effort: 'high',
    position: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  // Note: mockAgent removed - mockAgent now always has providerConfigId (Phase 4 NOT NULL)

  beforeEach(async () => {
    storage = {
      listAgents: jest.fn(),
      listGuests: jest.fn().mockResolvedValue([]),
      getAgent: jest.fn().mockResolvedValue(mockAgent),
      getAgentProfile: jest.fn(),
      getProvider: jest.fn(),
      getProfileProviderConfig: jest.fn(),
      listProfileProviderConfigsByIds: jest.fn().mockResolvedValue([]),
      listProvidersByIds: jest.fn().mockResolvedValue([]),
      createAgent: jest.fn(),
      updateAgent: jest.fn(),
      deleteAgent: jest.fn(),
    };

    sessionsService = {
      listActiveSessions: jest.fn(),
      terminateSession: jest.fn(),
      launchSession: jest.fn(),
    };
    mockSessionRuntime = {
      launch: jest.fn(),
      restore: jest.fn(),
    };

    sessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation((_agentId, fn) => fn()),
    };

    eventsService = {
      publish: jest.fn().mockResolvedValue('event-id-1'),
    };

    settingsService = {
      removeAgentFromProjectPresets: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        { provide: ProjectWriteGate, useValue: createProjectWriteGateStub() },
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
        {
          provide: SessionsService,
          useValue: sessionsService,
        },
        {
          provide: SessionCoordinatorService,
          useValue: sessionCoordinator,
        },
        {
          provide: EventsService,
          useValue: eventsService,
        },
        {
          provide: SessionRuntime,
          useValue: mockSessionRuntime,
        },
        {
          provide: SettingsService,
          useValue: settingsService,
        },
      ],
    }).compile();

    controller = module.get(AgentsController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/agents', () => {
    it('throws BadRequestException when projectId is missing', async () => {
      await expect(controller.listAgents(undefined as unknown as string)).rejects.toThrow(
        BadRequestException,
      );
      expect(storage.listAgents).not.toHaveBeenCalled();
    });

    it('includes guests when includeGuests=true', async () => {
      storage.listAgents.mockResolvedValue({
        items: [{ ...mockAgent, modelOverride: 'openai/gpt-4.1' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listGuests.mockResolvedValue([
        {
          id: 'guest-1',
          projectId: 'project-1',
          name: 'GuestBot',
          tmuxSessionId: 'tmux-guest-1',
          lastSeenAt: '2024-01-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ]);
      // Mock batch-loading of provider configs and providers
      storage.listProfileProviderConfigsByIds.mockResolvedValue([mockConfig]);
      storage.listProvidersByIds.mockResolvedValue([mockProvider]);

      const result = await controller.listAgents('project-1', 'true');

      expect(storage.listAgents).toHaveBeenCalledWith('project-1');
      expect(storage.listGuests).toHaveBeenCalledWith('project-1');
      expect(storage.listProfileProviderConfigsByIds).toHaveBeenCalledWith(['config-1']);
      expect(storage.listProvidersByIds).toHaveBeenCalledWith(['provider-1']);
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);

      // Verify agent item includes providerConfig
      const agentItem = result.items.find((item) => item.id === 'agent-1');
      expect(agentItem).toMatchObject({
        id: 'agent-1',
        name: 'Test Agent',
        isProjectOwner: false,
        profileId: 'profile-1',
        type: 'agent',
        modelOverride: 'openai/gpt-4.1',
        effortOverride: null,
        providerConfigId: 'config-1',
        providerConfig: {
          id: 'config-1',
          providerId: 'provider-1',
          providerName: 'claude-code',
          model: 'claude-sonnet-4-5',
          effort: 'high',
        },
      });

      // Verify guest item has null providerConfig
      const guestItem = result.items.find((item) => item.id === 'guest-1');
      expect(guestItem).toMatchObject({
        id: 'guest-1',
        name: 'GuestBot',
        isProjectOwner: false,
        profileId: null,
        type: 'guest',
        modelOverride: null,
        effortOverride: null,
        tmuxSessionId: 'tmux-guest-1',
        providerConfigId: null,
        providerConfig: null,
      });
    });
  });

  describe('GET /api/agents/:id', () => {
    it('returns agent with providerConfig (Phase 4: providerConfigId is always set)', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getProfileProviderConfig.mockResolvedValue(mockConfig);
      storage.getProvider.mockResolvedValue(mockProvider);

      const result = await controller.getAgent('agent-1');

      expect(storage.getAgent).toHaveBeenCalledWith('agent-1');
      expect(storage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      expect(result.providerConfigId).toBe('config-1');
      expect(result.providerConfig).toEqual({
        id: 'config-1',
        providerId: 'provider-1',
        providerName: 'claude-code',
        options: '--model opus',
        hasEnv: true,
      });
    });

    it('returns providerConfig.hasEnv=false when env is null', async () => {
      const configWithNoEnv = { ...mockConfig, env: null };
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getProfileProviderConfig.mockResolvedValue(configWithNoEnv);
      storage.getProvider.mockResolvedValue(mockProvider);

      const result = await controller.getAgent('agent-1');

      expect(result.providerConfig?.hasEnv).toBe(false);
    });

    it('returns agent without providerConfig when config lookup fails (Phase 4)', async () => {
      // No fallback to profile.providerId anymore - config is the only source
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getProfileProviderConfig.mockRejectedValue(new Error('Config not found'));

      const result = await controller.getAgent('agent-1');

      // No provider info since config lookup failed and no profile fallback
      expect(result.providerId).toBeUndefined();
      expect(result.providerName).toBeUndefined();
      expect(result.providerConfig).toBeUndefined();
    });
  });

  describe('POST /api/agents', () => {
    it('throws BadRequestException when providerConfigId belongs to wrong profile', async () => {
      const wrongConfig = { ...mockConfig, profileId: 'other-profile' };
      storage.getProfileProviderConfig.mockResolvedValue(wrongConfig);

      await expect(
        controller.createAgent({
          projectId: 'project-1',
          profileId: 'profile-1',
          name: 'New Agent',
          providerConfigId: 'config-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when providerConfigId not found', async () => {
      storage.getProfileProviderConfig.mockRejectedValue(new Error('Not found'));

      await expect(
        controller.createAgent({
          projectId: 'project-1',
          profileId: 'profile-1',
          name: 'New Agent',
          providerConfigId: 'nonexistent',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('publishes agent.created event after successful create', async () => {
      const createData = {
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'New Agent',
        providerConfigId: 'config-1',
      };
      storage.getProfileProviderConfig.mockResolvedValue(mockConfig);
      storage.createAgent.mockResolvedValue({ ...mockAgent, ...createData });

      await controller.createAgent(createData);

      expect(eventsService.publish).toHaveBeenCalledWith('agent.created', {
        agentId: mockAgent.id,
        agentName: 'New Agent',
        projectId: 'project-1',
        profileId: 'profile-1',
        providerConfigId: 'config-1',
        actor: null,
      });
    });

    it('swallows publish failure — agent still created', async () => {
      const createData = {
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'New Agent',
        providerConfigId: 'config-1',
      };
      storage.getProfileProviderConfig.mockResolvedValue(mockConfig);
      storage.createAgent.mockResolvedValue({ ...mockAgent, ...createData });
      eventsService.publish.mockRejectedValueOnce(new Error('publish failed'));

      const result = await controller.createAgent(createData);

      expect(result.name).toBe('New Agent');
      expect(eventsService.publish).toHaveBeenCalled();
    });

    it('does not expose project-owner assignment through public creation', async () => {
      const createData = {
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'New Agent',
        providerConfigId: 'config-1',
        isProjectOwner: true,
      };
      storage.getProfileProviderConfig.mockResolvedValue(mockConfig);
      storage.createAgent.mockResolvedValue({ ...mockAgent, name: createData.name });

      await controller.createAgent(createData);

      expect(storage.createAgent).toHaveBeenCalledWith({
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'New Agent',
        providerConfigId: 'config-1',
      });
    });
  });

  describe('PUT /api/agents/:id', () => {
    it.each([
      { name: 'current profile', profileId: 'profile-1', patch: { providerConfigId: 'config-1' } },
      {
        name: 'new profile',
        profileId: 'profile-2',
        patch: { profileId: 'profile-2', providerConfigId: 'config-1' },
      },
    ])('validates provider config ownership against the $name', async ({ profileId, patch }) => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getProfileProviderConfig.mockResolvedValue({ ...mockConfig, profileId });
      storage.updateAgent.mockResolvedValue({ ...mockAgent, ...patch });
      const result = await controller.updateAgent('agent-1', patch);
      expect(storage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', patch);
      expect(result.providerConfigId).toBe('config-1');
    });

    it('throws BadRequestException when providerConfigId belongs to wrong profile', async () => {
      const wrongConfig = { ...mockConfig, profileId: 'other-profile' };
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getProfileProviderConfig.mockResolvedValue(wrongConfig);

      await expect(
        controller.updateAgent('agent-1', { providerConfigId: 'config-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    // effortOverride mirrors modelOverride: set, clear via null, omit preserves,
    // reject empty. Identical restart-requirement semantics for online agents
    // (backend is pure persistence; restart is conveyed to the client elsewhere).
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes an agent, cleans up presets, and publishes agent.deleted event', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.deleteAgent.mockResolvedValue(undefined);

      await controller.deleteAgent('agent-1');

      expect(storage.getAgent).toHaveBeenCalledWith('agent-1');
      expect(storage.deleteAgent).toHaveBeenCalledWith('agent-1');
      expect(settingsService.removeAgentFromProjectPresets).toHaveBeenCalledWith(
        'project-1',
        'Test Agent',
      );
      expect(eventsService.publish).toHaveBeenCalledWith('agent.deleted', {
        agentId: 'agent-1',
        agentName: 'Test Agent',
        projectId: 'project-1',
        actor: null,
        teamId: null,
        teamName: null,
      });
    });

    it('preset cleanup is called after storage.deleteAgent, not before', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      const callOrder: string[] = [];
      storage.deleteAgent.mockImplementation(async () => {
        callOrder.push('deleteAgent');
      });
      settingsService.removeAgentFromProjectPresets.mockImplementation(async () => {
        callOrder.push('removeAgentFromProjectPresets');
      });

      await controller.deleteAgent('agent-1');

      expect(callOrder).toEqual(['deleteAgent', 'removeAgentFromProjectPresets']);
    });

    it('does not call preset cleanup when storage.deleteAgent rejects', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.deleteAgent.mockRejectedValue(new Error('active session conflict'));

      await expect(controller.deleteAgent('agent-1')).rejects.toThrow('active session conflict');
      expect(settingsService.removeAgentFromProjectPresets).not.toHaveBeenCalled();
      expect(eventsService.publish).not.toHaveBeenCalled();
    });

    it('rethrows cleanup failure and does not publish agent.deleted', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.deleteAgent.mockResolvedValue(undefined);
      settingsService.removeAgentFromProjectPresets.mockRejectedValue(new Error('cleanup failed'));

      await expect(controller.deleteAgent('agent-1')).rejects.toThrow('cleanup failed');
      expect(eventsService.publish).not.toHaveBeenCalled();
    });

    it('still completes when event publish fails (best-effort)', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.deleteAgent.mockResolvedValue(undefined);
      eventsService.publish.mockRejectedValueOnce(new Error('publish failed'));

      await controller.deleteAgent('agent-1');

      expect(storage.deleteAgent).toHaveBeenCalledWith('agent-1');
      expect(settingsService.removeAgentFromProjectPresets).toHaveBeenCalled();
      expect(eventsService.publish).toHaveBeenCalled();
    });
  });

  describe('POST /api/agents/:id/restart', () => {
    const mockNewSession = {
      id: 'session-new',
      epicId: null,
      agentId: 'agent-1',
      tmuxSessionId: 'tmux-new',
      status: 'running' as const,
      startedAt: '2024-01-01T00:00:00.000Z',
      endedAt: null,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      epic: null,
      agent: { id: 'agent-1', name: 'Test Agent', profileId: 'profile-1' },
      project: { id: 'project-1', name: 'Test Project', rootPath: '/test' },
    };

    it.each([
      { status: 'not_found', hasSession: false, error: false },
      { status: 'success', hasSession: true, error: false },
      { status: 'error', hasSession: true, error: true },
    ])(
      'restarts the agent after termination status $status',
      async ({ status, hasSession, error }) => {
        storage.getAgent.mockResolvedValue(mockAgent);
        sessionsService.listActiveSessions.mockResolvedValue(
          hasSession ? [{ id: 'session-old', agentId: 'agent-1', status: 'running' }] : [],
        );
        if (error)
          sessionsService.terminateSession.mockRejectedValue(new Error('Terminate failed'));
        else sessionsService.terminateSession.mockResolvedValue(undefined);
        mockSessionRuntime.launch.mockResolvedValue(mockNewSession);
        const result = await controller.restartAgent('agent-1', { projectId: 'project-1' });
        if (hasSession)
          expect(sessionsService.terminateSession).toHaveBeenCalledWith('session-old', {
            source: 'web-api',
            reason: 'restart',
          });
        else expect(sessionsService.terminateSession).not.toHaveBeenCalled();
        expect(mockSessionRuntime.launch).toHaveBeenCalledWith({
          agentId: 'agent-1',
          projectId: 'project-1',
        });
        expect(result.terminateStatus).toBe(status);
        if (error) {
          expect(result.terminateWarning).toContain('Previous session may still be running');
          expect(result.terminateWarning).toContain('Terminate failed');
        } else expect(result.terminateWarning).toBeUndefined();
        expect(result.session.id).toBe('session-new');
      },
    );

    it('throws BadRequestException when agent belongs to different project', async () => {
      storage.getAgent.mockResolvedValue({ ...mockAgent, projectId: 'other-project' });

      await expect(controller.restartAgent('agent-1', { projectId: 'project-1' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('does not use outer withAgentLock (launchSession handles locking internally)', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      sessionsService.listActiveSessions.mockResolvedValue([]);
      mockSessionRuntime.launch.mockResolvedValue(mockNewSession);

      await controller.restartAgent('agent-1', { projectId: 'project-1' });

      // Controller no longer wraps with withAgentLock - launchSession() has internal locking
      // This prevents deadlock from nested non-reentrant locks
      expect(sessionCoordinator.withAgentLock).not.toHaveBeenCalled();
    });
  });
});
