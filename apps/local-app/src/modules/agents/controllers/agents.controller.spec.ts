import { Test, TestingModule } from '@nestjs/testing';
import { AgentsController } from './agents.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { Agent, Provider, ProfileProviderConfig } from '../../storage/models/domain.models';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';

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

  const mockAgent: Agent = {
    id: 'agent-1',
    projectId: 'project-1',
    profileId: 'profile-1',
    providerConfigId: 'config-1', // Required after Phase 4
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
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const mockConfig: ProfileProviderConfig = {
    id: 'config-1',
    profileId: 'profile-1',
    providerId: 'provider-1',
    options: '--model opus',
    env: { API_KEY: 'test-key' },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  // Note: mockAgent removed - mockAgent now always has providerConfigId (Phase 4 NOT NULL)

  beforeEach(async () => {
    storage = {
      listAgents: jest.fn(),
      listGuests: jest.fn().mockResolvedValue([]),
      getAgent: jest.fn(),
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

    sessionCoordinator = {
      withAgentLock: jest.fn().mockImplementation((_agentId, fn) => fn()),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
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

    it('throws BadRequestException when projectId is empty string', async () => {
      await expect(controller.listAgents('')).rejects.toThrow(BadRequestException);
      expect(storage.listAgents).not.toHaveBeenCalled();
    });

    it('lists agents when projectId is provided', async () => {
      storage.listAgents.mockResolvedValue({
        items: [mockAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listAgents('project-1');

      expect(storage.listAgents).toHaveBeenCalledWith('project-1');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('agent-1');
    });

    it('returns only agents when includeGuests is not true', async () => {
      storage.listAgents.mockResolvedValue({
        items: [mockAgent],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await controller.listAgents('project-1', 'false');

      expect(storage.listAgents).toHaveBeenCalledWith('project-1');
      expect(storage.listGuests).not.toHaveBeenCalled();
      expect(result.items).toHaveLength(1);
    });

    it('includes guests when includeGuests=true', async () => {
      storage.listAgents.mockResolvedValue({
        items: [mockAgent],
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
      const agentItem = result.items.find(
        (item: { id: string; type: string }) => item.id === 'agent-1',
      );
      expect(agentItem).toMatchObject({
        id: 'agent-1',
        name: 'Test Agent',
        profileId: 'profile-1',
        type: 'agent',
        providerConfigId: 'config-1',
        providerConfig: {
          id: 'config-1',
          providerId: 'provider-1',
          providerName: 'claude-code',
        },
      });

      // Verify guest item has null providerConfig
      const guestItem = result.items.find(
        (item: { id: string; type: string }) => item.id === 'guest-1',
      );
      expect(guestItem).toMatchObject({
        id: 'guest-1',
        name: 'GuestBot',
        profileId: null,
        type: 'guest',
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
    it('creates a new agent with providerConfigId (required)', async () => {
      const createData = {
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'New Agent',
        providerConfigId: 'config-1',
      };
      storage.getProfileProviderConfig.mockResolvedValue(mockConfig);
      storage.createAgent.mockResolvedValue({ ...mockAgent, ...createData });

      const result = await controller.createAgent(createData);

      expect(storage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      expect(storage.createAgent).toHaveBeenCalledWith(createData);
      expect(result.name).toBe('New Agent');
    });

    it('throws when providerConfigId is missing (Phase 4: required)', async () => {
      const createData = {
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'New Agent',
        // providerConfigId missing
      };

      await expect(controller.createAgent(createData)).rejects.toThrow();
    });

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
  });

  describe('PUT /api/agents/:id', () => {
    it('updates an agent with valid data', async () => {
      const updateData = { name: 'Updated Agent' };
      storage.updateAgent.mockResolvedValue({ ...mockAgent, name: 'Updated Agent' });

      const result = await controller.updateAgent('agent-1', updateData);

      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', updateData);
      expect(result.name).toBe('Updated Agent');
    });

    it('updates agent with providerConfigId', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getProfileProviderConfig.mockResolvedValue(mockConfig);
      storage.updateAgent.mockResolvedValue({ ...mockAgent, providerConfigId: 'config-1' });

      const result = await controller.updateAgent('agent-1', { providerConfigId: 'config-1' });

      expect(storage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', { providerConfigId: 'config-1' });
      expect(result.providerConfigId).toBe('config-1');
    });

    it('validates providerConfigId against new profileId when both are changed', async () => {
      const newConfig = { ...mockConfig, profileId: 'profile-2' };
      storage.getProfileProviderConfig.mockResolvedValue(newConfig);
      storage.updateAgent.mockResolvedValue({
        ...mockAgent,
        profileId: 'profile-2',
        providerConfigId: 'config-1',
      });

      await controller.updateAgent('agent-1', {
        profileId: 'profile-2',
        providerConfigId: 'config-1',
      });

      expect(storage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      // Should validate against new profileId, not agent's current profileId
    });

    it('throws BadRequestException when providerConfigId belongs to wrong profile', async () => {
      const wrongConfig = { ...mockConfig, profileId: 'other-profile' };
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getProfileProviderConfig.mockResolvedValue(wrongConfig);

      await expect(
        controller.updateAgent('agent-1', { providerConfigId: 'config-1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when trying to set providerConfigId to null (Phase 4: NOT NULL)', async () => {
      // Sending null should fail validation since providerConfigId is NOT NULL in DB
      await expect(
        controller.updateAgent('agent-1', { providerConfigId: null } as unknown as {
          providerConfigId: string;
        }),
      ).rejects.toThrow();
    });
  });

  describe('PATCH /api/agents/:id', () => {
    it('patches an agent with valid data', async () => {
      const patchData = { name: 'Patched Agent' };
      storage.updateAgent.mockResolvedValue({ ...mockAgent, name: 'Patched Agent' });

      const result = await controller.patchAgent('agent-1', patchData);

      expect(storage.updateAgent).toHaveBeenCalledWith('agent-1', patchData);
      expect(result.name).toBe('Patched Agent');
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('deletes an agent', async () => {
      storage.deleteAgent.mockResolvedValue(undefined);

      await controller.deleteAgent('agent-1');

      expect(storage.deleteAgent).toHaveBeenCalledWith('agent-1');
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

    it('restarts agent with no existing session (terminateStatus: not_found)', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      sessionsService.listActiveSessions.mockResolvedValue([]);
      sessionsService.launchSession.mockResolvedValue(mockNewSession);

      const result = await controller.restartAgent('agent-1', { projectId: 'project-1' });

      // Note: No outer withAgentLock - launchSession handles locking internally
      expect(sessionsService.terminateSession).not.toHaveBeenCalled();
      expect(sessionsService.launchSession).toHaveBeenCalledWith({
        agentId: 'agent-1',
        projectId: 'project-1',
      });
      expect(result.terminateStatus).toBe('not_found');
      expect(result.terminateWarning).toBeUndefined();
      expect(result.session.id).toBe('session-new');
    });

    it('restarts agent with existing session (terminateStatus: success)', async () => {
      const existingSession = {
        id: 'session-old',
        agentId: 'agent-1',
        status: 'running',
      };
      storage.getAgent.mockResolvedValue(mockAgent);
      sessionsService.listActiveSessions.mockResolvedValue([existingSession]);
      sessionsService.terminateSession.mockResolvedValue(undefined);
      sessionsService.launchSession.mockResolvedValue(mockNewSession);

      const result = await controller.restartAgent('agent-1', { projectId: 'project-1' });

      expect(sessionsService.terminateSession).toHaveBeenCalledWith('session-old');
      expect(result.terminateStatus).toBe('success');
      expect(result.terminateWarning).toBeUndefined();
      expect(result.session.id).toBe('session-new');
    });

    it('restarts agent when terminate fails (terminateStatus: error with warning)', async () => {
      const existingSession = {
        id: 'session-old',
        agentId: 'agent-1',
        status: 'running',
      };
      storage.getAgent.mockResolvedValue(mockAgent);
      sessionsService.listActiveSessions.mockResolvedValue([existingSession]);
      sessionsService.terminateSession.mockRejectedValue(new Error('Terminate failed'));
      sessionsService.launchSession.mockResolvedValue(mockNewSession);

      const result = await controller.restartAgent('agent-1', { projectId: 'project-1' });

      expect(result.terminateStatus).toBe('error');
      expect(result.terminateWarning).toContain('Previous session may still be running');
      expect(result.terminateWarning).toContain('Terminate failed');
      expect(result.session.id).toBe('session-new');
    });

    it('throws BadRequestException when projectId is missing', async () => {
      await expect(controller.restartAgent('agent-1', {})).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when agent belongs to different project', async () => {
      storage.getAgent.mockResolvedValue({ ...mockAgent, projectId: 'other-project' });

      await expect(controller.restartAgent('agent-1', { projectId: 'project-1' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('does not use outer withAgentLock (launchSession handles locking internally)', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      sessionsService.listActiveSessions.mockResolvedValue([]);
      sessionsService.launchSession.mockResolvedValue(mockNewSession);

      await controller.restartAgent('agent-1', { projectId: 'project-1' });

      // Controller no longer wraps with withAgentLock - launchSession() has internal locking
      // This prevents deadlock from nested non-reentrant locks
      expect(sessionCoordinator.withAgentLock).not.toHaveBeenCalled();
    });
  });
});
