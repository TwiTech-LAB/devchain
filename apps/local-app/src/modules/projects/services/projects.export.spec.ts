import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { ProjectProviderProvisioningService } from './project-provider-provisioning.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { WatchersService } from '../../watchers/services/watchers.service';
import { WatcherRunnerService } from '../../watchers/services/watcher-runner.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { TeamsService } from '../../teams/services/teams.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import * as devchainShared from '@devchain/shared';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

// Mock probe-1m utility
jest.mock('../../providers/utils/probe-1m', () => ({
  probe1mSupport: jest.fn(),
}));
import { createMockProject } from '../../../../test/factories';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let storage: {
    getProject: jest.Mock;
    listProviders: jest.Mock;
    listProvidersByIds: jest.Mock;
    listProviderModelsByProviderIds: jest.Mock;
    bulkCreateProviderModels: jest.Mock;
    listPrompts: jest.Mock;
    getPrompt: jest.Mock;
    listAgentProfiles: jest.Mock;
    listAgents: jest.Mock;
    listStatuses: jest.Mock;
    getInitialSessionPrompt: jest.Mock;
    getProvider: jest.Mock;
    createStatus: jest.Mock;
    createPrompt: jest.Mock;
    createAgentProfile: jest.Mock;
    createAgent: jest.Mock;
    updateAgent: jest.Mock;
    deleteAgent: jest.Mock;
    deleteAgentProfile: jest.Mock;
    deletePrompt: jest.Mock;
    deleteStatus: jest.Mock;
    createProjectWithTemplate: jest.Mock;
    countEpicsByStatus: jest.Mock;
    listEpics: jest.Mock;
    updateEpic: jest.Mock;
    updateStatus: jest.Mock;
    updateEpicsStatus: jest.Mock;
    listWatchers: jest.Mock;
    listSubscribers: jest.Mock;
    listScheduledEpics: jest.Mock;
    createWatcher: jest.Mock;
    createSubscriber: jest.Mock;
    deleteSubscriber: jest.Mock;
    listProfileProviderConfigsByProfile: jest.Mock;
    createProfileProviderConfig: jest.Mock;
    deleteProfileProviderConfig: jest.Mock;
    getAgent: jest.Mock;
    getAgentProfile: jest.Mock;
    getProfileProviderConfig: jest.Mock;
  };
  let sessions: {
    listActiveSessions: jest.Mock;
    getActiveSessionsForProject: jest.Mock;
  };
  let settings: {
    updateSettings: jest.Mock;
    getSettings: jest.Mock;
    getAutoCleanStatusIds: jest.Mock;
    getRegistryConfig: jest.Mock;
    setProjectTemplateMetadata: jest.Mock;
    getProjectTemplateMetadata: jest.Mock;
    getProjectPresets: jest.Mock;
    setProjectPresets: jest.Mock;
    clearProjectPresets: jest.Mock;
  };
  let watchersService: {
    deleteWatcher: jest.Mock;
    createWatcher: jest.Mock;
  };
  let watcherRunner: {
    startWatcher: jest.Mock;
  };
  let unifiedTemplateService: {
    getTemplate: jest.Mock;
    getBundledTemplate: jest.Mock;
    listTemplates: jest.Mock;
    hasTemplate: jest.Mock;
    getTemplateFromFilePath: jest.Mock;
  };

  beforeEach(async () => {
    storage = {
      getProject: jest.fn().mockResolvedValue(
        createMockProject({
          id: 'project-123',
          description: 'A test project',
          rootPath: '/test/path',
        }),
      ),
      listProviders: jest.fn(),
      listProvidersByIds: jest.fn().mockResolvedValue([]),
      listProviderModelsByProviderIds: jest.fn().mockResolvedValue([]),
      bulkCreateProviderModels: jest.fn().mockResolvedValue({ added: [], existing: [] }),
      listPrompts: jest.fn(),
      getPrompt: jest.fn(),
      listAgentProfiles: jest.fn(),
      listAgents: jest.fn(),
      listStatuses: jest.fn(),
      getInitialSessionPrompt: jest.fn(),
      getProvider: jest.fn(),
      updateProvider: jest.fn(),
      createStatus: jest.fn(),
      createPrompt: jest.fn(),
      createAgentProfile: jest.fn(),
      createAgent: jest.fn(),
      updateAgent: jest.fn(),
      deleteAgent: jest.fn(),
      deleteAgentProfile: jest.fn(),
      deletePrompt: jest.fn(),
      deleteStatus: jest.fn(),
      createProjectWithTemplate: jest.fn(),
      countEpicsByStatus: jest.fn().mockResolvedValue(0),
      listEpics: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 }),
      updateEpic: jest.fn(),
      updateStatus: jest.fn(),
      updateEpicsStatus: jest.fn().mockResolvedValue(0),
      listWatchers: jest.fn().mockResolvedValue([]),
      listSubscribers: jest.fn().mockResolvedValue([]),
      listScheduledEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      createWatcher: jest.fn(),
      createSubscriber: jest.fn(),
      deleteSubscriber: jest.fn(),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
      createProfileProviderConfig: jest.fn().mockImplementation(async (data) => ({
        id: `config-${Date.now()}`,
        ...data,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      deleteProfileProviderConfig: jest.fn().mockResolvedValue(undefined),
      getAgent: jest.fn(),
      getAgentProfile: jest.fn(),
      getProfileProviderConfig: jest.fn(),
    };

    sessions = {
      listActiveSessions: jest.fn(),
      getActiveSessionsForProject: jest.fn().mockReturnValue([]),
    };

    settings = {
      updateSettings: jest.fn(),
      getSettings: jest.fn().mockReturnValue({}),
      getAutoCleanStatusIds: jest.fn().mockReturnValue([]),
      getRegistryConfig: jest.fn().mockReturnValue({ url: 'https://registry.example.com' }),
      setProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
      getProjectTemplateMetadata: jest.fn().mockReturnValue(null),
      getProjectPresets: jest.fn().mockReturnValue([]),
      setProjectPresets: jest.fn().mockResolvedValue(undefined),
      clearProjectPresets: jest.fn().mockResolvedValue(undefined),
    };

    watchersService = {
      deleteWatcher: jest.fn(),
      createWatcher: jest.fn().mockResolvedValue({ id: 'mock-watcher-id', enabled: false }),
    };

    watcherRunner = {
      startWatcher: jest.fn(),
    };

    unifiedTemplateService = {
      getTemplate: jest.fn(),
      getBundledTemplate: jest.fn(),
      listTemplates: jest.fn(),
      hasTemplate: jest.fn(),
      getTemplateFromFilePath: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
        {
          provide: SessionsService,
          useValue: sessions,
        },
        {
          provide: SettingsService,
          useValue: settings,
        },
        {
          provide: WatchersService,
          useValue: watchersService,
        },
        {
          provide: WatcherRunnerService,
          useValue: watcherRunner,
        },
        {
          provide: UnifiedTemplateService,
          useValue: unifiedTemplateService,
        },
        {
          provide: TeamsService,
          useValue: {
            deleteTeamsByProject: jest.fn().mockResolvedValue(undefined),
            listTeams: jest.fn().mockResolvedValue({ items: [] }),
            getTeam: jest.fn().mockResolvedValue(null),
            createTeam: jest.fn().mockImplementation(async (data: Record<string, unknown>) => ({
              id: `team-${Date.now()}`,
              ...data,
            })),
          },
        },
        {
          provide: ProjectProviderProvisioningService,
          useValue: { provisionProject: jest.fn().mockResolvedValue({ warnings: [] }) },
        },
        { provide: ProcessExecutor, useValue: new FakeProcessExecutor() },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('exportProject', () => {
    it('should export all agent fields including description', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: 'prof-1',
            name: 'Test Profile',
            providerId: 'prov-1',
            options: '{"model":"opus"}',
            instructions: 'Profile instructions',
            temperature: 0.7,
            maxTokens: 1500,
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Test Agent',
            profileId: 'prof-1',
            description: 'Detailed agent description',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.getProvider.mockResolvedValue({ id: 'prov-1', name: 'claude' });
      storage.listProvidersByIds.mockResolvedValue([{ id: 'prov-1', name: 'claude' }]);

      const result = await service.exportProject(projectId);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toEqual({
        id: 'agent-1',
        name: 'Test Agent',
        profileId: 'prof-1',
        description: 'Detailed agent description',
        modelOverride: null,
      });
    });

    it('should export all profile fields', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: 'prof-1',
            name: 'Advanced Profile',
            // Note: providerId/options removed in Phase 4
            instructions: 'Do complex tasks',
            temperature: 0.9,
            maxTokens: 4096,
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      // Provider info now comes from configs
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          options: '{"model":"sonnet","temperature":0.5}',
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.getProvider.mockResolvedValue({ id: 'prov-1', name: 'claude' });
      storage.listProvidersByIds.mockResolvedValue([{ id: 'prov-1', name: 'claude' }]);

      const result = await service.exportProject(projectId);

      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0]).toMatchObject({
        id: 'prof-1',
        name: 'Advanced Profile',
        provider: { id: 'prov-1', name: 'claude' },
        // options is now on providerConfigs, not directly on profile
        instructions: 'Do complex tasks',
        temperature: 0.9,
        maxTokens: 4096,
      });
    });

    it('should export all prompt fields', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({
        items: [
          {
            id: 'prompt-1',
            title: 'Init Prompt',
            version: 3,
            tags: ['init', 'setup'],
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.getPrompt.mockResolvedValue({
        id: 'prompt-1',
        title: 'Init Prompt',
        content: 'Initialize the agent',
        version: 3,
        tags: ['init', 'setup'],
      });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);

      const result = await service.exportProject(projectId);

      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0]).toEqual({
        id: 'prompt-1',
        title: 'Init Prompt',
        content: 'Initialize the agent',
        version: 3,
        tags: ['init', 'setup'],
      });
    });

    it('should export all status fields', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({
        items: [
          { id: 'status-1', label: 'In Progress', color: '#007bff', position: 1 },
          { id: 'status-2', label: 'Done', color: '#28a745', position: 2 },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });
      storage.getInitialSessionPrompt.mockResolvedValue(null);

      const result = await service.exportProject(projectId);

      expect(result.statuses).toHaveLength(2);
      expect(result.statuses[0]).toEqual({
        id: 'status-1',
        label: 'In Progress',
        color: '#007bff',
        position: 1,
      });
    });

    it('should export projectSettings with autoCleanStatusLabels', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({
        items: [
          { id: 'status-archive', label: 'Archive', color: '#000', position: 5 },
          { id: 'status-done', label: 'Done', color: '#28a745', position: 3 },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });
      storage.getInitialSessionPrompt.mockResolvedValue(null);

      // Mock settings with autoClean configured
      settings.getSettings.mockReturnValue({
        autoClean: {
          statusIds: {
            [projectId]: ['status-archive'],
          },
        },
      });

      const result = await service.exportProject(projectId);

      expect(result.projectSettings).toBeDefined();
      expect(result.projectSettings?.autoCleanStatusLabels).toEqual(['Archive']);
    });

    it('should include _manifest in export with project data', async () => {
      const projectId = 'project-123';

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'My Test Project',
        description: 'A project for testing',
        rootPath: '/test/path',
        isTemplate: false,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);

      const result = await service.exportProject(projectId);

      expect(result._manifest).toBeDefined();
      expect(result._manifest.name).toBe('My Test Project');
      expect(result._manifest.description).toBe('A project for testing');
      expect(result._manifest.slug).toBe('my-test-project'); // slugified from name
      expect(result._manifest.version).toBe('1.0.0'); // default when no template metadata
      expect(result._manifest.publishedAt).toBeDefined();
    });

    it('should use template metadata when available in _manifest', async () => {
      const projectId = 'project-123';

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'My Project',
        description: 'Description',
        rootPath: '/test/path',
        isTemplate: false,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);

      // Mock template metadata from registry link
      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'original-template',
        installedVersion: '2.5.0',
        source: 'registry',
      });

      const result = await service.exportProject(projectId);

      expect(result._manifest.slug).toBe('original-template');
      expect(result._manifest.version).toBe('2.5.0');
    });

    it('should apply manifest overrides in export', async () => {
      const projectId = 'project-123';

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'My Project',
        description: 'Original description',
        rootPath: '/test/path',
        isTemplate: false,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);

      const result = await service.exportProject(projectId, {
        manifestOverrides: {
          name: 'Overridden Name',
          description: 'Overridden description',
          category: 'development',
          tags: ['custom', 'export'],
          authorName: 'Test Author',
        },
      });

      expect(result._manifest.name).toBe('Overridden Name');
      expect(result._manifest.description).toBe('Overridden description');
      expect(result._manifest.category).toBe('development');
      expect(result._manifest.tags).toEqual(['custom', 'export']);
      expect(result._manifest.authorName).toBe('Test Author');
    });

    it('should slugify project name correctly', async () => {
      const projectId = 'project-123';

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'My Special Project! (v2)',
        description: null,
        rootPath: '/test/path',
        isTemplate: false,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);

      const result = await service.exportProject(projectId);

      expect(result._manifest.slug).toBe('my-special-project-v2');
    });

    it('should export profile providerConfigs when present', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: 'prof-1',
            name: 'Test Profile',
            providerId: 'prov-1',
            familySlug: 'coder',
            options: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Test Agent',
            profileId: 'prof-1',
            providerConfigId: 'config-1',
            description: null,
            modelOverride: 'anthropic/claude-sonnet-4-5',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.getProvider.mockImplementation(async (id) => {
        if (id === 'prov-1') return { id: 'prov-1', name: 'claude' };
        if (id === 'prov-2') return { id: 'prov-2', name: 'gemini' };
        throw new Error(`Provider not found: ${id}`);
      });
      // Bulk fetch providers (used by optimized export)
      storage.listProvidersByIds.mockResolvedValue([
        { id: 'prov-1', name: 'claude' },
        { id: 'prov-2', name: 'gemini' },
      ]);

      // Mock provider configs for the profile (name column added in Phase 5)
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          name: 'claude',
          options: '--model claude-3',
          env: { ANTHROPIC_API_KEY: 'sk-xxx' },
        },
        {
          id: 'config-2',
          profileId: 'prof-1',
          providerId: 'prov-2',
          name: 'gemini',
          options: '--model gemini-pro',
          env: { GOOGLE_API_KEY: 'xxx' },
        },
      ]);

      const result = await service.exportProject(projectId);

      // Profile should have providerConfigs
      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0].providerConfigs).toBeDefined();
      expect(result.profiles[0].providerConfigs).toHaveLength(2);
      expect(result.profiles[0].providerConfigs[0]).toEqual(
        expect.objectContaining({
          name: 'claude',
          providerName: 'claude',
          options: '--model claude-3',
          env: { ANTHROPIC_API_KEY: '***' },
        }),
      );
      expect(result.profiles[0].providerConfigs[1]).toEqual(
        expect.objectContaining({
          name: 'gemini',
          providerName: 'gemini',
          options: '--model gemini-pro',
          env: { GOOGLE_API_KEY: '***' },
        }),
      );

      // Agent should have providerConfigName
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].providerConfigName).toBe('claude');
      expect(result.agents[0].modelOverride).toBe('anthropic/claude-sonnet-4-5');
    });

    it('should not include providerConfigs in export when profile has none', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: 'prof-1',
            name: 'Test Profile',
            providerId: 'prov-1',
            options: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({
        items: [
          {
            id: 'agent-1',
            name: 'Test Agent',
            profileId: 'prof-1',
            providerConfigId: null, // No config
            description: null,
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.getProvider.mockResolvedValue({ id: 'prov-1', name: 'claude' });

      // No provider configs
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      // Profile should NOT have providerConfigs field
      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0].providerConfigs).toBeUndefined();

      // Agent should NOT have providerConfigName
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].providerConfigName).toBeUndefined();
      expect(result.agents[0].modelOverride).toBeNull();
    });

    it('should export watcher idleAfterSeconds', async () => {
      const projectId = 'project-123';
      const watcherId = '11111111-1111-1111-1111-111111111111';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([
        {
          id: watcherId,
          projectId,
          name: 'Idle gated watcher',
          description: null,
          enabled: true,
          scope: 'all',
          scopeFilterId: null,
          pollIntervalMs: 60000,
          viewportLines: 20,
          idleAfterSeconds: 25,
          condition: { type: 'regex', pattern: 'Context low \\(0% remaining\\)' },
          cooldownMs: 180000,
          cooldownMode: 'until_clear',
          eventName: 'watcher.conversation.compact_request',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ]);

      const result = await service.exportProject(projectId);

      expect(result.watchers).toHaveLength(1);
      expect(result.watchers[0]).toEqual(
        expect.objectContaining({
          id: watcherId,
          idleAfterSeconds: 25,
        }),
      );
    });

    it('should preserve watcher idleAfterSeconds on export/import round trip', async () => {
      const projectId = 'project-123';
      const watcherId = '22222222-2222-2222-2222-222222222222';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listSubscribers.mockResolvedValue([]);
      storage.listWatchers.mockResolvedValue([
        {
          id: watcherId,
          projectId,
          name: 'Roundtrip watcher',
          description: null,
          enabled: true,
          scope: 'all',
          scopeFilterId: null,
          pollIntervalMs: 30000,
          viewportLines: 50,
          idleAfterSeconds: 20,
          condition: { type: 'contains', pattern: 'Context low' },
          cooldownMs: 60000,
          cooldownMode: 'time',
          eventName: 'watcher.roundtrip',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
      ]);

      const exported = await service.exportProject(projectId);
      expect(exported.watchers[0].idleAfterSeconds).toBe(20);

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);
      storage.listEpics.mockResolvedValue({ items: [], total: 0, limit: 100000, offset: 0 });

      const { _manifest: _omittedManifest, ...importPayload } = exported;
      void _omittedManifest;
      jest
        .spyOn(devchainShared.ExportSchema, 'parse')
        .mockReturnValue(importPayload as ReturnType<typeof devchainShared.ExportSchema.parse>);

      await service.importProject({
        projectId,
        payload: importPayload,
        dryRun: false,
      });

      expect(watchersService.createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Roundtrip watcher',
          idleAfterSeconds: 20,
        }),
      );
    });

    it('should include providerSettings for providers with autoCompactThreshold', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Test Profile' }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          name: 'default',
          options: null,
          env: null,
          position: 0,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listProvidersByIds.mockResolvedValue([
        { id: 'prov-1', name: 'claude', autoCompactThreshold: 10 },
      ]);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      expect(result.providerSettings).toEqual([{ name: 'claude', autoCompactThreshold: 10 }]);
    });

    it('should not include providerSettings when no provider has autoCompactThreshold', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Test Profile' }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          name: 'default',
          options: null,
          env: null,
          position: 0,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listProvidersByIds.mockResolvedValue([
        { id: 'prov-1', name: 'claude', autoCompactThreshold: null },
      ]);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      expect(result.providerSettings).toBeUndefined();
    });

    it('should include providerModels for providers that have models using a single batch call', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Test Profile' }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          name: 'default',
          options: null,
          env: null,
          position: 0,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listProvidersByIds.mockResolvedValue([
        { id: 'prov-1', name: 'claude', autoCompactThreshold: null },
      ]);
      storage.listProviderModelsByProviderIds.mockResolvedValue([
        {
          id: 'model-1',
          providerId: 'prov-1',
          name: 'anthropic/claude-sonnet-4-5',
          position: 1,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'model-2',
          providerId: 'prov-1',
          name: 'anthropic/claude-opus-4-1',
          position: 2,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      expect(storage.listProviderModelsByProviderIds).toHaveBeenCalledTimes(1);
      expect(storage.listProviderModelsByProviderIds).toHaveBeenCalledWith(['prov-1']);
      expect(result.providerModels).toEqual([
        {
          providerName: 'claude',
          models: ['anthropic/claude-sonnet-4-5', 'anthropic/claude-opus-4-1'],
        },
      ]);
    });

    it('should exclude providers with zero models from providerModels export', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Test Profile' }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          name: 'claude-default',
          options: null,
          env: null,
          position: 0,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'config-2',
          profileId: 'prof-1',
          providerId: 'prov-2',
          name: 'gemini-default',
          options: null,
          env: null,
          position: 1,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listProvidersByIds.mockResolvedValue([
        { id: 'prov-1', name: 'claude', autoCompactThreshold: null },
        { id: 'prov-2', name: 'gemini', autoCompactThreshold: null },
      ]);
      storage.listProviderModelsByProviderIds.mockResolvedValue([
        {
          id: 'model-1',
          providerId: 'prov-1',
          name: 'anthropic/claude-sonnet-4-5',
          position: 1,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      expect(storage.listProviderModelsByProviderIds).toHaveBeenCalledTimes(1);
      expect(storage.listProviderModelsByProviderIds).toHaveBeenCalledWith(['prov-1', 'prov-2']);
      expect(result.providerModels).toEqual([
        {
          providerName: 'claude',
          models: ['anthropic/claude-sonnet-4-5'],
        },
      ]);
    });
  });

  describe('exportProject with presets', () => {
    it('should include presets from settings when available', async () => {
      const projectId = 'project-123';
      const presets = [
        {
          name: 'default',
          description: 'Default configuration',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
      ];

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets = jest
        .fn()
        .mockReturnValue(presets);

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        rootPath: '/test/path',
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      expect(result.presets).toEqual(presets);
    });

    it('should not include presets field when none exist', async () => {
      const projectId = 'project-123';

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets = jest
        .fn()
        .mockReturnValue([]);

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        rootPath: '/test/path',
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      expect(result.presets).toBeUndefined();
    });

    it('should include empty presets array when override is empty (explicit no presets)', async () => {
      const projectId = 'project-123';
      const storedPresets = [
        {
          name: 'stored-preset',
          agentConfigs: [{ agentName: 'Agent', providerConfigName: 'config' }],
        },
      ];

      // Mock stored presets (should be ignored when override is provided)
      (settings as { getProjectPresets: jest.Mock }).getProjectPresets = jest
        .fn()
        .mockReturnValue(storedPresets);

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        rootPath: '/test/path',
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      // Pass empty array as override - should explicitly export without presets
      const result = await service.exportProject(projectId, { presets: [] });

      expect(result.presets).toEqual([]);
    });

    it('should use override presets when provided', async () => {
      const projectId = 'project-123';
      const storedPresets = [
        {
          name: 'stored-preset',
          agentConfigs: [{ agentName: 'Agent', providerConfigName: 'old-config' }],
        },
      ];
      const overridePresets = [
        {
          name: 'override-preset',
          description: 'Custom override',
          agentConfigs: [{ agentName: 'NewAgent', providerConfigName: 'new-config' }],
        },
      ];

      // Mock stored presets (should be ignored when override is provided)
      (settings as { getProjectPresets: jest.Mock }).getProjectPresets = jest
        .fn()
        .mockReturnValue(storedPresets);

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        rootPath: '/test/path',
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId, { presets: overridePresets });

      expect(result.presets).toEqual(overridePresets);
    });

    it('round-trips exported presets with modelOverride through import', async () => {
      const projectId = 'project-123';
      const presets = [
        {
          name: 'with-model',
          description: 'Has model override',
          agentConfigs: [
            {
              agentName: 'Coder',
              providerConfigName: 'claude-config',
              modelOverride: 'openai/gpt-5',
            },
            {
              agentName: 'Reviewer',
              providerConfigName: 'gemini-config',
              modelOverride: null,
            },
          ],
        },
        {
          name: 'legacy-no-model',
          agentConfigs: [{ agentName: 'Tester', providerConfigName: 'default-config' }],
        },
      ];

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets = jest
        .fn()
        .mockReturnValue(presets);

      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        rootPath: '/test/path',
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const exported = await service.exportProject(projectId);
      expect(exported.presets).toEqual(presets);

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [],
        total: 0,
        limit: 10000,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      sessions.getActiveSessionsForProject.mockReturnValue([]);
      settings.updateSettings.mockResolvedValue(undefined);

      const { _manifest: _omittedManifest, ...importPayload } = exported;
      void _omittedManifest;
      jest
        .spyOn(devchainShared.ExportSchema, 'parse')
        .mockReturnValue(importPayload as ReturnType<typeof devchainShared.ExportSchema.parse>);

      await service.importProject({ projectId, payload: importPayload, dryRun: false });

      expect(settings.setProjectPresets).toHaveBeenCalledWith(projectId, presets);
      const setPresetCalls = (settings.setProjectPresets as jest.Mock).mock.calls;
      const importedPresets = setPresetCalls[setPresetCalls.length - 1]?.[1] as
        | Array<{
            name: string;
            agentConfigs: Array<{
              agentName: string;
              providerConfigName: string;
              modelOverride?: string | null;
            }>;
          }>
        | undefined;

      expect(importedPresets?.[0].agentConfigs[0].modelOverride).toBe('openai/gpt-5');
      expect(importedPresets?.[0].agentConfigs[1].modelOverride).toBeNull();
      expect(importedPresets?.[1].agentConfigs[0].modelOverride).toBeUndefined();
    });
  });

  describe('scheduledEpics export', () => {
    const projectId = 'project-123';

    beforeEach(() => {
      storage.getProject.mockResolvedValue({
        id: projectId,
        name: 'Test Project',
        rootPath: '/test/path',
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);
    });

    it('should export empty scheduledEpics when none exist', async () => {
      storage.listScheduledEpics.mockResolvedValue({ items: [], total: 0 });

      const result = await service.exportProject(projectId);

      expect(result.scheduledEpics).toEqual([]);
    });

    it('should export scheduled epic definitions with name-based references', async () => {
      storage.listStatuses.mockResolvedValue({
        items: [{ id: 'status-1', label: 'In Progress', color: '#007bff', position: 1 }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({
        items: [{ id: 'agent-1', name: 'Coder', profileId: 'prof-1' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listScheduledEpics.mockResolvedValue({
        items: [
          {
            id: 'sched-1',
            projectId,
            name: 'Daily Standup',
            cronExpression: '0 9 * * 1-5',
            timezone: 'America/New_York',
            enabled: true,
            titleTemplate: 'Standup {{date}}',
            descriptionTemplate: 'Notes for {{date}}',
            templateStatusId: 'status-1',
            templateParentEpicId: null,
            templateAgentId: 'agent-1',
            templateTags: ['standup'],
            allowOverlap: false,
            missedRunPolicy: 'skip',
            configVersion: 1,
            nextRunAt: '2024-01-02T14:00:00Z',
            lastRunAt: '2024-01-01T14:00:00Z',
            lastRunStatus: 'completed',
            lastError: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 1,
      });

      const result = await service.exportProject(projectId);

      expect(result.scheduledEpics).toHaveLength(1);
      expect(result.scheduledEpics[0]).toEqual({
        name: 'Daily Standup',
        cronExpression: '0 9 * * 1-5',
        timezone: 'America/New_York',
        enabled: true,
        titleTemplate: 'Standup {{date}}',
        descriptionTemplate: 'Notes for {{date}}',
        templateStatusLabel: 'In Progress',
        templateParentEpicTitle: null,
        templateAgentName: 'Coder',
        templateTags: ['standup'],
        allowOverlap: false,
        missedRunPolicy: 'skip',
      });
    });

    it('should exclude runtime fields from export', async () => {
      storage.listScheduledEpics.mockResolvedValue({
        items: [
          {
            id: 'sched-1',
            projectId,
            name: 'Weekly',
            cronExpression: '0 0 * * 0',
            timezone: 'UTC',
            enabled: false,
            titleTemplate: 'Week {{week}}',
            descriptionTemplate: null,
            templateStatusId: null,
            templateParentEpicId: null,
            templateAgentId: null,
            templateTags: [],
            allowOverlap: true,
            missedRunPolicy: 'run_once',
            configVersion: 3,
            nextRunAt: '2024-01-07T00:00:00Z',
            lastRunAt: '2024-01-01T00:00:00Z',
            lastRunStatus: 'failed',
            lastError: 'timeout',
            createdAt: '2023-12-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 1,
      });

      const result = await service.exportProject(projectId);
      const exported = result.scheduledEpics[0];

      expect(exported).not.toHaveProperty('id');
      expect(exported).not.toHaveProperty('projectId');
      expect(exported).not.toHaveProperty('nextRunAt');
      expect(exported).not.toHaveProperty('lastRunAt');
      expect(exported).not.toHaveProperty('lastRunStatus');
      expect(exported).not.toHaveProperty('lastError');
      expect(exported).not.toHaveProperty('configVersion');
      expect(exported).not.toHaveProperty('createdAt');
      expect(exported).not.toHaveProperty('updatedAt');
    });

    it('should preserve enabled state in export', async () => {
      storage.listScheduledEpics.mockResolvedValue({
        items: [
          {
            id: 'sched-1',
            projectId,
            name: 'Disabled',
            cronExpression: '0 0 * * *',
            timezone: 'UTC',
            enabled: false,
            titleTemplate: 'Task',
            descriptionTemplate: null,
            templateStatusId: null,
            templateParentEpicId: null,
            templateAgentId: null,
            templateTags: [],
            allowOverlap: false,
            missedRunPolicy: 'skip',
            configVersion: 1,
            nextRunAt: null,
            lastRunAt: null,
            lastRunStatus: null,
            lastError: null,
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          },
        ],
        total: 1,
      });

      const result = await service.exportProject(projectId);

      expect(result.scheduledEpics[0].enabled).toBe(false);
    });
  });
});
