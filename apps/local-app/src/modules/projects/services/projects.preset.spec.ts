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
import { NotFoundError } from '../../../common/errors/error-types';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

// Mock probe-1m utility
jest.mock('../../providers/utils/probe-1m', () => ({
  probe1mSupport: jest.fn(),
}));
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
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('computeFamilyAlternatives', () => {
    const coderProfileId = '11111111-1111-1111-1111-111111111111';
    const reviewerProfileId = '22222222-2222-2222-2222-222222222222';
    const coderAgentId = '33333333-3333-3333-3333-333333333333';
    const reviewerAgentId = '44444444-4444-4444-4444-444444444444';

    it('should return canImport: true when all family providers are available', async () => {
      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'p1', name: 'claude' },
          { id: 'p2', name: 'codex' },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Profile',
          provider: { name: 'claude' },
          familySlug: 'coder',
        },
        {
          id: reviewerProfileId,
          name: 'Reviewer Profile',
          provider: { name: 'codex' },
          familySlug: 'reviewer',
        },
      ];
      const agents = [
        { id: coderAgentId, name: 'Coder', profileId: coderProfileId },
        { id: reviewerAgentId, name: 'Reviewer', profileId: reviewerProfileId },
      ];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(true);
      expect(result.missingProviders).toEqual([]);
      expect(result.alternatives).toHaveLength(2);
    });

    it('should return canImport: false when a family has no available providers', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }], // codex is missing
        total: 1,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Profile',
          provider: { name: 'claude' },
          familySlug: 'coder',
        },
        {
          id: reviewerProfileId,
          name: 'Reviewer Profile',
          provider: { name: 'codex' },
          familySlug: 'reviewer',
        },
      ];
      const agents = [
        { id: coderAgentId, name: 'Coder', profileId: coderProfileId },
        { id: reviewerAgentId, name: 'Reviewer', profileId: reviewerProfileId },
      ];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(false);
      expect(result.missingProviders).toContain('codex');

      const reviewerFamily = result.alternatives.find((a) => a.familySlug === 'reviewer');
      expect(reviewerFamily?.hasAlternatives).toBe(false);
      expect(reviewerFamily?.availableProviders).toEqual([]);
    });

    it('should identify available alternatives for a family', async () => {
      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'p1', name: 'claude' },
          { id: 'p2', name: 'gemini' },
        ], // codex is missing but gemini is available
        total: 2,
        limit: 100,
        offset: 0,
      });

      // Coder family has profiles for both codex (default) and gemini (alternative)
      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Codex',
          provider: { name: 'codex' },
          familySlug: 'coder',
        },
        {
          id: '55555555-5555-5555-5555-555555555555',
          name: 'Coder Gemini',
          provider: { name: 'gemini' },
          familySlug: 'coder',
        },
      ];
      const agents = [{ id: coderAgentId, name: 'Coder', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(true);
      expect(result.missingProviders).toContain('codex');

      const coderFamily = result.alternatives.find((a) => a.familySlug === 'coder');
      expect(coderFamily?.defaultProvider).toBe('codex');
      expect(coderFamily?.defaultProviderAvailable).toBe(false);
      expect(coderFamily?.availableProviders).toContain('gemini');
      expect(coderFamily?.hasAlternatives).toBe(true);
    });

    it('should only consider families used by agents', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      // Template has profiles for 'coder' and 'reviewer' families
      // But only 'coder' is used by an agent
      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Profile',
          provider: { name: 'claude' },
          familySlug: 'coder',
        },
        {
          id: reviewerProfileId,
          name: 'Reviewer Profile',
          provider: { name: 'codex' },
          familySlug: 'reviewer',
        },
      ];
      const agents = [{ id: coderAgentId, name: 'Coder', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      // Only coder family should be in alternatives
      expect(result.alternatives).toHaveLength(1);
      expect(result.alternatives[0].familySlug).toBe('coder');
      // codex should not be in missingProviders since reviewer family is not used
      expect(result.missingProviders).not.toContain('codex');
    });

    it('should ignore profiles without familySlug', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'No Family Profile',
          provider: { name: 'claude' },
          familySlug: null,
        },
      ];
      const agents = [{ id: coderAgentId, name: 'Agent', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.alternatives).toHaveLength(0);
      expect(result.canImport).toBe(true);
    });

    it('should handle empty template profiles and agents', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const result = await service.computeFamilyAlternatives([], []);

      expect(result.alternatives).toEqual([]);
      expect(result.missingProviders).toEqual([]);
      expect(result.canImport).toBe(true);
    });

    it('should normalize provider names to lowercase', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'Claude' }], // uppercase in storage
        total: 1,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Profile',
          provider: { name: 'CLAUDE' },
          familySlug: 'coder',
        }, // uppercase in template
      ];
      const agents = [{ id: coderAgentId, name: 'Coder', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(true);
      expect(result.alternatives[0].defaultProviderAvailable).toBe(true);
    });

    it('should discover alternatives from providerConfigs when primary provider is missing', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: reviewerProfileId,
          name: 'Code Reviewer',
          provider: { name: 'gemini' },
          familySlug: 'code reviewer',
          providerConfigs: [
            { providerName: 'gemini' },
            { providerName: 'codex' },
            { providerName: 'claude' },
          ],
        },
      ];
      const agents = [{ id: reviewerAgentId, name: 'Reviewer', profileId: reviewerProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.missingProviders).toContain('gemini');
      expect(result.missingProviders).toContain('codex');
      const reviewerFamily = result.alternatives.find((a) => a.familySlug === 'code reviewer');
      expect(reviewerFamily).toBeDefined();
      expect(reviewerFamily!.defaultProvider).toBe('gemini');
      expect(reviewerFamily!.defaultProviderAvailable).toBe(false);
      expect(reviewerFamily!.availableProviders).toContain('claude');
      expect(reviewerFamily!.hasAlternatives).toBe(true);
      expect(result.canImport).toBe(true);
    });

    it('should not duplicate profile names when providerConfigs overlaps with provider.name', async () => {
      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'p1', name: 'claude' },
          { id: 'p2', name: 'codex' },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder',
          provider: { name: 'claude' },
          familySlug: 'coder',
          providerConfigs: [{ providerName: 'claude' }, { providerName: 'codex' }],
        },
      ];
      const agents = [{ id: coderAgentId, name: 'Coder', profileId: coderProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      const coderFamily = result.alternatives.find((a) => a.familySlug === 'coder');
      expect(coderFamily).toBeDefined();
      expect(coderFamily!.defaultProviderAvailable).toBe(true);
      expect(coderFamily!.availableProviders).toContain('claude');
      expect(coderFamily!.availableProviders).toContain('codex');
      expect(result.canImport).toBe(true);
    });

    it('should return canImport: false when all providerConfigs providers are also missing', async () => {
      storage.listProviders.mockResolvedValue({
        items: [],
        total: 0,
        limit: 100,
        offset: 0,
      });

      const profiles = [
        {
          id: reviewerProfileId,
          name: 'Code Reviewer',
          provider: { name: 'gemini' },
          familySlug: 'code reviewer',
          providerConfigs: [
            { providerName: 'gemini' },
            { providerName: 'codex' },
            { providerName: 'claude' },
          ],
        },
      ];
      const agents = [{ id: reviewerAgentId, name: 'Reviewer', profileId: reviewerProfileId }];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      expect(result.canImport).toBe(false);
      const reviewerFamily = result.alternatives.find((a) => a.familySlug === 'code reviewer');
      expect(reviewerFamily!.availableProviders).toEqual([]);
      expect(reviewerFamily!.hasAlternatives).toBe(false);
    });

    it('should return canImport: false in mixed-family scenario when one family has alternatives but another does not', async () => {
      storage.listProviders.mockResolvedValue({
        items: [{ id: 'p1', name: 'claude' }], // Only claude available locally
        total: 1,
        limit: 100,
        offset: 0,
      });

      // coder family: codex (default, missing) + claude (alternative, available) → hasAlternatives=true
      // reviewer family: only codex (missing) → hasAlternatives=false
      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Codex',
          provider: { name: 'codex' },
          familySlug: 'coder',
        },
        {
          id: '55555555-5555-5555-5555-555555555555',
          name: 'Coder Claude',
          provider: { name: 'claude' },
          familySlug: 'coder',
        },
        {
          id: reviewerProfileId,
          name: 'Reviewer Codex',
          provider: { name: 'codex' },
          familySlug: 'reviewer',
        },
      ];
      const agents = [
        { id: coderAgentId, name: 'Coder', profileId: coderProfileId },
        { id: reviewerAgentId, name: 'Reviewer', profileId: reviewerProfileId },
      ];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      // canImport must be false when ANY family has 0 alternatives — backend invariant
      expect(result.canImport).toBe(false);

      // coder family has alternatives (claude available)
      const coderFamily = result.alternatives.find((a) => a.familySlug === 'coder');
      expect(coderFamily?.hasAlternatives).toBe(true);
      expect(coderFamily?.availableProviders).toContain('claude');

      // reviewer family has NO alternatives
      const reviewerFamily = result.alternatives.find((a) => a.familySlug === 'reviewer');
      expect(reviewerFamily?.hasAlternatives).toBe(false);
      expect(reviewerFamily?.availableProviders).toEqual([]);
    });

    it('should return canImport: true only when all used families have at least one available provider', async () => {
      storage.listProviders.mockResolvedValue({
        items: [
          { id: 'p1', name: 'claude' },
          { id: 'p2', name: 'gemini' },
        ],
        total: 2,
        limit: 100,
        offset: 0,
      });

      // coder family: codex (missing) + claude (available) → has alternative
      // reviewer family: codex (missing) + gemini (available) → has alternative
      const profiles = [
        {
          id: coderProfileId,
          name: 'Coder Codex',
          provider: { name: 'codex' },
          familySlug: 'coder',
        },
        {
          id: '55555555-5555-5555-5555-555555555555',
          name: 'Coder Claude',
          provider: { name: 'claude' },
          familySlug: 'coder',
        },
        {
          id: reviewerProfileId,
          name: 'Reviewer Codex',
          provider: { name: 'codex' },
          familySlug: 'reviewer',
        },
        {
          id: '66666666-6666-6666-6666-666666666666',
          name: 'Reviewer Gemini',
          provider: { name: 'gemini' },
          familySlug: 'reviewer',
        },
      ];
      const agents = [
        { id: coderAgentId, name: 'Coder', profileId: coderProfileId },
        { id: reviewerAgentId, name: 'Reviewer', profileId: reviewerProfileId },
      ];

      const result = await service.computeFamilyAlternatives(profiles, agents);

      // canImport is true because ALL families have at least one available provider
      expect(result.canImport).toBe(true);
      expect(result.alternatives.every((a) => a.hasAlternatives)).toBe(true);
    });
  });

  describe('applyPreset', () => {
    const projectId = 'project-123';

    beforeEach(() => {
      // Add preset methods to settings mock
      (settings as { getProjectPresets: jest.Mock }).getProjectPresets = jest.fn();
      (settings as { setProjectPresets: jest.Mock }).setProjectPresets = jest.fn();
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest.fn();
    });

    it('should apply preset and update agent provider configs', async () => {
      const preset = {
        name: 'default',
        description: 'Default preset',
        agentConfigs: [
          { agentName: 'Coder', providerConfigName: 'claude-config' },
          { agentName: 'Reviewer', providerConfigName: 'gemini-config' },
        ],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      const profileId = 'profile-1';
      const claudeConfigId = 'config-claude';
      const geminiConfigId = 'config-gemini';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [
          { id: 'agent-1', name: 'Coder', profileId, providerConfigId: null },
          { id: 'agent-2', name: 'Reviewer', profileId, providerConfigId: null },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: claudeConfigId,
          profileId,
          providerId: 'claude',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: geminiConfigId,
          profileId,
          providerId: 'gemini',
          name: 'gemini-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const updatedAgents: Array<{ id: string; providerConfigId: string | null }> = [];
      storage.updateAgent.mockImplementation(async (id, data) => {
        updatedAgents.push({ id, providerConfigId: data.providerConfigId ?? null });
        return { id, ...data } as never;
      });

      const result = await service.applyPreset(projectId, 'default');

      expect(result.applied).toBe(2);
      expect(result.warnings).toHaveLength(0);
      expect(updatedAgents).toHaveLength(2);
      expect(updatedAgents[0].providerConfigId).toBe(claudeConfigId);
      expect(updatedAgents[1].providerConfigId).toBe(geminiConfigId);
    });

    it('should apply preset and forward explicit modelOverride values to updateAgent', async () => {
      const preset = {
        name: 'default',
        description: 'Default preset',
        agentConfigs: [
          {
            agentName: 'Coder',
            providerConfigName: 'claude-config',
            modelOverride: 'openai/gpt-5',
          },
          { agentName: 'Reviewer', providerConfigName: 'gemini-config', modelOverride: null },
        ],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      const profileId = 'profile-1';
      const claudeConfigId = 'config-claude';
      const geminiConfigId = 'config-gemini';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [
          { id: 'agent-1', name: 'Coder', profileId, providerConfigId: null, modelOverride: null },
          {
            id: 'agent-2',
            name: 'Reviewer',
            profileId,
            providerConfigId: null,
            modelOverride: 'stale-model',
          },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: claudeConfigId,
          profileId,
          providerId: 'claude',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: geminiConfigId,
          profileId,
          providerId: 'gemini',
          name: 'gemini-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      storage.updateAgent.mockResolvedValue({} as never);

      await service.applyPreset(projectId, 'default');

      expect(storage.updateAgent).toHaveBeenNthCalledWith(1, 'agent-1', {
        providerConfigId: claudeConfigId,
        modelOverride: 'openai/gpt-5',
      });
      expect(storage.updateAgent).toHaveBeenNthCalledWith(2, 'agent-2', {
        providerConfigId: geminiConfigId,
        modelOverride: null,
      });
    });

    it('should apply preset and preserve modelOverride when omitted in preset', async () => {
      const preset = {
        name: 'default',
        description: 'Default preset',
        agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      const profileId = 'profile-1';
      const claudeConfigId = 'config-claude';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
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
            providerConfigId: null,
            modelOverride: 'stale-model',
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: claudeConfigId,
          profileId,
          providerId: 'claude',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      storage.updateAgent.mockResolvedValue({} as never);

      await service.applyPreset(projectId, 'default');

      const updatePayload = (storage.updateAgent as jest.Mock).mock.calls[0]?.[1] as
        | { providerConfigId: string; modelOverride?: string | null }
        | undefined;
      expect(updatePayload).toEqual(
        expect.objectContaining({
          providerConfigId: claudeConfigId,
        }),
      );
      expect(updatePayload).toEqual(
        expect.not.objectContaining({
          modelOverride: expect.anything(),
        }),
      );
    });

    it('should throw NotFoundError when preset not found', async () => {
      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([
        { name: 'other', agentConfigs: [] },
      ]);

      await expect(service.applyPreset(projectId, 'missing')).rejects.toThrow(NotFoundError);
    });

    it('should return warning for missing agent', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [{ agentName: 'MissingAgent', providerConfigName: 'config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });

      const result = await service.applyPreset(projectId, 'default');

      expect(result.applied).toBe(0);
      expect(result.warnings).toContain('Agent "MissingAgent" not found in project');
    });

    it('should return warning for missing provider config', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [{ agentName: 'Coder', providerConfigName: 'missing-config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      const profileId = 'profile-1';
      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [{ id: 'agent-1', name: 'Coder', profileId, providerConfigId: null }],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: 'config-1',
          profileId,
          providerId: 'claude',
          name: 'other-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const result = await service.applyPreset(projectId, 'default');

      expect(result.applied).toBe(0);
      expect(result.warnings).toContain(
        'Provider config "missing-config" not found for agent "Coder"',
      );
    });

    it('should match agent names case-insensitively', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [{ agentName: 'coder', providerConfigName: 'config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);

      const profileId = 'profile-1';
      const configId = 'config-1';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [{ id: 'agent-1', name: 'Coder', profileId, providerConfigId: null }],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: configId,
          profileId,
          providerId: 'claude',
          name: 'config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      const updatedAgents: Array<{ id: string }> = [];
      storage.updateAgent.mockImplementation(async (id) => {
        updatedAgents.push({ id });
        return { id } as never;
      });

      const result = await service.applyPreset(projectId, 'default');

      expect(result.applied).toBe(1);
      expect(updatedAgents[0].id).toBe('agent-1');
    });

    it('should set activePreset when full match (no warnings, all applied)', async () => {
      const preset = {
        name: 'default',
        description: 'Default preset',
        agentConfigs: [
          { agentName: 'Coder', providerConfigName: 'claude-config' },
          { agentName: 'Reviewer', providerConfigName: 'gemini-config' },
        ],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest.fn();

      const profileId = 'profile-1';
      const claudeConfigId = 'config-claude';
      const geminiConfigId = 'config-gemini';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [
          { id: 'agent-1', name: 'Coder', profileId, providerConfigId: null },
          { id: 'agent-2', name: 'Reviewer', profileId, providerConfigId: null },
        ],
        total: 2,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: claudeConfigId,
          profileId,
          providerId: 'claude',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: geminiConfigId,
          profileId,
          providerId: 'gemini',
          name: 'gemini-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      storage.updateAgent.mockResolvedValue({} as never);

      await service.applyPreset(projectId, 'default');

      expect(settings.setProjectActivePreset).toHaveBeenCalledWith(projectId, 'default');
    });

    it('should not set activePreset when warnings present', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [{ agentName: 'MissingAgent', providerConfigName: 'config' }],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest.fn();

      storage.listAgentProfiles.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });
      storage.listAgents.mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0 });

      await service.applyPreset(projectId, 'default');

      expect(settings.setProjectActivePreset).not.toHaveBeenCalled();
    });

    it('should not set activePreset when not all agents applied', async () => {
      const preset = {
        name: 'default',
        agentConfigs: [
          { agentName: 'Coder', providerConfigName: 'claude-config' },
          { agentName: 'MissingAgent', providerConfigName: 'config' },
        ],
      };

      (settings as { getProjectPresets: jest.Mock }).getProjectPresets.mockReturnValue([preset]);
      (settings as { setProjectActivePreset: jest.Mock }).setProjectActivePreset = jest.fn();

      const profileId = 'profile-1';
      const claudeConfigId = 'config-claude';

      storage.listAgentProfiles.mockResolvedValue({
        items: [
          {
            id: profileId,
            projectId,
            name: 'CodeOpus',
            familySlug: 'coder',
            providerId: 'claude',
            instructions: null,
            temperature: null,
            maxTokens: null,
            options: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listAgents.mockResolvedValue({
        items: [{ id: 'agent-1', name: 'Coder', profileId, providerConfigId: null }],
        total: 1,
        limit: 1000,
        offset: 0,
      });

      storage.listProfileProviderConfigsByProfile.mockResolvedValue([
        {
          id: claudeConfigId,
          profileId,
          providerId: 'claude',
          name: 'claude-config',
          options: null,
          env: null,
          createdAt: '',
          updatedAt: '',
        },
      ]);

      storage.updateAgent.mockResolvedValue({} as never);

      await service.applyPreset(projectId, 'default');

      // 1 agent applied out of 2 in preset, so not a full match
      expect(settings.setProjectActivePreset).not.toHaveBeenCalled();
    });
  });
});
