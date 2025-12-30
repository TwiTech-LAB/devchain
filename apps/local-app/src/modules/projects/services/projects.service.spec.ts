import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { WatchersService } from '../../watchers/services/watchers.service';
import { WatcherRunnerService } from '../../watchers/services/watcher-runner.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import {
  ValidationError,
  NotFoundError,
  StorageError,
  ConflictError,
} from '../../../common/errors/error-types';
import * as fs from 'fs';
import * as envConfig from '../../../common/config/env.config';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock env config
jest.mock('../../../common/config/env.config');
const mockEnvConfig = envConfig as jest.Mocked<typeof envConfig>;

describe('ProjectsService', () => {
  let service: ProjectsService;
  let storage: {
    getProject: jest.Mock;
    listProviders: jest.Mock;
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
    createWatcher: jest.Mock;
    createSubscriber: jest.Mock;
    deleteSubscriber: jest.Mock;
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
    listTemplates: jest.Mock;
    hasTemplate: jest.Mock;
  };

  beforeEach(async () => {
    storage = {
      getProject: jest.fn().mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        description: 'A test project',
        rootPath: '/test/path',
        isTemplate: false,
      }),
      listProviders: jest.fn(),
      listPrompts: jest.fn(),
      getPrompt: jest.fn(),
      listAgentProfiles: jest.fn(),
      listAgents: jest.fn(),
      listStatuses: jest.fn(),
      getInitialSessionPrompt: jest.fn(),
      getProvider: jest.fn(),
      createStatus: jest.fn(),
      createPrompt: jest.fn(),
      createAgentProfile: jest.fn(),
      createAgent: jest.fn(),
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
      createWatcher: jest.fn(),
      createSubscriber: jest.fn(),
      deleteSubscriber: jest.fn(),
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
      listTemplates: jest.fn(),
      hasTemplate: jest.fn(),
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
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('listTemplates', () => {
    it('should return template filenames when templates directory exists', async () => {
      // Mock environment config
      mockEnvConfig.getEnvConfig.mockReturnValue({
        TEMPLATES_DIR: '/custom/templates',
      } as unknown as ReturnType<typeof mockEnvConfig.getEnvConfig>);

      // Mock fs operations
      mockFs.existsSync.mockReturnValue(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockFs.readdirSync.mockReturnValue(['template1.json', 'template2.json', 'readme.txt'] as any);

      const result = await service.listTemplates();

      expect(result).toEqual([
        { id: 'template1', fileName: 'template1.json' },
        { id: 'template2', fileName: 'template2.json' },
      ]);
      expect(mockFs.existsSync).toHaveBeenCalledWith('/custom/templates');
      expect(mockFs.readdirSync).toHaveBeenCalledWith('/custom/templates');
    });

    it('should throw StorageError when templates directory not found', async () => {
      // Mock environment with no TEMPLATES_DIR
      mockEnvConfig.getEnvConfig.mockReturnValue(
        {} as unknown as ReturnType<typeof mockEnvConfig.getEnvConfig>,
      );

      // Mock all possible paths as non-existent
      mockFs.existsSync.mockReturnValue(false);

      await expect(service.listTemplates()).rejects.toThrow(StorageError);
      await expect(service.listTemplates()).rejects.toThrow('Templates directory not found');
    });
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

    it('should set template metadata for bundled template', async () => {
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
        project: { id: 'p1', name: 'Test' },
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
        mappings: { promptIdMap: {}, profileIdMap: {}, agentIdMap: {}, statusIdMap: {} },
      });

      await service.createFromTemplate({
        name: 'Test Project',
        rootPath: '/test',
        slug: 'empty-project',
      });

      expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith('p1', {
        templateSlug: 'empty-project',
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

    it('should throw BadRequestException for duplicate watcher eventName', async () => {
      const templateWithWatcher = {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [
          {
            name: 'Duplicate Event Watcher',
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

      // Simulate UNIQUE constraint violation for eventName
      watchersService.createWatcher.mockRejectedValue(
        new Error('UNIQUE constraint failed: watchers.event_name'),
      );

      await expect(
        service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'duplicate-event-test',
        }),
      ).rejects.toThrow(ConflictError);

      await expect(
        service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'duplicate-event-test',
        }),
      ).rejects.toThrow('Duplicate watcher eventName');
    });
  });

  describe('importProject', () => {
    it('should return counts and missingProviders in dry run mode without DB mutations', async () => {
      const projectId = 'project-123';
      const payload = {
        prompts: [{ title: 'Prompt 1', content: 'Content' }],
        profiles: [
          {
            name: 'Profile 1',
            provider: { name: 'missing-provider' },
          },
        ],
        agents: [{ name: 'Agent 1' }],
        statuses: [{ label: 'Status 1', color: '#000', position: 0 }],
      };

      // Mock provider check - provider not found
      storage.listProviders.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      // Mock existing data
      storage.listPrompts.mockResolvedValue({
        items: [{ id: 'p1' } as unknown as never],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'pr1' } as unknown as never],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({
        items: [{ id: 'a1' } as unknown as never],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({
        items: [{ id: 's1', label: 'Status 1', color: '#000' }] as unknown as never[],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.importProject({
        projectId,
        payload,
        dryRun: true,
      });

      expect(result).toEqual({
        dryRun: true,
        missingProviders: ['missing-provider'],
        unmatchedStatuses: [],
        templateStatuses: [{ label: 'Status 1', color: '#000' }],
        counts: {
          toImport: {
            prompts: 1,
            profiles: 1,
            agents: 1,
            statuses: 1,
            watchers: 0,
            subscribers: 0,
          },
          toDelete: {
            prompts: 1,
            profiles: 1,
            agents: 1,
            statuses: 1,
            watchers: 0,
            subscribers: 0,
          },
        },
      });

      // Verify no DB mutations occurred
      expect(storage.deleteAgent).not.toHaveBeenCalled();
      expect(storage.deleteAgentProfile).not.toHaveBeenCalled();
      expect(storage.deletePrompt).not.toHaveBeenCalled();
      expect(storage.deleteStatus).not.toHaveBeenCalled();
      expect(storage.createStatus).not.toHaveBeenCalled();
      expect(storage.createPrompt).not.toHaveBeenCalled();
      expect(storage.createAgentProfile).not.toHaveBeenCalled();
      expect(storage.createAgent).not.toHaveBeenCalled();
      expect(settings.updateSettings).not.toHaveBeenCalled();
    });

    it('should return unmatchedStatuses in dry run when existing statuses have epics but no template match', async () => {
      const projectId = 'project-123';
      const payload = {
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [{ label: 'New', color: '#00f', position: 0 }],
      };

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({
        items: [
          { id: 's1', label: 'Old Status', color: '#f00' },
          { id: 's2', label: 'New', color: '#0f0' }, // This one matches template
        ] as unknown as never[],
        total: 2,
        limit: 100,
        offset: 0,
      });

      // Mock countEpicsByStatus - Old Status has 5 epics, New has 0
      storage.countEpicsByStatus.mockImplementation((statusId: string) => {
        if (statusId === 's1') return Promise.resolve(5);
        return Promise.resolve(0);
      });

      const result = await service.importProject({
        projectId,
        payload,
        dryRun: true,
      });

      expect(result).toMatchObject({
        dryRun: true,
        unmatchedStatuses: [{ id: 's1', label: 'Old Status', color: '#f00', epicCount: 5 }],
        templateStatuses: [{ label: 'New', color: '#00f' }],
      });
    });

    it('should throw StorageError with friendly message on FK constraint violation', async () => {
      const projectId = 'project-123';
      const payload = {
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
      };

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'pr1', name: 'Profile 1' }] as unknown as never[],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({
        items: [{ id: 'a1', name: 'Agent 1' }] as unknown as never[],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      sessions.listActiveSessions.mockResolvedValue([]);

      // Simulate FK constraint violation when deleting agent
      storage.deleteAgent.mockRejectedValue(new Error('FOREIGN KEY constraint failed'));

      await expect(
        service.importProject({
          projectId,
          payload,
          dryRun: false,
        }),
      ).rejects.toThrow(StorageError);

      await expect(
        service.importProject({
          projectId,
          payload,
          dryRun: false,
        }),
      ).rejects.toThrow('Cannot delete items that are still referenced');
    });

    it('should throw StorageError with friendly message on unique constraint violation', async () => {
      const projectId = 'project-123';
      const payload = {
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [{ label: 'New', color: '#00f', position: 0 }],
      };

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      sessions.listActiveSessions.mockResolvedValue([]);
      settings.updateSettings.mockResolvedValue(undefined);

      // Simulate unique constraint violation when creating status
      storage.createStatus.mockRejectedValue(new Error('UNIQUE constraint failed'));

      await expect(
        service.importProject({
          projectId,
          payload,
          dryRun: false,
        }),
      ).rejects.toThrow(StorageError);

      await expect(
        service.importProject({
          projectId,
          payload,
          dryRun: false,
        }),
      ).rejects.toThrow('Duplicate entry detected');
    });

    it('should pass all agent fields including description to createAgent', async () => {
      const projectId = 'project-123';
      const profId = '11111111-1111-1111-1111-111111111111';
      const agentId = '22222222-2222-2222-2222-222222222222';
      const provId = '33333333-3333-3333-3333-333333333333';
      const payload = {
        prompts: [],
        profiles: [
          {
            id: profId,
            name: 'Test Profile',
            provider: { id: provId, name: 'claude' },
            options: null,
            instructions: 'Test instructions',
            temperature: 0.7,
            maxTokens: 1000,
          },
        ],
        agents: [
          {
            id: agentId,
            name: 'Test Agent',
            profileId: profId,
            description: 'Agent description text',
          },
        ],
        statuses: [],
      };

      storage.listProviders.mockResolvedValue({
        items: [{ id: provId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      sessions.listActiveSessions.mockResolvedValue([]);
      settings.updateSettings.mockResolvedValue(undefined);

      storage.createAgentProfile.mockResolvedValue({ id: 'new-prof-1' });
      storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          name: 'Test Agent',
          description: 'Agent description text',
        }),
      );
    });

    it('should pass all profile fields to createAgentProfile', async () => {
      const projectId = 'project-123';
      const profId = '11111111-1111-1111-1111-111111111111';
      const provId = '33333333-3333-3333-3333-333333333333';
      const payload = {
        prompts: [],
        profiles: [
          {
            id: profId,
            name: 'Test Profile',
            provider: { id: provId, name: 'claude' },
            options: { model: 'opus' },
            instructions: 'Custom instructions',
            temperature: 0.8,
            maxTokens: 2000,
          },
        ],
        agents: [],
        statuses: [],
      };

      storage.listProviders.mockResolvedValue({
        items: [{ id: provId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      sessions.listActiveSessions.mockResolvedValue([]);
      settings.updateSettings.mockResolvedValue(undefined);

      storage.createAgentProfile.mockResolvedValue({ id: 'new-prof-1' });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.createAgentProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          name: 'Test Profile',
          providerId: provId,
          options: JSON.stringify({ model: 'opus' }),
          instructions: 'Custom instructions',
          temperature: 0.8,
          maxTokens: 2000,
        }),
      );
    });
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

      const result = await service.exportProject(projectId);

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toEqual({
        id: 'agent-1',
        name: 'Test Agent',
        profileId: 'prof-1',
        description: 'Detailed agent description',
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
            providerId: 'prov-1',
            options: '{"model":"sonnet","temperature":0.5}',
            instructions: 'Do complex tasks',
            temperature: 0.9,
            maxTokens: 4096,
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.getProvider.mockResolvedValue({ id: 'prov-1', name: 'claude' });

      const result = await service.exportProject(projectId);

      expect(result.profiles).toHaveLength(1);
      expect(result.profiles[0]).toMatchObject({
        id: 'prof-1',
        name: 'Advanced Profile',
        provider: { id: 'prov-1', name: 'claude' },
        options: '{"model":"sonnet","temperature":0.5}',
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
  });
});
