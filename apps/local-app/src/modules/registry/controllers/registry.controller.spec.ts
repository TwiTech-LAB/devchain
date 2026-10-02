import { RegistryController } from './registry.controller';
import { RegistryClientService } from '../services/registry-client.service';
import { TemplateCacheService } from '../services/template-cache.service';
import { RegistryOrchestrationService } from '../services/registry-orchestration.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StorageService } from '../../storage/interfaces/storage.interface';
import { createMockProject } from '../../../../test/factories';

describe('RegistryController', () => {
  let controller: RegistryController;
  let mockRegistryClient: jest.Mocked<
    Pick<RegistryClientService, 'isAvailable' | 'getRegistryUrl' | 'downloadTemplate'>
  >;
  let mockCacheService: jest.Mocked<Pick<TemplateCacheService, 'isCached' | 'saveTemplate'>>;
  let mockOrchestrationService: jest.Mocked<
    Pick<RegistryOrchestrationService, 'downloadToCache' | 'getUpdateStatus'>
  >;
  let mockSettingsService: jest.Mocked<
    Pick<SettingsService, 'getAllTrackedProjects' | 'getProjectTemplateMetadata'>
  >;
  let mockStorageService: jest.Mocked<Pick<StorageService, 'listProjects' | 'getProject'>>;

  beforeEach(() => {
    mockRegistryClient = {
      isAvailable: jest.fn(),
      getRegistryUrl: jest.fn(),
      downloadTemplate: jest.fn(),
    };

    mockCacheService = {
      isCached: jest.fn(),
      saveTemplate: jest.fn(),
    };

    mockOrchestrationService = {
      downloadToCache: jest.fn(),
      getUpdateStatus: jest.fn(),
    };

    mockSettingsService = {
      getAllTrackedProjects: jest.fn(),
      getProjectTemplateMetadata: jest.fn(),
    };

    mockStorageService = {
      listProjects: jest.fn(),
      getProject: jest.fn(),
    };

    controller = new RegistryController(
      mockRegistryClient as unknown as RegistryClientService,
      mockCacheService as unknown as TemplateCacheService,
      mockOrchestrationService as unknown as RegistryOrchestrationService,
      mockSettingsService as unknown as SettingsService,
      mockStorageService as unknown as StorageService,
    );
  });

  describe('downloadTemplate', () => {
    it('should return the existing cache-hit response from orchestration', async () => {
      mockOrchestrationService.downloadToCache.mockResolvedValue({ cached: true });

      await expect(controller.downloadTemplate('test-template', '1.0.0')).resolves.toEqual({
        success: true,
        cached: true,
        message: 'Already cached',
      });

      expect(mockOrchestrationService.downloadToCache).toHaveBeenCalledWith(
        'test-template',
        '1.0.0',
      );
      expect(mockRegistryClient.downloadTemplate).not.toHaveBeenCalled();
      expect(mockCacheService.isCached).not.toHaveBeenCalled();
      expect(mockCacheService.saveTemplate).not.toHaveBeenCalled();
    });

    it('should map the orchestration miss result to the existing response', async () => {
      mockOrchestrationService.downloadToCache.mockResolvedValue({
        cached: false,
        checksum: 'abc123',
        size: 42,
      });

      await expect(controller.downloadTemplate('test-template', '1.0.0')).resolves.toEqual({
        success: true,
        cached: false,
        checksum: 'abc123',
        size: 42,
      });

      expect(mockOrchestrationService.downloadToCache).toHaveBeenCalledWith(
        'test-template',
        '1.0.0',
      );
      expect(mockRegistryClient.downloadTemplate).not.toHaveBeenCalled();
      expect(mockCacheService.saveTemplate).not.toHaveBeenCalled();
    });

    it('should propagate orchestration failures unchanged', async () => {
      const error = new Error('Registry unavailable');
      mockOrchestrationService.downloadToCache.mockRejectedValue(error);

      await expect(controller.downloadTemplate('test-template', '1.0.0')).rejects.toBe(error);
    });
  });

  describe('getProjectsUsingTemplate', () => {
    it('should return empty array when no projects use the template', async () => {
      mockSettingsService.getAllTrackedProjects.mockReturnValue([]);

      const result = await controller.getProjectsUsingTemplate('test-template');

      expect(result).toEqual({ projects: [] });
      expect(mockStorageService.listProjects).not.toHaveBeenCalled();
    });

    it('should batch fetch project names in single query', async () => {
      mockSettingsService.getAllTrackedProjects.mockReturnValue([
        {
          projectId: 'project-1',
          metadata: {
            templateSlug: 'test-template',
            installedVersion: '1.0.0',
            installedAt: '2024-01-01T00:00:00Z',
            lastUpdateCheckAt: '2024-01-02T00:00:00Z',
            registryUrl: 'https://registry.test.com',
          },
        },
        {
          projectId: 'project-2',
          metadata: {
            templateSlug: 'test-template',
            installedVersion: '1.0.0',
            installedAt: '2024-01-01T00:00:00Z',
            registryUrl: 'https://registry.test.com',
          },
        },
        {
          projectId: 'project-3',
          metadata: {
            templateSlug: 'other-template',
            installedVersion: '2.0.0',
            installedAt: '2024-01-01T00:00:00Z',
            registryUrl: 'https://registry.test.com',
          },
        },
      ]);

      mockStorageService.listProjects.mockResolvedValue({
        items: [
          createMockProject({ id: 'project-1', name: 'Project One', rootPath: '/path/1' }),
          createMockProject({ id: 'project-2', name: 'Project Two', rootPath: '/path/2' }),
          createMockProject({ id: 'project-3', name: 'Project Three', rootPath: '/path/3' }),
        ],
        total: 3,
        limit: 1000,
        offset: 0,
      });

      const result = await controller.getProjectsUsingTemplate('test-template');

      // Should only return projects using 'test-template'
      expect(result.projects).toHaveLength(2);
      expect(result.projects[0]).toEqual({
        projectId: 'project-1',
        projectName: 'Project One',
        installedVersion: '1.0.0',
        installedAt: '2024-01-01T00:00:00Z',
        lastUpdateCheckAt: '2024-01-02T00:00:00Z',
      });
      expect(result.projects[1]).toEqual({
        projectId: 'project-2',
        projectName: 'Project Two',
        installedVersion: '1.0.0',
        installedAt: '2024-01-01T00:00:00Z',
        lastUpdateCheckAt: undefined,
      });

      // Should fetch all projects in single call (batch)
      expect(mockStorageService.listProjects).toHaveBeenCalledTimes(1);
      expect(mockStorageService.listProjects).toHaveBeenCalledWith({ limit: 1000 });

      // Should NOT call getProject (N+1 pattern)
      expect(mockStorageService.getProject).not.toHaveBeenCalled();
    });

    it('should return null projectName for deleted projects', async () => {
      mockSettingsService.getAllTrackedProjects.mockReturnValue([
        {
          projectId: 'deleted-project',
          metadata: {
            templateSlug: 'test-template',
            installedVersion: '1.0.0',
            installedAt: '2024-01-01T00:00:00Z',
            registryUrl: 'https://registry.test.com',
          },
        },
      ]);

      // Project no longer exists in storage
      mockStorageService.listProjects.mockResolvedValue({
        items: [],
        total: 0,
        limit: 1000,
        offset: 0,
      });

      const result = await controller.getProjectsUsingTemplate('test-template');

      expect(result.projects).toHaveLength(1);
      expect(result.projects[0].projectName).toBeNull();
    });
  });

  describe('getUpdateStatus', () => {
    it('should return pending state while startup check is running', () => {
      mockOrchestrationService.getUpdateStatus = jest.fn().mockReturnValue({
        state: 'pending',
        results: [],
      });

      const result = controller.getUpdateStatus();

      expect(result).toEqual({
        state: 'pending',
        results: [],
      });
      expect(mockOrchestrationService.getUpdateStatus).toHaveBeenCalledTimes(1);
    });

    it('should return complete state with mapped results and templateSlug', () => {
      mockOrchestrationService.getUpdateStatus = jest.fn().mockReturnValue({
        state: 'complete',
        results: [
          {
            projectId: 'project-1',
            hasUpdate: true,
            currentVersion: '0.7.0',
            latestVersion: '0.8.0',
            changelog: 'Improvements',
          },
          {
            projectId: 'project-2',
            hasUpdate: false,
            currentVersion: '0.8.0',
          },
        ],
      });
      mockSettingsService.getProjectTemplateMetadata = jest
        .fn()
        .mockImplementation((projectId: string) => {
          if (projectId === 'project-1') {
            return { templateSlug: '5-agents-dev' };
          }
          return null;
        });

      const result = controller.getUpdateStatus();

      expect(result).toEqual({
        state: 'complete',
        results: [
          {
            projectId: 'project-1',
            templateSlug: '5-agents-dev',
            hasUpdate: true,
            currentVersion: '0.7.0',
            latestVersion: '0.8.0',
            changelog: 'Improvements',
          },
          {
            projectId: 'project-2',
            templateSlug: null,
            hasUpdate: false,
            currentVersion: '0.8.0',
            latestVersion: undefined,
            changelog: undefined,
          },
        ],
      });
    });

    it('should return skipped state when startup check is skipped', () => {
      mockOrchestrationService.getUpdateStatus = jest.fn().mockReturnValue({
        state: 'skipped',
        results: [],
      });

      const result = controller.getUpdateStatus();

      expect(result).toEqual({
        state: 'skipped',
        results: [],
      });
    });
  });
});
