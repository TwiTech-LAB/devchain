import { RegistryOrchestrationService } from './registry-orchestration.service';
import { RegistryClientService } from './registry-client.service';
import { TemplateCacheService } from './template-cache.service';
import { SettingsService } from '../../settings/services/settings.service';

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

  beforeEach(() => {
    mockRegistryClient = {
      downloadTemplate: jest.fn(),
      getTemplate: jest.fn(),
      isAvailable: jest.fn().mockResolvedValue(true),
      checkForUpdates: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<RegistryClientService>;

    mockCacheService = {
      isCached: jest.fn(),
      saveTemplate: jest.fn(),
      getTemplate: jest.fn(),
    } as unknown as jest.Mocked<TemplateCacheService>;

    mockSettingsService = {
      getProjectTemplateMetadata: jest.fn(),
      getRegistryConfig: jest.fn().mockReturnValue({
        url: 'https://test.registry.com',
        cacheDir: '',
        checkUpdatesOnStartup: true,
      }),
      updateLastUpdateCheck: jest.fn(),
      getAllTrackedProjects: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<SettingsService>;

    service = new RegistryOrchestrationService(
      mockRegistryClient,
      mockCacheService,
      mockSettingsService,
    );
  });

  const flushBackgroundTasks = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };

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
      expect(mockCacheService.saveTemplate).toHaveBeenCalledWith(
        'test-template',
        '1.0.0',
        { prompts: [] },
        expect.objectContaining({
          checksum: 'abc123',
          size: expect.any(Number),
        }),
      );
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

    it('should return null if project is not linked', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue(null);

      await expect(service.checkForUpdates('project-123')).resolves.toBeNull();
    });

    it('should return null if template is not found in registry', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'deleted-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockRegistryClient.getTemplate.mockResolvedValue(null);

      await expect(service.checkForUpdates('project-123')).resolves.toBeNull();
    });

    it('should return null if no latest version exists', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockRegistryClient.getTemplate.mockResolvedValue(
        createMockTemplateDetail('test-template', [{ version: '1.0.0', isLatest: false }]),
      );

      await expect(service.checkForUpdates('project-123')).resolves.toBeNull();
    });

    it('should return null on registry error', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockRegistryClient.getTemplate.mockRejectedValue(new Error('Network error'));

      await expect(service.checkForUpdates('project-123')).resolves.toBeNull();
    });
  });

  describe('cache reads', () => {
    it('should report cached template versions', () => {
      mockCacheService.isCached.mockReturnValue(true);

      expect(service.isCached('test-template', '1.0.0')).toBe(true);
      expect(mockCacheService.isCached).toHaveBeenCalledWith('test-template', '1.0.0');
    });

    it('should read cached template content', async () => {
      const cached = {
        content: { prompts: [] },
        metadata: { slug: 'test', version: '1.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      };
      mockCacheService.getTemplate.mockResolvedValue(cached);

      await expect(service.getFromCache('test-template', '1.0.0')).resolves.toEqual(cached);
      expect(mockCacheService.getTemplate).toHaveBeenCalledWith('test-template', '1.0.0');
    });
  });

  describe('startup update check', () => {
    it('runs non-blocking on application bootstrap', async () => {
      let resolveAvailability: ((value: boolean) => void) | undefined;
      mockRegistryClient.isAvailable.mockReturnValue(
        new Promise<boolean>((resolve) => {
          resolveAvailability = resolve;
        }),
      );

      service.onApplicationBootstrap();

      expect(service.getUpdateStatus().state).toBe('pending');
      expect(mockRegistryClient.isAvailable).toHaveBeenCalledTimes(1);

      resolveAvailability?.(true);
      await flushBackgroundTasks();
    });

    it('sets state to skipped and avoids registry calls when startup checks are disabled', async () => {
      mockSettingsService.getRegistryConfig.mockReturnValue({
        url: 'https://test.registry.com',
        cacheDir: '',
        checkUpdatesOnStartup: false,
      });

      service.onApplicationBootstrap();
      await flushBackgroundTasks();

      expect(mockRegistryClient.isAvailable).not.toHaveBeenCalled();
      expect(mockRegistryClient.checkForUpdates).not.toHaveBeenCalled();
      expect(service.getUpdateStatus()).toEqual({
        state: 'skipped',
        results: [],
      });
    });

    it('sets state to skipped when registry is unavailable', async () => {
      mockRegistryClient.isAvailable.mockResolvedValue(false);

      service.onApplicationBootstrap();
      await flushBackgroundTasks();

      expect(mockSettingsService.getAllTrackedProjects).not.toHaveBeenCalled();
      expect(mockRegistryClient.checkForUpdates).not.toHaveBeenCalled();
      expect(service.getUpdateStatus()).toEqual({
        state: 'skipped',
        results: [],
      });
    });

    it('sets state to complete with no results when no tracked projects exist', async () => {
      mockSettingsService.getAllTrackedProjects.mockReturnValue([]);

      service.onApplicationBootstrap();
      await flushBackgroundTasks();

      expect(mockRegistryClient.checkForUpdates).not.toHaveBeenCalled();
      expect(service.getUpdateStatus()).toEqual({
        state: 'complete',
        results: [],
      });
    });

    it('deduplicates by slug+version and maps update results per checked project', async () => {
      mockSettingsService.getAllTrackedProjects.mockReturnValue([
        {
          projectId: 'project-1',
          metadata: {
            templateSlug: 'template-a',
            installedVersion: '1.0.0',
            registryUrl: 'https://test.registry.com',
            installedAt: new Date().toISOString(),
            source: 'registry',
          },
        },
        {
          projectId: 'project-2',
          metadata: {
            templateSlug: 'template-a',
            installedVersion: '1.0.0',
            registryUrl: 'https://test.registry.com',
            installedAt: new Date().toISOString(),
            source: undefined,
          },
        },
        {
          projectId: 'project-3',
          metadata: {
            templateSlug: 'template-a',
            installedVersion: '2.0.0',
            registryUrl: 'https://test.registry.com',
            installedAt: new Date().toISOString(),
            source: 'registry',
          },
        },
        {
          projectId: 'project-4',
          metadata: {
            templateSlug: 'template-b',
            installedVersion: null,
            registryUrl: 'https://test.registry.com',
            installedAt: new Date().toISOString(),
            source: 'registry',
          },
        },
        {
          projectId: 'project-5',
          metadata: {
            templateSlug: 'template-c',
            installedVersion: '1.0.0',
            registryUrl: null,
            installedAt: new Date().toISOString(),
            source: 'bundled',
          },
        },
      ]);
      mockRegistryClient.checkForUpdates.mockResolvedValue([
        {
          slug: 'template-a',
          currentVersion: '1.0.0',
          latestVersion: '1.1.0',
          changelog: 'Bug fixes',
        },
      ]);

      service.onApplicationBootstrap();
      await flushBackgroundTasks();

      expect(mockRegistryClient.checkForUpdates).toHaveBeenCalledWith([
        { slug: 'template-a', version: '1.0.0' },
        { slug: 'template-a', version: '2.0.0' },
      ]);
      expect(mockSettingsService.updateLastUpdateCheck).toHaveBeenCalledTimes(3);
      expect(service.getUpdateStatus()).toEqual({
        state: 'complete',
        results: expect.arrayContaining([
          {
            projectId: 'project-1',
            hasUpdate: true,
            currentVersion: '1.0.0',
            latestVersion: '1.1.0',
            changelog: 'Bug fixes',
          },
          {
            projectId: 'project-2',
            hasUpdate: true,
            currentVersion: '1.0.0',
            latestVersion: '1.1.0',
            changelog: 'Bug fixes',
          },
          {
            projectId: 'project-3',
            hasUpdate: false,
            currentVersion: '2.0.0',
          },
        ]),
      });
    });

    it('stores hasUpdate false when no updates are returned', async () => {
      mockSettingsService.getAllTrackedProjects.mockReturnValue([
        {
          projectId: 'project-123',
          metadata: {
            templateSlug: 'template-a',
            installedVersion: '1.0.0',
            registryUrl: 'https://test.registry.com',
            installedAt: new Date().toISOString(),
            source: 'registry',
          },
        },
      ]);
      mockRegistryClient.checkForUpdates.mockResolvedValue([]);

      service.onApplicationBootstrap();
      await flushBackgroundTasks();

      expect(service.getUpdateStatus()).toEqual({
        state: 'complete',
        results: [
          {
            projectId: 'project-123',
            hasUpdate: false,
            currentVersion: '1.0.0',
          },
        ],
      });
    });
  });
});
