import { BadRequestException } from '@nestjs/common';
import { RegistryOrchestrationService } from './registry-orchestration.service';
import { RegistryClientService } from './registry-client.service';
import { TemplateCacheService } from './template-cache.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StorageService } from '../../storage/interfaces/storage.interface';
import { ProjectsService } from '../../projects/services/projects.service';

const createMockImportResult = (
  counts = { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => ({
  dryRun: false,
  missingProviders: [],
  unmatchedStatuses: [],
  templateStatuses: [],
  counts: { toImport: {}, toDelete: {} },
  imported: counts,
});

const createMockTemplateDetail = (
  slug: string,
  versions: Array<{ version: string; isLatest: boolean }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any => ({
  template: {
    slug,
    name: 'Test Template',
    description: 'Test',
    authorName: null,
    license: null,
    category: null,
    tags: [],
    requiredProviders: [],
    isOfficial: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  versions: versions.map((v) => ({
    ...v,
    minDevchainVersion: null,
    changelog: null,
    publishedAt: new Date().toISOString(),
    downloadCount: 0,
  })),
});

describe('RegistryOrchestrationService', () => {
  let service: RegistryOrchestrationService;
  let mockRegistryClient: jest.Mocked<RegistryClientService>;
  let mockCacheService: jest.Mocked<TemplateCacheService>;
  let mockSettingsService: jest.Mocked<SettingsService>;
  let mockStorage: jest.Mocked<StorageService>;
  let mockProjectsService: jest.Mocked<ProjectsService>;

  beforeEach(() => {
    mockRegistryClient = {
      downloadTemplate: jest.fn(),
      getTemplate: jest.fn(),
    } as unknown as jest.Mocked<RegistryClientService>;

    mockCacheService = {
      isCached: jest.fn(),
      saveTemplate: jest.fn(),
      getTemplate: jest.fn(),
    } as unknown as jest.Mocked<TemplateCacheService>;

    mockSettingsService = {
      getProjectTemplateMetadata: jest.fn(),
      setProjectTemplateMetadata: jest.fn(),
      clearProjectTemplateMetadata: jest.fn(),
      getRegistryConfig: jest.fn().mockReturnValue({
        url: 'https://test.registry.com',
      }),
      updateLastUpdateCheck: jest.fn(),
      setProjectPresets: jest.fn(),
      getProjectPresets: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<SettingsService>;

    mockStorage = {
      createProject: jest.fn(),
      getProject: jest.fn(),
    } as unknown as jest.Mocked<StorageService>;

    mockProjectsService = {
      importProject: jest.fn(),
    } as unknown as jest.Mocked<ProjectsService>;

    service = new RegistryOrchestrationService(
      mockRegistryClient,
      mockCacheService,
      mockSettingsService,
      mockStorage,
      mockProjectsService,
    );
  });

  describe('downloadToCache', () => {
    it('should skip download if already cached', async () => {
      mockCacheService.isCached.mockReturnValue(true);

      await service.downloadToCache('test-template', '1.0.0');

      expect(mockRegistryClient.downloadTemplate).not.toHaveBeenCalled();
    });

    it('should download and cache if not cached', async () => {
      mockCacheService.isCached.mockReturnValue(false);
      mockRegistryClient.downloadTemplate.mockResolvedValue({
        content: { prompts: [] },
        checksum: 'abc123',
        slug: 'test-template',
        version: '1.0.0',
      });

      await service.downloadToCache('test-template', '1.0.0');

      expect(mockRegistryClient.downloadTemplate).toHaveBeenCalledWith('test-template', '1.0.0');
      expect(mockCacheService.saveTemplate).toHaveBeenCalled();
    });
  });

  describe('createProjectFromRegistry', () => {
    it('should download, cache, and create project', async () => {
      mockCacheService.isCached.mockReturnValue(false);
      mockRegistryClient.downloadTemplate.mockResolvedValue({
        content: { prompts: [], profiles: [], agents: [], statuses: [] },
        checksum: 'abc123',
        slug: 'test-template',
        version: '1.0.0',
      });
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [], profiles: [], agents: [], statuses: [] },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockProjectsService.importProject.mockResolvedValue(
        createMockImportResult({ prompts: 2, profiles: 1, agents: 3, statuses: 4 }),
      );

      const result = await service.createProjectFromRegistry({
        slug: 'test-template',
        version: '1.0.0',
        projectName: 'Test Project',
        rootPath: '/test/path',
      });

      expect(result.project.id).toBe('project-123');
      expect(result.fromRegistry).toBe(true);
      expect(result.templateSlug).toBe('test-template');
      expect(result.templateVersion).toBe('1.0.0');
    });

    it('should track registry metadata', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      await service.createProjectFromRegistry({
        slug: 'test-template',
        version: '1.0.0',
        projectName: 'Test Project',
        rootPath: '/test/path',
      });

      expect(mockSettingsService.setProjectTemplateMetadata).toHaveBeenCalledWith(
        'project-123',
        expect.objectContaining({
          templateSlug: 'test-template',
          installedVersion: '1.0.0',
        }),
      );
    });

    it('should skip download if cached', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      await service.createProjectFromRegistry({
        slug: 'test-template',
        version: '1.0.0',
        projectName: 'Test Project',
        rootPath: '/test/path',
      });

      expect(mockRegistryClient.downloadTemplate).not.toHaveBeenCalled();
    });

    it('should throw if template not found in cache after download', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue(null);

      await expect(
        service.createProjectFromRegistry({
          slug: 'test-template',
          version: '1.0.0',
          projectName: 'Test Project',
          rootPath: '/test/path',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if template format is invalid', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        content: null as any, // Invalid content - force null to test validation
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });

      await expect(
        service.createProjectFromRegistry({
          slug: 'test-template',
          version: '1.0.0',
          projectName: 'Test Project',
          rootPath: '/test/path',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should re-throw BadRequestException with missingProviders', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const missingProvidersError = new BadRequestException({
        message: 'Missing providers',
        missingProviders: ['openai'],
      });
      mockProjectsService.importProject.mockRejectedValue(missingProvidersError);

      await expect(
        service.createProjectFromRegistry({
          slug: 'test-template',
          version: '1.0.0',
          projectName: 'Test Project',
          rootPath: '/test/path',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should continue if import fails without missingProviders', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Non-provider error - should be swallowed
      mockProjectsService.importProject.mockRejectedValue(new Error('Generic import error'));

      const result = await service.createProjectFromRegistry({
        slug: 'test-template',
        version: '1.0.0',
        projectName: 'Test Project',
        rootPath: '/test/path',
      });

      // Project should still be created even if import failed
      expect(result.project.id).toBe('project-123');
      expect(mockSettingsService.setProjectTemplateMetadata).toHaveBeenCalled();
    });
  });

  describe('checkForUpdates', () => {
    it('should return update info when newer version available', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockRegistryClient.getTemplate.mockResolvedValue(
        createMockTemplateDetail('test-template', [
          { version: '2.0.0', isLatest: true },
          { version: '1.0.0', isLatest: false },
        ]),
      );

      const result = await service.checkForUpdates('project-123');

      expect(result).toEqual({
        hasUpdate: true,
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
      });
    });

    it('should return no update when up to date', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockRegistryClient.getTemplate.mockResolvedValue(
        createMockTemplateDetail('test-template', [{ version: '1.0.0', isLatest: true }]),
      );

      const result = await service.checkForUpdates('project-123');

      expect(result).toEqual({
        hasUpdate: false,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
      });
    });

    it('should return null if project not linked', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue(null);

      const result = await service.checkForUpdates('project-123');

      expect(result).toBeNull();
    });

    it('should return null if template not found in registry', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'deleted-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockRegistryClient.getTemplate.mockResolvedValue(null);

      const result = await service.checkForUpdates('project-123');

      expect(result).toBeNull();
    });

    it('should return null if no latest version found', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockRegistryClient.getTemplate.mockResolvedValue(
        createMockTemplateDetail('test-template', [
          { version: '1.0.0', isLatest: false }, // No isLatest=true
        ]),
      );

      const result = await service.checkForUpdates('project-123');

      expect(result).toBeNull();
    });

    it('should return null on registry error', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockRegistryClient.getTemplate.mockRejectedValue(new Error('Network error'));

      const result = await service.checkForUpdates('project-123');

      expect(result).toBeNull();
    });
  });

  describe('isCached', () => {
    it('should delegate to cache service', () => {
      mockCacheService.isCached.mockReturnValue(true);

      const result = service.isCached('test-template', '1.0.0');

      expect(result).toBe(true);
      expect(mockCacheService.isCached).toHaveBeenCalledWith('test-template', '1.0.0');
    });
  });

  describe('getFromCache', () => {
    it('should delegate to cache service', async () => {
      const cached = {
        content: { prompts: [] },
        metadata: { slug: 'test', version: '1.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      };
      mockCacheService.getTemplate.mockResolvedValue(cached);

      const result = await service.getFromCache('test-template', '1.0.0');

      expect(result).toEqual(cached);
      expect(mockCacheService.getTemplate).toHaveBeenCalledWith('test-template', '1.0.0');
    });
  });

  describe('preset persistence on import', () => {
    const mockPresets = [
      {
        name: 'default',
        description: 'Default preset',
        agentConfigs: [
          { agentName: 'Coder', providerConfigName: 'claude-config' },
          { agentName: 'Reviewer', providerConfigName: 'gemini-config' },
        ],
      },
      {
        name: 'minimal',
        description: null,
        agentConfigs: [{ agentName: 'Coder', providerConfigName: 'basic-config' }],
      },
    ];

    it('should persist presets when present in template content', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [], presets: mockPresets },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      await service.createProjectFromRegistry({
        slug: 'test-template',
        version: '1.0.0',
        projectName: 'Test Project',
        rootPath: '/test/path',
      });

      expect(mockSettingsService.setProjectPresets).toHaveBeenCalledWith(
        'project-123',
        mockPresets,
      );
    });

    it('should not call setProjectPresets when presets array is empty', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [], presets: [] },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      await service.createProjectFromRegistry({
        slug: 'test-template',
        version: '1.0.0',
        projectName: 'Test Project',
        rootPath: '/test/path',
      });

      expect(mockSettingsService.setProjectPresets).not.toHaveBeenCalled();
    });

    it('should not call setProjectPresets when presets field is undefined', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      await service.createProjectFromRegistry({
        slug: 'test-template',
        version: '1.0.0',
        projectName: 'Test Project',
        rootPath: '/test/path',
      });

      expect(mockSettingsService.setProjectPresets).not.toHaveBeenCalled();
    });

    it('should not fail project creation when setProjectPresets throws', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [], presets: mockPresets },
        metadata: {
          slug: 'test-template',
          version: '1.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockStorage.createProject.mockResolvedValue({
        id: 'project-123',
        name: 'Test Project',
        rootPath: '/test/path',
        description: null,
        isTemplate: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());
      mockSettingsService.setProjectPresets.mockRejectedValue(
        new Error('Failed to persist presets'),
      );

      const result = await service.createProjectFromRegistry({
        slug: 'test-template',
        version: '1.0.0',
        projectName: 'Test Project',
        rootPath: '/test/path',
      });

      // Project should still be created even if preset persistence fails
      expect(result.project.id).toBe('project-123');
    });
  });
});
