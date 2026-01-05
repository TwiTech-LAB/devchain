import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from '../services/projects.service';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Project } from '../../storage/models/domain.models';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('ProjectsController', () => {
  let controller: ProjectsController;
  let storage: jest.Mocked<
    Pick<
      StorageService,
      | 'createProject'
      | 'getProject'
      | 'updateProject'
      | 'listProjects'
      | 'findProjectByPath'
      | 'deleteProject'
      | 'listAgentProfiles'
    >
  >;
  let projectsService: jest.Mocked<Partial<ProjectsService>>;
  let settingsService: jest.Mocked<
    Pick<
      SettingsService,
      | 'getProjectTemplateMetadata'
      | 'getAllProjectTemplateMetadataMap'
      | 'clearProjectTemplateMetadata'
    >
  >;

  beforeEach(async () => {
    storage = {
      createProject: jest.fn(),
      getProject: jest.fn(),
      updateProject: jest.fn(),
      listProjects: jest.fn(),
      findProjectByPath: jest.fn(),
      deleteProject: jest.fn(),
      listAgentProfiles: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 }),
    };

    projectsService = {
      listTemplates: jest.fn(),
      createFromTemplate: jest.fn(),
      exportProject: jest.fn(),
      importProject: jest.fn(),
      getTemplateManifestForProject: jest.fn(),
      getBundledUpgradesForProjects: jest.fn().mockReturnValue(new Map()),
    };

    settingsService = {
      getProjectTemplateMetadata: jest.fn().mockReturnValue(null),
      getAllProjectTemplateMetadataMap: jest.fn().mockReturnValue(new Map()),
      clearProjectTemplateMetadata: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
        {
          provide: ProjectsService,
          useValue: projectsService,
        },
        {
          provide: SettingsService,
          useValue: settingsService,
        },
      ],
    }).compile();

    controller = module.get(ProjectsController);
  });

  function makeProject(overrides: Partial<Project> = {}): Project {
    const now = new Date().toISOString();
    return {
      id: overrides.id ?? 'p1',
      name: overrides.name ?? 'Project One',
      description: overrides.description ?? null,
      rootPath: overrides.rootPath ?? '/tmp/one',
      isTemplate: overrides.isTemplate ?? false,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  // Legacy POST /api/projects removed; creation is template-only now.

  describe('GET /api/projects/:id', () => {
    it('returns project with templateMetadata for registry template', async () => {
      const project = makeProject({ id: 'p1' });
      storage.getProject.mockResolvedValue(project);
      settingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'my-template',
        source: 'registry',
        installedVersion: '2.0.0',
        registryUrl: 'https://registry.example.com',
        installedAt: new Date().toISOString(),
      });

      const result = await controller.getProject('p1');

      expect(result.templateMetadata).toEqual({
        slug: 'my-template',
        version: '2.0.0',
        source: 'registry',
      });
    });

    it('returns project with templateMetadata for bundled template', async () => {
      const project = makeProject({ id: 'p1' });
      storage.getProject.mockResolvedValue(project);
      settingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'empty-project',
        source: 'bundled',
        installedVersion: null,
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });

      const result = await controller.getProject('p1');

      expect(result.templateMetadata).toEqual({
        slug: 'empty-project',
        version: null,
        source: 'bundled',
      });
    });

    it('returns project with null templateMetadata when not linked', async () => {
      const project = makeProject({ id: 'p1' });
      storage.getProject.mockResolvedValue(project);
      settingsService.getProjectTemplateMetadata.mockReturnValue(null);

      const result = await controller.getProject('p1');

      expect(result.templateMetadata).toBeNull();
    });
  });

  describe('GET /api/projects (list)', () => {
    it('returns projects with templateMetadata', async () => {
      const project1 = makeProject({ id: 'p1', name: 'Project 1' });
      const project2 = makeProject({ id: 'p2', name: 'Project 2' });
      storage.listProjects.mockResolvedValue({
        items: [project1, project2],
        total: 2,
        limit: 100,
        offset: 0,
      });

      // Mock different metadata for each project using batch method
      const metadataMap = new Map();
      metadataMap.set('p1', {
        templateSlug: 'template-a',
        source: 'registry',
        installedVersion: '1.0.0',
        registryUrl: 'https://registry.example.com',
        installedAt: new Date().toISOString(),
      });
      // p2 has no metadata (not in map)
      settingsService.getAllProjectTemplateMetadataMap.mockReturnValue(metadataMap);

      const result = await controller.listProjects();

      expect(result.items).toHaveLength(2);
      expect(result.items[0].templateMetadata).toEqual({
        slug: 'template-a',
        version: '1.0.0',
        source: 'registry',
      });
      expect(result.items[1].templateMetadata).toBeNull();
    });

    it('defaults source to registry for backward compatibility', async () => {
      const project = makeProject({ id: 'p1' });
      storage.listProjects.mockResolvedValue({
        items: [project],
        total: 1,
        limit: 100,
        offset: 0,
      });

      // Simulate old metadata without source field using the batch method
      const metadataMap = new Map();
      metadataMap.set('p1', {
        templateSlug: 'old-template',
        installedVersion: '1.0.0',
        registryUrl: 'https://registry.example.com',
        installedAt: new Date().toISOString(),
        // No source field
      });
      settingsService.getAllProjectTemplateMetadataMap.mockReturnValue(metadataMap);

      const result = await controller.listProjects();

      expect(result.items[0].templateMetadata?.source).toBe('registry');
    });

    it('includes bundledUpgradeAvailable in response', async () => {
      const project1 = makeProject({ id: 'p1', name: 'Project 1' });
      const project2 = makeProject({ id: 'p2', name: 'Project 2' });
      storage.listProjects.mockResolvedValue({
        items: [project1, project2],
        total: 2,
        limit: 100,
        offset: 0,
      });

      // p1 is a bundled template with upgrade available
      const metadataMap = new Map();
      metadataMap.set('p1', {
        templateSlug: 'bundled-template',
        installedVersion: '1.0.0',
        source: 'bundled',
        registryUrl: null,
        installedAt: new Date().toISOString(),
      });
      // p2 is a registry template
      metadataMap.set('p2', {
        templateSlug: 'registry-template',
        installedVersion: '2.0.0',
        source: 'registry',
        registryUrl: 'https://registry.example.com',
        installedAt: new Date().toISOString(),
      });
      settingsService.getAllProjectTemplateMetadataMap.mockReturnValue(metadataMap);

      // Mock upgrade check - p1 has upgrade available to 2.0.0
      const upgradesMap = new Map<string, string | null>();
      upgradesMap.set('p1', '2.0.0');
      upgradesMap.set('p2', null);
      projectsService.getBundledUpgradesForProjects.mockReturnValue(upgradesMap);

      const result = await controller.listProjects();

      expect(result.items).toHaveLength(2);
      expect(result.items[0].bundledUpgradeAvailable).toBe('2.0.0');
      expect(result.items[1].bundledUpgradeAvailable).toBeNull();

      // Verify getBundledUpgradesForProjects was called with correct data
      expect(projectsService.getBundledUpgradesForProjects).toHaveBeenCalledWith([
        {
          projectId: 'p1',
          templateSlug: 'bundled-template',
          installedVersion: '1.0.0',
          source: 'bundled',
        },
        {
          projectId: 'p2',
          templateSlug: 'registry-template',
          installedVersion: '2.0.0',
          source: 'registry',
        },
      ]);
    });
  });

  it('PUT/GET: toggles isTemplate and getProject returns updated value', async () => {
    storage.updateProject.mockImplementation(async (_id: string, data: Partial<Project>) =>
      makeProject({ ...data }),
    );
    storage.getProject.mockResolvedValue(makeProject({ isTemplate: false }));

    const updated = await controller.updateProject('p1', { isTemplate: false });
    expect(updated.isTemplate).toBe(false);

    const fetched = await controller.getProject('p1');
    expect(fetched.isTemplate).toBe(false);
  });

  describe('GET /api/projects/by-path', () => {
    it('returns project with templateMetadata when found by absolute Unix path', async () => {
      const project = makeProject({ id: 'p1', rootPath: '/home/user/project' });
      storage.findProjectByPath.mockResolvedValue(project);
      settingsService.getProjectTemplateMetadata.mockReturnValue({
        templateSlug: 'my-template',
        source: 'registry',
        installedVersion: '1.0.0',
        registryUrl: 'https://registry.example.com',
        installedAt: new Date().toISOString(),
      });

      const result = await controller.getProjectByPath('/home/user/project');

      expect(result).toMatchObject({
        ...project,
        templateMetadata: {
          slug: 'my-template',
          version: '1.0.0',
          source: 'registry',
        },
      });
      expect(storage.findProjectByPath).toHaveBeenCalledWith('/home/user/project');
    });

    it('returns project with null templateMetadata when no metadata exists', async () => {
      const project = makeProject({ id: 'p1', rootPath: 'C:\\Users\\user\\project' });
      storage.findProjectByPath.mockResolvedValue(project);
      settingsService.getProjectTemplateMetadata.mockReturnValue(null);

      const result = await controller.getProjectByPath('C:\\Users\\user\\project');

      expect(result.templateMetadata).toBeNull();
      expect(storage.findProjectByPath).toHaveBeenCalledWith('C:\\Users\\user\\project');
    });

    it('throws BadRequestException when path parameter is missing', async () => {
      await expect(controller.getProjectByPath(undefined)).rejects.toThrow(
        'path query parameter is required',
      );

      expect(storage.findProjectByPath).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when path is not absolute (relative path)', async () => {
      await expect(controller.getProjectByPath('relative/path')).rejects.toThrow(
        'path must be an absolute path',
      );

      expect(storage.findProjectByPath).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when project not found', async () => {
      storage.findProjectByPath.mockResolvedValue(null);

      await expect(controller.getProjectByPath('/nonexistent/path')).rejects.toThrow(
        'No project found with rootPath: /nonexistent/path',
      );

      expect(storage.findProjectByPath).toHaveBeenCalledWith('/nonexistent/path');
    });
  });

  describe('POST /api/projects/from-template', () => {
    it('accepts valid slug and passes to service', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1', name: 'New Project' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      (projectsService.createFromTemplate as jest.Mock).mockResolvedValue(mockResult);

      const result = await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        slug: 'my-template',
      });

      expect(result).toEqual(mockResult);
      expect(projectsService.createFromTemplate).toHaveBeenCalledWith({
        name: 'New Project',
        description: undefined,
        rootPath: '/tmp/new',
        slug: 'my-template',
        version: null,
      });
    });

    it('accepts valid slug with version', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1', name: 'New Project' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      (projectsService.createFromTemplate as jest.Mock).mockResolvedValue(mockResult);

      await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        slug: 'my-template',
        version: '1.2.3',
      });

      expect(projectsService.createFromTemplate).toHaveBeenCalledWith({
        name: 'New Project',
        description: undefined,
        rootPath: '/tmp/new',
        slug: 'my-template',
        version: '1.2.3',
      });
    });

    it('accepts legacy templateId for backward compatibility', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      (projectsService.createFromTemplate as jest.Mock).mockResolvedValue(mockResult);

      await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        templateId: 'old-template',
      });

      expect(projectsService.createFromTemplate).toHaveBeenCalledWith({
        name: 'New Project',
        description: undefined,
        rootPath: '/tmp/new',
        slug: 'old-template',
        version: null,
      });
    });

    it('rejects invalid slug format (special characters)', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
          slug: 'invalid/slug',
        }),
      ).rejects.toThrow('Slug must contain only alphanumeric characters, hyphens, and underscores');
    });

    it('rejects invalid version format (not semver)', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
          slug: 'my-template',
          version: 'invalid-version',
        }),
      ).rejects.toThrow('Version must be in semver format');
    });

    it('accepts semver with prerelease tag', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      (projectsService.createFromTemplate as jest.Mock).mockResolvedValue(mockResult);

      await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        slug: 'my-template',
        version: '1.0.0-beta.1',
      });

      expect(projectsService.createFromTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '1.0.0-beta.1',
        }),
      );
    });

    it('rejects when neither slug nor templateId provided', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
        }),
      ).rejects.toThrow('Either slug or templateId is required');
    });

    it('accepts valid familyProviderMappings and normalizes to lowercase', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      (projectsService.createFromTemplate as jest.Mock).mockResolvedValue(mockResult);

      await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        slug: 'my-template',
        familyProviderMappings: { Coder: 'CLAUDE', Reviewer: 'Gemini' },
      });

      expect(projectsService.createFromTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          familyProviderMappings: { coder: 'claude', reviewer: 'gemini' },
        }),
      );
    });

    it('rejects familyProviderMappings with empty key', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
          slug: 'my-template',
          familyProviderMappings: { '': 'claude' },
        }),
      ).rejects.toThrow();
    });

    it('rejects familyProviderMappings with empty value', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
          slug: 'my-template',
          familyProviderMappings: { coder: '' },
        }),
      ).rejects.toThrow();
    });
  });

  describe('POST /api/projects/:id/export', () => {
    it('accepts valid manifest overrides', async () => {
      const mockExport = { version: 1, _manifest: { name: 'Test' } };
      (projectsService.exportProject as jest.Mock).mockResolvedValue(mockExport);

      const result = await controller.exportProjectWithOverrides('p1', {
        manifest: {
          slug: 'my-slug',
          name: 'My Template',
          description: 'A description',
          category: 'development',
          tags: ['tag1', 'tag2'],
          version: '1.0.0',
        },
      });

      expect(result).toEqual(mockExport);
      expect(projectsService.exportProject).toHaveBeenCalledWith('p1', {
        manifestOverrides: {
          slug: 'my-slug',
          name: 'My Template',
          description: 'A description',
          category: 'development',
          tags: ['tag1', 'tag2'],
          version: '1.0.0',
        },
      });
    });

    it('accepts empty body', async () => {
      const mockExport = { version: 1 };
      (projectsService.exportProject as jest.Mock).mockResolvedValue(mockExport);

      const result = await controller.exportProjectWithOverrides('p1', undefined);

      expect(result).toEqual(mockExport);
      expect(projectsService.exportProject).toHaveBeenCalledWith('p1', {
        manifestOverrides: undefined,
      });
    });

    it('accepts null description', async () => {
      const mockExport = { version: 1 };
      (projectsService.exportProject as jest.Mock).mockResolvedValue(mockExport);

      await controller.exportProjectWithOverrides('p1', {
        manifest: { description: null },
      });

      expect(projectsService.exportProject).toHaveBeenCalledWith('p1', {
        manifestOverrides: { description: null },
      });
    });

    it('rejects invalid slug format', async () => {
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { slug: 'Invalid Slug With Spaces' },
        }),
      ).rejects.toThrow('Invalid manifest overrides');
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { slug: 'UPPERCASE' },
        }),
      ).rejects.toThrow('Invalid manifest overrides');
    });

    it('rejects empty name', async () => {
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { name: '' },
        }),
      ).rejects.toThrow('Invalid manifest overrides');
    });

    it('rejects invalid category', async () => {
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { category: 'invalid' as 'development' },
        }),
      ).rejects.toThrow('Invalid manifest overrides');
    });

    it('rejects too many tags', async () => {
      const tooManyTags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { tags: tooManyTags },
        }),
      ).rejects.toThrow('Invalid manifest overrides');
    });

    it('rejects invalid version format', async () => {
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { version: 'not-semver' },
        }),
      ).rejects.toThrow('Invalid manifest overrides');
    });

    it('accepts valid semver with prerelease', async () => {
      const mockExport = { version: 1 };
      (projectsService.exportProject as jest.Mock).mockResolvedValue(mockExport);

      await controller.exportProjectWithOverrides('p1', {
        manifest: { version: '1.0.0-beta.1' },
      });

      expect(projectsService.exportProject).toHaveBeenCalledWith('p1', {
        manifestOverrides: { version: '1.0.0-beta.1' },
      });
    });

    it('rejects unknown fields (strict mode)', async () => {
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { unknownField: 'value' } as Record<string, unknown>,
        }),
      ).rejects.toThrow('Invalid manifest overrides');
    });

    it('rejects description exceeding max length', async () => {
      const longDescription = 'a'.repeat(2001);
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { description: longDescription },
        }),
      ).rejects.toThrow('Invalid manifest overrides');
    });

    it('rejects changelog exceeding max length', async () => {
      const longChangelog = 'a'.repeat(5001);
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { changelog: longChangelog },
        }),
      ).rejects.toThrow('Invalid manifest overrides');
    });
  });

  describe('POST /api/projects/:id/import', () => {
    it('accepts valid familyProviderMappings and normalizes to lowercase', async () => {
      const mockResult = {
        success: true,
        counts: { imported: {}, deleted: {} },
      };
      (projectsService.importProject as jest.Mock).mockResolvedValue(mockResult);

      await controller.importProject('p1', undefined, {
        familyProviderMappings: { Coder: 'CLAUDE', Reviewer: 'Gemini' },
      });

      expect(projectsService.importProject).toHaveBeenCalledWith(
        expect.objectContaining({
          familyProviderMappings: { coder: 'claude', reviewer: 'gemini' },
        }),
      );
    });

    it('passes undefined familyProviderMappings when not provided', async () => {
      const mockResult = {
        success: true,
        counts: { imported: {}, deleted: {} },
      };
      (projectsService.importProject as jest.Mock).mockResolvedValue(mockResult);

      await controller.importProject('p1', undefined, {});

      expect(projectsService.importProject).toHaveBeenCalledWith(
        expect.objectContaining({
          familyProviderMappings: undefined,
        }),
      );
    });

    it('rejects familyProviderMappings with empty key', async () => {
      await expect(
        controller.importProject('p1', undefined, {
          familyProviderMappings: { '': 'claude' },
        }),
      ).rejects.toThrow('Invalid familyProviderMappings');
    });

    it('rejects familyProviderMappings with empty value', async () => {
      await expect(
        controller.importProject('p1', undefined, {
          familyProviderMappings: { coder: '' },
        }),
      ).rejects.toThrow('Invalid familyProviderMappings');
    });

    it('rejects familyProviderMappings with non-string value', async () => {
      await expect(
        controller.importProject('p1', undefined, {
          familyProviderMappings: { coder: 123 } as unknown as Record<string, string>,
        }),
      ).rejects.toThrow('Invalid familyProviderMappings');
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('deletes project and clears template metadata', async () => {
      storage.deleteProject.mockResolvedValue(undefined);
      settingsService.clearProjectTemplateMetadata.mockResolvedValue(undefined);

      await controller.deleteProject('p1');

      expect(storage.deleteProject).toHaveBeenCalledWith('p1');
      expect(settingsService.clearProjectTemplateMetadata).toHaveBeenCalledWith('p1');
    });

    it('clears template metadata even if project had no metadata', async () => {
      storage.deleteProject.mockResolvedValue(undefined);
      settingsService.clearProjectTemplateMetadata.mockResolvedValue(undefined);

      await controller.deleteProject('project-without-metadata');

      // Should still call clear to ensure cleanup
      expect(settingsService.clearProjectTemplateMetadata).toHaveBeenCalledWith(
        'project-without-metadata',
      );
    });
  });

  describe('GET /api/projects/:id/template-manifest', () => {
    it('returns manifest when available', async () => {
      const manifest = {
        name: 'Test Template',
        version: '1.0.0',
        description: 'A test template',
      };
      (projectsService.getTemplateManifestForProject as jest.Mock).mockResolvedValue(manifest);

      const result = await controller.getTemplateManifest('p1');

      expect(result).toEqual(manifest);
      expect(projectsService.getTemplateManifestForProject).toHaveBeenCalledWith('p1');
    });

    it('returns null when no manifest available', async () => {
      (projectsService.getTemplateManifestForProject as jest.Mock).mockResolvedValue(null);

      const result = await controller.getTemplateManifest('p1');

      expect(result).toBeNull();
      expect(projectsService.getTemplateManifestForProject).toHaveBeenCalledWith('p1');
    });
  });
});
