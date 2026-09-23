import { BadRequestException } from '@nestjs/common';
import { ProjectRegistryImportService } from './project-registry-import.service';
import { RegistryOrchestrationService } from '../../registry/services/registry-orchestration.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StorageService } from '../../storage/interfaces/storage.interface';
import { ProjectsService } from './projects.service';

const cachedTemplate = {
  content: {
    prompts: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Registry Custom',
        content: 'custom',
        version: 1,
        tags: ['type:custom'],
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Registry Legacy',
        content: 'legacy',
        version: 1,
        tags: [],
      },
    ],
    presets: [{ name: 'default', agentConfigs: [] }],
  },
  metadata: {
    slug: 'template-1',
    version: '1.0.0',
    checksum: 'checksum',
    cachedAt: '2026-01-01T00:00:00.000Z',
    size: 1,
  },
};

function createImportResult() {
  return {
    success: true,
    counts: {
      imported: { prompts: 2, profiles: 2, agents: 3, statuses: 4 },
      deleted: { prompts: 0 },
    },
    promptTransfer: { imported: 2, deleted: 0, preserved: 0, skipped: 0 },
  };
}

describe('ProjectRegistryImportService', () => {
  function createHarness() {
    const registryOrchestration = {
      getOrDownloadTemplate: jest.fn().mockResolvedValue(cachedTemplate),
    } as unknown as jest.Mocked<RegistryOrchestrationService>;
    const storage = {
      createProject: jest.fn().mockResolvedValue({
        id: 'project-1',
        workspaceId: '0defa017-0000-4000-8000-000000000001',
        name: 'Project 1',
        rootPath: '/tmp/project-1',
        description: null,
        isTemplate: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    } as unknown as jest.Mocked<StorageService>;
    const projects = {
      importProject: jest.fn().mockResolvedValue(createImportResult()),
    } as unknown as jest.Mocked<ProjectsService>;
    const settings = {
      setProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
      setProjectPresets: jest.fn().mockResolvedValue(undefined),
      getRegistryConfig: jest.fn().mockReturnValue({ url: 'https://registry.example' }),
    } as unknown as jest.Mocked<SettingsService>;
    const service = new ProjectRegistryImportService(
      registryOrchestration,
      storage,
      projects,
      settings,
    );
    return { service, registryOrchestration, storage, projects, settings };
  }

  it('creates a bare project, imports template content, and records registry metadata', async () => {
    const { service, registryOrchestration, storage, projects, settings } = createHarness();

    const result = await service.createProjectFromRegistry({
      slug: 'template-1',
      version: '1.0.0',
      projectName: 'Project 1',
      rootPath: '/tmp/project-1',
    });

    expect(registryOrchestration.getOrDownloadTemplate).toHaveBeenCalledWith('template-1', '1.0.0');
    expect(storage.createProject).toHaveBeenCalledWith({
      name: 'Project 1',
      description: null,
      rootPath: '/tmp/project-1',
      isTemplate: false,
    });
    expect(projects.importProject).toHaveBeenCalledWith({
      projectId: 'project-1',
      payload: cachedTemplate.content,
      dryRun: false,
    });
    expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        templateSlug: 'template-1',
        installedVersion: '1.0.0',
        registryUrl: 'https://registry.example',
      }),
    );
    expect(settings.setProjectPresets).toHaveBeenCalledWith(
      'project-1',
      cachedTemplate.content.presets,
    );
    expect(result.imported).toEqual({ prompts: 2, profiles: 2, agents: 3, statuses: 4 });
    expect(result.promptTransfer).toEqual({
      imported: 2,
      deleted: 0,
      preserved: 0,
      skipped: 0,
    });
  });

  it('passes an explicit workspace destination into the initial project mutation', async () => {
    const { service, storage } = createHarness();
    const workspaceId = '22222222-2222-4222-8222-222222222222';

    const result = await service.createProjectFromRegistry({
      slug: 'template-1',
      version: '1.0.0',
      projectName: 'Project 1',
      rootPath: '/tmp/project-1',
      workspaceId,
    });

    expect(storage.createProject).toHaveBeenCalledWith(expect.objectContaining({ workspaceId }));
    expect(result.project.workspaceId).toBe('0defa017-0000-4000-8000-000000000001');
  });

  it('waits for shared acquisition before the first project mutation', async () => {
    const { service, registryOrchestration, storage, projects } = createHarness();
    let resolveAcquisition!: (value: typeof cachedTemplate) => void;
    const acquisition = new Promise<typeof cachedTemplate>((resolve) => {
      resolveAcquisition = resolve;
    });
    registryOrchestration.getOrDownloadTemplate.mockReturnValueOnce(acquisition);

    const resultPromise = service.createProjectFromRegistry({
      slug: 'template-1',
      version: '1.0.0',
      projectName: 'Project 1',
      rootPath: '/tmp/project-1',
    });

    expect(registryOrchestration.getOrDownloadTemplate).toHaveBeenCalledWith('template-1', '1.0.0');
    expect(storage.createProject).not.toHaveBeenCalled();
    expect(projects.importProject).not.toHaveBeenCalled();

    resolveAcquisition(cachedTemplate);
    await expect(resultPromise).resolves.toEqual(expect.objectContaining({ fromRegistry: true }));
    expect(storage.createProject).toHaveBeenCalledTimes(1);
  });

  it('does not mutate when shared acquisition fails', async () => {
    const { service, registryOrchestration, storage, settings } = createHarness();
    const error = new Error('Registry unavailable');
    registryOrchestration.getOrDownloadTemplate.mockRejectedValueOnce(error);

    await expect(
      service.createProjectFromRegistry({
        slug: 'template-1',
        version: '1.0.0',
        projectName: 'Project 1',
        rootPath: '/tmp/project-1',
      }),
    ).rejects.toBe(error);

    expect(storage.createProject).not.toHaveBeenCalled();
    expect(settings.setProjectTemplateMetadata).not.toHaveBeenCalled();
    expect(settings.setProjectPresets).not.toHaveBeenCalled();
  });

  it('preserves the missing-cache error and does not mutate when acquisition returns null', async () => {
    const { service, registryOrchestration, storage, settings } = createHarness();
    registryOrchestration.getOrDownloadTemplate.mockResolvedValueOnce(null);

    await expect(
      service.createProjectFromRegistry({
        slug: 'template-1',
        version: '1.0.0',
        projectName: 'Project 1',
        rootPath: '/tmp/project-1',
      }),
    ).rejects.toMatchObject({
      response: {
        message: 'Template not found in cache after download',
        slug: 'template-1',
        version: '1.0.0',
      },
    });

    expect(storage.createProject).not.toHaveBeenCalled();
    expect(settings.setProjectTemplateMetadata).not.toHaveBeenCalled();
    expect(settings.setProjectPresets).not.toHaveBeenCalled();
  });

  it('rethrows provider mapping import failures but swallows generic import failures', async () => {
    const { service, projects, settings } = createHarness();
    projects.importProject.mockRejectedValueOnce(
      new BadRequestException({ message: 'Missing providers', missingProviders: ['openai'] }),
    );

    await expect(
      service.createProjectFromRegistry({
        slug: 'template-1',
        version: '1.0.0',
        projectName: 'Project 1',
        rootPath: '/tmp/project-1',
      }),
    ).rejects.toThrow(BadRequestException);

    projects.importProject.mockRejectedValueOnce(new Error('generic import failure'));
    await expect(
      service.createProjectFromRegistry({
        slug: 'template-1',
        version: '1.0.0',
        projectName: 'Project 1',
        rootPath: '/tmp/project-1',
      }),
    ).resolves.toEqual(expect.objectContaining({ fromRegistry: true }));
    expect(settings.setProjectTemplateMetadata).toHaveBeenCalled();
  });
});
