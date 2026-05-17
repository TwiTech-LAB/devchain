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
});
