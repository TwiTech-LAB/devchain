import { BadRequestException } from '@nestjs/common';
import { ProjectRegistryImportService } from './project-registry-import.service';
import { RegistryClientService } from '../../registry/services/registry-client.service';
import { TemplateCacheService } from '../../registry/services/template-cache.service';
import { SettingsService } from '../../settings/services/settings.service';
import { StorageService } from '../../storage/interfaces/storage.interface';
import { ProjectsService } from './projects.service';

const cachedTemplate = {
  content: { prompts: [], presets: [{ name: 'default', agentConfigs: [] }] },
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
    dryRun: false,
    missingProviders: [],
    unmatchedStatuses: [],
    templateStatuses: [],
    counts: { toImport: {}, toDelete: {} },
    imported: { prompts: 1, profiles: 2, agents: 3, statuses: 4 },
  };
}

describe('ProjectRegistryImportService', () => {
  function createHarness() {
    const registryClient = {
      downloadTemplate: jest.fn().mockResolvedValue({
        content: cachedTemplate.content,
        checksum: 'checksum',
      }),
    } as unknown as jest.Mocked<RegistryClientService>;
    const cache = {
      isCached: jest.fn().mockReturnValue(true),
      saveTemplate: jest.fn().mockResolvedValue(undefined),
      getTemplate: jest.fn().mockResolvedValue(cachedTemplate),
    } as unknown as jest.Mocked<TemplateCacheService>;
    const storage = {
      createProject: jest.fn().mockResolvedValue({
        id: 'project-1',
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
      registryClient,
      cache,
      storage,
      projects,
      settings,
    );
    return { service, registryClient, cache, storage, projects, settings };
  }

  it('creates a bare project, imports template content, and records registry metadata', async () => {
    const { service, registryClient, storage, projects, settings } = createHarness();

    const result = await service.createProjectFromRegistry({
      slug: 'template-1',
      version: '1.0.0',
      projectName: 'Project 1',
      rootPath: '/tmp/project-1',
    });

    expect(registryClient.downloadTemplate).not.toHaveBeenCalled();
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
    expect(result.imported).toEqual({ prompts: 1, profiles: 2, agents: 3, statuses: 4 });
  });

  it('downloads before import when the template is not already cached', async () => {
    const { service, registryClient, cache } = createHarness();
    cache.isCached.mockReturnValue(false);

    await service.createProjectFromRegistry({
      slug: 'template-1',
      version: '1.0.0',
      projectName: 'Project 1',
      rootPath: '/tmp/project-1',
    });

    expect(registryClient.downloadTemplate).toHaveBeenCalledWith('template-1', '1.0.0');
    expect(cache.saveTemplate).toHaveBeenCalledWith(
      'template-1',
      '1.0.0',
      cachedTemplate.content,
      expect.objectContaining({ checksum: 'checksum' }),
    );
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
