import { ValidationError, NotFoundError } from '../../../common/errors/error-types';
import { ProjectTemplateUpgradeService } from './project-template-upgrade.service';
import { TemplateCacheService } from '../../registry/services/template-cache.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { SettingsService } from '../../settings/services/settings.service';
import { ProjectsService } from './projects.service';
import { SessionsService } from '../../sessions/services/sessions.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

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
  success: true,
  dryRun: false,
  missingProviders: [],
  unmatchedStatuses: [],
  templateStatuses: [],
  counts: { toImport: {}, toDelete: {} },
  imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
  promptTransfer: { imported: 2, deleted: 1, preserved: 3, skipped: 4 },
});

describe('ProjectTemplateUpgradeService', () => {
  let service: ProjectTemplateUpgradeService;
  let mockCacheService: jest.Mocked<TemplateCacheService>;
  let mockUnifiedTemplateService: jest.Mocked<UnifiedTemplateService>;
  let mockSettingsService: jest.Mocked<SettingsService>;
  let mockProjectsService: jest.Mocked<ProjectsService>;
  let mockSessionsService: jest.Mocked<SessionsService>;

  beforeEach(() => {
    mockCacheService = {
      getTemplate: jest.fn(),
    } as unknown as jest.Mocked<TemplateCacheService>;

    mockUnifiedTemplateService = {
      getBundledTemplate: jest.fn(),
    } as unknown as jest.Mocked<UnifiedTemplateService>;

    mockSettingsService = {
      getProjectTemplateMetadata: jest.fn(),
      setProjectTemplateMetadata: jest.fn(),
      getProjectActivePreset: jest.fn().mockReturnValue(null),
      setProjectActivePreset: jest.fn().mockResolvedValue(undefined),
      getRegistryConfig: jest.fn().mockReturnValue({ url: 'https://test.com' }),
    } as unknown as jest.Mocked<SettingsService>;

    mockProjectsService = {
      exportProject: jest.fn(),
      importProject: jest.fn().mockResolvedValue(createMockImportResult()),
      setupPreview: jest.fn().mockResolvedValue({}),
    } as unknown as jest.Mocked<ProjectsService>;

    mockSessionsService = {
      getActiveSessionsForProject: jest.fn().mockReturnValue([]),
    } as unknown as jest.Mocked<SessionsService>;

    service = new ProjectTemplateUpgradeService(
      mockProjectsService,
      mockCacheService,
      mockUnifiedTemplateService,
      mockSettingsService,
      mockSessionsService,
      createProjectWriteAdmissionStub() as never,
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
      expect(mockProjectsService.exportProject).toHaveBeenCalledWith('project-123', {
        profileConfigEnvTransform: expect.any(Function),
      });
      const exportOptions = mockProjectsService.exportProject.mock.calls[0][1];
      expect(
        exportOptions?.profileConfigEnvTransform?.({ ANTHROPIC_API_KEY: 'sk-backup-secret' }),
      ).toEqual({ ANTHROPIC_API_KEY: 'sk-backup-secret' });
      expect(mockSettingsService.getProjectActivePreset.mock.invocationCallOrder[0]).toBeLessThan(
        mockProjectsService.exportProject.mock.invocationCallOrder[0],
      );
    });

    it('should throw if project not linked', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue(null);

      await expect(service.createBackup('project-123')).rejects.toThrow(NotFoundError);
    });

    it('should throw when project has no installed version', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'empty-project',
        source: 'bundled',
        installedVersion: null,
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });

      await expect(service.createBackup('project-123')).rejects.toThrow(ValidationError);
      await expect(service.createBackup('project-123')).rejects.toThrow(
        'Cannot upgrade: project has no installed version',
      );
    });

    it('should store source in backup for bundled templates', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'bundled-template',
        source: 'bundled',
        installedVersion: '1.0.0',
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      const backupId = await service.createBackup('project-123');

      expect(backupId).toMatch(/^backup-project-123-\d+$/);
      const info = service.getBackupInfo(backupId);
      expect(info).not.toBeNull();
    });
  });

  describe('previewUpgrade', () => {
    const preview = {
      payload: { version: 1, prompts: [], profiles: [], agents: [], statuses: [] },
      providerSummary: [],
      familyAlternatives: [],
      presetProviderCoverage: [],
      localAvailability: { installedProviders: [] },
    };

    it('resolves a registry preview from the exact cached slug and version', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        source: 'registry',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      const content = { _manifest: { version: '2.0.0' }, prompts: [] };
      mockCacheService.getTemplate.mockResolvedValue({
        content,
        metadata: {
          slug: 'test-template',
          version: '2.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockProjectsService.setupPreview.mockResolvedValue(preview as never);

      await expect(
        service.previewUpgrade({ projectId: 'project-123', targetVersion: '2.0.0' }),
      ).resolves.toBe(preview);
      expect(mockCacheService.getTemplate).toHaveBeenCalledWith('test-template', '2.0.0');
      expect(mockProjectsService.setupPreview).toHaveBeenCalledWith({ rawContent: content });
      expect(mockUnifiedTemplateService.getBundledTemplate).not.toHaveBeenCalled();
    });

    it('resolves a bundled preview without falling back to the registry cache', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'bundled-template',
        source: 'bundled',
        installedVersion: '1.0.0',
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });
      const content = { _manifest: { version: '2.0.0' }, prompts: [] };
      mockUnifiedTemplateService.getBundledTemplate.mockReturnValue({
        content,
        source: 'bundled',
        version: null,
      });
      mockProjectsService.setupPreview.mockResolvedValue(preview as never);

      await expect(
        service.previewUpgrade({ projectId: 'project-123', targetVersion: '2.0.0' }),
      ).resolves.toBe(preview);
      expect(mockProjectsService.setupPreview).toHaveBeenCalledWith({ rawContent: content });
      expect(mockCacheService.getTemplate).not.toHaveBeenCalled();
    });

    it('rejects a cached payload whose manifest version differs from the requested target', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        source: 'registry',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '1.5.0' }, prompts: [] },
        metadata: {
          slug: 'test-template',
          version: '2.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });

      await expect(
        service.previewUpgrade({ projectId: 'project-123', targetVersion: '2.0.0' }),
      ).resolves.toEqual({
        success: false,
        mutationStarted: false,
        error: 'Cached template version is 1.5.0, not 2.0.0',
      });
      expect(mockProjectsService.setupPreview).not.toHaveBeenCalled();
    });

    it('returns a structured pre-mutation failure when target content is invalid', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        source: 'registry',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '2.0.0' } },
        metadata: {
          slug: 'test-template',
          version: '2.0.0',
          checksum: 'abc',
          cachedAt: '',
          size: 0,
        },
      });
      mockProjectsService.setupPreview.mockRejectedValue(new ValidationError('Invalid content'));

      await expect(
        service.previewUpgrade({ projectId: 'project-123', targetVersion: '2.0.0' }),
      ).resolves.toEqual({
        success: false,
        mutationStarted: false,
        error: 'Target template content is invalid',
      });
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
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
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
        content: { _manifest: { version: '2.0.0' }, prompts: [{ id: '1' }] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(true);
      expect(result.newVersion).toBe('2.0.0');
      expect(result.promptTransfer).toEqual({
        imported: 2,
        deleted: 1,
        preserved: 3,
        skipped: 4,
      });
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
      const backupPayload = {
        ...createMockExportData(),
        profiles: [
          {
            id: 'profile-1',
            name: 'Coder',
            providerConfigs: [
              {
                name: 'default',
                providerName: 'claude',
                env: { ANTHROPIC_API_KEY: 'sk-backup-secret' },
              },
            ],
          },
        ],
      };
      mockProjectsService.exportProject.mockResolvedValue(backupPayload);
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
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
      expect(mockProjectsService.importProject).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          payload: backupPayload,
          promptTransferPolicy: 'snapshot',
        }),
      );
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
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
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
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
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
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
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

    it('does not inject familyProviderMappings when the caller omits it', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      mockProjectsService.importProject.mockResolvedValue({ success: true, warnings: [] });

      await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(mockProjectsService.importProject).toHaveBeenCalledWith({
        projectId: 'project-123',
        payload: { _manifest: { version: '2.0.0' }, prompts: [] },
        dryRun: false,
      });
    });

    it('forwards the caller configuration exactly without injecting defaults', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      const content = { _manifest: { version: '2.0.0' }, prompts: [] };
      mockCacheService.getTemplate.mockResolvedValue({
        content,
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      const controls = {
        selectedProviderNames: ['claude', 'codex'],
        familyProviderMappings: { anthropic: 'claude' },
        agentOverrides: [{ agentName: 'Coder', providerConfigName: 'Claude Default' }],
        teamOverrides: [{ teamName: 'Builders', maxMembers: 4 }],
        statusMappings: { Review: 'status-review' },
      };

      await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
        ...controls,
      });

      expect(mockProjectsService.importProject).toHaveBeenCalledWith({
        projectId: 'project-123',
        payload: content,
        dryRun: false,
        ...controls,
      });
    });

    it('blocks active sessions before creating a backup', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      mockSessionsService.getActiveSessionsForProject.mockReturnValue([
        { id: 'session-1', agentId: 'agent-1' } as never,
      ]);

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result).toMatchObject({
        success: false,
        mutationStarted: false,
        readiness: {
          ready: false,
          issues: [{ code: 'active_sessions' }],
        },
      });
      expect(mockProjectsService.exportProject).not.toHaveBeenCalled();
      expect(mockProjectsService.importProject).not.toHaveBeenCalled();
    });

    it('discards the unused backup when the import race guard finds a late session', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      const readiness = {
        ready: false as const,
        issues: [
          {
            code: 'active_sessions' as const,
            message: 'Import aborted: active agent sessions detected',
            details: { activeSessions: [{ id: 'session-late', agentId: 'agent-1' }] },
          },
        ],
      };
      mockProjectsService.importProject.mockResolvedValue({
        success: false,
        mutationStarted: false,
        error: readiness.issues[0].message,
        readiness,
      });

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result).toEqual({
        success: false,
        mutationStarted: false,
        error: readiness.issues[0].message,
        readiness,
      });
      expect(service.getProjectBackups('project-123')).toEqual([]);
      expect(result).not.toHaveProperty('backupId');
      expect(result).not.toHaveProperty('restored');
      expect(mockProjectsService.importProject).toHaveBeenCalledTimes(1);
    });

    it('session preserved when agent name still present in target template', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'dev-team',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: {
          _manifest: { version: '2.0.0' },
          prompts: [],
          agents: [{ name: 'Architect' }],
        },
        metadata: { slug: 'dev-team', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      // importProject returns success with preservation counts — Architect session preserved
      mockProjectsService.importProject.mockResolvedValue({
        ...createMockImportResult(),
        sessionPreservation: { preservedCount: 1, removedCount: 0 },
      });

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(true);
      expect(mockProjectsService.importProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-123', dryRun: false }),
      );
    });

    it('sessions deleted when agent dropped from target template', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'dev-team',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '2.0.0' }, prompts: [], agents: [] }, // Reviewer dropped from new template
        metadata: { slug: 'dev-team', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      // importProject returns success with removal counts — Reviewer session deleted
      mockProjectsService.importProject.mockResolvedValue({
        ...createMockImportResult(),
        sessionPreservation: { preservedCount: 0, removedCount: 1 },
      });

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(true);
      expect(mockProjectsService.importProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project-123', dryRun: false }),
      );
    });

    it('should return error and keep backup when import fails without throwing', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      // importProject returns generic failure (success: false without providerMappingRequired)
      mockProjectsService.importProject.mockResolvedValue({ success: false });

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Template import failed');
      expect(result.backupId).toBeDefined();
      // Metadata should NOT be updated
      expect(mockSettingsService.setProjectTemplateMetadata).not.toHaveBeenCalled();
      // Backup should be kept for manual recovery
      const backups = service.getProjectBackups('project-123');
      expect(backups).toHaveLength(1);
    });

    it('does not restore or write metadata for a non-mutating prompt preflight rejection', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockCacheService.getTemplate.mockResolvedValue({
        content: { _manifest: { version: '2.0.0' }, prompts: [] },
        metadata: { slug: 'test', version: '2.0.0', checksum: 'abc', cachedAt: '', size: 0 },
      });
      mockProjectsService.importProject.mockResolvedValue({
        success: false,
        mutationStarted: false,
        error: 'Template profiles reference prompts excluded from template transfer: "Private SOP"',
        promptReferenceValidation: {
          code: 'skipped_prompt_references',
          promptTitles: ['Private SOP'],
          issues: [{ promptTitle: 'Private SOP', profileNames: ['Coder'] }],
        },
      });

      const result = await service.upgradeProject({
        projectId: 'project-123',
        targetVersion: '2.0.0',
      });

      expect(result).toMatchObject({
        success: false,
        mutationStarted: false,
        error: expect.stringContaining('Private SOP'),
        promptReferenceValidation: {
          promptTitles: ['Private SOP'],
        },
      });
      expect(mockProjectsService.importProject).toHaveBeenCalledTimes(1);
      expect(mockSettingsService.setProjectTemplateMetadata).not.toHaveBeenCalled();
      expect(service.getProjectBackups('project-123')).toEqual([]);
    });

    describe('bundled templates', () => {
      it('should upgrade bundled template successfully', async () => {
        mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'bundled-template',
          source: 'bundled',
          installedVersion: '1.0.0',
          registryUrl: null,
          installedAt: new Date().toISOString(),
        });
        mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
        mockUnifiedTemplateService.getBundledTemplate.mockReturnValue({
          content: { prompts: [], _manifest: { version: '2.0.0' } },
          source: 'bundled',
          version: null,
        });
        mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

        const result = await service.upgradeProject({
          projectId: 'project-123',
          targetVersion: '2.0.0',
        });

        expect(result.success).toBe(true);
        expect(result.newVersion).toBe('2.0.0');
        expect(mockUnifiedTemplateService.getBundledTemplate).toHaveBeenCalledWith(
          'bundled-template',
        );
        expect(mockCacheService.getTemplate).not.toHaveBeenCalled();
      });

      it('should return error when bundled template not found', async () => {
        mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'nonexistent-bundled',
          source: 'bundled',
          installedVersion: '1.0.0',
          registryUrl: null,
          installedAt: new Date().toISOString(),
        });
        mockUnifiedTemplateService.getBundledTemplate.mockImplementation(() => {
          throw new NotFoundError('Template', 'nonexistent-bundled');
        });

        const result = await service.upgradeProject({
          projectId: 'project-123',
          targetVersion: '2.0.0',
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('should return error when bundled version does not match target', async () => {
        mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'bundled-template',
          source: 'bundled',
          installedVersion: '1.0.0',
          registryUrl: null,
          installedAt: new Date().toISOString(),
        });
        mockUnifiedTemplateService.getBundledTemplate.mockReturnValue({
          content: { prompts: [], _manifest: { version: '1.5.0' } }, // Different version
          source: 'bundled',
          version: null,
        });

        const result = await service.upgradeProject({
          projectId: 'project-123',
          targetVersion: '2.0.0', // Requesting 2.0.0 but bundled is 1.5.0
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Bundled template version is 1.5.0, not 2.0.0');
      });

      it('should not use cache service for bundled templates', async () => {
        mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
          templateSlug: 'bundled-template',
          source: 'bundled',
          installedVersion: '1.0.0',
          registryUrl: null,
          installedAt: new Date().toISOString(),
        });
        mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
        mockUnifiedTemplateService.getBundledTemplate.mockReturnValue({
          content: { prompts: [], _manifest: { version: '2.0.0' } },
          source: 'bundled',
          version: null,
        });
        mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

        await service.upgradeProject({
          projectId: 'project-123',
          targetVersion: '2.0.0',
        });

        expect(mockCacheService.getTemplate).not.toHaveBeenCalled();
      });
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
      mockSettingsService.getProjectActivePreset.mockReturnValue('balanced');

      const backupId = await service.createBackup('project-123');

      // Now restore
      await service.restoreBackup(backupId);

      expect(mockProjectsService.importProject).toHaveBeenCalledWith({
        projectId: 'project-123',
        payload: expect.objectContaining({
          prompts: [{ id: '1', title: 'Test', content: '', version: 1, tags: [] }],
        }),
        dryRun: false,
        promptTransferPolicy: 'snapshot',
      });
      expect(mockSettingsService.setProjectActivePreset).toHaveBeenCalledWith(
        'project-123',
        'balanced',
      );
      expect(mockProjectsService.importProject.mock.invocationCallOrder[0]).toBeLessThan(
        mockSettingsService.setProjectTemplateMetadata.mock.invocationCallOrder[0],
      );
      expect(
        mockSettingsService.setProjectTemplateMetadata.mock.invocationCallOrder[0],
      ).toBeLessThan(mockSettingsService.setProjectActivePreset.mock.invocationCallOrder[0]);
    });

    it('should restore an explicitly null active preset sidecar', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockSettingsService.getProjectActivePreset.mockReturnValue(null);
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());

      const backupId = await service.createBackup('project-123');
      await service.restoreBackup(backupId);

      expect(mockSettingsService.setProjectActivePreset).toHaveBeenCalledWith('project-123', null);
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

    it('should include source field when restoring registry template metadata', async () => {
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
          registryUrl: 'https://test.com',
        }),
      );
    });

    it('should restore bundled template with correct source and null registryUrl', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'bundled-template',
        source: 'bundled',
        installedVersion: '1.0.0',
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockProjectsService.importProject.mockResolvedValue(createMockImportResult());

      const backupId = await service.createBackup('project-123');
      await service.restoreBackup(backupId);

      expect(mockSettingsService.setProjectTemplateMetadata).toHaveBeenCalledWith(
        'project-123',
        expect.objectContaining({
          source: 'bundled',
          templateSlug: 'bundled-template',
          installedVersion: '1.0.0',
          registryUrl: null,
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
      mockSettingsService.getProjectActivePreset.mockReturnValue('sensitive-preset-name');
      mockProjectsService.exportProject.mockResolvedValue({
        ...createMockExportData(),
        profiles: [{ providerConfigs: [{ env: { API_KEY: 'raw-secret-value' } }] }],
      });

      const backupId = await service.createBackup('project-123');

      const info = service.getBackupInfo(backupId);

      expect(info).toEqual({
        projectId: 'project-123',
        createdAt: expect.any(String),
        fromVersion: '1.0.0',
      });
      expect(info).not.toHaveProperty('data');
      expect(info).not.toHaveProperty('activePreset');
      expect(JSON.stringify(info)).not.toContain('raw-secret-value');
      expect(JSON.stringify(info)).not.toContain('sensitive-preset-name');
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
      mockSettingsService.getProjectActivePreset.mockReturnValue('sensitive-preset-name');
      mockProjectsService.exportProject.mockResolvedValue({
        ...createMockExportData(),
        profiles: [{ providerConfigs: [{ env: { API_KEY: 'raw-secret-value' } }] }],
      });

      await service.createBackup('project-123');
      // Small delay to ensure unique timestamps
      await new Promise((resolve) => setTimeout(resolve, 5));
      await service.createBackup('project-123');

      const backups = service.getProjectBackups('project-123');

      expect(backups.length).toBeGreaterThanOrEqual(1);
      expect(backups[0]).toEqual({
        backupId: expect.stringMatching(/^backup-project-123-\d+$/),
        createdAt: expect.any(String),
      });
      expect(backups[0]).not.toHaveProperty('data');
      expect(backups[0]).not.toHaveProperty('activePreset');
      expect(JSON.stringify(backups)).not.toContain('raw-secret-value');
      expect(JSON.stringify(backups)).not.toContain('sensitive-preset-name');
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
      expect(service.getBackupInfo(backupId)).not.toBeNull();
      expect(mockSettingsService.setProjectTemplateMetadata).not.toHaveBeenCalled();
    });

    it('retains the backup and metadata when restore resolves without success=true', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      const backupId = await service.createBackup('project-123');
      mockProjectsService.importProject.mockResolvedValue({
        success: false,
        error: 'snapshot rejected',
      });

      await expect(service.restoreBackup(backupId)).rejects.toThrow(
        'Backup restore import failed: snapshot rejected',
      );

      expect(service.getBackupInfo(backupId)).not.toBeNull();
      expect(mockSettingsService.setProjectTemplateMetadata).not.toHaveBeenCalled();
    });

    it('rejects a truthy non-boolean restore result without cleanup', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      const backupId = await service.createBackup('project-123');
      mockProjectsService.importProject.mockResolvedValue({ success: 'yes' } as never);

      await expect(service.restoreBackup(backupId)).rejects.toThrow('Backup restore import failed');

      expect(service.getBackupInfo(backupId)).not.toBeNull();
      expect(mockSettingsService.setProjectTemplateMetadata).not.toHaveBeenCalled();
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

    it('should retain the backup when active preset restoration fails', async () => {
      mockSettingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'test-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://test.com',
        installedAt: new Date().toISOString(),
      });
      mockSettingsService.getProjectActivePreset.mockReturnValue('balanced');
      mockProjectsService.exportProject.mockResolvedValue(createMockExportData());
      mockSettingsService.setProjectActivePreset.mockRejectedValue(
        new Error('Active preset restore failed'),
      );

      const backupId = await service.createBackup('project-123');

      await expect(service.restoreBackup(backupId)).rejects.toThrow('Active preset restore failed');
      expect(mockSettingsService.setProjectTemplateMetadata).toHaveBeenCalled();
      expect(service.getBackupInfo(backupId)).not.toBeNull();
    });
  });

  describe('backup expiration', () => {
    let serviceWithFakeTimers: ProjectTemplateUpgradeService;

    beforeEach(() => {
      jest.useFakeTimers();

      serviceWithFakeTimers = new ProjectTemplateUpgradeService(
        mockProjectsService,
        mockCacheService,
        mockUnifiedTemplateService,
        mockSettingsService,
        mockSessionsService,
        createProjectWriteAdmissionStub() as never,
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
