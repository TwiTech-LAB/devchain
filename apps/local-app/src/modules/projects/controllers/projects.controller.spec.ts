import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from '../services/projects.service';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Project } from '../../storage/models/domain.models';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

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
      | 'listAllProfileProviderConfigs'
    >
  >;
  let projectsService: jest.Mocked<Partial<ProjectsService>>;
  let settingsService: jest.Mocked<
    Pick<
      SettingsService,
      | 'getProjectTemplateMetadata'
      | 'getAllProjectTemplateMetadataMap'
      | 'clearProjectTemplateMetadata'
      | 'clearProjectPresets'
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
      listAllProfileProviderConfigs: jest.fn().mockResolvedValue([]),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 }),
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
      clearProjectPresets: jest.fn(),
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

    describe('isConfigurable computation', () => {
      it('marks project as configurable when familySlug has 2+ providers via configs', async () => {
        const project = makeProject({ id: 'p1' });
        storage.listProjects.mockResolvedValue({
          items: [project],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Profile with familySlug='coder' in project p1
        storage.listAgentProfiles.mockResolvedValue({
          items: [
            {
              id: 'profile1',
              projectId: 'p1',
              familySlug: 'coder',
              providerId: 'default-provider',
              name: 'Profile 1',
              instructions: null,
              temperature: null,
              maxTokens: null,
              options: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          total: 1,
          limit: 10000,
          offset: 0,
        });

        // Two configs for the same profile but different providers
        storage.listAllProfileProviderConfigs.mockResolvedValue([
          {
            profileId: 'profile1',
            providerId: 'claude',
            id: 'c1',
            options: null,
            env: null,
            createdAt: '',
            updatedAt: '',
          },
          {
            profileId: 'profile1',
            providerId: 'gemini',
            id: 'c2',
            options: null,
            env: null,
            createdAt: '',
            updatedAt: '',
          },
        ]);

        const result = await controller.listProjects();

        expect(result.items[0].isConfigurable).toBe(true);
      });

      it('does NOT mark project as configurable when familySlug has only 1 provider', async () => {
        const project = makeProject({ id: 'p1' });
        storage.listProjects.mockResolvedValue({
          items: [project],
          total: 1,
          limit: 100,
          offset: 0,
        });

        storage.listAgentProfiles.mockResolvedValue({
          items: [
            {
              id: 'profile1',
              projectId: 'p1',
              familySlug: 'coder',
              providerId: 'default-provider',
              name: 'Profile 1',
              instructions: null,
              temperature: null,
              maxTokens: null,
              options: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          total: 1,
          limit: 10000,
          offset: 0,
        });

        // Only one config (single provider)
        storage.listAllProfileProviderConfigs.mockResolvedValue([
          {
            profileId: 'profile1',
            providerId: 'claude',
            id: 'c1',
            options: null,
            env: null,
            createdAt: '',
            updatedAt: '',
          },
        ]);

        const result = await controller.listProjects();

        expect(result.items[0].isConfigurable).toBe(false);
      });

      it('is NOT configurable when profiles have no configs (Phase 4: no providerId fallback)', async () => {
        const project = makeProject({ id: 'p1' });
        storage.listProjects.mockResolvedValue({
          items: [project],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Two profiles with same familySlug but no configs
        storage.listAgentProfiles.mockResolvedValue({
          items: [
            {
              id: 'profile1',
              projectId: 'p1',
              familySlug: 'coder',
              name: 'Profile 1',
              instructions: null,
              temperature: null,
              maxTokens: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            {
              id: 'profile2',
              projectId: 'p1',
              familySlug: 'coder',
              name: 'Profile 2',
              instructions: null,
              temperature: null,
              maxTokens: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          total: 2,
          limit: 10000,
          offset: 0,
        });

        // No configs exist - without configs, cannot determine providers
        storage.listAllProfileProviderConfigs.mockResolvedValue([]);

        const result = await controller.listProjects();

        // NOT configurable because no configs exist (Phase 4: profiles no longer have providerId)
        expect(result.items[0].isConfigurable).toBe(false);
      });

      it('does NOT mark project as configurable when no profiles have familySlug', async () => {
        const project = makeProject({ id: 'p1' });
        storage.listProjects.mockResolvedValue({
          items: [project],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Profile without familySlug
        storage.listAgentProfiles.mockResolvedValue({
          items: [
            {
              id: 'profile1',
              projectId: 'p1',
              familySlug: null,
              providerId: 'claude',
              name: 'Profile 1',
              instructions: null,
              temperature: null,
              maxTokens: null,
              options: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
          total: 1,
          limit: 10000,
          offset: 0,
        });

        storage.listAllProfileProviderConfigs.mockResolvedValue([
          {
            profileId: 'profile1',
            providerId: 'claude',
            id: 'c1',
            options: null,
            env: null,
            createdAt: '',
            updatedAt: '',
          },
          {
            profileId: 'profile1',
            providerId: 'gemini',
            id: 'c2',
            options: null,
            env: null,
            createdAt: '',
            updatedAt: '',
          },
        ]);

        const result = await controller.listProjects();

        // Not configurable because profile has no familySlug
        expect(result.items[0].isConfigurable).toBe(false);
      });
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
      ).rejects.toThrow(
        'Provide either (slug or templateId) OR templatePath, but not both or neither',
      );
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

    // templatePath parameter tests
    it('accepts valid templatePath without slug', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1', name: 'New Project' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      (projectsService.createFromTemplate as jest.Mock).mockResolvedValue(mockResult);

      const result = await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        templatePath: '/path/to/template.json',
      });

      expect(result).toEqual(mockResult);
      expect(projectsService.createFromTemplate).toHaveBeenCalledWith({
        name: 'New Project',
        description: undefined,
        rootPath: '/tmp/new',
        templatePath: '/path/to/template.json',
        familyProviderMappings: undefined,
      });
    });

    it('accepts templatePath with familyProviderMappings', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      (projectsService.createFromTemplate as jest.Mock).mockResolvedValue(mockResult);

      await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        templatePath: '/path/to/template.json',
        familyProviderMappings: { Coder: 'CLAUDE' },
      });

      expect(projectsService.createFromTemplate).toHaveBeenCalledWith({
        name: 'New Project',
        description: undefined,
        rootPath: '/tmp/new',
        templatePath: '/path/to/template.json',
        familyProviderMappings: { coder: 'claude' },
      });
    });

    it('rejects when both slug and templatePath provided', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
          slug: 'my-template',
          templatePath: '/path/to/template.json',
        }),
      ).rejects.toThrow(
        'Provide either (slug or templateId) OR templatePath, but not both or neither',
      );
    });

    it('rejects when both templateId and templatePath provided', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
          templateId: 'my-template',
          templatePath: '/path/to/template.json',
        }),
      ).rejects.toThrow(
        'Provide either (slug or templateId) OR templatePath, but not both or neither',
      );
    });

    it('rejects when version provided with templatePath', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
          templatePath: '/path/to/template.json',
          version: '1.0.0',
        }),
      ).rejects.toThrow('version cannot be specified when using templatePath');
    });

    it('rejects when neither slug, templateId, nor templatePath provided', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New Project',
          rootPath: '/tmp/new',
        }),
      ).rejects.toThrow(
        'Provide either (slug or templateId) OR templatePath, but not both or neither',
      );
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
      ).rejects.toThrow('Invalid export overrides');
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { slug: 'UPPERCASE' },
        }),
      ).rejects.toThrow('Invalid export overrides');
    });

    it('rejects empty name', async () => {
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { name: '' },
        }),
      ).rejects.toThrow('Invalid export overrides');
    });

    it('rejects invalid category', async () => {
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { category: 'invalid' as 'development' },
        }),
      ).rejects.toThrow('Invalid export overrides');
    });

    it('rejects too many tags', async () => {
      const tooManyTags = Array.from({ length: 11 }, (_, i) => `tag${i}`);
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { tags: tooManyTags },
        }),
      ).rejects.toThrow('Invalid export overrides');
    });

    it('rejects invalid version format', async () => {
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { version: 'not-semver' },
        }),
      ).rejects.toThrow('Invalid export overrides');
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
      ).rejects.toThrow('Invalid export overrides');
    });

    it('rejects description exceeding max length', async () => {
      const longDescription = 'a'.repeat(2001);
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { description: longDescription },
        }),
      ).rejects.toThrow('Invalid export overrides');
    });

    it('rejects changelog exceeding max length', async () => {
      const longChangelog = 'a'.repeat(5001);
      await expect(
        controller.exportProjectWithOverrides('p1', {
          manifest: { changelog: longChangelog },
        }),
      ).rejects.toThrow('Invalid export overrides');
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
    it('deletes project and clears template metadata, presets, and activePreset', async () => {
      storage.deleteProject.mockResolvedValue(undefined);
      settingsService.clearProjectTemplateMetadata.mockResolvedValue(undefined);
      settingsService.clearProjectPresets.mockResolvedValue(undefined);
      (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset =
        jest.fn().mockResolvedValue(undefined);

      await controller.deleteProject('p1');

      expect(storage.deleteProject).toHaveBeenCalledWith('p1');
      expect(settingsService.clearProjectTemplateMetadata).toHaveBeenCalledWith('p1');
      expect(settingsService.clearProjectPresets).toHaveBeenCalledWith('p1');
      expect(
        (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset,
      ).toHaveBeenCalledWith('p1', null);
    });

    it('clears template metadata, presets, and activePreset even if project had none', async () => {
      storage.deleteProject.mockResolvedValue(undefined);
      settingsService.clearProjectTemplateMetadata.mockResolvedValue(undefined);
      settingsService.clearProjectPresets.mockResolvedValue(undefined);
      (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset =
        jest.fn().mockResolvedValue(undefined);

      await controller.deleteProject('project-without-metadata');

      // Should still call clear to ensure cleanup
      expect(settingsService.clearProjectTemplateMetadata).toHaveBeenCalledWith(
        'project-without-metadata',
      );
      expect(settingsService.clearProjectPresets).toHaveBeenCalledWith('project-without-metadata');
      expect(
        (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset,
      ).toHaveBeenCalledWith('project-without-metadata', null);
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

  describe('GET /api/projects/:id/presets', () => {
    beforeEach(() => {
      // Add preset method to settings service mock
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets = jest.fn();
      (settingsService as { getProjectActivePreset: jest.Mock }).getProjectActivePreset =
        jest.fn();
      (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset =
        jest.fn();
      (projectsService as { doesProjectMatchPreset: jest.Mock }).doesProjectMatchPreset =
        jest.fn();
    });

    it('returns stored presets for project', async () => {
      const presets = [
        {
          name: 'default',
          description: 'Default configuration',
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

      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue(
        presets,
      );
      (settingsService as { getProjectActivePreset: jest.Mock }).getProjectActivePreset.mockReturnValue(
        null,
      );

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets, activePreset: null });
      expect(
        (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets,
      ).toHaveBeenCalledWith('p1');
    });

    it('returns empty array when no presets stored', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([]);
      (settingsService as { getProjectActivePreset: jest.Mock }).getProjectActivePreset.mockReturnValue(
        null,
      );

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets: [], activePreset: null });
    });

    it('returns activePreset when set and matches current config', async () => {
      const presets = [
        {
          name: 'default',
          description: 'Default configuration',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
      ];

      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue(
        presets,
      );
      (settingsService as { getProjectActivePreset: jest.Mock }).getProjectActivePreset.mockReturnValue(
        'default',
      );
      (projectsService as { doesProjectMatchPreset: jest.Mock }).doesProjectMatchPreset.mockResolvedValue(
        true,
      );

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets, activePreset: 'default' });
      expect(projectsService.doesProjectMatchPreset).toHaveBeenCalledWith('p1', presets[0]);
      expect(
        (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset,
      ).not.toHaveBeenCalled();
    });

    it('returns null activePreset when drifted (config no longer matches)', async () => {
      const presets = [
        {
          name: 'default',
          description: 'Default configuration',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
      ];

      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue(
        presets,
      );
      (settingsService as { getProjectActivePreset: jest.Mock }).getProjectActivePreset.mockReturnValue(
        'default',
      );
      (projectsService as { doesProjectMatchPreset: jest.Mock }).doesProjectMatchPreset.mockResolvedValue(
        false, // Drifted
      );

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets, activePreset: null });
      expect(
        (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset,
      ).toHaveBeenCalledWith('p1', null);
    });

    it('returns null activePreset when stored preset no longer exists', async () => {
      const presets = [
        {
          name: 'other-preset',
          description: 'Other configuration',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
      ];

      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue(
        presets,
      );
      (settingsService as { getProjectActivePreset: jest.Mock }).getProjectActivePreset.mockReturnValue(
        'default', // This preset no longer exists in the presets array
      );

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets, activePreset: null });
      expect(
        (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset,
      ).toHaveBeenCalledWith('p1', null);
      expect(projectsService.doesProjectMatchPreset).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when project not found', async () => {
      storage.getProject.mockRejectedValue(new Error('Project not found'));

      await expect(controller.getProjectPresets('nonexistent')).rejects.toThrow();
    });

    it('canonicalizes activePreset when stored name differs only in case (regression)', async () => {
      const presets = [
        {
          name: 'MyPreset',
          description: 'Default configuration',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
      ];

      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue(
        presets,
      );
      (settingsService as { getProjectActivePreset: jest.Mock }).getProjectActivePreset.mockReturnValue(
        'mypreset', // Stored as lowercase
      );
      (projectsService as { doesProjectMatchPreset: jest.Mock }).doesProjectMatchPreset.mockResolvedValue(
        true,
      );

      const result = await controller.getProjectPresets('p1');

      // Should canonicalize to the preset's actual name
      expect(result).toEqual({ presets, activePreset: 'MyPreset' });
      expect(
        (settingsService as { setProjectActivePreset: jest.Mock }).setProjectActivePreset,
      ).toHaveBeenCalledWith('p1', 'MyPreset');
    });
  });

  describe('POST /api/projects/:id/presets/apply', () => {
    beforeEach(() => {
      // Add preset method to settings service mock
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets = jest.fn();
      (projectsService as { applyPreset: jest.Mock }).applyPreset = jest.fn();
    });

    it('applies preset and returns updated agents', async () => {
      const projectId = 'p1';
      const presetName = 'default';

      storage.getProject.mockResolvedValue(makeProject({ id: projectId }));

      const presets = [
        {
          name: presetName,
          description: 'Default configuration',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        },
      ];
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue(
        presets,
      );

      const applyResult = { applied: 1, warnings: [] };
      (projectsService as { applyPreset: jest.Mock }).applyPreset.mockResolvedValue(applyResult);

      const updatedAgents = [
        { id: 'agent-1', name: 'Coder', profileId: 'profile-1', providerConfigId: 'config-1' },
      ];
      storage.listAgents.mockResolvedValue({
        items: updatedAgents,
        total: 1,
        limit: 1000,
        offset: 0,
      });

      const result = await controller.applyPreset(projectId, { presetName });

      expect(result).toEqual({
        applied: 1,
        warnings: [],
        agents: updatedAgents,
      });
      expect((projectsService as { applyPreset: jest.Mock }).applyPreset).toHaveBeenCalledWith(
        projectId,
        presetName,
      );
    });

    it('returns warnings when preset application has partial success', async () => {
      const projectId = 'p1';
      const presetName = 'default';

      storage.getProject.mockResolvedValue(makeProject({ id: projectId }));

      const presets = [
        {
          name: presetName,
          agentConfigs: [{ agentName: 'MissingAgent', providerConfigName: 'config' }],
        },
      ];
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue(
        presets,
      );

      const applyResult = { applied: 0, warnings: ['Agent "MissingAgent" not found in project'] };
      (projectsService as { applyPreset: jest.Mock }).applyPreset.mockResolvedValue(applyResult);

      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });

      const result = await controller.applyPreset(projectId, { presetName });

      expect(result.warnings).toContain('Agent "MissingAgent" not found in project');
    });

    it('rejects request with empty preset name', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      await expect(controller.applyPreset('p1', { presetName: '' })).rejects.toThrow();
    });

    it('throws NotFoundException when project not found', async () => {
      storage.getProject.mockRejectedValue(new Error('Project not found'));

      await expect(
        controller.applyPreset('nonexistent', { presetName: 'default' }),
      ).rejects.toThrow();
    });
  });

  describe('POST /api/projects/:id/presets', () => {
    const createProjectPresetMock = jest.fn().mockResolvedValue(undefined);

    beforeEach(() => {
      createProjectPresetMock.mockClear();
      (settingsService as { createProjectPreset: jest.Mock }).createProjectPreset =
        createProjectPresetMock;
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets = jest.fn();
    });

    const validPreset = {
      name: 'My Preset',
      description: 'A test preset',
      agentConfigs: [
        { agentName: 'Coder', providerConfigName: 'claude-config' },
        { agentName: 'Reviewer', providerConfigName: 'gemini-config' },
      ],
    };

    it('creates preset with valid data', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      const result = await controller.createPreset('p1', validPreset);

      expect(result).toEqual(validPreset);
      expect(createProjectPresetMock).toHaveBeenCalledWith('p1', validPreset);
    });

    it('creates preset with null description', async () => {
      const presetWithNullDescription = {
        name: 'Minimal Preset',
        description: null,
        agentConfigs: [{ agentName: 'Coder', providerConfigName: 'config' }],
      };

      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      const result = await controller.createPreset('p1', presetWithNullDescription);

      expect(result.description).toBeNull();
    });

    it('throws BadRequestException for invalid preset data (empty name)', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      let error: Error | undefined;
      try {
        await controller.createPreset('p1', { name: '', agentConfigs: [] });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error?.message).toContain('Invalid preset data');
    });

    it('throws BadRequestException for invalid preset data (missing agentConfigs)', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      let error: Error | undefined;
      try {
        await controller.createPreset('p1', { name: 'Test' } as unknown as Record<string, unknown>);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('throws ConflictException when name already exists', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      const createError = new Error(
        'Preset with name "My Preset" already exists (case-insensitive)',
      );
      createProjectPresetMock.mockRejectedValue(createError);

      let error: Error | undefined;
      try {
        await controller.createPreset('p1', validPreset);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(ConflictException);
    });

    it('throws NotFoundException when project not found', async () => {
      storage.getProject.mockRejectedValue(new Error('Project not found'));

      let error: Error | undefined;
      try {
        await controller.createPreset('nonexistent', validPreset);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
    });
  });

  describe('PATCH /api/projects/:id/presets', () => {
    const updateProjectPresetMock = jest.fn().mockResolvedValue(undefined);
    const getProjectPresetsMock = jest.fn().mockReturnValue([]);

    beforeEach(() => {
      updateProjectPresetMock.mockClear();
      getProjectPresetsMock.mockClear();
      (settingsService as { updateProjectPreset: jest.Mock }).updateProjectPreset =
        updateProjectPresetMock;
      (settingsService as { getProjectPresets: jest.Mock }).getProjectPresets =
        getProjectPresetsMock;
    });

    it('updates preset name', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      const updatedPresets = [
        { name: 'Renamed Preset', description: 'Original description', agentConfigs: [] },
      ];
      getProjectPresetsMock.mockReturnValue(updatedPresets);

      const result = await controller.updatePreset('p1', {
        presetName: 'existing preset',
        updates: { name: 'Renamed Preset' },
      });

      expect(result?.name).toBe('Renamed Preset');
      expect(updateProjectPresetMock).toHaveBeenCalledWith('p1', 'existing preset', {
        name: 'Renamed Preset',
      });
    });

    it('updates preset description', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      const updatedPresets = [
        {
          name: 'Existing Preset',
          description: 'New description',
          agentConfigs: [],
        },
      ];
      getProjectPresetsMock.mockReturnValue(updatedPresets);

      const result = await controller.updatePreset('p1', {
        presetName: 'Existing Preset',
        updates: { description: 'New description' },
      });

      expect(result?.description).toBe('New description');
    });

    it('updates agent configs', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      const updatedPresets = [
        {
          name: 'Existing Preset',
          description: 'Original description',
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'new-config' },
            { agentName: 'Reviewer', providerConfigName: 'review-config' },
          ],
        },
      ];
      getProjectPresetsMock.mockReturnValue(updatedPresets);

      const result = await controller.updatePreset('p1', {
        presetName: 'Existing Preset',
        updates: {
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'new-config' },
            { agentName: 'Reviewer', providerConfigName: 'review-config' },
          ],
        },
      });

      expect(result?.agentConfigs).toHaveLength(2);
    });

    it('throws BadRequestException for invalid request body', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      let error: Error | undefined;
      try {
        await controller.updatePreset('p1', {
          presetName: '',
        } as unknown as Record<string, unknown>);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('throws ConflictException when new name already exists', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      const conflictError = new Error('Preset with name "Other Preset" already exists');
      updateProjectPresetMock.mockRejectedValue(conflictError);

      let error: Error | undefined;
      try {
        await controller.updatePreset('p1', {
          presetName: 'Existing Preset',
          updates: { name: 'Other Preset' },
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(ConflictException);
    });

    it('throws NotFoundException when preset not found', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      const notFoundError = new Error('Preset "Nonexistent" not found');
      updateProjectPresetMock.mockRejectedValue(notFoundError);

      let error: Error | undefined;
      try {
        await controller.updatePreset('p1', {
          presetName: 'Nonexistent',
          updates: { name: 'New Name' },
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException for unknown fields in updates', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      let error: Error | undefined;
      try {
        await controller.updatePreset('p1', {
          presetName: 'Existing Preset',
          updates: { unknownField: 'value' } as unknown as Record<string, unknown>,
        });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(BadRequestException);
    });
  });

  describe('DELETE /api/projects/:id/presets', () => {
    const deleteProjectPresetMock = jest.fn().mockResolvedValue(undefined);

    beforeEach(() => {
      deleteProjectPresetMock.mockClear();
      (settingsService as { deleteProjectPreset: jest.Mock }).deleteProjectPreset =
        deleteProjectPresetMock;
    });

    it('deletes preset by name', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      (settingsService as { deleteProjectPreset: jest.Mock }).deleteProjectPreset.mockResolvedValue(
        undefined,
      );

      const result = await controller.deletePreset('p1', {
        presetName: 'My Preset',
      });

      expect(result).toEqual({ deleted: true });
      expect(
        (settingsService as { deleteProjectPreset: jest.Mock }).deleteProjectPreset,
      ).toHaveBeenCalledWith('p1', 'My Preset');
    });

    it('deletes preset case-insensitively', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      (settingsService as { deleteProjectPreset: jest.Mock }).deleteProjectPreset.mockResolvedValue(
        undefined,
      );

      await controller.deletePreset('p1', { presetName: 'my preset' });

      expect(
        (settingsService as { deleteProjectPreset: jest.Mock }).deleteProjectPreset,
      ).toHaveBeenCalledWith('p1', 'my preset');
    });

    it('throws BadRequestException for empty preset name', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      let error: Error | undefined;
      try {
        await controller.deletePreset('p1', {
          presetName: '',
        } as unknown as Record<string, unknown>);
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('throws NotFoundException when preset not found', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      const notFoundError = new Error('Preset "Nonexistent" not found');
      deleteProjectPresetMock.mockRejectedValue(notFoundError);

      let error: Error | undefined;
      try {
        await controller.deletePreset('p1', { presetName: 'Nonexistent' });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when project not found', async () => {
      storage.getProject.mockRejectedValue(new Error('Project not found'));

      let error: Error | undefined;
      try {
        await controller.deletePreset('nonexistent', { presetName: 'My Preset' });
      } catch (e) {
        error = e as Error;
      }

      expect(error).toBeDefined();
    });
  });
});
