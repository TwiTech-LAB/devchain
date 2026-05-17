/**
 * Characterization tests — ProjectTemplateUpgradeService upgrade/recovery semantics.
 *
 * Layer: backend-unit
 * Justification: mocked Registry/Projects collaborators are the cheapest layer
 * to lock always-200 result payloads, rollback behavior, manual backups, and
 * cleanup timers before Registry/Projects ownership moves.
 */

import { ProjectTemplateUpgradeService } from './project-template-upgrade.service';

const metadata = {
  templateSlug: 'template-1',
  source: 'registry' as const,
  installedVersion: '1.0.0',
  registryUrl: 'https://registry.example',
  installedAt: '2026-01-01T00:00:00.000Z',
};

const cachedTemplate = {
  content: { _manifest: { version: '2.0.0' }, prompts: [] },
  metadata: {
    slug: 'template-1',
    version: '2.0.0',
    checksum: 'checksum',
    cachedAt: '2026-01-01T00:00:00.000Z',
    size: 1,
  },
};

const exportPayload = {
  prompts: [],
  profiles: [],
  agents: [],
  statuses: [],
  version: 1,
};

function createImportResult() {
  return {
    success: true,
    dryRun: false,
    missingProviders: [],
    unmatchedStatuses: [],
    templateStatuses: [],
    counts: { toImport: {}, toDelete: {} },
    imported: {},
  };
}

describe('ProjectTemplateUpgradeService characterization', () => {
  function createHarness() {
    const cache = { getTemplate: jest.fn().mockResolvedValue(cachedTemplate) };
    const unified = { getBundledTemplate: jest.fn() };
    const settings = {
      getProjectTemplateMetadata: jest.fn().mockReturnValue(metadata),
      setProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
      getRegistryConfig: jest.fn().mockReturnValue({ url: 'https://registry.example' }),
    };
    const projects = {
      exportProject: jest.fn().mockResolvedValue(exportPayload),
      importProject: jest.fn().mockResolvedValue(createImportResult()),
    };
    const service = new ProjectTemplateUpgradeService(
      projects as never,
      cache as never,
      unified as never,
      settings as never,
    );
    return { service, cache, settings, projects };
  }

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('returns success and deletes backup after import and metadata update', async () => {
    const { service, settings, projects } = createHarness();

    await expect(
      service.upgradeProject({ projectId: 'project-1', targetVersion: '2.0.0' }),
    ).resolves.toEqual({ success: true, newVersion: '2.0.0' });

    expect(projects.exportProject).toHaveBeenCalledWith('project-1');
    expect(projects.importProject).toHaveBeenCalledWith({
      projectId: 'project-1',
      payload: cachedTemplate.content,
      dryRun: false,
      familyProviderMappings: {},
    });
    expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ installedVersion: '2.0.0' }),
    );
    expect(service.getProjectBackups('project-1')).toEqual([]);
  });

  it('auto-restores on thrown import failure and returns restored=true without backupId', async () => {
    const { service, projects } = createHarness();
    projects.importProject
      .mockRejectedValueOnce(new Error('upgrade import failed'))
      .mockResolvedValueOnce(createImportResult());

    await expect(
      service.upgradeProject({ projectId: 'project-1', targetVersion: '2.0.0' }),
    ).resolves.toEqual({
      success: false,
      error: 'upgrade import failed',
      restored: true,
    });
    expect(projects.importProject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ projectId: 'project-1', payload: exportPayload, dryRun: false }),
    );
    expect(service.getProjectBackups('project-1')).toEqual([]);
  });

  it('retains manual backup when import returns success=false', async () => {
    const { service, projects } = createHarness();
    projects.importProject.mockResolvedValueOnce({ success: false });

    const result = await service.upgradeProject({ projectId: 'project-1', targetVersion: '2.0.0' });

    expect(result).toEqual({
      success: false,
      error: 'Template import failed',
      backupId: expect.stringMatching(/^backup-project-1-\d+$/),
    });
    expect(service.getBackupInfo(result.backupId!)).toEqual(
      expect.objectContaining({ projectId: 'project-1', fromVersion: '1.0.0' }),
    );
  });

  it('retains manual backup when upgrade and auto-restore both throw, then manual restore deletes it', async () => {
    const { service, projects } = createHarness();
    projects.importProject
      .mockRejectedValueOnce(new Error('upgrade import failed'))
      .mockRejectedValueOnce(new Error('restore failed'))
      .mockResolvedValueOnce(createImportResult());

    const result = await service.upgradeProject({ projectId: 'project-1', targetVersion: '2.0.0' });
    expect(result).toEqual({
      success: false,
      error: 'upgrade import failed',
      restored: false,
      backupId: expect.stringMatching(/^backup-project-1-\d+$/),
    });

    await service.restoreBackup(result.backupId!);

    expect(service.getBackupInfo(result.backupId!)).toBeNull();
  });

  it('uses always-200 result semantics for validation failures before backup creation', async () => {
    const { service, settings, projects, cache } = createHarness();

    settings.getProjectTemplateMetadata.mockReturnValueOnce(null);
    await expect(
      service.upgradeProject({ projectId: 'project-1', targetVersion: '2.0.0' }),
    ).resolves.toEqual({ success: false, error: 'Project not linked to a template' });

    settings.getProjectTemplateMetadata.mockReturnValueOnce({ ...metadata, source: 'file' });
    await expect(
      service.upgradeProject({ projectId: 'project-1', targetVersion: '2.0.0' }),
    ).resolves.toEqual({ success: false, error: 'File-based templates cannot be upgraded' });

    cache.getTemplate.mockResolvedValueOnce(null);
    await expect(
      service.upgradeProject({ projectId: 'project-1', targetVersion: '9.0.0' }),
    ).resolves.toEqual({
      success: false,
      error: 'Version 9.0.0 is not cached. Please download it first from the Registry page.',
    });

    expect(projects.exportProject).not.toHaveBeenCalled();
  });

  it('cleans up expired backups on the unrefed cleanup interval', async () => {
    jest.useFakeTimers();
    const { service, projects } = createHarness();
    projects.importProject.mockResolvedValueOnce({ success: false });
    service.onModuleInit();

    const result = await service.upgradeProject({ projectId: 'project-1', targetVersion: '2.0.0' });
    expect(service.getBackupInfo(result.backupId!)).not.toBeNull();

    await jest.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(service.getBackupInfo(result.backupId!)).not.toBeNull();

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(service.getBackupInfo(result.backupId!)).toBeNull();
    service.onModuleDestroy();
  });
});
