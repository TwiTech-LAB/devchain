import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { ProjectProviderProvisioningService } from './project-provider-provisioning.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { WatchersService } from '../../watchers/services/watchers.service';
import { WatcherRunnerService } from '../../watchers/services/watcher-runner.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { TeamsService } from '../../teams/services/teams.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { SCHEDULED_EPIC_RUNNER_REFRESH } from '../../scheduled-epics/services/scheduled-epics.service';
import { StorageError } from '../../../common/errors/error-types';
import * as devchainShared from '@devchain/shared';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

// Mock probe-1m utility
jest.mock('../../providers/utils/probe-1m', () => ({
  probe1mSupport: jest.fn(),
}));
import { probe1mSupport } from '../../providers/utils/probe-1m';
const mockProbe1mSupport = probe1mSupport as jest.Mock;
import { createMockProject } from '../../../../test/factories';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let storage: {
    getProject: jest.Mock;
    listProviders: jest.Mock;
    listProvidersByIds: jest.Mock;
    listProviderModelsByProviderIds: jest.Mock;
    bulkCreateProviderModels: jest.Mock;
    listPrompts: jest.Mock;
    getPrompt: jest.Mock;
    listAgentProfiles: jest.Mock;
    listAgents: jest.Mock;
    listStatuses: jest.Mock;
    getInitialSessionPrompt: jest.Mock;
    getProvider: jest.Mock;
    createStatus: jest.Mock;
    createPrompt: jest.Mock;
    createAgentProfile: jest.Mock;
    createAgent: jest.Mock;
    updateAgent: jest.Mock;
    deleteAgent: jest.Mock;
    deleteAgentProfile: jest.Mock;
    deletePrompt: jest.Mock;
    deleteStatus: jest.Mock;
    createProjectWithTemplate: jest.Mock;
    countEpicsByStatus: jest.Mock;
    listEpics: jest.Mock;
    updateEpic: jest.Mock;
    updateStatus: jest.Mock;
    updateEpicsStatus: jest.Mock;
    listWatchers: jest.Mock;
    listSubscribers: jest.Mock;
    listScheduledEpics: jest.Mock;
    createScheduledEpic: jest.Mock;
    deleteScheduledEpic: jest.Mock;
    createWatcher: jest.Mock;
    createSubscriber: jest.Mock;
    deleteSubscriber: jest.Mock;
    listProfileProviderConfigsByProfile: jest.Mock;
    createProfileProviderConfig: jest.Mock;
    deleteProfileProviderConfig: jest.Mock;
    getAgent: jest.Mock;
    getAgentProfile: jest.Mock;
    getProfileProviderConfig: jest.Mock;
  };
  let sessions: {
    listActiveSessions: jest.Mock;
    getActiveSessionsForProject: jest.Mock;
  };
  let settings: {
    updateSettings: jest.Mock;
    getSettings: jest.Mock;
    getAutoCleanStatusIds: jest.Mock;
    getRegistryConfig: jest.Mock;
    setProjectTemplateMetadata: jest.Mock;
    getProjectTemplateMetadata: jest.Mock;
    getProjectPresets: jest.Mock;
    setProjectPresets: jest.Mock;
    clearProjectPresets: jest.Mock;
  };
  let watchersService: {
    deleteWatcher: jest.Mock;
    createWatcher: jest.Mock;
  };
  let watcherRunner: {
    startWatcher: jest.Mock;
  };
  let unifiedTemplateService: {
    getTemplate: jest.Mock;
    getBundledTemplate: jest.Mock;
    listTemplates: jest.Mock;
    hasTemplate: jest.Mock;
    getTemplateFromFilePath: jest.Mock;
  };

  beforeEach(async () => {
    storage = {
      getProject: jest.fn().mockResolvedValue(
        createMockProject({
          id: 'project-123',
          description: 'A test project',
          rootPath: '/test/path',
        }),
      ),
      listProviders: jest.fn(),
      listProvidersByIds: jest.fn().mockResolvedValue([]),
      listProviderModelsByProviderIds: jest.fn().mockResolvedValue([]),
      bulkCreateProviderModels: jest.fn().mockResolvedValue({ added: [], existing: [] }),
      listPrompts: jest.fn(),
      getPrompt: jest.fn(),
      listAgentProfiles: jest.fn(),
      listAgents: jest.fn(),
      listStatuses: jest.fn(),
      getInitialSessionPrompt: jest.fn(),
      getProvider: jest.fn(),
      updateProvider: jest.fn(),
      createStatus: jest.fn(),
      createPrompt: jest.fn(),
      createAgentProfile: jest.fn(),
      createAgent: jest.fn(),
      updateAgent: jest.fn(),
      deleteAgent: jest.fn(),
      deleteAgentProfile: jest.fn(),
      deletePrompt: jest.fn(),
      deleteStatus: jest.fn(),
      createProjectWithTemplate: jest.fn(),
      countEpicsByStatus: jest.fn().mockResolvedValue(0),
      listEpics: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 }),
      updateEpic: jest.fn(),
      updateStatus: jest.fn(),
      updateEpicsStatus: jest.fn().mockResolvedValue(0),
      listWatchers: jest.fn().mockResolvedValue([]),
      listSubscribers: jest.fn().mockResolvedValue([]),
      listScheduledEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      createScheduledEpic: jest.fn().mockResolvedValue({ id: 'sched-1' }),
      deleteScheduledEpic: jest.fn().mockResolvedValue(undefined),
      createWatcher: jest.fn(),
      createSubscriber: jest.fn(),
      deleteSubscriber: jest.fn(),
      listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
      createProfileProviderConfig: jest.fn().mockImplementation(async (data) => ({
        id: `config-${Date.now()}`,
        ...data,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      deleteProfileProviderConfig: jest.fn().mockResolvedValue(undefined),
      getAgent: jest.fn(),
      getAgentProfile: jest.fn(),
      getProfileProviderConfig: jest.fn(),
    };

    sessions = {
      listActiveSessions: jest.fn(),
      getActiveSessionsForProject: jest.fn().mockReturnValue([]),
    };

    settings = {
      updateSettings: jest.fn(),
      getSettings: jest.fn().mockReturnValue({}),
      getAutoCleanStatusIds: jest.fn().mockReturnValue([]),
      getRegistryConfig: jest.fn().mockReturnValue({ url: 'https://registry.example.com' }),
      setProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
      getProjectTemplateMetadata: jest.fn().mockReturnValue(null),
      getProjectPresets: jest.fn().mockReturnValue([]),
      setProjectPresets: jest.fn().mockResolvedValue(undefined),
      clearProjectPresets: jest.fn().mockResolvedValue(undefined),
    };

    watchersService = {
      deleteWatcher: jest.fn(),
      createWatcher: jest.fn().mockResolvedValue({ id: 'mock-watcher-id', enabled: false }),
    };

    watcherRunner = {
      startWatcher: jest.fn(),
    };

    unifiedTemplateService = {
      getTemplate: jest.fn(),
      getBundledTemplate: jest.fn(),
      listTemplates: jest.fn(),
      hasTemplate: jest.fn(),
      getTemplateFromFilePath: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        {
          provide: STORAGE_SERVICE,
          useValue: storage,
        },
        {
          provide: SessionsService,
          useValue: sessions,
        },
        {
          provide: SettingsService,
          useValue: settings,
        },
        {
          provide: WatchersService,
          useValue: watchersService,
        },
        {
          provide: WatcherRunnerService,
          useValue: watcherRunner,
        },
        {
          provide: UnifiedTemplateService,
          useValue: unifiedTemplateService,
        },
        {
          provide: TeamsService,
          useValue: {
            deleteTeamsByProject: jest.fn().mockResolvedValue(undefined),
            listTeams: jest.fn().mockResolvedValue({ items: [] }),
            getTeam: jest.fn().mockResolvedValue(null),
            createTeam: jest.fn().mockImplementation(async (data: Record<string, unknown>) => ({
              id: `team-${Date.now()}`,
              ...data,
            })),
          },
        },
        {
          provide: ProjectProviderProvisioningService,
          useValue: { provisionProject: jest.fn().mockResolvedValue({ warnings: [] }) },
        },
        { provide: ProcessExecutor, useValue: new FakeProcessExecutor() },
        {
          provide: SCHEDULED_EPIC_RUNNER_REFRESH,
          useValue: { refreshScheduleWindow: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('importProject', () => {
    it('should return counts and missingProviders in dry run mode without DB mutations', async () => {
      const projectId = 'project-123';
      const payload = {
        prompts: [{ title: 'Prompt 1', content: 'Content' }],
        profiles: [
          {
            name: 'Profile 1',
            provider: { name: 'missing-provider' },
          },
        ],
        agents: [{ name: 'Agent 1' }],
        statuses: [{ label: 'Status 1', color: '#000', position: 0 }],
      };

      // Mock provider check - provider not found
      storage.listProviders.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      // Mock existing data
      storage.listPrompts.mockResolvedValue({
        items: [{ id: 'p1' } as unknown as never],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'pr1' } as unknown as never],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({
        items: [{ id: 'a1' } as unknown as never],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({
        items: [{ id: 's1', label: 'Status 1', color: '#000' }] as unknown as never[],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.importProject({
        projectId,
        payload,
        dryRun: true,
      });

      expect(result).toEqual({
        dryRun: true,
        missingProviders: ['missing-provider'],
        unmatchedStatuses: [],
        templateStatuses: [{ label: 'Status 1', color: '#000' }],
        counts: {
          toImport: {
            prompts: 1,
            // Profile count is 0 because the provider is missing and profile can't be created
            profiles: 0,
            agents: 1,
            statuses: 1,
            watchers: 0,
            subscribers: 0,
            scheduledEpics: 0,
          },
          toDelete: {
            prompts: 1,
            profiles: 1,
            agents: 1,
            statuses: 1,
            watchers: 0,
            subscribers: 0,
            scheduledEpics: 0,
          },
        },
      });

      // Verify no DB mutations occurred
      expect(storage.deleteAgent).not.toHaveBeenCalled();
      expect(storage.deleteAgentProfile).not.toHaveBeenCalled();
      expect(storage.deletePrompt).not.toHaveBeenCalled();
      expect(storage.deleteStatus).not.toHaveBeenCalled();
      expect(storage.createStatus).not.toHaveBeenCalled();
      expect(storage.createPrompt).not.toHaveBeenCalled();
      expect(storage.createAgentProfile).not.toHaveBeenCalled();
      expect(storage.createAgent).not.toHaveBeenCalled();
      expect(settings.updateSettings).not.toHaveBeenCalled();
    });

    it('should return unmatchedStatuses in dry run when existing statuses have epics but no template match', async () => {
      const projectId = 'project-123';
      const payload = {
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [{ label: 'New', color: '#00f', position: 0 }],
      };

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({
        items: [
          { id: 's1', label: 'Old Status', color: '#f00' },
          { id: 's2', label: 'New', color: '#0f0' }, // This one matches template
        ] as unknown as never[],
        total: 2,
        limit: 100,
        offset: 0,
      });

      // Mock countEpicsByStatus - Old Status has 5 epics, New has 0
      storage.countEpicsByStatus.mockImplementation((statusId: string) => {
        if (statusId === 's1') return Promise.resolve(5);
        return Promise.resolve(0);
      });

      const result = await service.importProject({
        projectId,
        payload,
        dryRun: true,
      });

      expect(result).toMatchObject({
        dryRun: true,
        unmatchedStatuses: [{ id: 's1', label: 'Old Status', color: '#f00', epicCount: 5 }],
        templateStatuses: [{ label: 'New', color: '#00f' }],
      });
    });

    it('should throw StorageError with friendly message on FK constraint violation', async () => {
      const projectId = 'project-123';
      const payload = {
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
      };

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'pr1', name: 'Profile 1' }] as unknown as never[],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listAgents.mockResolvedValue({
        items: [{ id: 'a1', name: 'Agent 1' }] as unknown as never[],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      sessions.listActiveSessions.mockResolvedValue([]);

      // Simulate FK constraint violation when deleting agent
      storage.deleteAgent.mockRejectedValue(new Error('FOREIGN KEY constraint failed'));

      await expect(
        service.importProject({
          projectId,
          payload,
          dryRun: false,
        }),
      ).rejects.toThrow(StorageError);

      await expect(
        service.importProject({
          projectId,
          payload,
          dryRun: false,
        }),
      ).rejects.toThrow('Cannot delete items that are still referenced');
    });

    it('should throw StorageError with friendly message on unique constraint violation', async () => {
      const projectId = 'project-123';
      const payload = {
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [{ label: 'New', color: '#00f', position: 0 }],
      };

      storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      sessions.listActiveSessions.mockResolvedValue([]);
      settings.updateSettings.mockResolvedValue(undefined);

      // Simulate unique constraint violation when creating status
      storage.createStatus.mockRejectedValue(new Error('UNIQUE constraint failed'));

      await expect(
        service.importProject({
          projectId,
          payload,
          dryRun: false,
        }),
      ).rejects.toThrow(StorageError);

      await expect(
        service.importProject({
          projectId,
          payload,
          dryRun: false,
        }),
      ).rejects.toThrow('Duplicate entry detected');
    });

    it('should pass all agent fields including description to createAgent', async () => {
      const projectId = 'project-123';
      const profId = '11111111-1111-1111-1111-111111111111';
      const agentId = '22222222-2222-2222-2222-222222222222';
      const provId = '33333333-3333-3333-3333-333333333333';
      const payload = {
        prompts: [],
        profiles: [
          {
            id: profId,
            name: 'Test Profile',
            provider: { id: provId, name: 'claude' },
            options: null,
            instructions: 'Test instructions',
            temperature: 0.7,
            maxTokens: 1000,
          },
        ],
        agents: [
          {
            id: agentId,
            name: 'Test Agent',
            profileId: profId,
            description: 'Agent description text',
            modelOverride: 'openai/gpt-5',
          },
        ],
        statuses: [],
      };
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...payload,
        version: 1,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      storage.listProviders.mockResolvedValue({
        items: [{ id: provId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      sessions.listActiveSessions.mockResolvedValue([]);
      settings.updateSettings.mockResolvedValue(undefined);

      storage.createAgentProfile.mockResolvedValue({ id: 'new-prof-1' });
      storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          name: 'Test Agent',
          description: 'Agent description text',
          modelOverride: 'openai/gpt-5',
        }),
      );
      jest.restoreAllMocks();
    });

    it('should pass all profile fields to createAgentProfile', async () => {
      const projectId = 'project-123';
      const profId = '11111111-1111-1111-1111-111111111111';
      const provId = '33333333-3333-3333-3333-333333333333';
      const payload = {
        prompts: [],
        profiles: [
          {
            id: profId,
            name: 'Test Profile',
            provider: { id: provId, name: 'claude' },
            options: { model: 'opus' },
            instructions: 'Custom instructions',
            temperature: 0.8,
            maxTokens: 2000,
          },
        ],
        agents: [],
        statuses: [],
      };

      storage.listProviders.mockResolvedValue({
        items: [{ id: provId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      sessions.listActiveSessions.mockResolvedValue([]);
      settings.updateSettings.mockResolvedValue(undefined);

      storage.createAgentProfile.mockResolvedValue({ id: 'new-prof-1' });

      await service.importProject({ projectId, payload, dryRun: false });

      // Phase 4: providerId and options are no longer on profile
      expect(storage.createAgentProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          name: 'Test Profile',
          // Note: providerId and options now go to provider configs, not profile
          instructions: 'Custom instructions',
          temperature: 0.8,
          maxTokens: 2000,
        }),
      );
    });

    describe('with familyProviderMappings', () => {
      const projectId = 'project-123';
      const profileId1 = '11111111-1111-1111-1111-111111111111';
      const profileId2 = '22222222-2222-2222-2222-222222222222';
      const agentId = '33333333-3333-3333-3333-333333333333';
      const providerId = '44444444-4444-4444-4444-444444444444';

      it('should return providerMappingRequired in dry-run when default provider is missing', async () => {
        // Directly test computeFamilyAlternatives since import dry-run uses it
        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }], // codex is missing
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Test computeFamilyAlternatives directly to verify the logic
        const profiles = [
          { id: profileId1, name: 'Coder Codex', provider: { name: 'codex' }, familySlug: 'coder' },
          {
            id: profileId2,
            name: 'Coder Claude',
            provider: { name: 'claude' },
            familySlug: 'coder',
          },
        ];
        const agents = [{ id: agentId, name: 'Coder', profileId: profileId1 }];

        const familyResult = await service.computeFamilyAlternatives(profiles, agents);

        // Verify the conditions that would trigger providerMappingRequired in dry-run
        const needsMapping = familyResult.alternatives.some((alt) => !alt.defaultProviderAvailable);
        expect(needsMapping).toBe(true);
        expect(familyResult.missingProviders).toContain('codex');
        expect(familyResult.canImport).toBe(true);
        expect(familyResult.alternatives[0].availableProviders).toContain('claude');
      });

      it('should import with remapped profiles when mappings are provided', async () => {
        const payload = {
          prompts: [],
          profiles: [
            {
              id: profileId1,
              name: 'Coder Codex',
              provider: { name: 'codex' },
              familySlug: 'coder',
            },
            {
              id: profileId2,
              name: 'Coder Claude',
              provider: { name: 'claude' },
              familySlug: 'coder',
            },
          ],
          agents: [{ id: agentId, name: 'Coder', profileId: profileId1 }],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        // Mock ExportSchema.parse to preserve familySlug (ESM compatibility workaround)
        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // Only claude is available
        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);
        settings.updateSettings.mockResolvedValue(undefined);

        // Mock create operations
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
          familyProviderMappings: { coder: 'claude' }, // Remap coder family to claude
        });

        // Verify createAgentProfile was called with the claude profile (not codex)
        // Phase 4: providerId is no longer on profile, only on provider configs
        expect(storage.createAgentProfile).toHaveBeenCalledTimes(1);
        expect(storage.createAgentProfile).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Coder Claude',
            familySlug: 'coder',
          }),
        );

        // Cleanup
        jest.restoreAllMocks();
      });

      it('should import ALL profiles whose provider is available (not just agent-referenced ones)', async () => {
        // Template with multiple profiles per family - all should be imported if provider available
        const profile1 = '11111111-1111-1111-1111-111111111111';
        const profile2 = '22222222-2222-2222-2222-222222222222';
        const profile3 = '33333333-3333-3333-3333-333333333333';
        const agentIdLocal = '44444444-4444-4444-4444-444444444444';
        const claudeProviderId = '55555555-5555-5555-5555-555555555555';
        const geminiProviderId = '66666666-6666-6666-6666-666666666666';

        const payload = {
          prompts: [],
          profiles: [
            // Coder family - Claude profile (agent uses this)
            {
              id: profile1,
              name: 'Coder Claude',
              provider: { name: 'claude' },
              familySlug: 'coder',
            },
            // Coder family - Gemini profile (NOT used by any agent, but should be imported)
            {
              id: profile2,
              name: 'Coder Gemini',
              provider: { name: 'gemini' },
              familySlug: 'coder',
            },
            // Another family - Gemini profile (also not used by agent)
            {
              id: profile3,
              name: 'Reviewer Gemini',
              provider: { name: 'gemini' },
              familySlug: 'reviewer',
            },
          ],
          agents: [{ id: agentIdLocal, name: 'Coder', profileId: profile1 }], // Only references profile1
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // Both claude and gemini are available
        storage.listProviders.mockResolvedValue({
          items: [
            { id: claudeProviderId, name: 'claude' },
            { id: geminiProviderId, name: 'gemini' },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);
        settings.updateSettings.mockResolvedValue(undefined);

        // Mock create operations
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // ALL 3 profiles should be imported (not just the one referenced by agent)
        expect(storage.createAgentProfile).toHaveBeenCalledTimes(3);

        // Verify all profiles were created
        const createdProfiles = storage.createAgentProfile.mock.calls.map((call) => call[0].name);
        expect(createdProfiles).toContain('Coder Claude');
        expect(createdProfiles).toContain('Coder Gemini');
        expect(createdProfiles).toContain('Reviewer Gemini');

        jest.restoreAllMocks();
      });

      it('should assign agent to original profile provider when all providers available (no mapping)', async () => {
        // This tests the bug fix: when all providers are available (no mapping needed),
        // agents should use their original profile's provider, not the first one in template order
        const codexProfileId = '11111111-1111-1111-1111-111111111111';
        const claudeProfileId = '22222222-2222-2222-2222-222222222222';
        const coderAgentId = '33333333-3333-3333-3333-333333333333';
        const codexProviderId = '44444444-4444-4444-4444-444444444444';
        const claudeProviderId = '55555555-5555-5555-5555-555555555555';

        const payload = {
          prompts: [],
          profiles: [
            // IMPORTANT: Codex profile comes FIRST in the array
            {
              id: codexProfileId,
              name: 'CodeGPT',
              provider: { name: 'codex' },
              familySlug: 'coder',
            },
            // Claude profile comes SECOND in the array
            {
              id: claudeProfileId,
              name: 'CodeOpus',
              provider: { name: 'claude' },
              familySlug: 'coder',
            },
          ],
          // Agent is assigned to Claude profile (second in array)
          agents: [{ id: coderAgentId, name: 'Coder', profileId: claudeProfileId }],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // BOTH providers are available - this is the key condition
        storage.listProviders.mockResolvedValue({
          items: [
            { id: codexProviderId, name: 'codex' },
            { id: claudeProviderId, name: 'claude' },
          ],
          total: 2,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);
        settings.updateSettings.mockResolvedValue(undefined);

        // Track profile ID mappings
        let newClaudeProfileId: string | undefined;
        storage.createAgentProfile.mockImplementation(async (input) => {
          const id = `new-profile-${input.name}`;
          if (input.name === 'CodeOpus') {
            newClaudeProfileId = id;
          }
          return { id };
        });
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });

        // Track which profile the agent is assigned to
        let agentAssignedProfileId: string | undefined;
        storage.createAgent.mockImplementation(async (input) => {
          agentAssignedProfileId = input.profileId;
          return { id: 'new-agent-1' };
        });

        // Import WITHOUT providing familyProviderMappings (all providers available)
        await service.importProject({
          projectId,
          payload,
          dryRun: false,
          // No familyProviderMappings - should use original provider assignment
        });

        // Agent should be assigned to Claude profile (original assignment), NOT Codex (first in array)
        expect(agentAssignedProfileId).toBe(newClaudeProfileId);

        jest.restoreAllMocks();
      });

      it('should fall back to first available provider when original provider is not available', async () => {
        // When the agent's original provider is unavailable, fall back to first available
        const codexProfileId = '11111111-1111-1111-1111-111111111111';
        const claudeProfileId = '22222222-2222-2222-2222-222222222222';
        const coderAgentId = '33333333-3333-3333-3333-333333333333';
        const claudeProviderId = '55555555-5555-5555-5555-555555555555';

        const payload = {
          prompts: [],
          profiles: [
            // Codex profile comes FIRST
            {
              id: codexProfileId,
              name: 'CodeGPT',
              provider: { name: 'codex' },
              familySlug: 'coder',
            },
            // Claude profile comes SECOND
            {
              id: claudeProfileId,
              name: 'CodeOpus',
              provider: { name: 'claude' },
              familySlug: 'coder',
            },
          ],
          // Agent is assigned to Codex profile (first in array)
          agents: [{ id: coderAgentId, name: 'Coder', profileId: codexProfileId }],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // Only Claude is available - Codex (agent's original) is missing
        storage.listProviders.mockResolvedValue({
          items: [{ id: claudeProviderId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);
        settings.updateSettings.mockResolvedValue(undefined);

        // Track profile ID mappings
        let newClaudeProfileId: string | undefined;
        storage.createAgentProfile.mockImplementation(async (input) => {
          const id = `new-profile-${input.name}`;
          if (input.name === 'CodeOpus') {
            newClaudeProfileId = id;
          }
          return { id };
        });
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });

        // Track which profile the agent is assigned to
        let agentAssignedProfileId: string | undefined;
        storage.createAgent.mockImplementation(async (input) => {
          agentAssignedProfileId = input.profileId;
          return { id: 'new-agent-1' };
        });

        // Import with mapping since Codex is unavailable
        await service.importProject({
          projectId,
          payload,
          dryRun: false,
          familyProviderMappings: { coder: 'claude' },
        });

        // Agent should be assigned to Claude profile (mapped provider) since Codex is unavailable
        expect(agentAssignedProfileId).toBe(newClaudeProfileId);

        jest.restoreAllMocks();
      });

      it('should throw ValidationError when canImport is false (no alternatives available)', async () => {
        const payload = {
          prompts: [],
          profiles: [
            {
              id: profileId1,
              name: 'Special Profile',
              provider: { name: 'special-provider' },
              familySlug: 'special',
            },
          ],
          agents: [{ id: agentId, name: 'Special Agent', profileId: profileId1 }],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // No providers available at all
        storage.listProviders.mockResolvedValue({
          items: [],
          total: 0,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });

        // Even with mappings provided, should fail because canImport is false
        await expect(
          service.importProject({
            projectId,
            payload,
            dryRun: false,
            familyProviderMappings: { special: 'anything' },
          }),
        ).rejects.toThrow('Cannot import: some profile families have no available providers');

        jest.restoreAllMocks();
      });

      it('should return providerMappingRequired when defaults missing and no mappings provided (non-dry-run)', async () => {
        const payload = {
          prompts: [],
          profiles: [
            {
              id: profileId1,
              name: 'Coder Codex',
              provider: { name: 'codex' },
              familySlug: 'coder',
            },
            {
              id: profileId2,
              name: 'Coder Claude',
              provider: { name: 'claude' },
              familySlug: 'coder',
            },
          ],
          agents: [{ id: agentId, name: 'Coder', profileId: profileId1 }],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        // Only claude is available (codex is missing)
        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });

        // Mock existing data (empty project)
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });

        // Non-dry-run without mappings should return providerMappingRequired
        const result = await service.importProject({
          projectId,
          payload,
          dryRun: false,
          // No familyProviderMappings provided
        });

        expect(result.success).toBe(false);
        expect(result.providerMappingRequired).toBeDefined();
        expect(result.providerMappingRequired?.missingProviders).toContain('codex');
        expect(result.providerMappingRequired?.canImport).toBe(true);
        expect(result.providerMappingRequired?.familyAlternatives).toHaveLength(1);
        expect(result.providerMappingRequired?.familyAlternatives[0].familySlug).toBe('coder');

        jest.restoreAllMocks();
      });
    });

    describe('template source detection', () => {
      const projectId = 'project-123';
      const providerId = '44444444-4444-4444-4444-444444444444';

      it('should set source as bundled when importing a bundled template', async () => {
        const payload = {
          prompts: [],
          profiles: [],
          agents: [],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
          _manifest: {
            slug: 'bundled-template',
            name: 'Bundled Template',
            version: '1.0.0',
          },
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);

        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });

        // Mock getBundledTemplate to succeed (template is bundled)
        unifiedTemplateService.getBundledTemplate.mockReturnValue({
          content: {},
          source: 'bundled',
        });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // Verify template metadata was set with source: 'bundled'
        expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith(
          projectId,
          expect.objectContaining({
            templateSlug: 'bundled-template',
            source: 'bundled',
            installedVersion: '1.0.0',
          }),
        );

        jest.restoreAllMocks();
      });

      it('should set source as registry when importing a non-bundled template', async () => {
        const payload = {
          prompts: [],
          profiles: [],
          agents: [],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
          _manifest: {
            slug: 'registry-only-template',
            name: 'Registry Template',
            version: '2.0.0',
          },
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.listPrompts.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);

        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });

        // Mock getBundledTemplate to throw (template is NOT bundled)
        unifiedTemplateService.getBundledTemplate.mockImplementation(() => {
          throw new Error('Template not found');
        });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // Verify template metadata was set with source: 'registry'
        expect(settings.setProjectTemplateMetadata).toHaveBeenCalledWith(
          projectId,
          expect.objectContaining({
            templateSlug: 'registry-only-template',
            source: 'registry',
            installedVersion: '2.0.0',
          }),
        );

        jest.restoreAllMocks();
      });
    });

    describe('providerConfigs import', () => {
      const projectId = 'project-123';
      const providerId = 'provider-claude-id';

      it('should create provider configs and update agents with providerConfigId when importing new format', async () => {
        const payload = {
          prompts: [],
          profiles: [
            {
              id: 'profile-1',
              name: 'Test Profile',
              provider: { name: 'claude' },
              familySlug: 'coder',
              providerConfigs: [
                {
                  name: 'claude',
                  providerName: 'claude',
                  options: '--model claude-3',
                  env: { ANTHROPIC_API_KEY: 'sk-xxx' },
                },
              ],
            },
          ],
          agents: [
            {
              id: 'agent-1',
              name: 'Test Agent',
              profileId: 'profile-1',
              providerConfigName: 'claude',
            },
          ],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);

        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createProfileProviderConfig.mockResolvedValue({ id: 'new-config-1' });
        storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // Verify provider config was created
        expect(storage.createProfileProviderConfig).toHaveBeenCalledWith({
          profileId: 'new-profile-1',
          providerId,
          name: 'claude',
          description: null,
          options: '--model claude-3',
          env: { ANTHROPIC_API_KEY: 'sk-xxx' },
        });

        // Verify agent was created with providerConfigId
        expect(storage.createAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Test Agent',
            profileId: 'new-profile-1',
            providerConfigId: 'new-config-1',
          }),
        );

        jest.restoreAllMocks();
      });

      it('should handle backward compatibility with legacy format (no providerConfigs)', async () => {
        // Phase 4: Legacy format now creates a default config since providerConfigId is required
        const payload = {
          prompts: [],
          profiles: [
            {
              id: 'profile-1',
              name: 'Legacy Profile',
              provider: { name: 'claude' },
              familySlug: 'coder',
              // No providerConfigs field
            },
          ],
          agents: [
            {
              id: 'agent-1',
              name: 'Legacy Agent',
              profileId: 'profile-1',
              // No providerConfigName
            },
          ],
          statuses: [{ label: 'To Do', color: '#3b82f6', position: 0 }],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);

        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createProfileProviderConfig.mockResolvedValue({ id: 'default-config-1' });
        storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });

        await service.importProject({
          projectId,
          payload,
          dryRun: false,
        });

        // Verify a default provider config WAS created for legacy format (Phase 4: providerConfigId is NOT NULL)
        expect(storage.createProfileProviderConfig).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId: 'new-profile-1',
            providerId: providerId,
          }),
        );

        // Verify agent was created WITH providerConfigId (Phase 4: required)
        expect(storage.createAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Legacy Agent',
            profileId: 'new-profile-1',
            providerConfigId: 'default-config-1',
            modelOverride: null,
          }),
        );

        jest.restoreAllMocks();
      });

      it('round-trips agent modelOverride values through export and import', async () => {
        const projectId = 'project-123';
        const providerId = 'provider-claude-id';
        const profileId = 'profile-1';
        const providerConfigId = 'config-1';

        storage.getProject.mockResolvedValue({
          id: projectId,
          name: 'Round Trip Project',
          rootPath: '/test/path',
          isTemplate: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [
            {
              id: profileId,
              name: 'Runner',
              providerId,
              familySlug: 'coder',
              options: null,
              instructions: null,
              temperature: null,
              maxTokens: null,
            },
          ],
          total: 1,
          limit: 1000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({
          items: [
            {
              id: 'agent-1',
              name: 'Coder',
              profileId,
              providerConfigId,
              description: null,
              modelOverride: 'openai/gpt-5',
            },
            {
              id: 'agent-2',
              name: 'Reviewer',
              profileId,
              providerConfigId,
              description: null,
              modelOverride: null,
            },
          ],
          total: 2,
          limit: 1000,
          offset: 0,
        });
        storage.listStatuses.mockResolvedValue({
          items: [{ id: 'status-1', label: 'To Do', color: '#3b82f6', position: 0 }],
          total: 1,
          limit: 1000,
          offset: 0,
        });
        storage.listWatchers.mockResolvedValue([]);
        storage.listSubscribers.mockResolvedValue([]);
        storage.getInitialSessionPrompt.mockResolvedValue(null);
        storage.listProvidersByIds.mockResolvedValue([{ id: providerId, name: 'claude' }]);
        storage.listProfileProviderConfigsByProfile.mockResolvedValue([
          {
            id: providerConfigId,
            profileId,
            providerId,
            name: 'claude',
            options: null,
            env: null,
            position: 0,
          },
        ]);

        const exported = await service.exportProject(projectId);
        expect(exported.agents).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'Coder', modelOverride: 'openai/gpt-5' }),
            expect.objectContaining({ name: 'Reviewer', modelOverride: null }),
          ]),
        );

        storage.listProviders.mockResolvedValue({
          items: [{ id: providerId, name: 'claude' }],
          total: 1,
          limit: 100,
          offset: 0,
        });
        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);
        storage.createStatus.mockResolvedValue({ id: 'new-status-1' });
        storage.createAgentProfile.mockResolvedValue({ id: 'new-profile-1' });
        storage.createProfileProviderConfig.mockResolvedValue({ id: 'new-config-1' });
        storage.createAgent
          .mockResolvedValueOnce({ id: 'new-agent-1' })
          .mockResolvedValueOnce({ id: 'new-agent-2' });

        const { _manifest: _omittedManifest, ...importPayload } = exported;
        void _omittedManifest;
        jest
          .spyOn(devchainShared.ExportSchema, 'parse')
          .mockReturnValue(importPayload as ReturnType<typeof devchainShared.ExportSchema.parse>);

        await service.importProject({ projectId, payload: importPayload, dryRun: false });

        expect(storage.createAgent).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            name: 'Coder',
            modelOverride: 'openai/gpt-5',
          }),
        );
        expect(storage.createAgent).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            name: 'Reviewer',
            modelOverride: null,
          }),
        );

        jest.restoreAllMocks();
      });
    });

    describe('presets import', () => {
      it('stores imported presets preserving modelOverride values', async () => {
        const projectId = 'project-123';
        const payload = {
          prompts: [],
          profiles: [],
          agents: [],
          statuses: [],
          presets: [
            {
              name: 'with-model',
              agentConfigs: [
                {
                  agentName: 'Coder',
                  providerConfigName: 'claude-config',
                  modelOverride: 'openai/gpt-5',
                },
              ],
            },
          ],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);
        settings.updateSettings.mockResolvedValue(undefined);

        await service.importProject({ projectId, payload, dryRun: false });

        expect(settings.setProjectPresets).toHaveBeenCalledWith(projectId, payload.presets);
        expect(settings.clearProjectPresets).not.toHaveBeenCalled();
      });

      it('stores legacy imported presets without modelOverride (backward compatibility)', async () => {
        const projectId = 'project-123';
        const payload = {
          prompts: [],
          profiles: [],
          agents: [],
          statuses: [],
          presets: [
            {
              name: 'legacy',
              agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
            },
          ],
        };

        jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
          ...payload,
          version: 1,
          exportedAt: undefined,
          initialPrompt: undefined,
          projectSettings: undefined,
          watchers: [],
          subscribers: [],
          _manifest: undefined,
        } as ReturnType<typeof devchainShared.ExportSchema.parse>);

        storage.listProviders.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
        storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listAgentProfiles.mockResolvedValue({
          items: [],
          total: 0,
          limit: 10000,
          offset: 0,
        });
        storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
        sessions.getActiveSessionsForProject.mockReturnValue([]);
        settings.updateSettings.mockResolvedValue(undefined);

        await service.importProject({ projectId, payload, dryRun: false });

        expect(settings.setProjectPresets).toHaveBeenCalledWith(projectId, payload.presets);
      });
    });
  });

  describe('importProject providerSettings', () => {
    const projectId = 'project-123';

    function buildMinimalPayload(
      providerSettings?: Array<{
        name: string;
        autoCompactThreshold?: number | null;
        oneMillionContextEnabled?: boolean;
      }>,
      providerModels?: Array<{ providerName: string; models: string[] }>,
    ) {
      return {
        version: 1,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        prompts: [],
        profiles: [],
        agents: [],
        statuses: [],
        watchers: [],
        subscribers: [],
        providerModels: providerModels ?? [],
        ...(providerSettings !== undefined ? { providerSettings } : {}),
      } as ReturnType<typeof devchainShared.ExportSchema.parse>;
    }

    function setupImportMocks() {
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 });
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);
      storage.listEpics.mockResolvedValue({ items: [], total: 0, limit: 100000, offset: 0 });
    }

    it('should apply providerSettings threshold to local provider when local threshold is null', async () => {
      const payload = buildMinimalPayload([{ name: 'claude', autoCompactThreshold: 10 }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold: 10,
      });

      jest.restoreAllMocks();
    });

    it('should not overwrite existing local provider threshold during import', async () => {
      const payload = buildMinimalPayload([{ name: 'claude', autoCompactThreshold: 20 }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: 10 }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      // updateProvider should not be called to update autoCompactThreshold
      // (it may be called for other reasons, so check the specific call)
      const thresholdCalls = storage.updateProvider.mock.calls.filter((args: unknown[]) => {
        const updatePayload = args[1] as Record<string, unknown>;
        return updatePayload.autoCompactThreshold !== undefined;
      });
      expect(thresholdCalls).toHaveLength(0);

      jest.restoreAllMocks();
    });

    it('should skip providerSettings for providers not found locally', async () => {
      const payload = buildMinimalPayload([{ name: 'missing-provider', autoCompactThreshold: 15 }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      const thresholdCalls = storage.updateProvider.mock.calls.filter((args: unknown[]) => {
        const updatePayload = args[1] as Record<string, unknown>;
        return updatePayload.autoCompactThreshold !== undefined;
      });
      expect(thresholdCalls).toHaveLength(0);

      jest.restoreAllMocks();
    });

    it('should import correctly when template has no providerSettings (backward compat)', async () => {
      const payload = buildMinimalPayload();
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      // No provider threshold updates should happen
      const thresholdCalls = storage.updateProvider.mock.calls.filter((args: unknown[]) => {
        const updatePayload = args[1] as Record<string, unknown>;
        return updatePayload.autoCompactThreshold !== undefined;
      });
      expect(thresholdCalls).toHaveLength(0);

      jest.restoreAllMocks();
    });

    it('should include oneMillionContextEnabled in export providerSettings when enabled', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Test Profile' }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          name: 'default',
          options: null,
          env: null,
          position: 0,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listProvidersByIds.mockResolvedValue([
        {
          id: 'prov-1',
          name: 'claude',
          autoCompactThreshold: 50,
          oneMillionContextEnabled: true,
        },
      ]);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      expect(result.providerSettings).toEqual([
        { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
      ]);
    });

    it('should not include oneMillionContextEnabled in export when disabled', async () => {
      const projectId = 'project-123';

      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Test Profile' }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          name: 'default',
          options: null,
          env: null,
          position: 0,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listProvidersByIds.mockResolvedValue([
        {
          id: 'prov-1',
          name: 'claude',
          autoCompactThreshold: 10,
          oneMillionContextEnabled: false,
        },
      ]);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const result = await service.exportProject(projectId);

      expect(result.providerSettings).toEqual([{ name: 'claude', autoCompactThreshold: 10 }]);
    });

    it('should disable oneMillionContextEnabled and set threshold to 95 on import when no threshold exists', async () => {
      const payload = buildMinimalPayload([{ name: 'claude', oneMillionContextEnabled: true }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      // Should disable 1M and set safe fallback threshold of 95
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
      });

      jest.restoreAllMocks();
    });

    it('should force threshold 95 when template has threshold 50 but 1M probe fails on import', async () => {
      const payload = buildMinimalPayload([
        { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
      ]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      // Template threshold 50 is only appropriate when 1M is enabled;
      // since 1M is disabled (no binPath/probe), threshold must be forced to 95
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
      });

      jest.restoreAllMocks();
    });

    it('should force threshold 95 when 1M disabled even if local provider has existing threshold', async () => {
      const payload = buildMinimalPayload([{ name: 'claude', oneMillionContextEnabled: true }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: 80 }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      // Should disable 1M; local threshold 80 preserved (not overwritten)
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
      });

      jest.restoreAllMocks();
    });

    it('should enable oneMillionContextEnabled when auto-probe succeeds on import', async () => {
      const payload = buildMinimalPayload([{ name: 'claude', oneMillionContextEnabled: true }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'prov-1', name: 'claude', autoCompactThreshold: null, binPath: '/usr/bin/claude' },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockProbe1mSupport.mockResolvedValue({ supported: true, status: 'supported' });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(mockProbe1mSupport).toHaveBeenCalledWith(expect.anything(), '/usr/bin/claude');
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
      });

      jest.restoreAllMocks();
    });

    it('should disable oneMillionContextEnabled when auto-probe fails on import', async () => {
      const payload = buildMinimalPayload([{ name: 'claude', oneMillionContextEnabled: true }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'prov-1', name: 'claude', autoCompactThreshold: null, binPath: '/usr/bin/claude' },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockProbe1mSupport.mockResolvedValue({ supported: false, status: 'unsupported' });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(mockProbe1mSupport).toHaveBeenCalledWith(expect.anything(), '/usr/bin/claude');
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
      });

      jest.restoreAllMocks();
    });

    it('should disable oneMillionContextEnabled when provider has no binPath on import', async () => {
      const payload = buildMinimalPayload([{ name: 'claude', oneMillionContextEnabled: true }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null, binPath: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(mockProbe1mSupport).not.toHaveBeenCalled();
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
      });

      jest.restoreAllMocks();
    });

    it('should force threshold 95 when template has threshold 50 and probe fails on import', async () => {
      const payload = buildMinimalPayload([
        { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
      ]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'prov-1', name: 'claude', autoCompactThreshold: null, binPath: '/usr/bin/claude' },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockProbe1mSupport.mockResolvedValue({ supported: false, status: 'unsupported' });

      await service.importProject({ projectId, payload, dryRun: false });

      // Template threshold 50 is overridden to 95 because 1M probe failed
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: null,
        oneMillionContextEnabled: false,
      });

      jest.restoreAllMocks();
    });

    it('should keep threshold 50 when template has threshold 50 and probe succeeds on import', async () => {
      const payload = buildMinimalPayload([
        { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
      ]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'prov-1', name: 'claude', autoCompactThreshold: null, binPath: '/usr/bin/claude' },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockProbe1mSupport.mockResolvedValue({ supported: true, status: 'supported' });

      await service.importProject({ projectId, payload, dryRun: false });

      // Legacy template: standard threshold forced to 95; 1M threshold gets template value (50)
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
      });

      jest.restoreAllMocks();
    });

    it('should force threshold 50 when local provider has threshold 95 and probe succeeds on import', async () => {
      const payload = buildMinimalPayload([{ name: 'claude', oneMillionContextEnabled: true }]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'prov-1', name: 'claude', autoCompactThreshold: 95, binPath: '/usr/bin/claude' },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      });

      mockProbe1mSupport.mockResolvedValue({ supported: true, status: 'supported' });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(mockProbe1mSupport).toHaveBeenCalledWith(expect.anything(), '/usr/bin/claude');
      // Local provider had threshold 95 — preserved (not overwritten); 1M threshold = 50
      expect(storage.updateProvider).toHaveBeenCalledWith('prov-1', {
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
      });

      jest.restoreAllMocks();
    });

    it('should import providerModels for matching local providers', async () => {
      const payload = buildMinimalPayload(undefined, [
        { providerName: 'claude', models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'] },
      ]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.bulkCreateProviderModels.mockResolvedValue({
        added: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'],
        existing: [],
      });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.bulkCreateProviderModels).toHaveBeenCalledTimes(1);
      expect(storage.bulkCreateProviderModels).toHaveBeenCalledWith('prov-1', [
        'anthropic/claude-sonnet-4-5',
        'openai/gpt-5',
      ]);

      jest.restoreAllMocks();
    });

    it('should skip providerModels entries when provider is not found locally', async () => {
      const payload = buildMinimalPayload(undefined, [
        { providerName: 'missing-provider', models: ['model-a'] },
      ]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.bulkCreateProviderModels).not.toHaveBeenCalled();

      jest.restoreAllMocks();
    });

    it('should deduplicate existing models via bulkCreateProviderModels existing result', async () => {
      const payload = buildMinimalPayload(undefined, [
        { providerName: 'claude', models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'] },
      ]);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.bulkCreateProviderModels.mockResolvedValue({
        added: ['openai/gpt-5'],
        existing: ['anthropic/claude-sonnet-4-5'],
      });

      const result = await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.bulkCreateProviderModels).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);

      jest.restoreAllMocks();
    });

    it('should no-op when providerModels is an empty array', async () => {
      const payload = buildMinimalPayload(undefined, []);
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue(payload);
      setupImportMocks();

      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.bulkCreateProviderModels).not.toHaveBeenCalled();
      expect(storage.listProviders).toHaveBeenCalledTimes(2);

      jest.restoreAllMocks();
    });

    it('should preserve providerModels names and order on export/import round trip', async () => {
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({
        items: [{ id: 'prof-1', name: 'Test Profile' }],
        total: 1,
        limit: 1000,
        offset: 0,
      });
      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId: 'prof-1',
          providerId: 'prov-1',
          name: 'default',
          options: null,
          env: null,
          position: 0,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listProvidersByIds.mockResolvedValue([
        { id: 'prov-1', name: 'claude', autoCompactThreshold: null },
      ]);
      storage.listProviderModelsByProviderIds.mockResolvedValue([
        {
          id: 'model-1',
          providerId: 'prov-1',
          name: 'anthropic/claude-opus-4-1',
          position: 1,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 'model-2',
          providerId: 'prov-1',
          name: 'anthropic/claude-sonnet-4-5',
          position: 2,
          createdAt: '',
          updatedAt: '',
        },
      ]);
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.getInitialSessionPrompt.mockResolvedValue(null);
      storage.listWatchers.mockResolvedValue([]);
      storage.listSubscribers.mockResolvedValue([]);

      const exported = await service.exportProject(projectId);
      expect(exported.providerModels).toEqual([
        {
          providerName: 'claude',
          models: ['anthropic/claude-opus-4-1', 'anthropic/claude-sonnet-4-5'],
        },
      ]);

      setupImportMocks();
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'prov-1', name: 'claude', autoCompactThreshold: null }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.bulkCreateProviderModels.mockResolvedValue({
        added: ['anthropic/claude-opus-4-1', 'anthropic/claude-sonnet-4-5'],
        existing: [],
      });

      const importPayload = buildMinimalPayload(undefined, exported.providerModels);
      jest
        .spyOn(devchainShared.ExportSchema, 'parse')
        .mockReturnValue(importPayload as ReturnType<typeof devchainShared.ExportSchema.parse>);

      await service.importProject({ projectId, payload: importPayload, dryRun: false });

      expect(storage.bulkCreateProviderModels).toHaveBeenCalledTimes(1);
      expect(storage.bulkCreateProviderModels).toHaveBeenCalledWith('prov-1', [
        'anthropic/claude-opus-4-1',
        'anthropic/claude-sonnet-4-5',
      ]);

      jest.restoreAllMocks();
    });
  });

  describe('importProject scheduledEpics', () => {
    const projectId = 'project-123';
    const profId = '11111111-1111-1111-1111-111111111111';
    const provId = '33333333-3333-3333-3333-333333333333';
    const agentId = '22222222-2222-2222-2222-222222222222';

    function makePayload(scheduledEpics: unknown[]) {
      const payload = {
        prompts: [],
        profiles: [
          {
            id: profId,
            name: 'Test Profile',
            provider: { id: provId, name: 'claude' },
            options: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
        agents: [
          {
            id: agentId,
            name: 'Coder',
            profileId: profId,
            description: null,
            modelOverride: null,
          },
        ],
        statuses: [],
        scheduledEpics,
      };
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...payload,
        version: 1,
        exportedAt: undefined,
        initialPrompt: undefined,
        projectSettings: undefined,
        watchers: [],
        subscribers: [],
        teams: [],
        presets: [],
        providerModels: [],
        _manifest: undefined,
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);
      return payload;
    }

    const defaultSchedule = {
      name: 'Daily Task',
      cronExpression: '0 9 * * 1-5',
      timezone: 'America/New_York',
      enabled: true,
      titleTemplate: 'Daily {{date}}',
      descriptionTemplate: null,
      templateStatusLabel: null,
      templateParentEpicTitle: null,
      templateAgentName: 'Coder',
      templateTags: ['daily'],
      allowOverlap: false,
      missedRunPolicy: 'skip' as const,
    };

    beforeEach(() => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: provId, name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });
      storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.listStatuses.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
      storage.createAgentProfile.mockResolvedValue({ id: 'new-prof-1' });
      storage.createAgent.mockResolvedValue({ id: 'new-agent-1' });
    });

    it('should create scheduled epics during import', async () => {
      const payload = makePayload([defaultSchedule]);

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.createScheduledEpic).toHaveBeenCalledTimes(1);
      expect(storage.createScheduledEpic).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          name: 'Daily Task',
          cronExpression: '0 9 * * 1-5',
          timezone: 'America/New_York',
          enabled: true,
          titleTemplate: 'Daily {{date}}',
          templateTags: ['daily'],
          allowOverlap: false,
          missedRunPolicy: 'skip',
        }),
      );
      jest.restoreAllMocks();
    });

    it('should preserve enabled=false state during import', async () => {
      const payload = makePayload([{ ...defaultSchedule, enabled: false }]);

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.createScheduledEpic).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
      jest.restoreAllMocks();
    });

    it('should delete existing scheduled epics before importing new ones', async () => {
      storage.listScheduledEpics.mockResolvedValue({
        items: [{ id: 'old-sched-1' }, { id: 'old-sched-2' }],
        total: 2,
      });
      const payload = makePayload([defaultSchedule]);

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.deleteScheduledEpic).toHaveBeenCalledWith('old-sched-1');
      expect(storage.deleteScheduledEpic).toHaveBeenCalledWith('old-sched-2');
      expect(storage.createScheduledEpic).toHaveBeenCalledTimes(1);
      jest.restoreAllMocks();
    });

    it('should not create scheduled epics when payload has none', async () => {
      const payload = makePayload([]);

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.createScheduledEpic).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    });

    it('should set templateAgentId to null when agent name not found', async () => {
      const payload = makePayload([{ ...defaultSchedule, templateAgentName: 'NonExistent' }]);

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.createScheduledEpic).toHaveBeenCalledWith(
        expect.objectContaining({ templateAgentId: null }),
      );
      jest.restoreAllMocks();
    });

    it('should include nextRunAt computed from cron expression', async () => {
      const payload = makePayload([defaultSchedule]);

      await service.importProject({ projectId, payload, dryRun: false });

      expect(storage.createScheduledEpic).toHaveBeenCalledWith(
        expect.objectContaining({ nextRunAt: expect.any(String) }),
      );
      jest.restoreAllMocks();
    });

    it('should trigger refreshScheduleWindow after importing schedules', async () => {
      const payload = makePayload([defaultSchedule]);
      // Get the runner refresh mock from the module
      const module = await Test.createTestingModule({
        providers: [
          ProjectsService,
          { provide: STORAGE_SERVICE, useValue: storage },
          { provide: SessionsService, useValue: sessions },
          { provide: SettingsService, useValue: settings },
          { provide: WatchersService, useValue: watchersService },
          { provide: WatcherRunnerService, useValue: watcherRunner },
          { provide: UnifiedTemplateService, useValue: unifiedTemplateService },
          {
            provide: TeamsService,
            useValue: {
              deleteTeamsByProject: jest.fn().mockResolvedValue(undefined),
              listTeams: jest.fn().mockResolvedValue({ items: [] }),
              getTeam: jest.fn().mockResolvedValue(null),
              createTeam: jest.fn(),
            },
          },
          {
            provide: ProjectProviderProvisioningService,
            useValue: { provisionProject: jest.fn().mockResolvedValue({ warnings: [] }) },
          },
          { provide: ProcessExecutor, useValue: new FakeProcessExecutor() },
          {
            provide: SCHEDULED_EPIC_RUNNER_REFRESH,
            useValue: { refreshScheduleWindow: jest.fn() },
          },
        ],
      }).compile();

      const localService = module.get<ProjectsService>(ProjectsService);
      const runnerRefresh = module.get(SCHEDULED_EPIC_RUNNER_REFRESH);

      await localService.importProject({ projectId, payload, dryRun: false });

      expect(runnerRefresh.refreshScheduleWindow).toHaveBeenCalled();
      jest.restoreAllMocks();
    });
  });
});
