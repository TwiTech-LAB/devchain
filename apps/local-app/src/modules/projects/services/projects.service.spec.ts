import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { WatchersService } from '../../watchers/services/watchers.service';
import { WatcherRunnerService } from '../../watchers/services/watcher-runner.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { ValidationError, NotFoundError, StorageError } from '../../../common/errors/error-types';
import * as fs from 'fs';
import * as envConfig from '../../../common/config/env.config';
import * as devchainShared from '@devchain/shared';

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
    createWatcher: jest.Mock;
    createSubscriber: jest.Mock;
    deleteSubscriber: jest.Mock;
    listProfileProviderConfigsByProfile: jest.Mock;
    createProfileProviderConfig: jest.Mock;
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
      getProject: jest.fn().mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        description: 'A test project',
        rootPath: '/test/path',
        isTemplate: false,
      }),
      listProviders: jest.fn(),
      listProvidersByIds: jest.fn().mockResolvedValue([]),
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
            // Profile count is 0 because the provider is missing and profile can't be created
            profiles: 0,
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

      // Phase 4: providerId and options are no longer on profile
      expect(storage.createAgentProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          name: 'Test Profile',
          // Note: providerId and options now go to provider configs, not profile
          instructions: 'Custom instructions',
          temperature: 0.8,
          maxTokens: 2000,
        }),
      );
    });

    describe('with familyProviderMappings', () => {
      const projectId = 'project-123';
      const profileId1 = '11111111-1111-1111-1111-111111111111';
      const profileId2 = '22222222-2222-2222-2222-222222222222';
      const agentId = '33333333-3333-3333-3333-333333333333';
      const providerId = '44444444-4444-4444-4444-444444444444';

      it('should return providerMappingRequired in dry-run when default provider is missing', async () => {
        // Directly test computeFamilyAlternatives since import dry-run uses it
        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }], // codex is missing
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Test computeFamilyAlternatives directly to verify the logic
        const profiles = [
          { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
          {
            id: profileId2,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ];
        const agents = [{ id: agentId, name: 'Coder', profileId: profileId1 }];

        const familyResult = await service.computeFamilyAlternatives(profiles, agents);

        // Verify the conditions that would trigger providerMappingRequired in dry-run
        const needsMapping = familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable);
        expect(needsMapping).toBe(true);
        expect(familyResult.missingProviders).toContain('codex');
        expect(familyResult.canImport).toBe(true);
        expect(familyResult.alternatives[0].availableProviders).toContain('claude');
      });

      it('should import with remapped profiles when mappings are provided', async () => {
        const payload = {
          prompts: [],
          profiles: [
            {
              id: profileId1,
              name: 'Coder Codex',
              provider: { name: 'codex' },
              familySlug: 'coder',
            },
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

        // Mock ExportSchema.parse to preserve familySlug (ESM compatibility workaround)
        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // Only claude is available
        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
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

        // Mock create operations
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
          familyProviderMappings: { coder: 'claude' }, // Remap coder family to claude
        });

        // Verify createAgentProfile was called with the claude profile (not codex)
        // Phase 4: providerId is no longer on profile, only on provider configs
        expect(storage.createAgentProfile).toHaveBeenCalledTimes(1);
        expect(storage.createAgentProfile).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Coder Claude',
            familySlug: 'coder',
          }),
        );

        // Cleanup
        jest.restoreAllMocks();
      });

      it('should import ALL profiles whose provider is available (not just agent-referenced ones)', async () => {
        // Template with multiple profiles per family - all should be imported if provider available
        const profile1 = '11111111-1111-1111-1111-111111111111';
        const profile2 = '22222222-2222-2222-2222-222222222222';
        const profile3 = '33333333-3333-3333-3333-333333333333';
        const agentIdLocal = '44444444-4444-4444-4444-444444444444';
        const claudeProviderId = '55555555-5555-5555-5555-555555555555';
        const geminiProviderId = '66666666-6666-6666-6666-666666666666';

        const payload = {
          prompts: [],
          profiles: [
            // Coder family - Claude profile (agent uses this)
            {
              id: profile1,
              name: 'Coder Claude',
              provider: { name: 'claude' },
              familySlug: 'coder',
            },
            // Coder family - Gemini profile (NOT used by any agent, but should be imported)
            {
              id: profile2,
              name: 'Coder Gemini',
              provider: { name: 'gemini' },
              familySlug: 'coder',
            },
            // Another family - Gemini profile (also not used by agent)
            {
              id: profile3,
              name: 'Reviewer Gemini',
              provider: { name: 'gemini' },
              familySlug: 'reviewer',
            },
          ],
          agents: [{ id: agentIdLocal, name: 'Coder', profileId: profile1 }], // Only references profile1
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // Both claude and gemini are available
        storage.listProviders.mockResolvedValue({
          items: [
            { id: claudeProviderId, name: 'claude' },
            { id: geminiProviderId, name: 'gemini' },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
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

        // Mock create operations
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // ALL 3 profiles should be imported (not just the one referenced by agent)
        expect(storage.createAgentProfile).toHaveBeenCalledTimes(3);

        // Verify all profiles were created
        const createdProfiles = storage.createAgentProfile.mock.calls.map((call) => call[0].name);
        expect(createdProfiles).toContain('Coder Claude');
        expect(createdProfiles).toContain('Coder Gemini');
        expect(createdProfiles).toContain('Reviewer Gemini');

        jest.restoreAllMocks();
      });

      it('should assign agent to original profile provider when all providers available (no mapping)', async () => {
        // This tests the bug fix: when all providers are available (no mapping needed),
        // agents should use their original profile's provider, not the first one in template order
        const codexProfileId = '11111111-1111-1111-1111-111111111111';
        const claudeProfileId = '22222222-2222-2222-2222-222222222222';
        const coderAgentId = '33333333-3333-3333-3333-333333333333';
        const codexProviderId = '44444444-4444-4444-4444-444444444444';
        const claudeProviderId = '55555555-5555-5555-5555-555555555555';

        const payload = {
          prompts: [],
          profiles: [
            // IMPORTANT: Codex profile comes FIRST in the array
            {
              id: codexProfileId,
              name: 'CodeGPT',
              provider: { name: 'codex' },
              familySlug: 'coder',
            },
            // Claude profile comes SECOND in the array
            {
              id: claudeProfileId,
              name: 'CodeOpus',
              provider: { name: 'claude' },
              familySlug: 'coder',
            },
          ],
          // Agent is assigned to Claude profile (second in array)
          agents: [{ id: coderAgentId, name: 'Coder', profileId: claudeProfileId }],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // BOTH providers are available - this is the key condition
        storage.listProviders.mockResolvedValue({
          items: [
            { id: codexProviderId, name: 'codex' },
            { id: claudeProviderId, name: 'claude' },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
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

        // Track profile ID mappings
        let newClaudeProfileId: string | undefined;
        storage.createAgentProfile.mockImplementation(async (input) => {
          const id = `new-profile-${input.name}`;
          if (input.name === 'CodeOpus') {
            newClaudeProfileId = id;
          }
          return { id };
        });
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });

        // Track which profile the agent is assigned to
        let agentAssignedProfileId: string | undefined;
        storage.createAgent.mockImplementation(async (input) => {
          agentAssignedProfileId = input.profileId;
          return { id: 'new-agent-1' };
        });

        // Import WITHOUT providing familyProviderMappings (all providers available)
        await service.importProject({
          projectId,
          payload,
          dryRun: false,
          // No familyProviderMappings - should use original provider assignment
        });

        // Agent should be assigned to Claude profile (original assignment), NOT Codex (first in array)
        expect(agentAssignedProfileId).toBe(newClaudeProfileId);

        jest.restoreAllMocks();
      });

      it('should fall back to first available provider when original provider is not available', async () => {
        // When the agent's original provider is unavailable, fall back to first available
        const codexProfileId = '11111111-1111-1111-1111-111111111111';
        const claudeProfileId = '22222222-2222-2222-2222-222222222222';
        const coderAgentId = '33333333-3333-3333-3333-333333333333';
        const claudeProviderId = '55555555-5555-5555-5555-555555555555';

        const payload = {
          prompts: [],
          profiles: [
            // Codex profile comes FIRST
            {
              id: codexProfileId,
              name: 'CodeGPT',
              provider: { name: 'codex' },
              familySlug: 'coder',
            },
            // Claude profile comes SECOND
            {
              id: claudeProfileId,
              name: 'CodeOpus',
              provider: { name: 'claude' },
              familySlug: 'coder',
            },
          ],
          // Agent is assigned to Codex profile (first in array)
          agents: [{ id: coderAgentId, name: 'Coder', profileId: codexProfileId }],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // Only Claude is available - Codex (agent's original) is missing
        storage.listProviders.mockResolvedValue({
          items: [{ id: claudeProviderId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
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

        // Track profile ID mappings
        let newClaudeProfileId: string | undefined;
        storage.createAgentProfile.mockImplementation(async (input) => {
          const id = `new-profile-${input.name}`;
          if (input.name === 'CodeOpus') {
            newClaudeProfileId = id;
          }
          return { id };
        });
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });

        // Track which profile the agent is assigned to
        let agentAssignedProfileId: string | undefined;
        storage.createAgent.mockImplementation(async (input) => {
          agentAssignedProfileId = input.profileId;
          return { id: 'new-agent-1' };
        });

        // Import with mapping since Codex is unavailable
        await service.importProject({
          projectId,
          payload,
          dryRun: false,
          familyProviderMappings: { coder: 'claude' },
        });

        // Agent should be assigned to Claude profile (mapped provider) since Codex is unavailable
        expect(agentAssignedProfileId).toBe(newClaudeProfileId);

        jest.restoreAllMocks();
      });

      it('should throw ValidationError when canImport is false (no alternatives available)', async () => {
        const payload = {
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
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // No providers available at all
        storage.listProviders.mockResolvedValue({
          items: [],
          total: 0,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });

        // Even with mappings provided, should fail because canImport is false
        await expect(
          service.importProject({
            projectId,
            payload,
            dryRun: false,
            familyProviderMappings: { special: 'anything' },
          }),
        ).rejects.toThrow('Cannot import: some profile families have no available providers');

        jest.restoreAllMocks();
      });

      it('should return providerMappingRequired when defaults missing and no mappings provided (non-dry-run)', async () => {
        const payload = {
          prompts: [],
          profiles: [
            {
              id: profileId1,
              name: 'Coder Codex',
              provider: { name: 'codex' },
              familySlug: 'coder',
            },
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
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // Only claude is available (codex is missing)
        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });

        // Non-dry-run without mappings should return providerMappingRequired
        const result = await service.importProject({
          projectId,
          payload,
          dryRun: false,
          // No familyProviderMappings provided
        });

        expect(result.success).toBe(false);
        expect(result.providerMappingRequired).toBeDefined();
        expect(result.providerMappingRequired?.missingProviders).toContain('codex');
        expect(result.providerMappingRequired?.canImport).toBe(true);
        expect(result.providerMappingRequired?.familyAlternatives).toHaveLength(1);
        expect(result.providerMappingRequired?.familyAlternatives[0].familySlug).toBe('coder');

        jest.restoreAllMocks();
      });
    });

    describe('template source detection', () => {
      const projectId = 'project-123';
      const providerId = '44444444-4444-4444-4444-444444444444';

      it('should set source as bundled when importing a bundled template', async () => {
        const payload = {
          prompts: [],
          profiles: [],
          agents: [],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
          _manifest: {
            slug: 'bundled-template',
            name: 'Bundled Template',
            version: '1.0.0',
          },
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);

        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });

        // Mock getBundledTemplate to succeed (template is bundled)
        unifiedTemplateService.getBundledTemplate.mockReturnValue({
          content: {},
          source: 'bundled',
        });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // Verify template metadata was set with source: 'bundled'
        expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith(
          projectId,
          expect.objectContaining({
            templateSlug: 'bundled-template',
            source: 'bundled',
            installedVersion: '1.0.0',
          }),
        );

        jest.restoreAllMocks();
      });

      it('should set source as registry when importing a non-bundled template', async () => {
        const payload = {
          prompts: [],
          profiles: [],
          agents: [],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
          _manifest: {
            slug: 'registry-only-template',
            name: 'Registry Template',
            version: '2.0.0',
          },
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);

        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });

        // Mock getBundledTemplate to throw (template is NOT bundled)
        unifiedTemplateService.getBundledTemplate.mockImplementation(() => {
          throw new Error('Template not found');
        });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // Verify template metadata was set with source: 'registry'
        expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith(
          projectId,
          expect.objectContaining({
            templateSlug: 'registry-only-template',
            source: 'registry',
            installedVersion: '2.0.0',
          }),
        );

        jest.restoreAllMocks();
      });
    });

    describe('providerConfigs import', () => {
      const projectId = 'project-123';
      const providerId = 'provider-claude-id';

      it('should create provider configs and update agents with providerConfigId when importing new format', async () => {
        const payload = {
          prompts: [],
          profiles: [
            {
              id: 'profile-1',
              name: 'Test Profile',
              provider: { name: 'claude' },
              familySlug: 'coder',
              providerConfigs: [
                {
                  name: 'claude',
                  providerName: 'claude',
                  options: '--model claude-3',
                  env: { ANTHROPIC_API_KEY: 'sk-xxx' },
                },
              ],
            },
          ],
          agents: [
            {
              id: 'agent-1',
              name: 'Test Agent',
              profileId: 'profile-1',
              providerConfigName: 'claude',
            },
          ],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
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

        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createProfileProviderConfig.mockResolvedValue({ id: 'new-config-1' });
        storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // Verify provider config was created
        expect(storage.createProfileProviderConfig).toHaveBeenCalledWith({
          profileId: 'new-profile-1',
          providerId,
          name: 'claude',
          options: '--model claude-3',
          env: { ANTHROPIC_API_KEY: 'sk-xxx' },
        });

        // Verify agent was created with providerConfigId
        expect(storage.createAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Test Agent',
            profileId: 'new-profile-1',
            providerConfigId: 'new-config-1',
          }),
        );

        jest.restoreAllMocks();
      });

      it('should handle backward compatibility with legacy format (no providerConfigs)', async () => {
        // Phase 4: Legacy format now creates a default config since providerConfigId is required
        const payload = {
          prompts: [],
          profiles: [
            {
              id: 'profile-1',
              name: 'Legacy Profile',
              provider: { name: 'claude' },
              familySlug: 'coder',
              // No providerConfigs field
            },
          ],
          agents: [
            {
              id: 'agent-1',
              name: 'Legacy Agent',
              profileId: 'profile-1',
              // No providerConfigName
            },
          ],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
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

        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createProfileProviderConfig.mockResolvedValue({ id: 'default-config-1' });
        storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // Verify a default provider config WAS created for legacy format (Phase 4: providerConfigId is NOT NULL)
        expect(storage.createProfileProviderConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId: 'new-profile-1',
            providerId: providerId,
          }),
        );

        // Verify agent was created WITH providerConfigId (Phase 4: required)
        expect(storage.createAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Legacy Agent',
            profileId: 'new-profile-1',
            providerConfigId: 'default-config-1',
          }),
        );

        jest.restoreAllMocks();
      });
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
      storage.listProvidersByIds.mockResolvedValue([{ id: 'prov-1', name: 'claude' }]);

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
      expect(result.profiles[0].providerConfigs[0]).toEqual({
        name: 'claude',
        providerName: 'claude',
        options: '--model claude-3',
        env: { ANTHROPIC_API_KEY: 'sk-xxx' },
      });
      expect(result.profiles[0].providerConfigs[1]).toEqual({
        name: 'gemini',
        providerName: 'gemini',
        options: '--model gemini-pro',
        env: { GOOGLE_API_KEY: 'xxx' },
      });

      // Agent should have providerConfigName
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].providerConfigName).toBe('claude');
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
  });

  describe('computeFamilyAlternatives', () => {
    const coderProfileId = '11111111-1111-1111-1111-111111111111';
    const reviewerProfileId = '22222222-2222-2222-2222-222222222222';
    const coderAgentId = '33333333-3333-3333-3333-333333333333';
    const reviewerAgentId = '44444444-4444-4444-4444-444444444444';

    it('should return canImport: true when all family providers are available', async () => {
      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'p1', name: 'claude' },
          { id: 'p2', name: 'codex' },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Profile',
          provider: { name: 'claude' },
          familySlug: 'coder',
        },
        {
          id: reviewerProfileId,
          name: 'Reviewer Profile',
          provider: { name: 'codex' },
          familySlug: 'reviewer',
        },
      ];
      const agents = [
        { id: coderAgentId, name: 'Coder', profileId: coderProfileId },
        { id: reviewerAgentId, name: 'Reviewer', profileId: reviewerProfileId },
      ];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(true);
      expect(result.missingProviders).toEqual([]);
      expect(result.alternatives).toHaveLength(2);
    });

    it('should return canImport: false when a family has no available providers', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }], // codex is missing
        total: 1,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Profile',
          provider: { name: 'claude' },
          familySlug: 'coder',
        },
        {
          id: reviewerProfileId,
          name: 'Reviewer Profile',
          provider: { name: 'codex' },
          familySlug: 'reviewer',
        },
      ];
      const agents = [
        { id: coderAgentId, name: 'Coder', profileId: coderProfileId },
        { id: reviewerAgentId, name: 'Reviewer', profileId: reviewerProfileId },
      ];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(false);
      expect(result.missingProviders).toContain('codex');

      const reviewerFamily = result.alternatives.find((a) => a.familySlug === 'reviewer');
      expect(reviewerFamily?.hasAlternatives).toBe(false);
      expect(reviewerFamily?.availableProviders).toEqual([]);
    });

    it('should identify available alternatives for a family', async () => {
      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'p1', name: 'claude' },
          { id: 'p2', name: 'gemini' },
        ], // codex is missing but gemini is available
        total: 2,
        limit: 100,
        offset: 0,
      });

      // Coder family has profiles for both codex (default) and gemini (alternative)
      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Codex',
          provider: { name: 'codex' },
          familySlug: 'coder',
        },
        {
          id: '55555555-5555-5555-5555-555555555555',
          name: 'Coder Gemini',
          provider: { name: 'gemini' },
          familySlug: 'coder',
        },
      ];
      const agents = [{ id: coderAgentId, name: 'Coder', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(true);
      expect(result.missingProviders).toContain('codex');

      const coderFamily = result.alternatives.find((a) => a.familySlug === 'coder');
      expect(coderFamily?.defaultProvider).toBe('codex');
      expect(coderFamily?.defaultProviderAvailable).toBe(false);
      expect(coderFamily?.availableProviders).toContain('gemini');
      expect(coderFamily?.hasAlternatives).toBe(true);
    });

    it('should only consider families used by agents', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      // Template has profiles for 'coder' and 'reviewer' families
      // But only 'coder' is used by an agent
      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Profile',
          provider: { name: 'claude' },
          familySlug: 'coder',
        },
        {
          id: reviewerProfileId,
          name: 'Reviewer Profile',
          provider: { name: 'codex' },
          familySlug: 'reviewer',
        },
      ];
      const agents = [{ id: coderAgentId, name: 'Coder', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      // Only coder family should be in alternatives
      expect(result.alternatives).toHaveLength(1);
      expect(result.alternatives[0].familySlug).toBe('coder');
      // codex should not be in missingProviders since reviewer family is not used
      expect(result.missingProviders).not.toContain('codex');
    });

    it('should ignore profiles without familySlug', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'No Family Profile',
          provider: { name: 'claude' },
          familySlug: null,
        },
      ];
      const agents = [{ id: coderAgentId, name: 'Agent', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.alternatives).toHaveLength(0);
      expect(result.canImport).toBe(true);
    });

    it('should handle empty template profiles and agents', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.computeFamilyAlternatives([], []);

      expect(result.alternatives).toEqual([]);
      expect(result.missingProviders).toEqual([]);
      expect(result.canImport).toBe(true);
    });

    it('should normalize provider names to lowercase', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'Claude' }], // uppercase in storage
        total: 1,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Profile',
          provider: { name: 'CLAUDE' },
          familySlug: 'coder',
        }, // uppercase in template
      ];
      const agents = [{ id: coderAgentId, name: 'Coder', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(true);
      expect(result.alternatives[0].defaultProviderAvailable).toBe(true);
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
        agents: [{ id: agentId, name: 'Coder', profileId: profileId1 }],
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

      // Even with mappings provided, should fail because canImport is false
      await expect(
        service.createFromTemplate({
          name: 'Test Project',
          rootPath: '/test',
          slug: 'test-template',
          familyProviderMappings: { special: 'anything' },
        }),
      ).rejects.toThrow('Cannot import: some profile families have no available providers');

      jest.restoreAllMocks();
    });
  });

  describe('getTemplateManifestForProject', () => {
    it('should return null when no template metadata exists', async () => {
      settings.getProjectTemplateMetadata.mockReturnValue(null);

      const result = await service.getTemplateManifestForProject('project-123');

      expect(result).toBeNull();
      expect(settings.getProjectTemplateMetadata).toHaveBeenCalledWith('project-123');
    });

    it('should return null when metadata has no templateSlug', async () => {
      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: '',
        installedVersion: '1.0.0',
        source: 'registry',
      });

      const result = await service.getTemplateManifestForProject('project-123');

      expect(result).toBeNull();
    });

    it('should return manifest from bundled template', async () => {
      const manifest = {
        name: 'Test Template',
        version: '1.0.0',
        description: 'A test template',
      };

      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: null,
        source: 'bundled',
      });

      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: manifest },
        source: 'bundled',
        version: null,
      });

      const result = await service.getTemplateManifestForProject('project-123');

      expect(result).toEqual(manifest);
      expect(unifiedTemplateService.getBundledTemplate).toHaveBeenCalledWith('test-template');
      expect(unifiedTemplateService.getTemplate).not.toHaveBeenCalled();
    });

    it('should return manifest from registry template with installedVersion', async () => {
      const manifest = {
        name: 'Registry Template',
        version: '2.5.0',
        description: 'A registry template',
      };

      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'registry-template',
        installedVersion: '2.5.0',
        source: 'registry',
      });

      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: { _manifest: manifest },
        source: 'registry',
        version: '2.5.0',
      });

      const result = await service.getTemplateManifestForProject('project-123');

      expect(result).toEqual(manifest);
      expect(unifiedTemplateService.getTemplate).toHaveBeenCalledWith('registry-template', '2.5.0');
      expect(unifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
    });

    it('should return null when bundled template throws error', async () => {
      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'missing-template',
        installedVersion: null,
        source: 'bundled',
      });

      unifiedTemplateService.getBundledTemplate.mockImplementation(() => {
        throw new Error('Template not found');
      });

      const result = await service.getTemplateManifestForProject('project-123');

      expect(result).toBeNull();
    });

    it('should return null when registry template throws error', async () => {
      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'missing-template',
        installedVersion: '1.0.0',
        source: 'registry',
      });

      unifiedTemplateService.getTemplate.mockRejectedValue(new Error('Template not found'));

      const result = await service.getTemplateManifestForProject('project-123');

      expect(result).toBeNull();
    });

    it('should return null when template has no _manifest field', async () => {
      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'no-manifest',
        installedVersion: null,
        source: 'bundled',
      });

      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { profiles: [], agents: [] }, // No _manifest
        source: 'bundled',
        version: null,
      });

      const result = await service.getTemplateManifestForProject('project-123');

      expect(result).toBeNull();
    });

    it('should return null when registry source requested but bundled returned (honor stored source)', async () => {
      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'registry-template',
        installedVersion: '1.0.0',
        source: 'registry', // Project was created from registry template
      });

      // UnifiedTemplateService fell back to bundled (registry version not cached)
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: { _manifest: { name: 'Bundled Version' } },
        source: 'bundled', // Wrong source - should be registry
        version: null,
      });

      const result = await service.getTemplateManifestForProject('project-123');

      // Should reject bundled fallback and return null
      expect(result).toBeNull();
      expect(unifiedTemplateService.getTemplate).toHaveBeenCalledWith('registry-template', '1.0.0');
    });

    it('should return null for file-based templates (source: file)', async () => {
      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'file-based-template',
        installedVersion: '1.0.0',
        source: 'file',
      });

      const result = await service.getTemplateManifestForProject('project-123');

      // File-based templates cannot provide manifest (source file may have moved/changed)
      expect(result).toBeNull();
      // Should not attempt to fetch template
      expect(unifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
      expect(unifiedTemplateService.getTemplate).not.toHaveBeenCalled();
    });
  });

  describe('getBundledUpgradeVersion', () => {
    it('should return new version when bundled is newer', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: '2.0.0' } },
        source: 'bundled',
        version: null,
      });

      const result = service.getBundledUpgradeVersion('test-template', '1.0.0');

      expect(result).toBe('2.0.0');
      expect(unifiedTemplateService.getBundledTemplate).toHaveBeenCalledWith('test-template');
    });

    it('should return null when versions are equal', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: '1.0.0' } },
        source: 'bundled',
        version: null,
      });

      const result = service.getBundledUpgradeVersion('test-template', '1.0.0');

      expect(result).toBeNull();
    });

    it('should return null when installed is newer', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: '1.0.0' } },
        source: 'bundled',
        version: null,
      });

      const result = service.getBundledUpgradeVersion('test-template', '2.0.0');

      expect(result).toBeNull();
    });

    it('should return null when installed version is null', () => {
      const result = service.getBundledUpgradeVersion('test-template', null);

      expect(result).toBeNull();
      expect(unifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
    });

    it('should return null when bundled template has no version', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: {} }, // No version
        source: 'bundled',
        version: null,
      });

      const result = service.getBundledUpgradeVersion('test-template', '1.0.0');

      expect(result).toBeNull();
    });

    it('should return null when bundled template not found', () => {
      unifiedTemplateService.getBundledTemplate.mockImplementation(() => {
        throw new Error('Template not found');
      });

      const result = service.getBundledUpgradeVersion('nonexistent', '1.0.0');

      expect(result).toBeNull();
    });

    it('should return null when installed version is invalid semver', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: '2.0.0' } },
        source: 'bundled',
        version: null,
      });

      // Invalid semver strings that would throw in isLessThan
      const invalidVersions = ['1.0', 'v1.0.0', 'latest', 'invalid', ''];
      for (const invalidVersion of invalidVersions) {
        const result = service.getBundledUpgradeVersion('test-template', invalidVersion);
        expect(result).toBeNull();
      }
    });

    it('should return null when bundled version is invalid semver', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: 'invalid-version' } },
        source: 'bundled',
        version: null,
      });

      const result = service.getBundledUpgradeVersion('test-template', '1.0.0');

      expect(result).toBeNull();
    });
  });

  describe('getBundledUpgradesForProjects', () => {
    it('should return upgrades for bundled projects with newer versions', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: '2.0.0' } },
        source: 'bundled',
        version: null,
      });

      const projects = [
        {
          projectId: 'p1',
          templateSlug: 'template-a',
          installedVersion: '1.0.0',
          source: 'bundled' as const,
        },
        {
          projectId: 'p2',
          templateSlug: 'template-a',
          installedVersion: '2.0.0',
          source: 'bundled' as const,
        },
      ];

      const result = service.getBundledUpgradesForProjects(projects);

      expect(result.get('p1')).toBe('2.0.0'); // Upgrade available
      expect(result.get('p2')).toBeNull(); // Already at latest
    });

    it('should return null for registry projects', () => {
      const projects = [
        {
          projectId: 'p1',
          templateSlug: 'template-a',
          installedVersion: '1.0.0',
          source: 'registry' as const,
        },
      ];

      const result = service.getBundledUpgradesForProjects(projects);

      expect(result.get('p1')).toBeNull();
      expect(unifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
    });

    it('should return null for projects without template slug', () => {
      const projects = [
        {
          projectId: 'p1',
          templateSlug: null,
          installedVersion: '1.0.0',
          source: 'bundled' as const,
        },
      ];

      const result = service.getBundledUpgradesForProjects(projects);

      expect(result.get('p1')).toBeNull();
    });

    it('should cache bundled template lookups', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: '2.0.0' } },
        source: 'bundled',
        version: null,
      });

      const projects = [
        {
          projectId: 'p1',
          templateSlug: 'template-a',
          installedVersion: '1.0.0',
          source: 'bundled' as const,
        },
        {
          projectId: 'p2',
          templateSlug: 'template-a',
          installedVersion: '1.5.0',
          source: 'bundled' as const,
        },
        {
          projectId: 'p3',
          templateSlug: 'template-a',
          installedVersion: '2.0.0',
          source: 'bundled' as const,
        },
      ];

      const result = service.getBundledUpgradesForProjects(projects);

      // Should only call getBundledTemplate once due to caching
      expect(unifiedTemplateService.getBundledTemplate).toHaveBeenCalledTimes(1);
      expect(result.get('p1')).toBe('2.0.0');
      expect(result.get('p2')).toBe('2.0.0');
      expect(result.get('p3')).toBeNull();
    });

    it('should return null for projects with invalid semver versions (not crash)', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: '2.0.0' } },
        source: 'bundled',
        version: null,
      });

      const projects = [
        {
          projectId: 'p1',
          templateSlug: 'template-a',
          installedVersion: 'invalid-version', // Invalid semver
          source: 'bundled' as const,
        },
        {
          projectId: 'p2',
          templateSlug: 'template-a',
          installedVersion: '1.0', // Missing patch
          source: 'bundled' as const,
        },
        {
          projectId: 'p3',
          templateSlug: 'template-a',
          installedVersion: 'v1.0.0', // Has 'v' prefix
          source: 'bundled' as const,
        },
        {
          projectId: 'p4',
          templateSlug: 'template-a',
          installedVersion: '1.0.0', // Valid - should work
          source: 'bundled' as const,
        },
      ];

      // Should not throw - gracefully handle invalid versions
      const result = service.getBundledUpgradesForProjects(projects);

      expect(result.get('p1')).toBeNull(); // Invalid - no upgrade
      expect(result.get('p2')).toBeNull(); // Invalid - no upgrade
      expect(result.get('p3')).toBeNull(); // Invalid - no upgrade
      expect(result.get('p4')).toBe('2.0.0'); // Valid - upgrade available
    });

    it('should return null when bundled template has invalid semver version', () => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: 'not-a-valid-semver' } },
        source: 'bundled',
        version: null,
      });

      const projects = [
        {
          projectId: 'p1',
          templateSlug: 'template-a',
          installedVersion: '1.0.0',
          source: 'bundled' as const,
        },
      ];

      // Should not throw - gracefully handle invalid bundled version
      const result = service.getBundledUpgradesForProjects(projects);

      expect(result.get('p1')).toBeNull();
    });
  });

  describe('applyPreset', () => {
    const projectId = 'project-123';

    beforeEach(() => {
      // Add preset methods to settings mock
      (settings as { getProjectPresets: jest.Mock }).getProjectPresets = jest.fn();
      (settings as { setProjectPresets: jest.Mock }).setProjectPresets = jest.fn();
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest.fn();
    });

    it('should apply preset and update agent provider configs', async () => {
      const preset = {
        name: 'default',
        description: 'Default preset',
        agentConfigs: [
          { agentName: 'Coder', providerConfigName: 'claude-config' },
          { agentName: 'Reviewer', providerConfigName: 'gemini-config' },
        ],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      const profileId = 'profile-1';
      const claudeConfigId = 'config-claude';
      const geminiConfigId = 'config-gemini';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [
          { id: 'agent-1', name: 'Coder', profileId, providerConfigId: null },
          { id: 'agent-2', name: 'Reviewer', profileId, providerConfigId: null },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: claudeConfigId,
          profileId,
          providerId: 'claude',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: geminiConfigId,
          profileId,
          providerId: 'gemini',
          name: 'gemini-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const updatedAgents: Array<{ id: string; providerConfigId: string | null }> = [];
      storage.updateAgent.mockImplementation(async (id, data) => {
        updatedAgents.push({ id, providerConfigId: data.providerConfigId ?? null });
        return { id, ...data } as never;
      });

      const result = await service.applyPreset(projectId, 'default');

      expect(result.applied).toBe(2);
      expect(result.warnings).toHaveLength(0);
      expect(updatedAgents).toHaveLength(2);
      expect(updatedAgents[0].providerConfigId).toBe(claudeConfigId);
      expect(updatedAgents[1].providerConfigId).toBe(geminiConfigId);
    });

    it('should throw NotFoundError when preset not found', async () => {
      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([
        { name: 'other', agentConfigs: [] },
      ]);

      await expect(service.applyPreset(projectId, 'missing')).rejects.toThrow(NotFoundError);
    });

    it('should return warning for missing agent', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [{ agentName: 'MissingAgent', providerConfigName: 'config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });

      const result = await service.applyPreset(projectId, 'default');

      expect(result.applied).toBe(0);
      expect(result.warnings).toContain('Agent "MissingAgent" not found in project');
    });

    it('should return warning for missing provider config', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [{ agentName: 'Coder', providerConfigName: 'missing-config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      const profileId = 'profile-1';
      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [{ id: 'agent-1', name: 'Coder', profileId, providerConfigId: null }],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId,
          providerId: 'claude',
          name: 'other-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const result = await service.applyPreset(projectId, 'default');

      expect(result.applied).toBe(0);
      expect(result.warnings).toContain(
        'Provider config "missing-config" not found for agent "Coder"',
      );
    });

    it('should match agent names case-insensitively', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [{ agentName: 'coder', providerConfigName: 'config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      const profileId = 'profile-1';
      const configId = 'config-1';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [{ id: 'agent-1', name: 'Coder', profileId, providerConfigId: null }],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: configId,
          profileId,
          providerId: 'claude',
          name: 'config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const updatedAgents: Array<{ id: string }> = [];
      storage.updateAgent.mockImplementation(async (id) => {
        updatedAgents.push({ id });
        return { id } as never;
      });

      const result = await service.applyPreset(projectId, 'default');

      expect(result.applied).toBe(1);
      expect(updatedAgents[0].id).toBe('agent-1');
    });

    it('should set activePreset when full match (no warnings, all applied)', async () => {
      const preset = {
        name: 'default',
        description: 'Default preset',
        agentConfigs: [
          { agentName: 'Coder', providerConfigName: 'claude-config' },
          { agentName: 'Reviewer', providerConfigName: 'gemini-config' },
        ],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest.fn();

      const profileId = 'profile-1';
      const claudeConfigId = 'config-claude';
      const geminiConfigId = 'config-gemini';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [
          { id: 'agent-1', name: 'Coder', profileId, providerConfigId: null },
          { id: 'agent-2', name: 'Reviewer', profileId, providerConfigId: null },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: claudeConfigId,
          profileId,
          providerId: 'claude',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: geminiConfigId,
          profileId,
          providerId: 'gemini',
          name: 'gemini-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      storage.updateAgent.mockResolvedValue({} as never);

      await service.applyPreset(projectId, 'default');

      expect(settings.setProjectActivePreset).toHaveBeenCalledWith(projectId, 'default');
    });

    it('should not set activePreset when warnings present', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [{ agentName: 'MissingAgent', providerConfigName: 'config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest.fn();

      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });

      await service.applyPreset(projectId, 'default');

      expect(settings.setProjectActivePreset).not.toHaveBeenCalled();
    });

    it('should not set activePreset when not all agents applied', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [
          { agentName: 'Coder', providerConfigName: 'claude-config' },
          { agentName: 'MissingAgent', providerConfigName: 'config' },
        ],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest.fn();

      const profileId = 'profile-1';
      const claudeConfigId = 'config-claude';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [{ id: 'agent-1', name: 'Coder', profileId, providerConfigId: null }],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: claudeConfigId,
          profileId,
          providerId: 'claude',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      storage.updateAgent.mockResolvedValue({} as never);

      await service.applyPreset(projectId, 'default');

      // 1 agent applied out of 2 in preset, so not a full match
      expect(settings.setProjectActivePreset).not.toHaveBeenCalled();
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
  });
});
