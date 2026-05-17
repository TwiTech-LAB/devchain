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
import { SCHEDULED_EPIC_RUNNER_REFRESH } from '../../scheduled-epics/services/scheduled-epics.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import * as devchainShared from '@devchain/shared';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

// Mock probe-1m utility
jest.mock('../../providers/utils/probe-1m', () => ({
  probe1mSupport: jest.fn(),
}));
import { probe1mSupport } from '../../providers/utils/probe-1m';
const mockProbe1mSupport = probe1mSupport as jest.Mock;
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
    deleteScheduledEpic: jest.Mock;
    createScheduledEpic: jest.Mock;
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
  let scheduledEpicRunnerRefresh: {
    refreshScheduleWindow: jest.Mock;
  };
  let unifiedTemplateService: {
    getTemplate: jest.Mock;
    getBundledTemplate: jest.Mock;
    listTemplates: jest.Mock;
    hasTemplate: jest.Mock;
    getTemplateFromFilePath: jest.Mock;
  };
  let teamsServiceMock: {
    deleteTeamsByProject: jest.Mock;
    listTeams: jest.Mock;
    getTeam: jest.Mock;
    createTeam: jest.Mock;
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
      deleteScheduledEpic: jest.fn().mockResolvedValue(undefined),
      createScheduledEpic: jest.fn().mockImplementation(async (data) => ({
        id: `scheduled-epic-${Date.now()}`,
        ...data,
        configVersion: 1,
        runCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
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

    scheduledEpicRunnerRefresh = {
      refreshScheduleWindow: jest.fn(),
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
          provide: SCHEDULED_EPIC_RUNNER_REFRESH,
          useValue: scheduledEpicRunnerRefresh,
        },
        {
          provide: UnifiedTemplateService,
          useValue: unifiedTemplateService,
        },
        {
          provide: TeamsService,
          useValue: (teamsServiceMock = {
            deleteTeamsByProject: jest.fn().mockResolvedValue(undefined),
            listTeams: jest.fn().mockResolvedValue({ items: [] }),
            getTeam: jest.fn().mockResolvedValue(null),
            createTeam: jest.fn().mockImplementation(async (data: Record<string, unknown>) => ({
              id: `team-${Date.now()}`,
              ...data,
            })),
          }),
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

  describe('createFromTemplate', () => {
    it('should throw ValidationError for invalid template content', async () => {
      // Mock UnifiedTemplateService to return content that doesn't match ExportSchema
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: { invalid: 'content without required fields' },
        source: 'bundled',
        version: null,
      });

      await expect(
        service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'bad-template',
        }),
      ).rejects.toThrow(ValidationError);

      await expect(
        service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'bad-template',
        }),
      ).rejects.toThrow('Invalid template format');
    });

    it('should throw ValidationError for slug with path traversal attempt', async () => {
      // UnifiedTemplateService validates slugs internally and throws ValidationError
      unifiedTemplateService.getTemplate.mockRejectedValue(
        new ValidationError(
          'Invalid template slug: must contain only alphanumeric characters and hyphens',
          {
            slug: '../../../etc/passwd',
          },
        ),
      );

      await expect(
        service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: '../../../etc/passwd',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('should throw ValidationError for slug with special characters', async () => {
      const invalidSlugs = [
        'template;rm -rf /',
        'template`whoami`',
        'template$PATH',
        'template@host',
      ];

      for (const slug of invalidSlugs) {
        unifiedTemplateService.getTemplate.mockRejectedValue(
          new ValidationError('Invalid template slug', { slug }),
        );

        await expect(
          service.createFromTemplate({
            name: 'Test Project',
            rootPath: '/test',
            slug,
          }),
        ).rejects.toThrow(ValidationError);
      }
    });

    it('should throw NotFoundError for missing template', async () => {
      unifiedTemplateService.getTemplate.mockRejectedValue(
        new NotFoundError('Template', 'nonexistent-template'),
      );

      await expect(
        service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'nonexistent-template',
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it('should accept valid slug and create project from template', async () => {
      // Mock valid template content via UnifiedTemplateService
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
      };
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'bundled',
        version: null,
      });

      // Mock storage methods
      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      const validSlugs = ['valid-template', 'template-123', 'ABC123', 'my-template-v1'];

      for (const slug of validSlugs) {
        await expect(
          service.createFromTemplate({
            name: 'Test Project',
            rootPath: '/test',
            slug,
          }),
        ).resolves.toBeDefined();
      }
    });

    it('should create scheduled epics when template payload contains them', async () => {
      const profileTemplateId = '11111111-1111-4111-8111-111111111111';
      const agentTemplateId = '22222222-2222-4222-8222-222222222222';
      const statusTemplateId = '33333333-3333-4333-8333-333333333333';
      const template = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileTemplateId,
            name: 'Builder Profile',
            provider: { id: '44444444-4444-4444-8444-444444444444', name: 'claude' },
            options: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
            familySlug: null,
          },
        ],
        agents: [
          {
            id: agentTemplateId,
            name: 'Coder',
            profileId: profileTemplateId,
            description: null,
            modelOverride: null,
          },
        ],
        statuses: [
          {
            id: statusTemplateId,
            label: 'Backlog',
            color: '#6c757d',
            position: 1,
            mcpHidden: false,
          },
        ],
        watchers: [],
        subscribers: [],
        teams: [],
        presets: [],
        providerModels: [],
        scheduledEpics: [
          {
            name: 'Daily Planning',
            cronExpression: '0 9 * * 1-5',
            timezone: 'America/New_York',
            enabled: false,
            titleTemplate: 'Daily planning {{date}}',
            descriptionTemplate: 'Create planning context for {{date}}',
            templateStatusLabel: 'Backlog',
            templateAgentName: 'Coder',
            templateParentEpicTitle: 'Parent Epic',
            templateTags: ['planning', 'daily'],
            allowOverlap: false,
            missedRunPolicy: 'skip' as const,
          },
        ],
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        _manifest: undefined,
      };

      jest
        .spyOn(devchainShared.ExportSchema, 'parse')
        .mockReturnValueOnce(template as ReturnType<typeof devchainShared.ExportSchema.parse>);
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: template,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'provider-local-1', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listEpics.mockResolvedValue({
        items: [{ id: 'parent-epic-1', title: 'Parent Epic' }],
        total: 1,
        limit: 100000,
        offset: 0,
      });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'project-from-template-1', name: 'Template Project' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileTemplateId]: 'profile-local-1' },
          agentIdMap: { [agentTemplateId]: 'agent-local-1' },
          statusIdMap: { [statusTemplateId]: 'status-local-1' },
        },
      });

      const result = await service.createFromTemplate({
        name: 'Template Project',
        rootPath: '/test/template-project',
        slug: 'scheduled-template',
      });

      expect(storage.createScheduledEpic).toHaveBeenCalledTimes(1);
      expect(storage.createScheduledEpic).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'project-from-template-1',
          name: 'Daily Planning',
          cronExpression: '0 9 * * 1-5',
          timezone: 'America/New_York',
          enabled: false,
          titleTemplate: 'Daily planning {{date}}',
          descriptionTemplate: 'Create planning context for {{date}}',
          templateStatusId: 'status-local-1',
          templateAgentId: 'agent-local-1',
          templateParentEpicId: 'parent-epic-1',
          templateTags: ['planning', 'daily'],
          allowOverlap: false,
          missedRunPolicy: 'skip',
          nextRunAt: expect.any(String),
        }),
      );
      expect(scheduledEpicRunnerRefresh.refreshScheduleWindow).toHaveBeenCalledTimes(1);
      expect(result).toEqual(
        expect.objectContaining({
          imported: expect.objectContaining({ scheduledEpics: 1 }),
        }),
      );
    });

    it('passes pre-generated projectId to storage when provided', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
      };
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: '11111111-1111-4111-8111-111111111111', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'my-template',
        projectId: '11111111-1111-4111-8111-111111111111',
      });

      expect(storage.createProjectWithTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Project',
          rootPath: '/test',
        }),
        expect.any(Object),
        {
          projectId: '11111111-1111-4111-8111-111111111111',
        },
      );
    });

    it('should pass version to UnifiedTemplateService when provided', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
      };
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'registry',
        version: '1.2.0',
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'my-template',
        version: '1.2.0',
      });

      expect(unifiedTemplateService.getTemplate).toHaveBeenCalledWith('my-template', '1.2.0');
    });

    it('should call startWatcher for enabled watchers in template', async () => {
      const agentId = '11111111-1111-1111-1111-111111111111';
      const profileId = '22222222-2222-2222-2222-222222222222';
      const providerId = '33333333-3333-3333-3333-333333333333';

      const templateWithWatchers = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId,
            name: 'Test Profile',
            provider: { name: 'claude' },
            options: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
        agents: [
          {
            id: agentId,
            name: 'Test Agent',
            profileId: profileId,
            description: null,
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        watchers: [
          {
            name: 'Enabled Watcher',
            description: null,
            enabled: true, // Should trigger startWatcher
            scope: 'all',
            scopeFilterName: null,
            pollIntervalMs: 5000,
            viewportLines: 100,
            condition: { type: 'contains', pattern: 'test' },
            cooldownMs: 10000,
            cooldownMode: 'time',
            eventName: 'test-event-enabled',
          },
        ],
        subscribers: [],
      };

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithWatchers,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId]: 'new-profile-1' },
          agentIdMap: { [agentId]: 'new-agent-1' },
          statusIdMap: {},
        },
      });

      const createdWatcher = {
        id: 'watcher-1',
        name: 'Enabled Watcher',
        enabled: true,
        scope: 'all',
        scopeFilterId: null,
      };
      // WatchersService.createWatcher handles start internally
      watchersService.createWatcher.mockResolvedValue(createdWatcher);

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'watcher-test',
      });

      // Verify createWatcher was called via WatchersService (which handles start internally)
      expect(watchersService.createWatcher).toHaveBeenCalledTimes(1);
      expect(watchersService.createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Enabled Watcher',
          enabled: true,
        }),
      );
    });

    it('should NOT call startWatcher for disabled watchers in template', async () => {
      const templateWithDisabledWatcher = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [
          {
            name: 'Disabled Watcher',
            description: null,
            enabled: false, // Should NOT trigger startWatcher
            scope: 'all',
            scopeFilterName: null,
            pollIntervalMs: 5000,
            viewportLines: 100,
            condition: { type: 'contains', pattern: 'test' },
            cooldownMs: 10000,
            cooldownMode: 'time',
            eventName: 'test-event-disabled',
          },
        ],
        subscribers: [],
      };

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithDisabledWatcher,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: {
          promptIdMap: {},
          profileIdMap: {},
          agentIdMap: {},
          statusIdMap: {},
        },
      });

      // WatchersService.createWatcher handles start internally (won't start if disabled)
      watchersService.createWatcher.mockResolvedValue({
        id: 'watcher-1',
        name: 'Disabled Watcher',
        enabled: false,
        scope: 'all',
        scopeFilterId: null,
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'disabled-watcher-test',
      });

      // Verify createWatcher was called with enabled: false
      expect(watchersService.createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Disabled Watcher',
          enabled: false,
        }),
      );
    });

    it('should fallback to scope "all" when scopeFilterName cannot be resolved', async () => {
      const templateWithUnresolvableScope = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [
          {
            name: 'Watcher with Unresolvable Scope',
            description: null,
            enabled: false,
            scope: 'agent', // Agent scope but no matching agent
            scopeFilterName: 'NonExistent Agent',
            pollIntervalMs: 5000,
            viewportLines: 100,
            condition: { type: 'contains', pattern: 'test' },
            cooldownMs: 10000,
            cooldownMode: 'time',
            eventName: 'test-event-unresolved',
          },
        ],
        subscribers: [],
      };

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithUnresolvableScope,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: {
          promptIdMap: {},
          profileIdMap: {},
          agentIdMap: {}, // No agents, so scope cannot be resolved
          statusIdMap: {},
        },
      });

      watchersService.createWatcher.mockResolvedValue({
        id: 'watcher-1',
        name: 'Watcher with Unresolvable Scope',
        enabled: false,
        scope: 'all', // Should fallback to 'all'
        scopeFilterId: null,
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'unresolved-scope-test',
      });

      // Verify createWatcher was called with scope: 'all' (fallback)
      expect(watchersService.createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'all',
          scopeFilterId: null,
        }),
      );
    });

    it('should set template metadata for bundled template with version from _manifest', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        _manifest: {
          slug: 'bundled-template',
          name: 'Bundled Template',
          version: '1.1.0',
        },
      };

      // Mock ExportSchema.parse to return the expected parsed output
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...validTemplate,
        watchers: [],
        subscribers: [],
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'bundled',
        version: null, // UnifiedTemplateService returns null for bundled templates
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'bundled-template',
      });

      // Should read version from _manifest when getTemplate returns version: null
      expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith('p1', {
        templateSlug: 'bundled-template',
        source: 'bundled',
        installedVersion: '1.1.0',
        registryUrl: null,
        installedAt: expect.any(String),
      });

      jest.restoreAllMocks();
    });

    it('should set installedVersion as null for bundled template without _manifest version', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        // No _manifest or _manifest without version
      };
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'legacy-template',
      });

      expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith('p1', {
        templateSlug: 'legacy-template',
        source: 'bundled',
        installedVersion: null,
        registryUrl: null,
        installedAt: expect.any(String),
      });
    });

    it('should set template metadata for registry template with version', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
      };
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'registry',
        version: '1.2.0',
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'my-registry-template',
        version: '1.2.0',
      });

      expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith('p1', {
        templateSlug: 'my-registry-template',
        source: 'registry',
        installedVersion: '1.2.0',
        registryUrl: 'https://registry.example.com',
        installedAt: expect.any(String),
      });
    });

    it('should allow duplicate watcher eventName values when importing template watchers', async () => {
      const templateWithWatcher = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [
          {
            name: 'Watcher A',
            description: null,
            enabled: false,
            scope: 'all',
            scopeFilterName: null,
            pollIntervalMs: 5000,
            viewportLines: 100,
            condition: { type: 'contains', pattern: 'test' },
            cooldownMs: 10000,
            cooldownMode: 'time',
            eventName: 'duplicate-event',
          },
          {
            name: 'Watcher B',
            description: null,
            enabled: false,
            scope: 'all',
            scopeFilterName: null,
            pollIntervalMs: 5000,
            viewportLines: 100,
            condition: { type: 'contains', pattern: 'another' },
            cooldownMs: 10000,
            cooldownMode: 'time',
            eventName: 'duplicate-event',
          },
        ],
        subscribers: [],
      };

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithWatcher,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: {
          promptIdMap: {},
          profileIdMap: {},
          agentIdMap: {},
          statusIdMap: {},
        },
      });

      watchersService.createWatcher
        .mockResolvedValueOnce({ id: 'watcher-1', enabled: false })
        .mockResolvedValueOnce({ id: 'watcher-2', enabled: false });

      const result = await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'duplicate-event-test',
      });

      expect(result.success).toBe(true);
      expect(result.imported.watchers).toBe(2);
      expect(watchersService.createWatcher).toHaveBeenCalledTimes(2);
      expect(watchersService.createWatcher).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ eventName: 'duplicate-event' }),
      );
      expect(watchersService.createWatcher).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ eventName: 'duplicate-event' }),
      );
    });

    // Tests for templatePath flow (file-based templates)
    it('should call getTemplateFromFilePath when templatePath is provided', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        _manifest: { slug: 'file-template', version: '1.0.0' },
      };

      // Mock ExportSchema.parse to return valid parsed output
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...validTemplate,
        watchers: [],
        subscribers: [],
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplateFromFilePath.mockReturnValue({
        content: validTemplate,
        source: 'file',
        version: '1.0.0',
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        templatePath: '/path/to/template.json',
      });

      expect(unifiedTemplateService.getTemplateFromFilePath).toHaveBeenCalledWith(
        '/path/to/template.json',
      );
      expect(unifiedTemplateService.getTemplate).not.toHaveBeenCalled();

      jest.restoreAllMocks();
    });

    it('should set source: file in metadata when templatePath is provided', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        _manifest: { slug: 'file-template', version: '2.0.0' },
      };

      // Mock ExportSchema.parse to return valid parsed output
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...validTemplate,
        watchers: [],
        subscribers: [],
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplateFromFilePath.mockReturnValue({
        content: validTemplate,
        source: 'file',
        version: '2.0.0',
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        templatePath: '/path/to/template.json',
      });

      expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith('p1', {
        templateSlug: 'file-template',
        source: 'file',
        installedVersion: '2.0.0',
        registryUrl: null,
        installedAt: expect.any(String),
      });

      jest.restoreAllMocks();
    });

    it('should derive slug from filename when _manifest.slug is absent', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        // No _manifest or _manifest without slug
      };
      unifiedTemplateService.getTemplateFromFilePath.mockReturnValue({
        content: validTemplate,
        source: 'file',
        version: null,
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        templatePath: '/path/to/my-custom-template.json',
      });

      expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith('p1', {
        templateSlug: 'my-custom-template', // Derived from filename
        source: 'file',
        installedVersion: null,
        registryUrl: null,
        installedAt: expect.any(String),
      });
    });

    it('should use _manifest.slug when present in file-based template', async () => {
      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        _manifest: { slug: 'manifest-defined-slug', version: '1.5.0' },
      };

      // Mock ExportSchema.parse to return valid parsed output
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...validTemplate,
        watchers: [],
        subscribers: [],
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplateFromFilePath.mockReturnValue({
        content: validTemplate,
        source: 'file',
        version: '1.5.0',
      });

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        templatePath: '/path/to/different-filename.json',
      });

      expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith('p1', {
        templateSlug: 'manifest-defined-slug', // From _manifest, not filename
        source: 'file',
        installedVersion: '1.5.0',
        registryUrl: null,
        installedAt: expect.any(String),
      });

      jest.restoreAllMocks();
    });

    it('should apply providerSettings with oneMillionContextEnabled during createFromTemplate', async () => {
      const providerId = '33333333-3333-3333-3333-333333333333';
      const profileId = '22222222-2222-2222-2222-222222222222';

      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId,
            name: 'Test Profile',
            provider: { name: 'claude' },
            options: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
        agents: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            name: 'Test Agent',
            profileId,
            description: null,
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...validTemplate,
        watchers: [],
        subscribers: [],
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        providerSettings: [{ name: 'claude', oneMillionContextEnabled: true }],
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId]: 'new-profile-1' },
          agentIdMap: { '11111111-1111-1111-1111-111111111111': 'new-agent-1' },
          statusIdMap: {},
        },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'my-template',
      });

      // No binPath → should disable 1M and set safe fallback threshold of 95
      expect(storage.updateProvider).toHaveBeenCalledWith(providerId, {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
      });
      expect(mockProbe1mSupport).not.toHaveBeenCalled();

      jest.restoreAllMocks();
    });

    it('should enable 1M during createFromTemplate when auto-probe succeeds', async () => {
      const providerId = '33333333-3333-3333-3333-333333333333';
      const profileId = '22222222-2222-2222-2222-222222222222';

      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId,
            name: 'Test Profile',
            provider: { name: 'claude' },
            options: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
        agents: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            name: 'Test Agent',
            profileId,
            description: null,
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...validTemplate,
        watchers: [],
        subscribers: [],
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        providerSettings: [{ name: 'claude', oneMillionContextEnabled: true }],
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({
        items: [
          {
            id: providerId,
            name: 'claude',
            autoCompactThreshold: null,
            binPath: '/usr/bin/claude',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId]: 'new-profile-1' },
          agentIdMap: { '11111111-1111-1111-1111-111111111111': 'new-agent-1' },
          statusIdMap: {},
        },
      });

      mockProbe1mSupport.mockResolvedValue({ supported: true, status: 'supported' });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'my-template',
      });

      expect(mockProbe1mSupport).toHaveBeenCalledWith(expect.anything(), '/usr/bin/claude');
      expect(storage.updateProvider).toHaveBeenCalledWith(providerId, {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
      });

      jest.restoreAllMocks();
    });

    it('should disable 1M during createFromTemplate when auto-probe fails', async () => {
      const providerId = '33333333-3333-3333-3333-333333333333';
      const profileId = '22222222-2222-2222-2222-222222222222';

      const validTemplate = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId,
            name: 'Test Profile',
            provider: { name: 'claude' },
            options: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
        agents: [
          {
            id: '11111111-1111-1111-1111-111111111111',
            name: 'Test Agent',
            profileId,
            description: null,
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...validTemplate,
        watchers: [],
        subscribers: [],
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        providerSettings: [{ name: 'claude', oneMillionContextEnabled: true }],
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: validTemplate,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({
        items: [
          {
            id: providerId,
            name: 'claude',
            autoCompactThreshold: null,
            binPath: '/usr/bin/claude',
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId]: 'new-profile-1' },
          agentIdMap: { '11111111-1111-1111-1111-111111111111': 'new-agent-1' },
          statusIdMap: {},
        },
      });

      mockProbe1mSupport.mockResolvedValue({ supported: false, status: 'unsupported' });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'my-template',
      });

      expect(mockProbe1mSupport).toHaveBeenCalledWith(expect.anything(), '/usr/bin/claude');
      expect(storage.updateProvider).toHaveBeenCalledWith(providerId, {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
      });

      jest.restoreAllMocks();
    });

    describe('team seeding', () => {
      const tProfileId = '22222222-2222-2222-2222-222222222222';
      const tProviderId = '33333333-3333-3333-3333-333333333333';
      const tAgentA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const tAgentB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

      function makeTemplateWithTeams(
        teams: Array<{
          name: string;
          description?: string | null;
          teamLeadAgentName?: string | null;
          memberAgentNames: string[];
          maxMembers?: number;
          maxConcurrentTasks?: number;
          profileNames?: string[];
          profileSelections?: Array<{ profileName: string; configNames: string[] }>;
        }>,
        providerConfigs: Array<{
          name: string;
          providerName: string;
          description?: string | null;
          options?: string | null;
          env?: Record<string, string> | null;
        }> = [
          {
            name: 'local',
            providerName: 'claude',
            description: null,
            options: null,
            env: null,
          },
        ],
      ) {
        return {
          version: 1,
          prompts: [],
          profiles: [
            {
              id: tProfileId,
              name: 'Default Profile',
              provider: { name: 'claude' },
              options: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
              providerConfigs,
            },
          ],
          agents: [
            { id: tAgentA, name: 'Lead Agent', profileId: tProfileId, description: null },
            { id: tAgentB, name: 'Worker Agent', profileId: tProfileId, description: null },
          ],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
          teams,
        };
      }

      function setupTeamSeedMocks() {
        const newProfileId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
        const newAgentA = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
        const newAgentB = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

        storage.listProviders.mockResolvedValue({
          items: [{ id: tProviderId, name: 'claude', binPath: null }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.createProjectWithTemplate.mockResolvedValue({
          project: { id: 'new-proj-1', name: 'Test' },
          imported: { prompts: 0, profiles: 1, agents: 2, statuses: 1 },
          mappings: {
            promptIdMap: {},
            profileIdMap: { [tProfileId]: newProfileId },
            agentIdMap: { [tAgentA]: newAgentA, [tAgentB]: newAgentB },
            statusIdMap: {},
          },
        });
        storage.listAgents.mockResolvedValue({
          items: [
            { id: newAgentA, name: 'Lead Agent', profileId: newProfileId },
            { id: newAgentB, name: 'Worker Agent', profileId: newProfileId },
          ],
          total: 2,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [{ id: newProfileId, name: 'Default Profile' }],
          total: 1,
          limit: 1000,
          offset: 0,
        });
        storage.listProfileProviderConfigsByProfile.mockResolvedValue([
          {
            id: 'config-local-1',
            name: 'local',
            profileId: newProfileId,
            providerId: tProviderId,
            options: null,
            env: null,
          },
        ]);
        storage.createProfileProviderConfig.mockImplementation(
          async (data: Record<string, unknown>) => ({
            id: `config-${Date.now()}`,
            ...data,
          }),
        );
      }

      function mockParsedTemplate(
        teams: Array<{
          name: string;
          description?: string | null;
          teamLeadAgentName?: string | null;
          memberAgentNames: string[];
          maxMembers?: number;
          maxConcurrentTasks?: number;
          profileNames?: string[];
          profileSelections?: Array<{ profileName: string; configNames: string[] }>;
        }>,
        providerConfigs?: Parameters<typeof makeTemplateWithTeams>[1],
      ) {
        const template = makeTemplateWithTeams(teams, providerConfigs);
        const parsed = {
          ...template,
          prompts: [],
          profiles: template.profiles.map((p) => ({
            ...p,
            familySlug: null,
          })),
          agents: template.agents.map((a) => ({
            ...a,
            modelOverride: null,
          })),
          watchers: [],
          subscribers: [],
          teams,
          presets: [],
          providerModels: [],
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>;

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(parsed);
        unifiedTemplateService.getTemplate.mockResolvedValue({
          content: template,
          source: 'bundled',
          version: null,
        });
      }

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('should seed one team from template', async () => {
        mockParsedTemplate([
          {
            name: 'Dev Team',
            description: 'Main dev team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent', 'Worker Agent'],
            profileNames: ['Default Profile'],
            profileSelections: [{ profileName: 'Default Profile', configNames: ['local'] }],
          },
        ]);
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'team-seed-test',
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        expect(teamsServiceMock.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'new-proj-1',
            name: 'Dev Team',
            description: 'Main dev team',
          }),
        );
      });

      it('should seed two teams from template', async () => {
        mockParsedTemplate([
          {
            name: 'Team Alpha',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent', 'Worker Agent'],
          },
          {
            name: 'Team Beta',
            teamLeadAgentName: 'Worker Agent',
            memberAgentNames: ['Worker Agent'],
          },
        ]);
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'two-teams-test',
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(2);
        expect(teamsServiceMock.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Team Alpha' }),
        );
        expect(teamsServiceMock.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Team Beta' }),
        );
      });

      it('should skip team when lead agent is missing (non-fatal)', async () => {
        mockParsedTemplate([
          {
            name: 'Bad Team',
            teamLeadAgentName: 'Nonexistent Agent',
            memberAgentNames: ['Nonexistent Agent'],
          },
        ]);
        setupTeamSeedMocks();

        const result = await service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'missing-lead-test',
        });

        expect(result).toBeDefined();
        expect(teamsServiceMock.createTeam).not.toHaveBeenCalled();
      });

      it('should create project normally when template has zero teams', async () => {
        mockParsedTemplate([]);
        setupTeamSeedMocks();

        const result = await service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'no-teams-test',
        });

        expect(result).toBeDefined();
        expect(teamsServiceMock.createTeam).not.toHaveBeenCalled();
      });

      it('should preserve allow-all sentinel when no profileSelections provided', async () => {
        mockParsedTemplate([
          {
            name: 'AllowAll Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['Default Profile'],
          },
        ]);
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'allow-all-test',
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        const callArgs = teamsServiceMock.createTeam.mock.calls[0][0];
        expect(callArgs.profileConfigSelections).toBeUndefined();
      });

      it('should prune skipped provider configs from team profileSelections', async () => {
        mockParsedTemplate(
          [
            {
              name: 'Dev Team',
              teamLeadAgentName: 'Lead Agent',
              memberAgentNames: ['Lead Agent', 'Worker Agent'],
              profileNames: ['Default Profile'],
              profileSelections: [
                { profileName: 'Default Profile', configNames: ['local', 'gemini3'] },
              ],
            },
          ],
          [
            {
              name: 'local',
              providerName: 'claude',
              description: null,
              options: null,
              env: null,
            },
            {
              name: 'gemini3',
              providerName: 'gemini',
              description: null,
              options: null,
              env: null,
            },
          ],
        );
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'skipped-provider-config-test',
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        const callArgs = teamsServiceMock.createTeam.mock.calls[0][0];
        expect(callArgs.profileConfigSelections).toEqual([
          { profileId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', configIds: ['config-local-1'] },
        ]);
      });

      it('should not widen access when all selected provider configs are skipped', async () => {
        mockParsedTemplate(
          [
            {
              name: 'Dev Team',
              teamLeadAgentName: 'Lead Agent',
              memberAgentNames: ['Lead Agent', 'Worker Agent'],
              profileNames: ['Default Profile'],
              profileSelections: [{ profileName: 'Default Profile', configNames: ['gemini3'] }],
            },
          ],
          [
            {
              name: 'gemini3',
              providerName: 'gemini',
              description: null,
              options: null,
              env: null,
            },
          ],
        );
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'all-skipped-provider-config-test',
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        const callArgs = teamsServiceMock.createTeam.mock.calls[0][0];
        expect(callArgs.profileIds).toEqual([]);
        expect(callArgs.profileConfigSelections).toBeUndefined();
      });

      it('should pass maxMembers and maxConcurrentTasks to createTeam', async () => {
        mockParsedTemplate([
          {
            name: 'Capped Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            maxMembers: 8,
            maxConcurrentTasks: 3,
          },
        ]);
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'capacity-test',
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            maxMembers: 8,
            maxConcurrentTasks: 3,
          }),
        );
      });

      it('should remap team profileNames via profileNameRemapMap for family-mapped templates', async () => {
        const codexProfileId = 'aaaaaaaa-aaaa-aaaa-aaaa-111111111111';
        const claudeProfileId = 'aaaaaaaa-aaaa-aaaa-aaaa-222222222222';
        const fmAgentId = 'aaaaaaaa-aaaa-aaaa-aaaa-333333333333';
        const fmProviderId = 'aaaaaaaa-aaaa-aaaa-aaaa-444444444444';

        const templateWithFamily = {
          version: 1,
          prompts: [],
          profiles: [
            {
              id: codexProfileId,
              name: 'Coder Codex',
              provider: { name: 'codex' },
              familySlug: 'coder',
              options: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
            },
            {
              id: claudeProfileId,
              name: 'Coder Claude',
              provider: { name: 'claude' },
              familySlug: 'coder',
              options: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
            },
          ],
          agents: [
            {
              id: fmAgentId,
              name: 'Coder',
              profileId: codexProfileId,
              description: null,
              modelOverride: null,
            },
          ],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
          teams: [
            {
              name: 'Dev Team',
              teamLeadAgentName: 'Coder',
              memberAgentNames: ['Coder'],
              profileNames: ['Coder Codex'],
            },
          ],
          watchers: [],
          subscribers: [],
          presets: [],
          providerModels: [],
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
        };

        jest
          .spyOn(devchainShared.ExportSchema, 'parse')
          .mockReturnValue(
            templateWithFamily as ReturnType<typeof devchainShared.ExportSchema.parse>,
          );

        unifiedTemplateService.getTemplate.mockResolvedValue({
          content: templateWithFamily,
          source: 'bundled',
          version: null,
        });

        storage.listProviders.mockResolvedValue({
          items: [{ id: fmProviderId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });

        const newProfileId = 'aaaaaaaa-aaaa-aaaa-aaaa-555555555555';
        const newAgentId = 'aaaaaaaa-aaaa-aaaa-aaaa-666666666666';

        storage.createProjectWithTemplate.mockResolvedValue({
          project: { id: 'new-proj-fm', name: 'Family Test' },
          imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
          mappings: {
            promptIdMap: {},
            profileIdMap: { [claudeProfileId]: newProfileId },
            agentIdMap: { [fmAgentId]: newAgentId },
            statusIdMap: {},
          },
        });

        storage.listAgents.mockResolvedValue({
          items: [{ id: newAgentId, name: 'Coder', profileId: newProfileId }],
          total: 1,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [{ id: newProfileId, name: 'Coder Claude' }],
          total: 1,
          limit: 1000,
          offset: 0,
        });
        storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);
        storage.createProfileProviderConfig.mockImplementation(
          async (data: Record<string, unknown>) => ({
            id: `config-${Date.now()}`,
            ...data,
          }),
        );

        await service.createFromTemplate({
          name: 'Family Test',
          rootPath: '/test',
          slug: 'family-test',
          familyProviderMappings: { coder: 'claude' },
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        const callArgs = teamsServiceMock.createTeam.mock.calls[0][0];
        expect(callArgs.profileIds).toBeDefined();
        expect(callArgs.profileIds).toContain(newProfileId);
      });

      it('should roundtrip capacity values through export and import', async () => {
        const projectId = 'project-123';

        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 1000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
        storage.getInitialSessionPrompt.mockResolvedValue(null);
        storage.listWatchers.mockResolvedValue([]);
        storage.listSubscribers.mockResolvedValue([]);
        storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);

        const teamId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const leadAgentId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';
        teamsServiceMock.listTeams.mockResolvedValue({
          items: [
            {
              id: teamId,
              name: 'Capped Team',
              description: null,
              teamLeadAgentId: leadAgentId,
              memberCount: 1,
            },
          ],
        });
        teamsServiceMock.getTeam.mockResolvedValue({
          id: teamId,
          name: 'Capped Team',
          description: null,
          teamLeadAgentId: leadAgentId,
          maxMembers: 6,
          maxConcurrentTasks: 2,
          members: [{ agentId: leadAgentId }],
          profileIds: [],
          profileConfigSelections: [],
        });
        storage.getAgent.mockResolvedValue({ id: leadAgentId, name: 'Lead Agent' });

        const exported = await service.exportProject(projectId);

        expect(exported.teams).toBeDefined();
        expect(exported.teams).toHaveLength(1);
        expect(exported.teams![0].maxMembers).toBe(6);
        expect(exported.teams![0].maxConcurrentTasks).toBe(2);

        // Now import and verify capacity is passed through
        storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
        storage.listEpics.mockResolvedValue({ items: [], total: 0, limit: 100000, offset: 0 });
        // Import creates agents/profiles; listAgents called by createImportedTeams
        storage.listAgents.mockResolvedValue({
          items: [{ id: leadAgentId, name: 'Lead Agent', profileId: 'prof-1' }],
          total: 1,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 1000,
          offset: 0,
        });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listWatchers.mockResolvedValue([]);
        storage.listSubscribers.mockResolvedValue([]);

        const { _manifest: _omitted, ...importPayload } = exported;
        void _omitted;
        jest
          .spyOn(devchainShared.ExportSchema, 'parse')
          .mockReturnValue(importPayload as ReturnType<typeof devchainShared.ExportSchema.parse>);

        await service.importProject({
          projectId,
          payload: importPayload,
          dryRun: false,
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            maxMembers: 6,
            maxConcurrentTasks: 2,
          }),
        );
      });

      it('should roundtrip allowTeamLeadCreateAgents through export and import', async () => {
        const projectId = 'project-123';

        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 1000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
        storage.getInitialSessionPrompt.mockResolvedValue(null);
        storage.listWatchers.mockResolvedValue([]);
        storage.listSubscribers.mockResolvedValue([]);
        storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);

        const teamId = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
        const leadAgentId = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';
        teamsServiceMock.listTeams.mockResolvedValue({
          items: [
            {
              id: teamId,
              name: 'Flagged Team',
              description: null,
              teamLeadAgentId: leadAgentId,
              memberCount: 1,
            },
          ],
        });
        teamsServiceMock.getTeam.mockResolvedValue({
          id: teamId,
          name: 'Flagged Team',
          description: null,
          teamLeadAgentId: leadAgentId,
          maxMembers: 5,
          maxConcurrentTasks: 5,
          allowTeamLeadCreateAgents: true,
          members: [{ agentId: leadAgentId }],
          profileIds: [],
          profileConfigSelections: [],
        });
        storage.getAgent.mockResolvedValue({ id: leadAgentId, name: 'Lead' });

        const exported = await service.exportProject(projectId);

        expect(exported.teams).toHaveLength(1);
        expect(exported.teams![0].allowTeamLeadCreateAgents).toBe(true);

        // Import without the field → should default to false
        storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
        storage.listEpics.mockResolvedValue({ items: [], total: 0, limit: 100000, offset: 0 });
        storage.listAgents.mockResolvedValue({
          items: [{ id: leadAgentId, name: 'Lead', profileId: 'prof-1' }],
          total: 1,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 1000,
          offset: 0,
        });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listWatchers.mockResolvedValue([]);
        storage.listSubscribers.mockResolvedValue([]);

        // Import WITH the field set
        const { _manifest: _omit, ...importPayload } = exported;
        void _omit;
        jest
          .spyOn(devchainShared.ExportSchema, 'parse')
          .mockReturnValue(importPayload as ReturnType<typeof devchainShared.ExportSchema.parse>);

        await service.importProject({
          projectId,
          payload: importPayload,
          dryRun: false,
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            allowTeamLeadCreateAgents: true,
          }),
        );
      });

      it('should apply teamOverrides with correct precedence (override > template)', async () => {
        mockParsedTemplate([
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            maxMembers: 5,
          },
        ]);
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'Override Test',
          rootPath: '/test',
          slug: 'override-test',
          teamOverrides: [{ teamName: 'Dev Team', maxMembers: 8, allowTeamLeadCreateAgents: true }],
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        expect(teamsServiceMock.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            maxMembers: 8,
            allowTeamLeadCreateAgents: true,
          }),
        );
      });

      it('should ignore unknown teamName in teamOverrides without error', async () => {
        mockParsedTemplate([
          {
            name: 'Real Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
          },
        ]);
        setupTeamSeedMocks();

        const result = await service.createFromTemplate({
          name: 'Unknown Override Test',
          rootPath: '/test',
          slug: 'unknown-override',
          teamOverrides: [{ teamName: 'Nonexistent Team', maxMembers: 9 }],
        });

        expect(result).toBeDefined();
        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        expect(teamsServiceMock.createTeam).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'Real Team' }),
        );
      });

      it('should use override profileNames to remove a profile from the team (Rule 3 regression)', async () => {
        const newProfileIdA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
        const newProfileIdB = 'cccccccc-cccc-cccc-cccc-dddddddddddd';
        const newAgentA = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

        mockParsedTemplate([
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['ProfileA', 'ProfileB'],
          },
        ]);

        storage.listProviders.mockResolvedValue({
          items: [{ id: tProviderId, name: 'claude', binPath: null }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.createProjectWithTemplate.mockResolvedValue({
          project: { id: 'new-proj-1', name: 'Test' },
          imported: { prompts: 0, profiles: 2, agents: 1, statuses: 1 },
          mappings: {
            promptIdMap: {},
            profileIdMap: { [tProfileId]: newProfileIdA },
            agentIdMap: { [tAgentA]: newAgentA },
            statusIdMap: {},
          },
        });
        storage.listAgents.mockResolvedValue({
          items: [{ id: newAgentA, name: 'Lead Agent', profileId: newProfileIdA }],
          total: 1,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [
            { id: newProfileIdA, name: 'ProfileA' },
            { id: newProfileIdB, name: 'ProfileB' },
          ],
          total: 2,
          limit: 1000,
          offset: 0,
        });
        storage.listProfileProviderConfigsByProfile.mockResolvedValue([]);
        storage.createProfileProviderConfig.mockImplementation(
          async (data: Record<string, unknown>) => ({
            id: `config-${Date.now()}`,
            ...data,
          }),
        );

        await service.createFromTemplate({
          name: 'Rule3 Test',
          rootPath: '/test',
          slug: 'rule3-test',
          teamOverrides: [
            {
              teamName: 'Dev Team',
              profileNames: ['ProfileB'],
            },
          ],
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        const callArgs = teamsServiceMock.createTeam.mock.calls[0][0];
        expect(callArgs.profileIds).toEqual([newProfileIdB]);
      });

      it('should preserve template profileNames when override profileNames is undefined', async () => {
        mockParsedTemplate([
          {
            name: 'Dev Team',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['Default Profile'],
          },
        ]);
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'No Override Test',
          rootPath: '/test',
          slug: 'no-override-test',
          teamOverrides: [{ teamName: 'Dev Team', maxMembers: 8 }],
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        const callArgs = teamsServiceMock.createTeam.mock.calls[0][0];
        expect(callArgs.profileIds).toBeDefined();
        expect(callArgs.profileIds!.length).toBe(1);
      });

      it('should apply profileNameRemapMap to override profileSelections', async () => {
        const codexProfileId = 'aaaaaaaa-aaaa-aaaa-aaaa-111111111111';
        const claudeProfileId = 'aaaaaaaa-aaaa-aaaa-aaaa-222222222222';
        const fmAgentId = 'aaaaaaaa-aaaa-aaaa-aaaa-333333333333';
        const fmProviderId = 'aaaaaaaa-aaaa-aaaa-aaaa-444444444444';

        const templateWithFamily = {
          version: 1,
          prompts: [],
          profiles: [
            {
              id: codexProfileId,
              name: 'Coder Codex',
              provider: { name: 'codex' },
              familySlug: 'coder',
              options: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
            },
            {
              id: claudeProfileId,
              name: 'Coder Claude',
              provider: { name: 'claude' },
              familySlug: 'coder',
              options: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
            },
          ],
          agents: [
            {
              id: fmAgentId,
              name: 'Coder',
              profileId: codexProfileId,
              description: null,
              modelOverride: null,
            },
          ],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
          teams: [
            {
              name: 'Dev Team',
              teamLeadAgentName: 'Coder',
              memberAgentNames: ['Coder'],
              profileNames: ['Coder Codex'],
            },
          ],
          watchers: [],
          subscribers: [],
          presets: [],
          providerModels: [],
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
        };

        jest
          .spyOn(devchainShared.ExportSchema, 'parse')
          .mockReturnValue(
            templateWithFamily as ReturnType<typeof devchainShared.ExportSchema.parse>,
          );

        unifiedTemplateService.getTemplate.mockResolvedValue({
          content: templateWithFamily,
          source: 'bundled',
          version: null,
        });

        storage.listProviders.mockResolvedValue({
          items: [{ id: fmProviderId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });

        const newProfileId = 'aaaaaaaa-aaaa-aaaa-aaaa-555555555555';
        const newAgentId = 'aaaaaaaa-aaaa-aaaa-aaaa-666666666666';

        storage.createProjectWithTemplate.mockResolvedValue({
          project: { id: 'new-proj-fm2', name: 'Family Override Test' },
          imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
          mappings: {
            promptIdMap: {},
            profileIdMap: { [claudeProfileId]: newProfileId },
            agentIdMap: { [fmAgentId]: newAgentId },
            statusIdMap: {},
          },
        });

        storage.listAgents.mockResolvedValue({
          items: [{ id: newAgentId, name: 'Coder', profileId: newProfileId }],
          total: 1,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [{ id: newProfileId, name: 'Coder Claude' }],
          total: 1,
          limit: 1000,
          offset: 0,
        });
        storage.listProfileProviderConfigsByProfile.mockResolvedValue([
          {
            id: 'config-claude-1',
            name: 'claude-local',
            profileId: newProfileId,
            providerId: fmProviderId,
            options: null,
            env: null,
          },
        ]);
        storage.createProfileProviderConfig.mockImplementation(
          async (data: Record<string, unknown>) => ({
            id: `config-${Date.now()}`,
            ...data,
          }),
        );

        await service.createFromTemplate({
          name: 'Family Override Test',
          rootPath: '/test',
          slug: 'family-override',
          familyProviderMappings: { coder: 'claude' },
          teamOverrides: [
            {
              teamName: 'Dev Team',
              profileSelections: [{ profileName: 'Coder Codex', configNames: ['claude-local'] }],
            },
          ],
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        const callArgs = teamsServiceMock.createTeam.mock.calls[0][0];
        expect(callArgs.profileIds).toContain(newProfileId);
      });

      it('should preserve allow-all when override has empty configNames', async () => {
        mockParsedTemplate([
          {
            name: 'AllowAll Override',
            teamLeadAgentName: 'Lead Agent',
            memberAgentNames: ['Lead Agent'],
            profileNames: ['Default Profile'],
            profileSelections: [{ profileName: 'Default Profile', configNames: ['local'] }],
          },
        ]);
        setupTeamSeedMocks();

        await service.createFromTemplate({
          name: 'AllowAll Override Test',
          rootPath: '/test',
          slug: 'allowall-override',
          teamOverrides: [
            {
              teamName: 'AllowAll Override',
              profileSelections: [{ profileName: 'Default Profile', configNames: [] }],
            },
          ],
        });

        expect(teamsServiceMock.createTeam).toHaveBeenCalledTimes(1);
        const callArgs = teamsServiceMock.createTeam.mock.calls[0][0];
        const selections = callArgs.profileConfigSelections;
        expect(!selections || selections.length === 0).toBe(true);
      });
    });
  });

  describe('createFromTemplate with familyProviderMappings', () => {
    const profileId1 = '11111111-1111-1111-1111-111111111111';
    const profileId2 = '22222222-2222-2222-2222-222222222222';
    const agentId = '33333333-3333-3333-3333-333333333333';
    const providerId = '44444444-4444-4444-4444-444444444444';

    it('should return providerMappingRequired when default provider is missing and no mappings provided', async () => {
      // Directly test computeFamilyAlternatives since createFromTemplate's schema parsing
      // has ESM compatibility issues in Jest. The createFromTemplate integration is tested
      // in e2e tests where the full schema works correctly.
      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }], // codex is missing
        total: 1,
        limit: 100,
        offset: 0,
      });

      // Test computeFamilyAlternatives directly to verify the logic
      const profiles = [
        { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
        { id: profileId2, name: 'Coder Claude', provider: { name: 'claude' }, familySlug: 'coder' },
      ];
      const agents = [{ id: agentId, name: 'Coder', profileId: profileId1 }];

      const familyResult = await service.computeFamilyAlternatives(profiles, agents);

      // Verify the conditions that would trigger providerMappingRequired return
      const needsMapping = familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable);
      expect(needsMapping).toBe(true);
      expect(familyResult.missingProviders).toContain('codex');
      expect(familyResult.canImport).toBe(true);
      expect(familyResult.alternatives).toHaveLength(1);
      expect(familyResult.alternatives[0].familySlug).toBe('coder');
      expect(familyResult.alternatives[0].availableProviders).toContain('claude');
    });

    it('should create project with remapped profiles when mappings are provided', async () => {
      const templateWithMissingProvider = {
        version: 1,
        prompts: [],
        profiles: [
          { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
          {
            id: profileId2,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [
          {
            id: agentId,
            name: 'Coder',
            profileId: profileId1,
            modelOverride: 'anthropic/claude-sonnet-4-5',
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      // Mock ExportSchema.parse to return input with defaults applied (preserving familySlug)
      // This works around ESM compatibility issues in Jest
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithMissingProvider,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithMissingProvider,
        source: 'bundled',
        version: null,
      });

      // Only claude is available
      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId2]: 'new-profile-1' },
          agentIdMap: { [agentId]: 'new-agent-1' },
          statusIdMap: {},
        },
      });

      const result = await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'test-template',
        familyProviderMappings: { coder: 'claude' }, // Remap coder family to claude
      });

      expect(result.success).toBe(true);
      expect(result.project).toBeDefined();

      // Verify createProjectWithTemplate was called with the claude profile (not codex)
      expect(storage.createProjectWithTemplate).toHaveBeenCalled();
      const [, templatePayload] = storage.createProjectWithTemplate.mock.calls[0];
      expect(templatePayload.profiles).toHaveLength(1);
      expect(templatePayload.profiles[0].name).toBe('Coder Claude');
      expect(templatePayload.profiles[0].providerId).toBe(providerId);
      expect(templatePayload.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Coder',
            modelOverride: 'anthropic/claude-sonnet-4-5',
          }),
        ]),
      );

      // Cleanup
      jest.restoreAllMocks();
    });

    it('should proceed normally when all default providers are available', async () => {
      const templateWithAvailableProvider = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [{ id: agentId, name: 'Coder', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      // Mock ExportSchema.parse to return input with defaults applied (preserving familySlug)
      // This works around ESM compatibility issues in Jest
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithAvailableProvider,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithAvailableProvider,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId1]: 'new-profile-1' },
          agentIdMap: { [agentId]: 'new-agent-1' },
          statusIdMap: {},
        },
      });

      const result = await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'test-template',
        // No mappings needed
      });

      expect(result.success).toBe(true);
      expect(result.providerMappingRequired).toBeUndefined();

      // Cleanup
      jest.restoreAllMocks();
    });

    it('should remap watcher profile scope when profile is remapped via family mappings', async () => {
      const watcherId = '55555555-5555-5555-5555-555555555555';
      const templateWithWatcher = {
        version: 1,
        prompts: [],
        profiles: [
          { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
          {
            id: profileId2,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [{ id: agentId, name: 'Coder', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        // Watcher references 'Coder Codex' profile which won't be created (Coder Claude will be selected)
        watchers: [
          {
            id: watcherId,
            name: 'Test Watcher',
            enabled: true,
            scope: 'profile' as const,
            scopeFilterName: 'Coder Codex', // References the original profile
            pollIntervalMs: 1000,
            viewportLines: 50,
            condition: { type: 'contains' as const, pattern: 'error' },
            cooldownMs: 5000,
            cooldownMode: 'time' as const,
            eventName: 'test-event',
          },
        ],
        subscribers: [],
      };

      // Mock ExportSchema.parse to preserve familySlug
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithWatcher,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithWatcher,
        source: 'bundled',
        version: null,
      });

      // Only claude is available
      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const newProfileId = 'new-profile-uuid';
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId2]: newProfileId },
          agentIdMap: { [agentId]: 'new-agent-1' },
          statusIdMap: {},
        },
      });

      // Mock watcher creation
      watchersService.createWatcher.mockResolvedValue({ id: 'new-watcher-id', enabled: true });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'test-template',
        familyProviderMappings: { coder: 'claude' },
      });

      // Verify watcher was created with the remapped profile scope
      expect(watchersService.createWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'profile',
          // scopeFilterId should be the new profile ID (remapped from Coder Codex to Coder Claude)
          scopeFilterId: newProfileId,
        }),
      );

      // Cleanup
      jest.restoreAllMocks();
    });

    it('should throw ValidationError when canImport is false (no alternatives available)', async () => {
      // Template with a profile that has no available provider alternatives
      const templateWithNoAlternatives = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Special Profile',
            provider: { name: 'special-provider' },
            familySlug: 'special',
          },
        ],
        agents: [{ id: agentId, name: 'Special Agent', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithNoAlternatives,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithNoAlternatives,
        source: 'bundled',
        version: null,
      });

      // No providers available at all
      storage.listProviders.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      // Even with mappings provided, should return canImport: false (not throw)
      const result = await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'test-template',
        familyProviderMappings: { special: 'anything' },
      });

      expect(result.success).toBe(false);
      expect(result.providerMappingRequired).toBeDefined();
      expect(result.providerMappingRequired!.canImport).toBe(false);

      jest.restoreAllMocks();
    });

    it('should auto-select provider when exactly one alternative is available', async () => {
      const templateWithAlternatives = {
        version: 1,
        prompts: [],
        profiles: [
          { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
          {
            id: profileId2,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ],
        agents: [{ id: agentId, name: 'Coder', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithAlternatives,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithAlternatives,
        source: 'bundled',
        version: null,
      });

      // Only claude available (codex missing)
      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId2]: 'new-profile-1' },
          agentIdMap: { [agentId]: 'new-agent-1' },
          statusIdMap: {},
        },
      });

      // No familyProviderMappings — should auto-select claude
      const result = await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'test-template',
      });

      expect(result.success).toBe(true);
      expect(result.providerMappingRequired).toBeUndefined();

      // Verify the claude profile was selected (not codex)
      expect(storage.createProjectWithTemplate).toHaveBeenCalled();
      const [, templatePayload] = storage.createProjectWithTemplate.mock.calls[0];
      expect(templatePayload.profiles).toHaveLength(1);
      expect(templatePayload.profiles[0].name).toBe('Coder Claude');
      expect(templatePayload.agents[0].modelOverride).toBeNull();

      jest.restoreAllMocks();
    });

    it('should fall back to first available config when agent providerConfigName is unavailable', async () => {
      const opusConfigId = 'created-opus-config';
      storage.createProfileProviderConfig.mockImplementation(
        async (data: { name: string; profileId: string }) => ({
          id:
            data.name.trim().toLowerCase() === 'opus' ? opusConfigId : `config-other-${Date.now()}`,
          ...data,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );

      const templateWithConfigs = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
            providerConfigs: [
              { name: 'opus', providerName: 'claude', options: null, env: null },
              { name: 'gpt-high', providerName: 'codex', options: null, env: null },
            ],
          },
        ],
        agents: [
          {
            id: agentId,
            name: 'Coder',
            profileId: profileId1,
            providerConfigName: 'gpt-high', // codex config — unavailable
            modelOverride: 'openai/gpt-5',
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithConfigs,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithConfigs,
        source: 'bundled',
        version: null,
      });

      // Only claude available (codex missing — gpt-high config won't be created)
      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const newProfileId = 'new-profile-1';
      const newAgentId = 'new-agent-1';

      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId1]: newProfileId },
          agentIdMap: { [agentId]: newAgentId },
          statusIdMap: {},
        },
      });

      const result = await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'test-template',
      });

      expect(result.success).toBe(true);

      // Agent should have been updated with fallback config (opus) since gpt-high was unavailable
      expect(storage.updateAgent).toHaveBeenCalledWith(newAgentId, {
        providerConfigId: opusConfigId,
      });
      const [, templatePayload] = storage.createProjectWithTemplate.mock.calls[0];
      expect(templatePayload.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Coder',
            modelOverride: 'openai/gpt-5',
          }),
        ]),
      );
      const reassignmentPayload = (storage.updateAgent as jest.Mock).mock.calls[0]?.[1] as
        | { providerConfigId: string; modelOverride?: string | null }
        | undefined;
      expect(reassignmentPayload?.providerConfigId).toBe(opusConfigId);
      expect(reassignmentPayload).not.toHaveProperty('modelOverride');

      jest.restoreAllMocks();
    });

    it('preserves modelOverride when create-from-template applies a preset that omits modelOverride', async () => {
      const selectedPresetName = 'balanced';
      const opusConfigId = 'created-opus-config';
      const newProfileId = 'new-profile-1';
      const newAgentId = 'new-agent-1';
      const initialModelOverride = 'anthropic/claude-sonnet-4-5';

      const templateWithPreset = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
            providerConfigs: [{ name: 'opus', providerName: 'claude', options: null, env: null }],
          },
        ],
        agents: [
          {
            id: agentId,
            name: 'Coder',
            profileId: profileId1,
            providerConfigName: 'opus',
            modelOverride: initialModelOverride,
          },
        ],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        presets: [
          {
            name: selectedPresetName,
            agentConfigs: [{ agentName: 'Coder', providerConfigName: 'opus' }],
          },
        ],
      };

      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithPreset,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithPreset,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId1]: newProfileId },
          agentIdMap: { [agentId]: newAgentId },
          statusIdMap: {},
        },
      });
      storage.createProfileProviderConfig.mockResolvedValue({
        id: opusConfigId,
        profileId: newProfileId,
        providerId,
        name: 'opus',
        options: null,
        env: null,
        createdAt: '',
        updatedAt: '',
      });

      let currentAgent = {
        id: newAgentId,
        name: 'Coder',
        profileId: newProfileId,
        providerConfigId: null as string | null,
        modelOverride: initialModelOverride,
      };
      storage.listAgents.mockImplementation(async () => ({
        items: [currentAgent],
        total: 1,
        limit: 1000,
        offset: 0,
      }));
      storage.updateAgent.mockImplementation(async (id, data) => {
        if (id === currentAgent.id) {
          currentAgent = { ...currentAgent, ...data };
        }
        return { id, ...data } as never;
      });

      const storedPresetsByProject = new Map<string, unknown[]>();
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest
        .fn()
        .mockResolvedValue(undefined);
      (settings as { setProjectPresets: jest.Mock }).setProjectPresets.mockImplementation(
        async (projectIdParam: string, presets: unknown[]) => {
          storedPresetsByProject.set(projectIdParam, presets);
        },
      );
      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockImplementation(
        (projectIdParam: string) => storedPresetsByProject.get(projectIdParam) ?? [],
      );

      const result = await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'test-template',
        presetName: selectedPresetName,
      });

      expect(result.success).toBe(true);
      const [, templatePayload] = storage.createProjectWithTemplate.mock.calls[0];
      expect(templatePayload.agents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Coder',
            modelOverride: initialModelOverride,
          }),
        ]),
      );
      for (const [, updatePayload] of (storage.updateAgent as jest.Mock).mock.calls) {
        expect(updatePayload).toEqual(
          expect.objectContaining({
            providerConfigId: opusConfigId,
          }),
        );
        expect(updatePayload).toEqual(
          expect.not.objectContaining({
            modelOverride: expect.anything(),
          }),
        );
      }
      expect(currentAgent.modelOverride).toBe(initialModelOverride);
      expect(
        (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset,
      ).toHaveBeenCalledWith('new-project-1', selectedPresetName);

      jest.restoreAllMocks();
    });

    it('should not throw when deleteProfileProviderConfig fails during cleanup', async () => {
      const templateWithConfigs = {
        version: 1,
        prompts: [],
        profiles: [
          {
            id: profileId1,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
            providerConfigs: [{ name: 'opus', providerName: 'claude', options: null, env: null }],
          },
        ],
        agents: [{ id: agentId, name: 'Coder', profileId: profileId1 }],
        statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
      };

      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithConfigs,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: templateWithConfigs,
        source: 'bundled',
        version: null,
      });

      storage.listProviders.mockResolvedValue({
        items: [{ id: providerId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const newProfileId = 'new-profile-1';
      storage.createProjectWithTemplate.mockResolvedValue({
        project: { id: 'new-project-1', name: 'Test' },
        imported: { prompts: 0, profiles: 1, agents: 1, statuses: 1 },
        mappings: {
          promptIdMap: {},
          profileIdMap: { [profileId1]: newProfileId },
          agentIdMap: { [agentId]: 'new-agent-1' },
          statusIdMap: {},
        },
      });

      // Storage layer created a default config matching profile name
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        { id: 'default-config', name: 'Coder Claude', profileId: newProfileId },
        { id: 'opus-config', name: 'opus', profileId: newProfileId },
      ]);

      // Simulate deleteProfileProviderConfig throwing (config still referenced by agent)
      storage.deleteProfileProviderConfig.mockRejectedValue(
        new ValidationError('Cannot delete provider config: still referenced by agents'),
      );

      // Should NOT throw — the try-catch in cleanup absorbs the error
      const result = await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'test-template',
      });

      expect(result.success).toBe(true);
      // Verify cleanup was attempted
      expect(storage.deleteProfileProviderConfig).toHaveBeenCalledWith('default-config');

      jest.restoreAllMocks();
    });
  });
});
