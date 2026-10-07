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
import { StorageError } from '../../../common/errors/error-types';
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

import { createMockProject } from '../../../../test/factories';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

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
    updateProvider: jest.Mock;
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
        { provide: ProjectWriteAdmissionService, useValue: createProjectWriteAdmissionStub() },
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

  describe('getTemplateManifestForProject', () => {
    it.each([
      {
        label: 'no metadata',
        metadata: null,
        bundled: null,
        registry: null,
        bundledError: false,
        registryError: false,
      },
      {
        label: 'no slug',
        metadata: { templateSlug: '', installedVersion: '1.0.0', source: 'registry' },
        bundled: null,
        registry: null,
        bundledError: false,
        registryError: false,
      },
      {
        label: 'bundled error',
        metadata: { templateSlug: 'missing-template', installedVersion: null, source: 'bundled' },
        bundled: null,
        registry: null,
        bundledError: true,
        registryError: false,
      },
      {
        label: 'registry error',
        metadata: {
          templateSlug: 'missing-template',
          installedVersion: '1.0.0',
          source: 'registry',
        },
        bundled: null,
        registry: null,
        bundledError: false,
        registryError: true,
      },
      {
        label: 'no manifest',
        metadata: { templateSlug: 'no-manifest', installedVersion: null, source: 'bundled' },
        bundled: { content: { profiles: [], agents: [] }, source: 'bundled', version: null },
        registry: null,
        bundledError: false,
        registryError: false,
      },
      {
        label: 'registry falls back to bundled',
        metadata: {
          templateSlug: 'registry-template',
          installedVersion: '1.0.0',
          source: 'registry',
        },
        bundled: null,
        registry: {
          content: { _manifest: { name: 'Bundled Version' } },
          source: 'bundled',
          version: null,
        },
        bundledError: false,
        registryError: false,
      },
      {
        label: 'file source',
        metadata: {
          templateSlug: 'file-based-template',
          installedVersion: '1.0.0',
          source: 'file',
        },
        bundled: null,
        registry: null,
        bundledError: false,
        registryError: false,
      },
    ])(
      'returns null manifest for $label',
      async ({ metadata, bundled, registry, bundledError, registryError }) => {
        settings.getProjectTemplateMetadata.mockReturnValue(metadata);
        if (bundledError) {
          unifiedTemplateService.getBundledTemplate.mockImplementation(() => {
            throw new Error('Template not found');
          });
        } else {
          unifiedTemplateService.getBundledTemplate.mockReturnValue(bundled);
        }
        if (registryError) {
          unifiedTemplateService.getTemplate.mockRejectedValue(new Error('Template not found'));
        } else {
          unifiedTemplateService.getTemplate.mockResolvedValue(registry);
        }
        expect(await service.getTemplateManifestForProject('project-123')).toBeNull();
        expect(settings.getProjectTemplateMetadata).toHaveBeenCalledWith('project-123');
        if (metadata?.source === 'registry' && metadata.templateSlug) {
          expect(unifiedTemplateService.getTemplate).toHaveBeenCalledWith(
            metadata.templateSlug,
            metadata.installedVersion,
          );
        }
        if (metadata?.source === 'file') {
          expect(unifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
          expect(unifiedTemplateService.getTemplate).not.toHaveBeenCalled();
        }
      },
    );

    it.each([
      {
        source: 'bundled',
        slug: 'test-template',
        version: null,
        manifest: { name: 'Test Template', version: '1.0.0', description: 'A test template' },
      },
      {
        source: 'registry',
        slug: 'registry-template',
        version: '2.5.0',
        manifest: {
          name: 'Registry Template',
          version: '2.5.0',
          description: 'A registry template',
        },
      },
    ])('resolves $source manifest', async ({ source, slug, version, manifest }) => {
      settings.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: slug,
        installedVersion: version,
        source,
      });
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: manifest },
        source,
        version,
      });
      unifiedTemplateService.getTemplate.mockResolvedValue({
        content: { _manifest: manifest },
        source,
        version,
      });
      expect(await service.getTemplateManifestForProject('project-123')).toEqual(manifest);
      if (source === 'bundled') {
        expect(unifiedTemplateService.getBundledTemplate).toHaveBeenCalledWith(slug);
        expect(unifiedTemplateService.getTemplate).not.toHaveBeenCalled();
      } else {
        expect(unifiedTemplateService.getTemplate).toHaveBeenCalledWith(slug, version);
        expect(unifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
      }
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

    it.each([
      {
        scenario: 'versions are equal',
        installedVersions: ['1.0.0'],
        bundledVersion: '1.0.0',
        missingTemplate: false,
      },
      {
        scenario: 'installed is newer',
        installedVersions: ['2.0.0'],
        bundledVersion: '1.0.0',
        missingTemplate: false,
      },
      {
        scenario: 'installed version is null',
        installedVersions: [null],
        bundledVersion: '2.0.0',
        missingTemplate: false,
      },
      {
        scenario: 'bundled template has no version',
        installedVersions: ['1.0.0'],
        bundledVersion: null,
        missingTemplate: false,
      },
      {
        scenario: 'bundled template is not found',
        installedVersions: ['1.0.0'],
        bundledVersion: '2.0.0',
        missingTemplate: true,
      },
      {
        scenario: 'installed version is invalid semver',
        installedVersions: ['1.0', 'v1.0.0', 'latest', 'invalid', ''],
        bundledVersion: '2.0.0',
        missingTemplate: false,
      },
      {
        scenario: 'bundled version is invalid semver',
        installedVersions: ['1.0.0'],
        bundledVersion: 'invalid-version',
        missingTemplate: false,
      },
    ])('returns null when $scenario', ({ installedVersions, bundledVersion, missingTemplate }) => {
      if (missingTemplate) {
        unifiedTemplateService.getBundledTemplate.mockImplementation(() => {
          throw new Error('Template not found');
        });
      } else {
        unifiedTemplateService.getBundledTemplate.mockReturnValue({
          content: { _manifest: bundledVersion ? { version: bundledVersion } : {} },
          source: 'bundled',
          version: null,
        });
      }
      for (const installedVersion of installedVersions) {
        expect(service.getBundledUpgradeVersion('test-template', installedVersion)).toBeNull();
      }
      if (installedVersions[0] === null) {
        expect(unifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
      }
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

    it.each([
      {
        label: 'registry source',
        projects: [
          {
            projectId: 'p1',
            templateSlug: 'template-a',
            installedVersion: '1.0.0',
            source: 'registry' as const,
          },
        ],
        bundledVersion: '2.0.0',
        expected: [['p1', null]],
      },
      {
        label: 'no slug',
        projects: [
          {
            projectId: 'p1',
            templateSlug: null,
            installedVersion: '1.0.0',
            source: 'bundled' as const,
          },
        ],
        bundledVersion: '2.0.0',
        expected: [['p1', null]],
      },
      {
        label: 'invalid installed versions',
        projects: [
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
        ],
        bundledVersion: '2.0.0',
        expected: [
          ['p1', null],
          ['p2', null],
          ['p3', null],
          ['p4', '2.0.0'],
        ],
      },
      {
        label: 'invalid bundled version',
        projects: [
          {
            projectId: 'p1',
            templateSlug: 'template-a',
            installedVersion: '1.0.0',
            source: 'bundled' as const,
          },
        ],
        bundledVersion: 'not-a-valid-semver',
        expected: [['p1', null]],
      },
    ])('handles bundled-upgrade $label', ({ projects, bundledVersion, expected }) => {
      unifiedTemplateService.getBundledTemplate.mockReturnValue({
        content: { _manifest: { version: bundledVersion } },
        source: 'bundled',
        version: null,
      });
      const result = service.getBundledUpgradesForProjects(projects);
      expect([...result]).toEqual(expected);
      if (projects[0].source === 'registry') {
        expect(unifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
      }
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
  });
});
