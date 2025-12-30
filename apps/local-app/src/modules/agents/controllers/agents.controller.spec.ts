import { Test, TestingModule } from '@nestjs/testing';
import { AgentsController } from './agents.controller';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { BadRequestException } from '@nestjs/common';
import { Agent, AgentProfile, Provider } from '../../storage/models/domain.models';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SessionCoordinatorService } from '../../sessions/services/session-coordinator.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('AgentsController', () => {
  let controller: AgentsController;
  let storage: {
    listAgents: jest.Mock;
    getAgent: jest.Mock;
    getAgentProfile: jest.Mock;
    getProvider: jest.Mock;
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
    name: 'Test Agent',
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  const mockProfile: AgentProfile = {
    id: 'profile-1',
    projectId: 'project-1',
    name: 'Test Profile',
    providerId: 'provider-1',
    options: null,
    systemPrompt: null,
    instructions: null,
    temperature: null,
    maxTokens: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

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

  beforeEach(async () => {
    storage = {
      listAgents: jest.fn(),
      getAgent: jest.fn(),
      getAgentProfile: jest.fn(),
      getProvider: jest.fn(),
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
  });

  describe('GET /api/agents/:id', () => {
    it('returns an agent enriched with provider info', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getAgentProfile.mockResolvedValue(mockProfile);
      storage.getProvider.mockResolvedValue(mockProvider);

      const result = await controller.getAgent('agent-1');

      expect(storage.getAgent).toHaveBeenCalledWith('agent-1');
      expect(storage.getAgentProfile).toHaveBeenCalledWith('profile-1');
      expect(storage.getProvider).toHaveBeenCalledWith('provider-1');
      expect(result.id).toBe('agent-1');
      expect(result.providerId).toBe('provider-1');
      expect(result.providerName).toBe('claude-code');
    });

    it('returns agent without provider info when profile lookup fails', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getAgentProfile.mockRejectedValue(new Error('Profile not found'));

      const result = await controller.getAgent('agent-1');

      expect(storage.getAgent).toHaveBeenCalledWith('agent-1');
      expect(result.id).toBe('agent-1');
      expect(result.providerId).toBeUndefined();
      expect(result.providerName).toBeUndefined();
    });

    it('returns agent without provider info when provider lookup fails', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      storage.getAgentProfile.mockResolvedValue(mockProfile);
      storage.getProvider.mockRejectedValue(new Error('Provider not found'));

      const result = await controller.getAgent('agent-1');

      expect(storage.getAgent).toHaveBeenCalledWith('agent-1');
      expect(result.id).toBe('agent-1');
      expect(result.providerId).toBeUndefined();
      expect(result.providerName).toBeUndefined();
    });
  });

  describe('POST /api/agents', () => {
    it('creates a new agent with valid data', async () => {
      const createData = {
        projectId: 'project-1',
        profileId: 'profile-1',
        name: 'New Agent',
      };
      storage.createAgent.mockResolvedValue({ ...mockAgent, ...createData });

      const result = await controller.createAgent(createData);

      expect(storage.createAgent).toHaveBeenCalledWith(createData);
      expect(result.name).toBe('New Agent');
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

      expect(sessionCoordinator.withAgentLock).toHaveBeenCalledWith(
        'agent-1',
        expect.any(Function),
      );
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

    it('uses withAgentLock for atomicity', async () => {
      storage.getAgent.mockResolvedValue(mockAgent);
      sessionsService.listActiveSessions.mockResolvedValue([]);
      sessionsService.launchSession.mockResolvedValue(mockNewSession);

      await controller.restartAgent('agent-1', { projectId: 'project-1' });

      expect(sessionCoordinator.withAgentLock).toHaveBeenCalledTimes(1);
      expect(sessionCoordinator.withAgentLock).toHaveBeenCalledWith(
        'agent-1',
        expect.any(Function),
      );
    });
  });
});
