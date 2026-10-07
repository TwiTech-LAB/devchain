import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from '../services/projects.service';
import { SettingsService } from '../../settings/services/settings.service';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { Project } from '../../storage/models/domain.models';
import { ProjectRegistryImportService } from '../services/project-registry-import.service';
import { ProjectTemplateUpgradeService } from '../services/project-template-upgrade.service';
import { ConflictException, HttpStatus, NotFoundException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { resetEnvConfig } from '../../../common/config/env.config';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../storage/db/schema';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';
import { createProjectWriteAdmissionStub } from '../../remotes/admission/testing/project-write-admission.stub';

const SECOND_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

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
      | 'listAgents'
    >
  >;
  let projectsService: jest.Mocked<
    Pick<
      ProjectsService,
      | 'listTemplates'
      | 'createFromTemplate'
      | 'setupPreview'
      | 'exportProject'
      | 'importProject'
      | 'updateProject'
      | 'deleteProject'
      | 'getTemplateManifestForProject'
      | 'getBundledUpgradesForProjects'
      | 'doesProjectMatchPreset'
      | 'applyPreset'
    >
  >;
  let templateUpgradeService: jest.Mocked<
    Pick<
      ProjectTemplateUpgradeService,
      'upgradeProject' | 'previewUpgrade' | 'restoreBackup' | 'getBackupInfo' | 'getProjectBackups'
    >
  >;
  let registryImportService: jest.Mocked<
    Pick<ProjectRegistryImportService, 'createProjectFromRegistry'>
  >;
  let settingsService: jest.Mocked<
    Pick<
      SettingsService,
      | 'getProjectTemplateMetadata'
      | 'getAllProjectTemplateMetadataMap'
      | 'clearProjectTemplateMetadata'
      | 'clearProjectPresets'
      | 'getProjectPresets'
      | 'getProjectActivePreset'
      | 'setProjectActivePreset'
      | 'createProjectPreset'
      | 'updateProjectPreset'
      | 'deleteProjectPreset'
    >
  >;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    resetEnvConfig();

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
      setupPreview: jest.fn(),
      exportProject: jest.fn(),
      importProject: jest.fn(),
      updateProject: jest.fn(),
      deleteProject: jest.fn(),
      getTemplateManifestForProject: jest.fn(),
      getBundledUpgradesForProjects: jest.fn().mockReturnValue(new Map()),
      doesProjectMatchPreset: jest.fn(),
      applyPreset: jest.fn(),
    };

    templateUpgradeService = {
      upgradeProject: jest.fn(),
      previewUpgrade: jest.fn(),
      restoreBackup: jest.fn(),
      getBackupInfo: jest.fn(),
      getProjectBackups: jest.fn(),
    };

    registryImportService = {
      createProjectFromRegistry: jest.fn(),
    };

    settingsService = {
      getProjectTemplateMetadata: jest.fn().mockReturnValue(null),
      getAllProjectTemplateMetadataMap: jest.fn().mockReturnValue(new Map()),
      clearProjectTemplateMetadata: jest.fn(),
      clearProjectPresets: jest.fn(),
      getProjectPresets: jest.fn().mockReturnValue([]),
      getProjectActivePreset: jest.fn().mockReturnValue(null),
      setProjectActivePreset: jest.fn(),
      createProjectPreset: jest.fn().mockResolvedValue(undefined),
      updateProjectPreset: jest.fn().mockResolvedValue(undefined),
      deleteProjectPreset: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectWriteAdmissionService, useValue: createProjectWriteAdmissionStub() },
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
        {
          provide: ProjectTemplateUpgradeService,
          useValue: templateUpgradeService,
        },
        {
          provide: ProjectRegistryImportService,
          useValue: registryImportService,
        },
      ],
    }).compile();

    controller = module.get(ProjectsController);
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    resetEnvConfig();
  });

  function makeProject(overrides: Partial<Project> = {}): Project {
    const now = new Date().toISOString();
    return {
      id: overrides.id ?? 'p1',
      workspaceId: overrides.workspaceId ?? DEFAULT_PROJECT_WORKSPACE_ID,
      name: overrides.name ?? 'Project One',
      description: overrides.description ?? null,
      rootPath: overrides.rootPath ?? '/tmp/one',
      isTemplate: overrides.isTemplate ?? false,
      createdAt: overrides.createdAt ?? now,
      updatedAt: overrides.updatedAt ?? now,
    };
  }

  // Legacy POST /api/projects removed; creation is template-only now.

  describe('template upgrade endpoints', () => {
    it('returns HTTP 200 for result-envelope POST endpoints', () => {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, ProjectsController.prototype.upgradeTemplate),
      ).toBe(HttpStatus.OK);
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          ProjectsController.prototype.previewTemplateUpgrade,
        ),
      ).toBe(HttpStatus.OK);
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, ProjectsController.prototype.restoreTemplateBackup),
      ).toBe(HttpStatus.OK);
    });

    it('validates and forwards every upgrade wizard selection', async () => {
      templateUpgradeService.upgradeProject!.mockResolvedValue({
        success: true,
        newVersion: '2.0.0',
      });
      const body = {
        targetVersion: '2.0.0',
        selectedProviderNames: [' Claude ', 'CLAUDE', 'Codex'],
        familyProviderMappings: { ' Anthropic ': ' Claude ' },
        agentOverrides: [
          {
            agentName: 'Coder',
            providerConfigName: 'Claude Default',
            modelOverride: null,
          },
        ],
        teamOverrides: [
          {
            teamName: 'Builders',
            maxMembers: 4,
            profileSelections: [{ profileName: 'Coder', configNames: ['Claude Default'] }],
          },
        ],
        statusMappings: { Review: 'status-review' },
      };

      await controller.upgradeTemplate('p1', body);

      expect(templateUpgradeService.upgradeProject).toHaveBeenCalledWith({
        projectId: 'p1',
        targetVersion: '2.0.0',
        selectedProviderNames: ['claude', 'codex'],
        familyProviderMappings: { anthropic: 'claude' },
        agentOverrides: body.agentOverrides,
        teamOverrides: body.teamOverrides,
        statusMappings: body.statusMappings,
      });
    });

    it('rejects presetName together with agentOverrides', async () => {
      await expect(
        controller.upgradeTemplate('p1', {
          targetVersion: '2.0.0',
          presetName: 'Balanced',
          agentOverrides: [{ agentName: 'Coder', providerConfigName: 'Claude Default' }],
        }),
      ).rejects.toThrow('Provide either presetName or agentOverrides, but not both');
      expect(templateUpgradeService.upgradeProject).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when restore backup belongs to another project', async () => {
      templateUpgradeService.getBackupInfo!.mockReturnValue({
        projectId: 'p2',
        createdAt: '2026-01-01T00:00:00.000Z',
        fromVersion: '1.0.0',
      });

      await expect(
        controller.restoreTemplateBackup('p1', { backupId: 'backup-p2-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(templateUpgradeService.restoreBackup).not.toHaveBeenCalled();
    });

    it('returns project-scoped backup info', async () => {
      templateUpgradeService.getBackupInfo!.mockReturnValue({
        projectId: 'p1',
        createdAt: '2026-01-01T00:00:00.000Z',
        fromVersion: '1.0.0',
      });

      await expect(controller.getTemplateBackup('p1', 'backup-p1-1')).resolves.toEqual({
        backupId: 'backup-p1-1',
        found: true,
        projectId: 'p1',
        createdAt: '2026-01-01T00:00:00.000Z',
        fromVersion: '1.0.0',
      });
    });

    it('does not leak backup info across projects', async () => {
      templateUpgradeService.getBackupInfo!.mockReturnValue({
        projectId: 'p2',
        createdAt: '2026-01-01T00:00:00.000Z',
        fromVersion: '1.0.0',
      });

      await expect(controller.getTemplateBackup('p1', 'backup-p2-1')).resolves.toEqual({
        backupId: 'backup-p2-1',
        found: false,
      });
    });
  });

  describe('GET /api/projects/:id', () => {
    it.each([
      {
        name: 'registry',
        metadata: {
          templateSlug: 'my-template',
          source: 'registry' as const,
          installedVersion: '2.0.0',
          registryUrl: 'https://registry.example.com',
          installedAt: new Date().toISOString(),
        },
        expected: { slug: 'my-template', version: '2.0.0', source: 'registry' },
      },
      {
        name: 'bundled',
        metadata: {
          templateSlug: 'empty-project',
          source: 'bundled' as const,
          installedVersion: null,
          registryUrl: null,
          installedAt: new Date().toISOString(),
        },
        expected: { slug: 'empty-project', version: null, source: 'bundled' },
      },
      { name: 'unlinked', metadata: null, expected: null },
    ])('enriches $name template metadata', async ({ metadata, expected }) => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      settingsService.getProjectTemplateMetadata.mockReturnValue(metadata);
      expect((await controller.getProject('p1')).templateMetadata).toEqual(expected);
    });
  });

  describe('GET /api/projects (list)', () => {
    it('filters both items and total by workspaceId', async () => {
      const project = makeProject({ id: 'p2', workspaceId: SECOND_WORKSPACE_ID });
      storage.listProjects.mockResolvedValue({
        items: [project],
        total: 1,
        limit: 25,
        offset: 0,
      });

      const result = await controller.listProjects('25', '0', SECOND_WORKSPACE_ID);

      expect(storage.listProjects).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
        workspaceId: SECOND_WORKSPACE_ID,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].workspaceId).toBe(SECOND_WORKSPACE_ID);
      expect(result.total).toBe(1);
    });

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
      it.each([
        {
          name: 'multiple providers',
          profileCount: 1,
          familySlug: 'coder',
          providers: ['claude', 'agy'],
          expected: true,
        },
        {
          name: 'single provider',
          profileCount: 1,
          familySlug: 'coder',
          providers: ['claude'],
          expected: false,
        },
        {
          name: 'no configs',
          profileCount: 2,
          familySlug: 'coder',
          providers: [],
          expected: false,
        },
        {
          name: 'no family',
          profileCount: 1,
          familySlug: null,
          providers: ['claude', 'agy'],
          expected: false,
        },
      ])(
        'computes configurability with $name',
        async ({ profileCount, familySlug, providers, expected }) => {
          storage.listProjects.mockResolvedValue({
            items: [makeProject({ id: 'p1' })],
            total: 1,
            limit: 100,
            offset: 0,
          });
          storage.listAgentProfiles.mockResolvedValue({
            items: Array.from({ length: profileCount }, (_, index) => ({
              id: 'profile' + (index + 1),
              projectId: 'p1',
              familySlug,
              name: 'Profile ' + (index + 1),
              instructions: null,
              temperature: null,
              maxTokens: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            })),
            total: profileCount,
            limit: 10000,
            offset: 0,
          });
          storage.listAllProfileProviderConfigs.mockResolvedValue(
            providers.map((providerId, position) => ({
              profileId: 'profile1',
              providerId,
              id: 'c' + (position + 1),
              name: providerId,
              description: null,
              options: null,
              env: null,
              model: null,
              effort: null,
              position,
              createdAt: '',
              updatedAt: '',
            })),
          );
          expect((await controller.listProjects()).items[0].isConfigurable).toBe(expected);
        },
      );
    });
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
    it('accepts legacy templateId for backward compatibility', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      projectsService.createFromTemplate.mockResolvedValue(mockResult as never);

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

    it('accepts templateId when slug is empty string', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      projectsService.createFromTemplate.mockResolvedValue(mockResult as never);

      await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        slug: '',
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

    it('treats empty templatePath as undefined when slug is provided', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      projectsService.createFromTemplate.mockResolvedValue(mockResult as never);

      await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        slug: 'my-template',
        templatePath: '',
      });

      expect(projectsService.createFromTemplate).toHaveBeenCalledWith({
        name: 'New Project',
        description: undefined,
        rootPath: '/tmp/new',
        slug: 'my-template',
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

    it('accepts valid familyProviderMappings and normalizes to lowercase', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      projectsService.createFromTemplate.mockResolvedValue(mockResult as never);

      await controller.createProjectFromTemplate({
        name: 'New Project',
        rootPath: '/tmp/new',
        slug: 'my-template',
        familyProviderMappings: { Coder: 'CLAUDE', Reviewer: 'Agy' },
      });

      expect(projectsService.createFromTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          familyProviderMappings: { coder: 'claude', reviewer: 'agy' },
        }),
      );
    });

    // templatePath parameter tests
    it('accepts valid templatePath without slug', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1', name: 'New Project' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 5 },
      };
      projectsService.createFromTemplate.mockResolvedValue(mockResult as never);

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

    it.each([
      {
        name: 'rejects when both slug and templatePath provided',
        body: {
          name: 'New Project',
          rootPath: '/tmp/new',
          slug: 'my-template',
          templatePath: '/path/to/template.json',
        },
        message: 'Provide either (slug or templateId) OR templatePath, but not both or neither',
      },
      {
        name: 'rejects when both templateId and templatePath provided',
        body: {
          name: 'New Project',
          rootPath: '/tmp/new',
          templateId: 'my-template',
          templatePath: '/path/to/template.json',
        },
        message: 'Provide either (slug or templateId) OR templatePath, but not both or neither',
      },
      {
        name: 'rejects when version provided with templatePath',
        body: {
          name: 'New Project',
          rootPath: '/tmp/new',
          templatePath: '/path/to/template.json',
          version: '1.0.0',
        },
        message: 'version cannot be specified when using templatePath',
      },
      {
        name: 'rejects when neither slug, templateId, nor templatePath provided',
        body: {
          name: 'New Project',
          rootPath: '/tmp/new',
        },
        message: 'Provide either (slug or templateId) OR templatePath, but not both or neither',
      },
    ])('$name', async ({ body, message }) => {
      await expect(controller.createProjectFromTemplate(body)).rejects.toThrow(message);
    });

    it('rejects duplicate teamName in teamOverrides', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New',
          rootPath: '/tmp/new',
          slug: 'my-template',
          teamOverrides: [{ teamName: 'Dev Team' }, { teamName: 'dev team' }],
        }),
      ).rejects.toThrow('Duplicate teamName in teamOverrides');
    });

    it('rejects when presetName and agentOverrides are both provided (400)', async () => {
      await expect(
        controller.createProjectFromTemplate({
          name: 'New',
          rootPath: '/tmp/new',
          slug: 'my-template',
          presetName: 'default',
          agentOverrides: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        }),
      ).rejects.toThrow('Provide either presetName or agentOverrides, but not both');
      expect(projectsService.createFromTemplate).not.toHaveBeenCalled();
    });

    it('accepts selectedProviderNames and normalizes them to lowercase', async () => {
      const mockResult = {
        success: true,
        project: makeProject({ id: 'p1', name: 'New' }),
        imported: { prompts: 0, profiles: 0, agents: 0, statuses: 0 },
      };
      projectsService.createFromTemplate.mockResolvedValue(mockResult as never);

      await controller.createProjectFromTemplate({
        name: 'New',
        rootPath: '/tmp/new',
        slug: 'my-template',
        selectedProviderNames: ['Claude', 'CODEX'],
      });

      expect(projectsService.createFromTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ selectedProviderNames: ['claude', 'codex'] }),
      );
    });
  });

  describe('POST /api/projects/setup-preview', () => {
    const mockPreviewResponse = {
      payload: {
        version: 1,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [],
        subscribers: [],
        teams: [],
        providerModels: [],
        providerEfforts: [],
        presets: [],
        scheduledEpics: [],
      },
      providerSummary: [
        { name: 'claude', available: true, families: ['reasoning'], agentCount: 1 },
      ],
      familyAlternatives: [
        {
          familySlug: 'reasoning',
          defaultProvider: 'claude',
          defaultProviderAvailable: true,
          availableProviders: ['claude'],
          hasAlternatives: true,
        },
      ],
      presetProviderCoverage: [
        {
          presetName: 'default',
          referencedProviders: ['claude'],
          coversAllAgents: true,
          coveredAgentNames: ['coder'],
          agentResolvedProviders: { coder: 'claude' },
        },
      ],
      localAvailability: { installedProviders: [{ id: 'prov-1', name: 'claude' }] },
    };

    it.each([
      { name: 'slug', input: { slug: 'my-template' } },
      { name: 'file path', input: { templatePath: '/abs/path/template.json' } },
      { name: 'raw content', input: { rawContent: { profiles: [], agents: [], statuses: [] } } },
    ])('dispatches setup preview from $name', async ({ input }) => {
      projectsService.setupPreview.mockResolvedValue(mockPreviewResponse);
      expect(await controller.setupPreview(input)).toBe(mockPreviewResponse);
      expect(projectsService.setupPreview).toHaveBeenCalledWith(input);
    });

    it.each([
      {
        name: 'rejects when no source is provided',
        body: {},
        message: 'Provide exactly one of slug, templatePath, or rawContent',
      },
      {
        name: 'rejects when multiple sources are provided',
        body: { slug: 'my-template', rawContent: { profiles: [] } },
        message: 'Provide exactly one of slug, templatePath, or rawContent',
      },
      {
        name: 'rejects version paired with templatePath',
        body: { templatePath: '/abs/t.json', version: '1.0.0' },
        message: 'version can only be specified together with slug',
      },
      {
        name: 'rejects version paired with rawContent',
        body: { rawContent: {}, version: '1.0.0' },
        message: 'version can only be specified together with slug',
      },
    ])('$name', async ({ body, message }) => {
      await expect(controller.setupPreview(body)).rejects.toThrow(message);
      expect(projectsService.setupPreview).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/projects/:id/export', () => {
    it('does not expose the internal Custom-prompt export option', async () => {
      projectsService.exportProject.mockResolvedValue({ version: 1 } as never);

      await controller.exportProjectWithOverrides('p1', {
        includeCustomPrompts: true,
      });

      expect(projectsService.exportProject).toHaveBeenCalledWith('p1', {
        manifestOverrides: undefined,
      });
    });
  });

  describe('GET /api/projects/:id/export', () => {
    it('uses the public System-only default', async () => {
      projectsService.exportProject.mockResolvedValue({ version: 1 } as never);

      await controller.exportProject('p1');

      expect(projectsService.exportProject).toHaveBeenCalledWith('p1');
    });
  });

  describe('POST /api/projects/:id/import', () => {
    it('accepts valid familyProviderMappings and normalizes to lowercase', async () => {
      const mockResult = { success: true, counts: { imported: {}, deleted: {} } };
      projectsService.importProject.mockResolvedValue(mockResult as never);

      await controller.importProject('p1', undefined, {
        familyProviderMappings: { Coder: 'CLAUDE', Reviewer: 'Agy' },
      });

      expect(projectsService.importProject).toHaveBeenCalledWith(
        expect.objectContaining({
          familyProviderMappings: { coder: 'claude', reviewer: 'agy' },
        }),
      );
    });

    it('passes undefined familyProviderMappings when not provided', async () => {
      const mockResult = { success: true, counts: { imported: {}, deleted: {} } };
      projectsService.importProject.mockResolvedValue(mockResult as never);

      await controller.importProject('p1', undefined, {});

      expect(projectsService.importProject).toHaveBeenCalledWith(
        expect.objectContaining({
          familyProviderMappings: undefined,
        }),
      );
    });

    it('rejects duplicate teamName in teamOverrides', async () => {
      await expect(
        controller.importProject('p1', undefined, {
          teamOverrides: [{ teamName: 'Dev Team' }, { teamName: 'dev team' }],
        }),
      ).rejects.toThrow('Duplicate teamName in teamOverrides');
    });

    it('validates + strips agentOverrides so they never reach the template payload', async () => {
      const mockResult = { success: true, counts: { imported: {}, deleted: {} } };
      projectsService.importProject.mockResolvedValue(mockResult as never);

      await controller.importProject('p1', undefined, {
        agentOverrides: [
          { agentName: 'Coder', providerConfigName: 'claude-config', effortOverride: 'high' },
        ],
        // Simulated template export field that must remain in the payload.
        agents: [{ name: 'Coder' }],
      } as unknown as Record<string, unknown>);

      const call = projectsService.importProject.mock.calls[0][0];
      const payload = call.payload as Record<string, unknown>;
      expect(call.agentOverrides).toEqual([
        { agentName: 'Coder', providerConfigName: 'claude-config', effortOverride: 'high' },
      ]);
      // Stripped from the ExportSchema-bound payload (would otherwise be swallowed by `...payload`).
      expect(payload.agentOverrides).toBeUndefined();
      expect(payload.agents).toEqual([{ name: 'Coder' }]);
    });

    it('rejects when presetName and agentOverrides are both provided (400)', async () => {
      await expect(
        controller.importProject('p1', undefined, {
          presetName: 'default',
          agentOverrides: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
        } as unknown as Record<string, unknown>),
      ).rejects.toThrow('Provide either presetName or agentOverrides, but not both');
      expect(projectsService.importProject).not.toHaveBeenCalled();
    });

    it('validates, forwards, and strips presetName from the template payload', async () => {
      projectsService.importProject.mockResolvedValue({
        success: true,
        counts: { imported: {}, deleted: {} },
      } as never);

      await controller.importProject('p1', undefined, {
        presetName: 'Fast',
        agents: [{ name: 'Coder' }],
      } as unknown as Record<string, unknown>);

      const call = projectsService.importProject.mock.calls[0][0];
      const payload = call.payload as Record<string, unknown>;
      expect(call.presetName).toBe('Fast');
      expect(payload.presetName).toBeUndefined();
      expect(payload.agents).toEqual([{ name: 'Coder' }]);
    });

    it('validates + normalizes + strips selectedProviderNames so they never reach the payload', async () => {
      const mockResult = { success: true, counts: { imported: {}, deleted: {} } };
      projectsService.importProject.mockResolvedValue(mockResult as never);

      await controller.importProject('p1', undefined, {
        selectedProviderNames: ['Claude', 'CODEX'],
        agents: [{ name: 'Coder' }],
      } as unknown as Record<string, unknown>);

      const call = projectsService.importProject.mock.calls[0][0];
      const payload = call.payload as Record<string, unknown>;
      expect(call.selectedProviderNames).toEqual(['claude', 'codex']);
      // Stripped from the ExportSchema-bound payload (would otherwise be swallowed by `...payload`).
      expect(payload.selectedProviderNames).toBeUndefined();
      expect(payload.agents).toEqual([{ name: 'Coder' }]);
    });
  });

  describe('GET /api/projects/:id/presets', () => {
    beforeEach(() => {
      // Add preset method to settings service mock
      settingsService.getProjectPresets = jest.fn();
      settingsService.getProjectActivePreset = jest.fn();
      settingsService.setProjectActivePreset = jest.fn();
      projectsService.doesProjectMatchPreset = jest.fn();
    });

    it('returns stored presets for project', async () => {
      const presets = [
        {
          name: 'default',
          description: 'Default configuration',
          agentConfigs: [
            { agentName: 'Coder', providerConfigName: 'claude-config' },
            { agentName: 'Reviewer', providerConfigName: 'agy-config' },
          ],
        },
        {
          name: 'minimal',
          description: null,
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'basic-config' }],
        },
      ];

      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      settingsService.getProjectPresets.mockReturnValue(presets);
      settingsService.getProjectActivePreset.mockReturnValue(null);

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets, activePreset: null });
      expect(settingsService.getProjectPresets).toHaveBeenCalledWith('p1');
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
      settingsService.getProjectPresets.mockReturnValue(presets);
      settingsService.getProjectActivePreset.mockReturnValue('default');
      projectsService.doesProjectMatchPreset.mockResolvedValue(true);

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets, activePreset: 'default' });
      expect(projectsService.doesProjectMatchPreset).toHaveBeenCalledWith('p1', presets[0]);
      expect(settingsService.setProjectActivePreset).not.toHaveBeenCalled();
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
      settingsService.getProjectPresets.mockReturnValue(presets);
      settingsService.getProjectActivePreset.mockReturnValue('default');
      projectsService.doesProjectMatchPreset.mockResolvedValue(
        false, // Drifted
      );

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets, activePreset: null });
      expect(settingsService.setProjectActivePreset).toHaveBeenCalledWith('p1', null);
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
      settingsService.getProjectPresets.mockReturnValue(presets);
      settingsService.getProjectActivePreset.mockReturnValue(
        'default', // This preset no longer exists in the presets array
      );

      const result = await controller.getProjectPresets('p1');

      expect(result).toEqual({ presets, activePreset: null });
      expect(settingsService.setProjectActivePreset).toHaveBeenCalledWith('p1', null);
      expect(projectsService.doesProjectMatchPreset).not.toHaveBeenCalled();
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
      settingsService.getProjectPresets.mockReturnValue(presets);
      settingsService.getProjectActivePreset.mockReturnValue(
        'mypreset', // Stored as lowercase
      );
      projectsService.doesProjectMatchPreset.mockResolvedValue(true);

      const result = await controller.getProjectPresets('p1');

      // Should canonicalize to the preset's actual name
      expect(result).toEqual({ presets, activePreset: 'MyPreset' });
      expect(settingsService.setProjectActivePreset).toHaveBeenCalledWith('p1', 'MyPreset');
    });
  });

  describe('POST /api/projects/:id/presets/apply', () => {
    beforeEach(() => {
      // Add preset method to settings service mock
      settingsService.getProjectPresets = jest.fn();
      projectsService.applyPreset = jest.fn();
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
      settingsService.getProjectPresets.mockReturnValue(presets);

      const applyResult = { applied: 1, warnings: [] };
      projectsService.applyPreset.mockResolvedValue(applyResult);

      const updatedAgents = [
        {
          id: 'agent-1',
          projectId,
          isProjectOwner: false,
          profileId: 'profile-1',
          providerConfigId: 'config-1',
          modelOverride: null,
          effortOverride: null,
          name: 'Coder',
          description: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
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
      expect(projectsService.applyPreset).toHaveBeenCalledWith(projectId, presetName);
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
      settingsService.getProjectPresets.mockReturnValue(presets);

      const applyResult = { applied: 0, warnings: ['Agent "MissingAgent" not found in project'] };
      projectsService.applyPreset.mockResolvedValue(applyResult);

      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });

      const result = await controller.applyPreset(projectId, { presetName });

      expect(result.warnings).toContain('Agent "MissingAgent" not found in project');
    });
  });

  describe('POST /api/projects/:id/presets', () => {
    const createProjectPresetMock = jest.fn().mockResolvedValue(undefined);

    beforeEach(() => {
      createProjectPresetMock.mockClear();
      settingsService.createProjectPreset = createProjectPresetMock;
      settingsService.getProjectPresets = jest.fn();
    });

    const validPreset = {
      name: 'My Preset',
      description: 'A test preset',
      agentConfigs: [
        { agentName: 'Coder', providerConfigName: 'claude-config' },
        { agentName: 'Reviewer', providerConfigName: 'agy-config' },
      ],
    };

    it('creates preset with valid data', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));

      const result = await controller.createPreset('p1', validPreset);

      expect(result).toEqual(validPreset);
      expect(createProjectPresetMock).toHaveBeenCalledWith('p1', validPreset);
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
  });

  describe('PATCH /api/projects/:id/presets', () => {
    const updateProjectPresetMock = jest.fn().mockResolvedValue(undefined);
    const getProjectPresetsMock = jest.fn().mockReturnValue([]);

    beforeEach(() => {
      updateProjectPresetMock.mockClear();
      getProjectPresetsMock.mockClear();
      settingsService.updateProjectPreset = updateProjectPresetMock;
      settingsService.getProjectPresets = getProjectPresetsMock;
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
  });

  describe('DELETE /api/projects/:id/presets', () => {
    const deleteProjectPresetMock = jest.fn().mockResolvedValue(undefined);

    beforeEach(() => {
      deleteProjectPresetMock.mockClear();
      settingsService.deleteProjectPreset = deleteProjectPresetMock;
    });

    it('deletes preset by name', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      settingsService.deleteProjectPreset.mockResolvedValue(undefined);

      const result = await controller.deletePreset('p1', {
        presetName: 'My Preset',
      });

      expect(result).toEqual({ deleted: true });
      expect(settingsService.deleteProjectPreset).toHaveBeenCalledWith('p1', 'My Preset');
    });

    it('deletes preset case-insensitively', async () => {
      storage.getProject.mockResolvedValue(makeProject({ id: 'p1' }));
      settingsService.deleteProjectPreset.mockResolvedValue(undefined);

      await controller.deletePreset('p1', { presetName: 'my preset' });

      expect(settingsService.deleteProjectPreset).toHaveBeenCalledWith('p1', 'my preset');
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
  });
});
