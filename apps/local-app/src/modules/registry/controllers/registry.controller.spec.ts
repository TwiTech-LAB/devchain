import { RegistryController } from './registry.controller';
import { RegistryClientService } from '../services/registry-client.service';
import { TemplateCacheService } from '../services/template-cache.service';
import { RegistryOrchestrationService } from '../services/registry-orchestration.service';
import { TemplateUpgradeService } from '../services/template-upgrade.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StorageService } from '../../storage/interfaces/storage.interface';

describe('RegistryController', () => {
  let controller: RegistryController;
  let mockRegistryClient: jest.Mocked<Partial<RegistryClientService>>;
  let mockCacheService: jest.Mocked<Partial<TemplateCacheService>>;
  let mockOrchestrationService: jest.Mocked<Partial<RegistryOrchestrationService>>;
  let mockUpgradeService: jest.Mocked<Partial<TemplateUpgradeService>>;
  let mockSettingsService: jest.Mocked<Partial<SettingsService>>;
  let mockStorageService: jest.Mocked<Partial<StorageService>>;

  beforeEach(() => {
    mockRegistryClient = {
      isAvailable: jest.fn(),
      getRegistryUrl: jest.fn(),
    };

    mockCacheService = {};

    mockOrchestrationService = {};

    mockUpgradeService = {};

    mockSettingsService = {
      getAllTrackedProjects: jest.fn(),
      getProjectTemplateMetadata: jest.fn(),
    };

    mockStorageService = {
      listProjects: jest.fn(),
      getProject: jest.fn(),
    };

    controller = new RegistryController(
      mockRegistryClient as RegistryClientService,
      mockCacheService as TemplateCacheService,
      mockOrchestrationService as RegistryOrchestrationService,
      mockUpgradeService as TemplateUpgradeService,
      mockSettingsService as SettingsService,
      mockStorageService as StorageService,
    );
  });

  describe('getProjectsUsingTemplate', () => {
    it('should return empty array when no projects use the template', async () => {
      mockSettingsService.getAllTrackedProjects!.mockReturnValue([]);

      const result = await controller.getProjectsUsingTemplate('test-template');

      expect(result).toEqual({ projects: [] });
      expect(mockStorageService.listProjects).not.toHaveBeenCalled();
    });

    it('should batch fetch project names in single query', async () => {
      mockSettingsService.getAllTrackedProjects!.mockReturnValue([
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
            lastUpdateCheckAt: null,
            registryUrl: 'https://registry.test.com',
          },
        },
        {
          projectId: 'project-3',
          metadata: {
            templateSlug: 'other-template',
            installedVersion: '2.0.0',
            installedAt: '2024-01-01T00:00:00Z',
            lastUpdateCheckAt: null,
            registryUrl: 'https://registry.test.com',
          },
        },
      ]);

      mockStorageService.listProjects!.mockResolvedValue({
        items: [
          {
            id: 'project-1',
            name: 'Project One',
            rootPath: '/path/1',
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'project-2',
            name: 'Project Two',
            rootPath: '/path/2',
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'project-3',
            name: 'Project Three',
            rootPath: '/path/3',
            createdAt: '',
            updatedAt: '',
          },
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
        lastUpdateCheckAt: null,
      });

      // Should fetch all projects in single call (batch)
      expect(mockStorageService.listProjects).toHaveBeenCalledTimes(1);
      expect(mockStorageService.listProjects).toHaveBeenCalledWith({ limit: 1000 });

      // Should NOT call getProject (N+1 pattern)
      expect(mockStorageService.getProject).not.toHaveBeenCalled();
    });

    it('should return null projectName for deleted projects', async () => {
      mockSettingsService.getAllTrackedProjects!.mockReturnValue([
        {
          projectId: 'deleted-project',
          metadata: {
            templateSlug: 'test-template',
            installedVersion: '1.0.0',
            installedAt: '2024-01-01T00:00:00Z',
            lastUpdateCheckAt: null,
            registryUrl: 'https://registry.test.com',
          },
        },
      ]);

      // Project no longer exists in storage
      mockStorageService.listProjects!.mockResolvedValue({
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
