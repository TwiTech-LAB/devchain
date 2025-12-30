import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import { TemplateUpgradeService } from './template-upgrade.service';
import { RegistryOrchestrationService } from './registry-orchestration.service';
import { TemplateCacheService } from './template-cache.service';
import { SettingsService } from '../../settings/services/settings.service';
import { ProjectsService } from '../../projects/services/projects.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createMockExportData = (prompts: any[] = []): any => ({
  prompts,
  profiles: [],
  agents: [],
  statuses: [],
  watchers: [],
  subscribers: [],
  version: 1,
  exportedAt: new Date().toISOString(),
  initialPrompt: null,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createMockImportResult = (): any => ({
  dryRun: false,
  missingProviders: [],
  unmatchedStatuses: [],
  templateStatuses: [],
  counts: { toImport: {}, toDelete: {} },
  imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
});

describe('TemplateUpgradeService', () => {
  let service: TemplateUpgradeService;
  let mockOrchestrationService: jest.Mocked<RegistryOrchestrationService>;
  let mockCacheService: jest.Mocked<TemplateCacheService>;
  let mockSettingsService: jest.Mocked<SettingsService>;
  let mockProjectsService: jest.Mocked<ProjectsService>;

  beforeEach(() => {
    mockOrchestrationService = {
      downloadToCache: jest.fn(),
    } as unknown as jest.Mocked<RegistryOrchestrationService>;

    mockCacheService = {
      getTemplate: jest.fn(),
    } as unknown as jest.Mocked<TemplateCacheService>;

    mockSettingsService = {
      getProjectTemplateMetadata: jest.fn(),
      setProjectTemplateMetadata: jest.fn(),
      getRegistryConfig: jest.fn().mockReturnValue({ url: 'https://test.com' }),
    } as unknown as jest.Mocked<SettingsService>;

    mockProjectsService = {
      exportProject: jest.fn(),
      importProject: jest.fn(),
    } as unknown as jest.Mocked<ProjectsService>;

    service = new TemplateUpgradeService(
      mockOrchestrationService,
      mockCacheService,
      mockSettingsService,
      mockProjectsService,
    );
  });

  describe('createBackup', () => {
    it('should export project and store backup', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      const backupId = await service.createBackup('project-123');

      expect(backupId).toMatch(/^backup-project-123-\d+$/);
      expect(mockProjectsService.exportProject).toHaveBeenCalledWith('project-123');
    });

    it('should throw if project not linked', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue(null);

      await expect(service.createBackup('project-123')).rejects.toThrow(NotFoundError);
    });

    it('should throw for bundled templates (no installedVersion)', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'empty-project',
        source: 'bundled',
        installedVersion: null,
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });

      await expect(service.createBackup('project-123')).rejects.toThrow(ValidationError);
      await expect(service.createBackup('project-123')).rejects.toThrow(
        'Bundled templates cannot be upgraded',
      );
    });
  });

  describe('upgradeProject', () => {
    it('should create backup before upgrade', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(mockProjectsService.exportProject).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should apply template and update metadata', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [{ id: '1' }] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(true);
      expect(result.newVersion).toBe('2.0.0');
      expect(mockProjectsService.importProject).toHaveBeenCalled();
      expect(mockSettingsService.setProjectTemplateMetadata).toHaveBeenCalledWith(
        'project-123',
        expect.objectContaining({
          installedVersion: '2.0.0',
        }),
      );
    });

    it('should auto-restore and return restored=true on failure when restore succeeds', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      // First import (upgrade) fails, second import (restore) succeeds
      mockProjectsService.importProject
        .mockRejectedValueOnce(new Error('Import failed'))
        .mockResolvedValueOnce(createMockImportResult());

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Import failed');
      expect(result.restored).toBe(true);
      expect(result.backupId).toBeUndefined();
    });

    it('should return backupId when auto-restore also fails', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      // Both imports fail
      mockProjectsService.importProject
        .mockRejectedValueOnce(new Error('Import failed'))
        .mockRejectedValueOnce(new Error('Restore also failed'));

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Import failed');
      expect(result.restored).toBe(false);
      expect(result.backupId).toMatch(/^backup-project-123-\d+$/);
    });

    it('should return error if project not linked', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue(null);

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not linked');
    });

    it('should return error if already at target version', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '2.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already at this version');
    });

    it('should return error if version not cached (before backup)', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockCacheService.getTemplate.mockResolvedValue(null);

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not cached');
      // Should NOT have created a backup since validation failed early
      expect(mockProjectsService.exportProject).not.toHaveBeenCalled();
    });

    it('should return error if backup creation fails', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      mockProjectsService.exportProject.mockRejectedValue(new Error('Export failed'));

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create backup');
      expect(result.error).toContain('Export failed');
    });

    it('should delete backup after successful upgrade', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(true);
      // Backup should be deleted after successful upgrade
      const backups = service.getProjectBackups('project-123');
      expect(backups).toHaveLength(0);
    });
  });

  describe('restoreBackup', () => {
    it('should restore project from backup', async () => {
      // First create a backup
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(
        createMockExportData([{ id: '1', title: 'Test', content: '', version: 1, tags: [] }]),
      );

      const backupId = await service.createBackup('project-123');

      // Now restore
      await service.restoreBackup(backupId);

      expect(mockProjectsService.importProject).toHaveBeenCalledWith({
        projectId: 'project-123',
        payload: expect.objectContaining({
          prompts: [{ id: '1', title: 'Test', content: '', version: 1, tags: [] }],
        }),
        dryRun: false,
      });
    });

    it('should throw if backup expired or not found', async () => {
      await expect(service.restoreBackup('non-existent-backup')).rejects.toThrow(NotFoundError);
    });

    it('should restore original metadata', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      const backupId = await service.createBackup('project-123');

      await service.restoreBackup(backupId);

      expect(mockSettingsService.setProjectTemplateMetadata).toHaveBeenCalledWith(
        'project-123',
        expect.objectContaining({
          templateSlug: 'test-template',
          installedVersion: '1.0.0',
        }),
      );
    });

    it('should include source field when restoring metadata', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        source: 'registry',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      const backupId = await service.createBackup('project-123');
      await service.restoreBackup(backupId);

      expect(mockSettingsService.setProjectTemplateMetadata).toHaveBeenCalledWith(
        'project-123',
        expect.objectContaining({
          source: 'registry',
          templateSlug: 'test-template',
          installedVersion: '1.0.0',
        }),
      );
    });
  });

  describe('getBackupInfo', () => {
    it('should return backup info', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      const backupId = await service.createBackup('project-123');

      const info = service.getBackupInfo(backupId);

      expect(info).not.toBeNull();
      expect(info?.projectId).toBe('project-123');
      expect(info?.fromVersion).toBe('1.0.0');
    });

    it('should return null for non-existent backup', () => {
      const info = service.getBackupInfo('non-existent');
      expect(info).toBeNull();
    });
  });

  describe('getProjectBackups', () => {
    it('should list active backups for project', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      await service.createBackup('project-123');
      // Small delay to ensure unique timestamps
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.createBackup('project-123');

      const backups = service.getProjectBackups('project-123');

      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(backups[0].backupId).toMatch(/^backup-project-123-\d+$/);
    });

    it('should return empty array when no backups', () => {
      const backups = service.getProjectBackups('project-123');
      expect(backups).toHaveLength(0);
    });

    it('should only return backups for specified project', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      await service.createBackup('project-123');
      await service.createBackup('project-456');

      const backups123 = service.getProjectBackups('project-123');
      const backups456 = service.getProjectBackups('project-456');

      expect(backups123.length).toBe(1);
      expect(backups456.length).toBe(1);
      expect(backups123[0].backupId).toContain('project-123');
      expect(backups456[0].backupId).toContain('project-456');
    });
  });

  describe('restoreBackup error handling', () => {
    it('should propagate import errors during restore', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      const backupId = await service.createBackup('project-123');

      mockProjectsService.importProject.mockRejectedValue(new Error('Restore import failed'));

      await expect(service.restoreBackup(backupId)).rejects.toThrow('Restore import failed');
    });

    it('should remove backup after successful restore', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      const backupId = await service.createBackup('project-123');

      // Verify backup exists
      expect(service.getBackupInfo(backupId)).not.toBeNull();

      await service.restoreBackup(backupId);

      // Backup should be removed after restore
      expect(service.getBackupInfo(backupId)).toBeNull();
    });
  });

  describe('backup expiration', () => {
    let serviceWithFakeTimers: TemplateUpgradeService;

    beforeEach(() => {
      jest.useFakeTimers();

      // Create service after enabling fake timers so setInterval is mocked
      serviceWithFakeTimers = new TemplateUpgradeService(
        mockOrchestrationService,
        mockCacheService,
        mockSettingsService,
        mockProjectsService,
      );
      // Initialize the cleanup timer (moved from constructor to onModuleInit)
      serviceWithFakeTimers.onModuleInit();
    });

    afterEach(() => {
      // Clean up the timer
      serviceWithFakeTimers.onModuleDestroy();
      jest.useRealTimers();
    });

    it('should cleanup expired backups after expiration time', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      const backupId = await serviceWithFakeTimers.createBackup('project-123');

      // Verify backup exists
      expect(serviceWithFakeTimers.getBackupInfo(backupId)).not.toBeNull();

      // Advance time past expiration (1 hour + 5 minutes to trigger cleanup)
      jest.advanceTimersByTime(60 * 60 * 1000 + 5 * 60 * 1000);

      // Backup should be expired and cleaned up
      expect(serviceWithFakeTimers.getBackupInfo(backupId)).toBeNull();
    });

    it('should preserve non-expired backups during cleanup', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      const backupId = await serviceWithFakeTimers.createBackup('project-123');

      // Verify backup exists
      expect(serviceWithFakeTimers.getBackupInfo(backupId)).not.toBeNull();

      // Advance time but not past expiration (30 minutes + 5 minutes to trigger cleanup)
      jest.advanceTimersByTime(30 * 60 * 1000 + 5 * 60 * 1000);

      // Backup should still exist (hasn't expired yet)
      expect(serviceWithFakeTimers.getBackupInfo(backupId)).not.toBeNull();
    });
  });
});
