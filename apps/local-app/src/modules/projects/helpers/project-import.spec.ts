import type { StorageService } from '../../storage/interfaces/storage.interface';
import {
  importProjectWithHelper,
  createImportedTeams,
  pruneUnavailableTeamProfileSelections,
} from './project-import';
import { preserveImportedEnv } from './profile-mapping.helpers';
import { applyTeamOverrides } from './team-overrides.helpers';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('preserveImportedEnv', () => {
  it('returns null for null input', () => {
    expect(preserveImportedEnv(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(preserveImportedEnv(undefined)).toBeNull();
  });

  it('keeps redacted entries (the user needs to see which secrets to fill in)', () => {
    expect(preserveImportedEnv({ API_KEY: '***', NODE_ENV: 'prod' })).toEqual({
      API_KEY: '***',
      NODE_ENV: 'prod',
    });
  });

  it('keeps redacted entries even when every entry is redacted', () => {
    expect(preserveImportedEnv({ API_KEY: '***', SECRET: '***' })).toEqual({
      API_KEY: '***',
      SECRET: '***',
    });
  });

  it('preserves all entries when none are redacted', () => {
    const env = { FOO: 'bar', BAZ: 'qux' };
    expect(preserveImportedEnv(env)).toEqual(env);
  });

  it('returns empty-to-null for empty input', () => {
    expect(preserveImportedEnv({})).toBeNull();
  });
});
describe('createImportedTeams', () => {
  const projectId = 'project-1';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyDeps = any;

  const makeDeps = (overrides?: {
    agents?: Array<{ id: string; name: string }>;
    profiles?: Array<{ id: string; name: string }>;
    createTeam?: jest.Mock;
    deleteTeamsByProject?: jest.Mock;
    deleteTeamsByIds?: jest.Mock;
  }) => {
    const agents = overrides?.agents ?? [
      { id: 'agent-1', name: 'Agent A' },
      { id: 'agent-2', name: 'Agent B' },
    ];
    const profiles = overrides?.profiles ?? [{ id: 'profile-1', name: 'Profile 1' }];

    return {
      storage: {
        listAgents: jest.fn().mockResolvedValue({ items: agents }),
        listAgentProfiles: jest.fn().mockResolvedValue({ items: profiles }),
      } as unknown as StorageService,
      settings: {} as unknown,
      watchersService: {} as unknown,
      sessions: {} as unknown,
      unifiedTemplateService: {} as unknown,
      computeFamilyAlternatives: jest.fn(),
      createWatchersFromPayload: jest.fn(),
      createSubscribersFromPayload: jest.fn(),
      applyProjectSettings: jest.fn(),
      getImportErrorMessage: jest.fn(),
      teamsService: {
        createTeam: overrides?.createTeam ?? jest.fn().mockResolvedValue({ id: 'team-1' }),
        deleteTeamsByProject:
          overrides?.deleteTeamsByProject ?? jest.fn().mockResolvedValue(undefined),
        deleteTeamsByIds: overrides?.deleteTeamsByIds ?? jest.fn().mockResolvedValue(undefined),
      },
    };
  };

  it('successfully imports teams with agents and profiles resolved', async () => {
    const deps = makeDeps();
    const teams = [
      {
        name: 'Backend Team',
        description: 'The backend team',
        teamLeadAgentName: 'Agent A',
        memberAgentNames: ['Agent A', 'Agent B'],
        profileNames: ['Profile 1'],
      },
    ];

    const result = await createImportedTeams(projectId, teams, deps as AnyDeps);
    expect(result).toBe(1);
    expect(deps.teamsService.createTeam).toHaveBeenCalledWith({
      projectId,
      name: 'Backend Team',
      description: 'The backend team',
      teamLeadAgentId: 'agent-1',
      memberAgentIds: ['agent-1', 'agent-2'],
      profileIds: ['profile-1'],
    });
  });

  it('throws when a member agent name is not found', async () => {
    const deps = makeDeps();
    const teams = [
      {
        name: 'Team X',
        memberAgentNames: ['Agent A', 'NonExistent'],
      },
    ];

    await expect(createImportedTeams(projectId, teams, deps as AnyDeps)).rejects.toThrow(
      'references agent "NonExistent" which was not found',
    );
  });

  it('throws when team lead agent name is not found', async () => {
    const deps = makeDeps();
    const teams = [
      {
        name: 'Team X',
        teamLeadAgentName: 'Ghost',
        memberAgentNames: ['Agent A'],
      },
    ];

    await expect(createImportedTeams(projectId, teams, deps as AnyDeps)).rejects.toThrow(
      'references team lead "Ghost" which was not found',
    );
  });

  it('throws when a profile name is not found', async () => {
    const deps = makeDeps();
    const teams = [
      {
        name: 'Team X',
        memberAgentNames: ['Agent A'],
        profileNames: ['Missing Profile'],
      },
    ];

    await expect(createImportedTeams(projectId, teams, deps as AnyDeps)).rejects.toThrow(
      'references profile "Missing Profile" which was not found',
    );
  });

  it('calls deleteTeamsByIds with only created team ids on cleanup when creation fails mid-batch', async () => {
    const createTeam = jest
      .fn()
      .mockResolvedValueOnce({ id: 'team-created-1' })
      .mockRejectedValueOnce(new Error('DB error'));
    const deleteTeamsByIds = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ createTeam, deleteTeamsByIds });
    const teams = [
      { name: 'Team 1', memberAgentNames: ['Agent A'] },
      { name: 'Team 2', memberAgentNames: ['Agent B'] },
    ];

    await expect(createImportedTeams(projectId, teams, deps as AnyDeps)).rejects.toThrow(
      'DB error',
    );
    expect(deleteTeamsByIds).toHaveBeenCalledWith(['team-created-1']);
    expect(deps.teamsService.deleteTeamsByProject).not.toHaveBeenCalled();
  });

  it('pre-existing teams survive when mid-batch import fails', async () => {
    const createTeam = jest
      .fn()
      .mockResolvedValueOnce({ id: 'imported-1' })
      .mockResolvedValueOnce({ id: 'imported-2' })
      .mockRejectedValueOnce(new Error('3rd team failed'));
    const deleteTeamsByIds = jest.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ createTeam, deleteTeamsByIds });
    const teams = [
      { name: 'Team A', memberAgentNames: ['Agent A'] },
      { name: 'Team B', memberAgentNames: ['Agent B'] },
      { name: 'Team C', memberAgentNames: ['Agent A'], profileNames: ['Unknown Profile'] },
    ];

    await expect(createImportedTeams(projectId, teams, deps as AnyDeps)).rejects.toThrow();
    expect(deleteTeamsByIds).toHaveBeenCalledWith(['imported-1', 'imported-2']);
    expect(deps.teamsService.deleteTeamsByProject).not.toHaveBeenCalled();
  });

  it('returns 0 when teamsService is not provided', async () => {
    const deps = makeDeps();
    delete (deps as AnyDeps).teamsService;

    const result = await createImportedTeams(projectId, [], deps as AnyDeps);
    expect(result).toBe(0);
  });

  it('returns 0 for empty teams array', async () => {
    const deps = makeDeps();

    const result = await createImportedTeams(projectId, [], deps as AnyDeps);
    expect(result).toBe(0);
    expect(deps.teamsService.createTeam).not.toHaveBeenCalled();
  });

  it('resolves profileSelections and passes profileConfigSelections to createTeam', async () => {
    const deps = makeDeps();
    (
      deps.storage as unknown as { listProfileProviderConfigsByProfile: jest.Mock }
    ).listProfileProviderConfigsByProfile = jest.fn().mockResolvedValue([
      { id: 'config-1', name: 'Config Alpha', profileId: 'profile-1' },
      { id: 'config-2', name: 'Config Beta', profileId: 'profile-1' },
    ]);

    const teams = [
      {
        name: 'Backend Team',
        memberAgentNames: ['Agent A'],
        profileNames: ['Profile 1'],
        profileSelections: [{ profileName: 'Profile 1', configNames: ['Config Alpha'] }],
      },
    ];

    const result = await createImportedTeams(projectId, teams, deps as AnyDeps);
    expect(result).toBe(1);
    expect(deps.teamsService.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        profileConfigSelections: [{ profileId: 'profile-1', configIds: ['config-1'] }],
      }),
    );
  });

  it('throws when profileSelections references unknown config name', async () => {
    const deps = makeDeps();
    (
      deps.storage as unknown as { listProfileProviderConfigsByProfile: jest.Mock }
    ).listProfileProviderConfigsByProfile = jest
      .fn()
      .mockResolvedValue([{ id: 'config-1', name: 'Config Alpha', profileId: 'profile-1' }]);

    const teams = [
      {
        name: 'Team X',
        memberAgentNames: ['Agent A'],
        profileNames: ['Profile 1'],
        profileSelections: [{ profileName: 'Profile 1', configNames: ['NonExistent Config'] }],
      },
    ];

    await expect(createImportedTeams(projectId, teams, deps as AnyDeps)).rejects.toThrow(
      'references config "NonExistent Config" for profile "Profile 1" which was not found',
    );
  });

  it('throws when profileSelections references unknown profile name', async () => {
    const deps = makeDeps();
    const teams = [
      {
        name: 'Team X',
        memberAgentNames: ['Agent A'],
        profileSelections: [{ profileName: 'Ghost Profile', configNames: ['Config'] }],
      },
    ];

    await expect(createImportedTeams(projectId, teams, deps as AnyDeps)).rejects.toThrow(
      'references profile "Ghost Profile" in profileSelections which was not found',
    );
  });

  it('imports teams without profileSelections (legacy backward compat)', async () => {
    const deps = makeDeps();
    const teams = [
      {
        name: 'Legacy Team',
        memberAgentNames: ['Agent A'],
        profileNames: ['Profile 1'],
      },
    ];

    const result = await createImportedTeams(projectId, teams, deps as AnyDeps);
    expect(result).toBe(1);
    const call = deps.teamsService.createTeam.mock.calls[0][0];
    expect(call.profileConfigSelections).toBeUndefined();
  });

  it('config name resolution is case-insensitive', async () => {
    const deps = makeDeps();
    (
      deps.storage as unknown as { listProfileProviderConfigsByProfile: jest.Mock }
    ).listProfileProviderConfigsByProfile = jest
      .fn()
      .mockResolvedValue([{ id: 'config-1', name: 'Config Alpha', profileId: 'profile-1' }]);

    const teams = [
      {
        name: 'Team CI',
        memberAgentNames: ['Agent A'],
        profileNames: ['Profile 1'],
        profileSelections: [{ profileName: 'profile 1', configNames: ['config alpha'] }],
      },
    ];

    const result = await createImportedTeams(projectId, teams, deps as AnyDeps);
    expect(result).toBe(1);
    expect(deps.teamsService.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        profileConfigSelections: [{ profileId: 'profile-1', configIds: ['config-1'] }],
      }),
    );
  });
});

describe('pruneUnavailableTeamProfileSelections', () => {
  it('drops known template configs that were not created because their provider is unavailable', () => {
    const result = pruneUnavailableTeamProfileSelections(
      [
        {
          name: 'Planning',
          memberAgentNames: ['Architect'],
          profileSelections: [
            {
              profileName: 'Architect',
              configNames: ['gpt-high', 'agy3', 'opus'],
            },
          ],
        },
      ],
      [
        {
          id: 'profile-old-1',
          name: 'Architect',
          providerConfigs: [{ name: 'gpt-high' }, { name: 'agy3' }, { name: 'opus' }],
        },
      ],
      { 'profile-old-1': 'profile-new-1' },
      new Map([
        ['profile-new-1:gpt-high', 'config-gpt'],
        ['profile-new-1:opus', 'config-opus'],
      ]),
    );

    expect(result[0].profileSelections).toEqual([
      {
        profileName: 'Architect',
        configNames: ['gpt-high', 'opus'],
      },
    ]);
  });

  it('keeps unknown config names so strict team import still reports template typos', () => {
    const result = pruneUnavailableTeamProfileSelections(
      [
        {
          name: 'Planning',
          memberAgentNames: ['Architect'],
          profileSelections: [
            {
              profileName: 'Architect',
              configNames: ['typo-config'],
            },
          ],
        },
      ],
      [
        {
          id: 'profile-old-1',
          name: 'Architect',
          providerConfigs: [{ name: 'gpt-high' }],
        },
      ],
      { 'profile-old-1': 'profile-new-1' },
      new Map([['profile-new-1:gpt-high', 'config-gpt']]),
    );

    expect(result[0].profileSelections).toEqual([
      {
        profileName: 'Architect',
        configNames: ['typo-config'],
      },
    ]);
  });

  it('removes a profile from profileNames when all selected configs are unavailable', () => {
    const result = pruneUnavailableTeamProfileSelections(
      [
        {
          name: 'Planning',
          memberAgentNames: ['Architect'],
          profileNames: ['Architect'],
          profileSelections: [
            {
              profileName: 'Architect',
              configNames: ['agy3'],
            },
          ],
        },
      ],
      [
        {
          id: 'profile-old-1',
          name: 'Architect',
          providerConfigs: [{ name: 'agy3' }],
        },
      ],
      { 'profile-old-1': 'profile-new-1' },
      new Map(),
    );

    expect(result[0].profileNames).toEqual([]);
    expect(result[0].profileSelections).toBeUndefined();
  });
});

describe('applyTeamOverrides', () => {
  const baseTeam = {
    name: 'Dev Team',
    description: 'A team',
    memberAgentNames: ['Agent A'],
    maxMembers: 4,
    maxConcurrentTasks: 2,
    allowTeamLeadCreateAgents: false,
    profileNames: ['Profile A'],
    profileSelections: [{ profileName: 'Profile A', configNames: ['Config 1'] }],
  };

  it('returns teams unchanged when no overrides provided', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, undefined);
    expect(result).toStrictEqual(teams);
  });

  it('returns teams unchanged when overrides array is empty', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, []);
    expect(result).toStrictEqual(teams);
  });

  it('applies maxMembers, maxConcurrentTasks, and allowTeamLeadCreateAgents overrides', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, [
      {
        teamName: 'Dev Team',
        maxMembers: 8,
        maxConcurrentTasks: 5,
        allowTeamLeadCreateAgents: true,
      },
    ]);
    expect(result[0].maxMembers).toBe(8);
    expect(result[0].maxConcurrentTasks).toBe(5);
    expect(result[0].allowTeamLeadCreateAgents).toBe(true);
  });

  it('applies profileNames override, replacing template profileNames', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, [
      { teamName: 'Dev Team', profileNames: ['Profile B'] },
    ]);
    expect(result[0].profileNames).toEqual(['Profile B']);
  });

  it('applies profileSelections override, replacing template profileSelections', () => {
    const teams = [baseTeam];
    const overrideSelections = [{ profileName: 'Profile B', configNames: ['Config X'] }];
    const result = applyTeamOverrides(teams, [
      { teamName: 'Dev Team', profileSelections: overrideSelections },
    ]);
    expect(result[0].profileSelections).toEqual(overrideSelections);
  });

  it('does not modify teams not referenced by an override', () => {
    const otherTeam = { ...baseTeam, name: 'QA Team', maxMembers: 3 };
    const teams = [baseTeam, otherTeam];
    const result = applyTeamOverrides(teams, [{ teamName: 'Dev Team', maxMembers: 10 }]);
    expect(result[0].maxMembers).toBe(10);
    expect(result[1].maxMembers).toBe(3);
  });

  it('silently skips overrides that reference non-existent team names', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, [{ teamName: 'Ghost Team', maxMembers: 10 }]);
    expect(result).toHaveLength(1);
    expect(result[0].maxMembers).toBe(4);
  });

  it('matches team names case-insensitively', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, [{ teamName: 'DEV TEAM', maxMembers: 6 }]);
    expect(result[0].maxMembers).toBe(6);
  });

  it('import without overrides: createImportedTeams receives unmodified team data', async () => {
    const deps = {
      storage: {
        listAgents: jest.fn().mockResolvedValue({ items: [{ id: 'a1', name: 'Agent A' }] }),
        listAgentProfiles: jest
          .fn()
          .mockResolvedValue({ items: [{ id: 'p1', name: 'Profile A' }] }),
      },
      teamsService: {
        createTeam: jest.fn().mockResolvedValue({ id: 't1' }),
        deleteTeamsByIds: jest.fn(),
      },
    };
    const teams = [{ name: 'Dev Team', memberAgentNames: ['Agent A'], maxMembers: 4 }];
    const overridden = applyTeamOverrides(teams, undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createImportedTeams('proj-1', overridden, deps as any);
    expect(deps.teamsService.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({ maxMembers: 4 }),
    );
  });

  it('import with overrides: createImportedTeams receives overridden team data', async () => {
    const deps = {
      storage: {
        listAgents: jest.fn().mockResolvedValue({ items: [{ id: 'a1', name: 'Agent A' }] }),
        listAgentProfiles: jest.fn().mockResolvedValue({ items: [] }),
      },
      teamsService: {
        createTeam: jest.fn().mockResolvedValue({ id: 't1' }),
        deleteTeamsByIds: jest.fn(),
      },
    };
    const teams = [{ name: 'Dev Team', memberAgentNames: ['Agent A'], maxMembers: 4 }];
    const overridden = applyTeamOverrides(teams, [{ teamName: 'Dev Team', maxMembers: 9 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await createImportedTeams('proj-1', overridden, deps as any);
    expect(deps.teamsService.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({ maxMembers: 9 }),
    );
  });

  describe('profileNameRemapMap', () => {
    it('returns teams unchanged when no remap map provided (undefined)', () => {
      const teams = [baseTeam];
      const result = applyTeamOverrides(
        teams,
        [{ teamName: 'Dev Team', profileNames: ['Profile A'] }],
        undefined,
      );
      expect(result[0].profileNames).toEqual(['Profile A']);
    });

    it('remaps override profileNames through the remap map, re-resolving original casing', () => {
      // Realistic family substitution: 'Coder Codex' -> 'Coder Claude'. The remap
      // map value is the selected profile name lowercased, matching profile-mapping.helpers.
      const remapMap = new Map([['coder codex', 'coder claude']]);
      const resolvedProfiles = [{ name: 'Coder Claude' }];
      const teams = [{ ...baseTeam, profileNames: ['Coder Codex'] }];
      const result = applyTeamOverrides(
        teams,
        [{ teamName: 'Dev Team', profileNames: ['Coder Codex'] }],
        remapMap,
        resolvedProfiles,
      );
      expect(result[0].profileNames).toEqual(['Coder Claude']);
    });

    it('remaps override profileSelections.profileName through the remap map, re-resolving casing', () => {
      const remapMap = new Map([['coder codex', 'coder claude']]);
      const resolvedProfiles = [{ name: 'Coder Claude' }];
      const teams = [baseTeam];
      const result = applyTeamOverrides(
        teams,
        [
          {
            teamName: 'Dev Team',
            profileSelections: [{ profileName: 'Coder Codex', configNames: ['claude-local'] }],
          },
        ],
        remapMap,
        resolvedProfiles,
      );
      expect(result[0].profileSelections).toEqual([
        { profileName: 'Coder Claude', configNames: ['claude-local'] },
      ]);
    });

    it('preserves profile names not in the remap map', () => {
      const remapMap = new Map([['codex-default', 'claude-default']]);
      const teams = [baseTeam];
      const result = applyTeamOverrides(
        teams,
        [
          {
            teamName: 'Dev Team',
            profileNames: ['Profile A'],
            profileSelections: [{ profileName: 'Profile A', configNames: ['Config 1'] }],
          },
        ],
        remapMap,
      );
      expect(result[0].profileNames).toEqual(['Profile A']);
      expect(result[0].profileSelections).toEqual([
        { profileName: 'Profile A', configNames: ['Config 1'] },
      ]);
    });

    it('remap is case-insensitive on the profile name lookup', () => {
      const remapMap = new Map([['coder codex', 'coder claude']]);
      const resolvedProfiles = [{ name: 'Coder Claude' }];
      const teams = [baseTeam];
      const result = applyTeamOverrides(
        teams,
        [{ teamName: 'Dev Team', profileNames: ['CODER CODEX'] }],
        remapMap,
        resolvedProfiles,
      );
      expect(result[0].profileNames).toEqual(['Coder Claude']);
    });

    it('integration: override with remapped profileSelections resolves against post-remap profileIdMap', async () => {
      // Scenario: family provider substitution remapped 'codex-default' → 'claude-default'.
      // The override references 'codex-default'. After applyTeamOverrides remap, it becomes
      // 'claude-default'. createImportedTeams must resolve against the created profile.
      const remapMap = new Map([['codex-default', 'claude-default']]);
      const deps = {
        storage: {
          listAgents: jest.fn().mockResolvedValue({ items: [{ id: 'a1', name: 'Agent A' }] }),
          listAgentProfiles: jest.fn().mockResolvedValue({
            items: [{ id: 'p-claude', name: 'claude-default' }],
          }),
          listProfileProviderConfigsByProfile: jest
            .fn()
            .mockResolvedValue([{ id: 'c1', name: 'claude-local' }]),
        },
        teamsService: {
          createTeam: jest.fn().mockResolvedValue({ id: 't1' }),
          deleteTeamsByIds: jest.fn(),
        },
      };
      // Template team has profileNames referencing the pre-substitution profile name.
      const teams = [
        {
          ...baseTeam,
          profileNames: ['codex-default'],
          profileSelections: [{ profileName: 'codex-default', configNames: ['claude-local'] }],
        },
      ];
      // Override also references pre-substitution name; both should be remapped.
      const overridden = applyTeamOverrides(
        teams,
        [
          {
            teamName: 'Dev Team',
            profileSelections: [{ profileName: 'codex-default', configNames: ['claude-local'] }],
          },
        ],
        remapMap,
        // Resolved profiles that will be created; re-resolution lands on 'claude-default'.
        [{ name: 'claude-default' }],
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createImportedTeams('proj-1', overridden, deps as any);
      const createArg = (deps.teamsService.createTeam as jest.Mock).mock.calls[0][0];
      // profileConfigSelections should reference the post-remap profile id (p-claude)
      expect(createArg.profileConfigSelections?.[0]?.profileId).toBe('p-claude');
    });
  });
});

// ─── importProjectWithHelper — session preservation ────────────────────────
describe('importProjectWithHelper — session preservation', () => {
  // Fixed template-level IDs used across tests
  const PROFILE_TPL_ID = '11111111-1111-1111-1111-111111111111';
  const AGENT_TPL_1_ID = '22222222-2222-2222-2222-222222222221';
  const AGENT_TPL_2_ID = '22222222-2222-2222-2222-222222222222';
  const PROJECT_ID = 'project-session-test';

  // Minimal valid profile for the template payload
  const defaultProfile = {
    id: PROFILE_TPL_ID,
    name: 'Default Profile',
    provider: { name: 'claude' },
  };

  // Build a minimal valid import payload
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makePayload = (agents: any[], profiles: any[] = [defaultProfile]) => ({
    profiles,
    agents,
    statuses: [],
    prompts: [],
  });

  // Base agent entries for the template (each references defaultProfile)
  const makeTemplateAgent = (name: string, id: string = AGENT_TPL_1_ID) => ({
    id,
    name,
    profileId: PROFILE_TPL_ID,
  });

  // Storage mock factory — all methods return sensible defaults; pass overrides to customise
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeStorage = (overrides: Record<string, jest.Mock> = {}): Record<string, jest.Mock> => ({
    listProviders: jest.fn().mockResolvedValue({
      items: [{ id: 'provider-claude', name: 'claude' }],
      total: 1,
      limit: 100,
      offset: 0,
    }),
    listPrompts: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 }),
    listAgentProfiles: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 }),
    listAgents: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 }),
    listStatuses: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 }),
    listWatchers: jest.fn().mockResolvedValue([]),
    listSubscribers: jest.fn().mockResolvedValue([]),
    listScheduledEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listEpics: jest.fn().mockResolvedValue({ items: [], total: 0, limit: 10000, offset: 0 }),
    countEpicsByStatus: jest.fn().mockResolvedValue(0),
    deleteAgent: jest.fn().mockResolvedValue(undefined),
    deleteAgentProfile: jest.fn().mockResolvedValue(undefined),
    deletePrompt: jest.fn().mockResolvedValue(undefined),
    deleteStatus: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockImplementation(async (id: string) => ({ id })),
    deleteSubscriber: jest.fn().mockResolvedValue(undefined),
    deleteScheduledEpic: jest.fn().mockResolvedValue(undefined),
    createAgentProfile: jest.fn().mockImplementation(async (data: { name: string }) => ({
      id: `new-profile-${data.name.toLowerCase().replace(/\s+/g, '-')}`,
      ...data,
    })),
    createProfileProviderConfig: jest
      .fn()
      .mockImplementation(async (data: { profileId: string }) => ({
        id: `new-config-${data.profileId}`,
      })),
    createAgent: jest.fn().mockImplementation(async (data: { name: string }) => ({
      id: `new-agent-${data.name.trim().toLowerCase().replace(/\s+/g, '-')}`,
      ...data,
    })),
    createPrompt: jest.fn().mockImplementation(async (data: { title: string }) => ({
      id: `new-prompt-${data.title}`,
      ...data,
    })),
    createStatus: jest.fn().mockImplementation(async (data: { label: string }) => ({
      id: `new-status-${data.label}`,
      ...data,
    })),
    parkSessionsFromAgents: jest.fn().mockResolvedValue(new Map()),
    applySessionPlan: jest.fn().mockResolvedValue(undefined),
    updateProvider: jest.fn().mockResolvedValue(undefined),
    updateEpic: jest.fn().mockResolvedValue(undefined),
    listProvidersByIds: jest.fn().mockResolvedValue([]),
    listProviderModelsByProviderIds: jest.fn().mockResolvedValue([]),
    bulkCreateProviderModels: jest.fn().mockResolvedValue({ added: [], existing: [] }),
    listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([]),
    ...overrides,
  });

  // Deps factory — wires the storage mock into the full ImportProjectDeps shape
  const makeDeps = (
    storage: ReturnType<typeof makeStorage>,
    sessionsMock = jest.fn().mockReturnValue([]),
  ) => ({
    storage: storage as unknown as StorageService,
    sessions: { getActiveSessionsForProject: sessionsMock },
    settings: {
      updateSettings: jest.fn().mockResolvedValue(undefined),
      setProjectTemplateMetadata: jest.fn().mockResolvedValue(undefined),
      clearProjectPresets: jest.fn().mockResolvedValue(undefined),
      setProjectPresets: jest.fn().mockResolvedValue(undefined),
    } as unknown as import('../../settings/services/settings.service').SettingsService,
    watchersService: { deleteWatcher: jest.fn().mockResolvedValue(undefined) },
    unifiedTemplateService: {
      getBundledTemplate: jest.fn().mockImplementation(() => {
        throw new Error('not bundled');
      }),
    },
    computeFamilyAlternatives: jest
      .fn()
      .mockResolvedValue({ alternatives: [], missingProviders: [], canImport: true }),
    createWatchersFromPayload: jest.fn().mockResolvedValue({ created: 0, watcherIdMap: {} }),
    createSubscribersFromPayload: jest.fn().mockResolvedValue({ created: 0, subscriberIdMap: {} }),
    applyProjectSettings: jest.fn().mockResolvedValue({ initialPromptSet: false }),
    getImportErrorMessage: jest.fn().mockImplementation((e: unknown) => String(e)),
    applyAgentConfigs: jest.fn().mockResolvedValue({ applied: 0, warnings: [] }),
  });

  it('(a) preserves sessions when old agent name matches new template agent name', async () => {
    const storage = makeStorage({
      listAgentProfiles: jest.fn().mockResolvedValue({
        items: [{ id: 'old-profile-1', name: 'Default Profile' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: 'old-agent-1', name: 'Coder', profileId: 'old-profile-1' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      parkSessionsFromAgents: jest.fn().mockResolvedValue(new Map([['old-agent-1', ['sess-1']]])),
      createAgent: jest.fn().mockResolvedValue({ id: 'new-coder-id', name: 'Coder' }),
    });
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
      deps,
    );

    expect(result).toMatchObject({
      success: true,
      sessionPreservation: { preservedCount: 1, removedCount: 0 },
    });
    expect(storage.applySessionPlan).toHaveBeenCalledWith(
      [{ sessionId: 'sess-1', newAgentId: 'new-coder-id' }],
      [],
    );
  });

  it('applies agentOverrides after the profiles+agents batch and leaves batch-6 preset semantics untouched', async () => {
    const storage = makeStorage();
    const deps = makeDeps(storage);
    const agentOverrides = [
      { agentName: 'Coder', providerConfigName: 'claude-config', modelOverride: 'openai/gpt-5' },
    ];

    const result = await importProjectWithHelper(
      {
        projectId: PROJECT_ID,
        payload: makePayload([makeTemplateAgent('Coder')]),
        agentOverrides,
      },
      deps,
    );

    expect(result).toMatchObject({ success: true });

    // agentOverrides are applied via the shared helper, using the freshly-built name maps that
    // the profiles/agents codecs published (proving the apply runs AFTER that batch).
    expect(deps.applyAgentConfigs).toHaveBeenCalledTimes(1);
    const [calledProjectId, calledConfigs, calledMaps] = deps.applyAgentConfigs.mock.calls[0];
    expect(calledProjectId).toBe(PROJECT_ID);
    expect(calledConfigs).toEqual(agentOverrides);
    expect(calledMaps.agentNameToId).toBeInstanceOf(Map);
    expect(calledMaps.agentNameToId.get('coder')).toBe('new-agent-coder');
    expect(calledMaps.configLookupMap).toBeInstanceOf(Map);

    // Regression: batch-6 presets codec still runs unchanged (payload has no presets → clear).
    expect(
      (deps.settings as unknown as { clearProjectPresets: jest.Mock }).clearProjectPresets,
    ).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('does not invoke applyAgentConfigs when no agentOverrides are provided', async () => {
    const storage = makeStorage();
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
      deps,
    );

    expect(result).toMatchObject({ success: true });
    expect(deps.applyAgentConfigs).not.toHaveBeenCalled();
  });

  it('(b) deletes sessions when old agent name has no match in new template', async () => {
    const storage = makeStorage({
      listAgentProfiles: jest.fn().mockResolvedValue({
        items: [{ id: 'old-profile-1', name: 'Default Profile' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: 'old-reviewer-id', name: 'Reviewer', profileId: 'old-profile-1' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      parkSessionsFromAgents: jest
        .fn()
        .mockResolvedValue(new Map([['old-reviewer-id', ['sess-rev-1']]])),
    });
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
      deps,
    );

    expect(result).toMatchObject({
      success: true,
      sessionPreservation: { preservedCount: 0, removedCount: 1 },
    });
    expect(storage.applySessionPlan).toHaveBeenCalledWith([], ['sess-rev-1']);
  });

  it('(c) reassigns all sessions when old agent has multiple sessions and name matches', async () => {
    const storage = makeStorage({
      listAgentProfiles: jest.fn().mockResolvedValue({
        items: [{ id: 'old-profile-1', name: 'Default Profile' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: 'old-coder-id', name: 'Coder', profileId: 'old-profile-1' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      parkSessionsFromAgents: jest
        .fn()
        .mockResolvedValue(new Map([['old-coder-id', ['s1', 's2', 's3']]])),
      createAgent: jest.fn().mockResolvedValue({ id: 'new-coder-id', name: 'Coder' }),
    });
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
      deps,
    );

    expect(result).toMatchObject({
      success: true,
      sessionPreservation: { preservedCount: 3, removedCount: 0 },
    });
    expect(storage.applySessionPlan).toHaveBeenCalledWith(
      [
        { sessionId: 's1', newAgentId: 'new-coder-id' },
        { sessionId: 's2', newAgentId: 'new-coder-id' },
        { sessionId: 's3', newAgentId: 'new-coder-id' },
      ],
      [],
    );
  });

  it('(d) merges sessions from two old agents with the same lowercased name into one new agent', async () => {
    // Defensive scenario: duplicate OLD names (schema doesn't prevent it on old data).
    // Both old agents have the same lowercased name 'coder', each with one session.
    // New template has one 'Coder' agent — both sessions should be reassigned to it.
    const storage = makeStorage({
      listAgentProfiles: jest.fn().mockResolvedValue({
        items: [{ id: 'old-profile-1', name: 'Default Profile' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [
          { id: 'old-a1', name: 'Coder', profileId: 'old-profile-1' },
          { id: 'old-a2', name: 'coder', profileId: 'old-profile-1' },
        ],
        total: 2,
        limit: 10000,
        offset: 0,
      }),
      parkSessionsFromAgents: jest.fn().mockResolvedValue(
        new Map([
          ['old-a1', ['sess-1']],
          ['old-a2', ['sess-2']],
        ]),
      ),
      createAgent: jest.fn().mockResolvedValue({ id: 'new-coder-id', name: 'Coder' }),
    });
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
      deps,
    );

    expect(result).toMatchObject({
      success: true,
      sessionPreservation: { preservedCount: 2, removedCount: 0 },
    });
    const [toReassign] = (storage.applySessionPlan as jest.Mock).mock.calls[0];
    expect(toReassign).toHaveLength(2);
    expect(toReassign.every((r: { newAgentId: string }) => r.newAgentId === 'new-coder-id')).toBe(
      true,
    );
  });

  it('(e) throws ValidationError before any DB mutation when new template has duplicate agent names', async () => {
    // Both 'Coder' and 'coder' normalise to the same key — hard-fail before touching storage.
    const storage = makeStorage({
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: 'old-a1', name: 'Coder', profileId: 'old-profile-1' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
    });
    const deps = makeDeps(storage);

    await expect(
      importProjectWithHelper(
        {
          projectId: PROJECT_ID,
          payload: makePayload([
            makeTemplateAgent('Coder', AGENT_TPL_1_ID),
            makeTemplateAgent('coder', AGENT_TPL_2_ID),
          ]),
        },
        deps,
      ),
    ).rejects.toThrow(ValidationError);

    expect(storage.parkSessionsFromAgents).not.toHaveBeenCalled();
    expect(storage.applySessionPlan).not.toHaveBeenCalled();
    expect(storage.deleteAgent).not.toHaveBeenCalled();
    expect(storage.createAgent).not.toHaveBeenCalled();
  });

  it('(f) handles empty parked map — no sessions in old project', async () => {
    const storage = makeStorage({
      listAgentProfiles: jest.fn().mockResolvedValue({
        items: [{ id: 'old-profile-1', name: 'Default Profile' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: 'old-a1', name: 'Coder', profileId: 'old-profile-1' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      parkSessionsFromAgents: jest.fn().mockResolvedValue(new Map()),
      createAgent: jest.fn().mockResolvedValue({ id: 'new-coder-id', name: 'Coder' }),
    });
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
      deps,
    );

    expect(result).toMatchObject({
      success: true,
      sessionPreservation: { preservedCount: 0, removedCount: 0 },
    });
    expect(storage.applySessionPlan).toHaveBeenCalledWith([], []);
  });

  it('(g) deletes all sessions when new template has zero agents', async () => {
    // Old project has sessions; new template has no agents.
    // All parked sessions must be scheduled for deletion.
    const storage = makeStorage({
      listAgentProfiles: jest.fn().mockResolvedValue({
        items: [{ id: 'old-profile-1', name: 'Default Profile' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: 'old-a1', name: 'Coder', profileId: 'old-profile-1' }],
        total: 1,
        limit: 10000,
        offset: 0,
      }),
      parkSessionsFromAgents: jest.fn().mockResolvedValue(new Map([['old-a1', ['s1', 's2']]])),
    });
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      // Payload has no profiles or agents — empty template
      { projectId: PROJECT_ID, payload: makePayload([], []) },
      deps,
    );

    expect(result).toMatchObject({
      success: true,
      sessionPreservation: { preservedCount: 0, removedCount: 2 },
    });
    expect(storage.applySessionPlan).toHaveBeenCalledWith([], ['s1', 's2']);
  });

  it('uses the same prompt partitions for template dry-run counts', async () => {
    const storage = makeStorage({
      listPrompts: jest.fn().mockResolvedValue({
        items: [
          { id: 'existing-system', title: 'System', tags: ['type:system'] },
          { id: 'existing-untyped', title: 'Untyped', tags: ['legacy'] },
          { id: 'existing-custom', title: 'Custom', tags: ['type:custom'] },
        ],
        total: 3,
        limit: 10000,
        offset: 0,
      }),
    });
    const deps = makeDeps(storage);
    const payload = {
      ...makePayload([], []),
      prompts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'System',
          content: 'system',
          version: 1,
          tags: ['type:system'],
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Untyped',
          content: 'untyped',
          version: 1,
          tags: [],
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          title: 'Custom',
          content: 'custom',
          version: 1,
          tags: ['type:custom'],
        },
      ],
    };

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload, dryRun: true },
      deps,
    );

    expect(result).toMatchObject({
      dryRun: true,
      promptTransfer: { imported: 3, deleted: 3, preserved: 0, skipped: 0 },
      counts: {
        toImport: { prompts: 3 },
        toDelete: { prompts: 3 },
      },
    });
    expect(storage.deletePrompt).not.toHaveBeenCalled();
    expect(storage.createPrompt).not.toHaveBeenCalled();
  });

  it('replaces matching Custom rows while preserving unrelated and whitespace-different rows', async () => {
    const storage = makeStorage({
      listPrompts: jest.fn().mockResolvedValue({
        items: [
          { id: 'existing-system', title: 'System', tags: ['type:system'] },
          { id: 'existing-untyped', title: 'Untyped', tags: ['legacy'] },
          { id: 'existing-custom', title: 'cUsToM', tags: ['type:custom'] },
          { id: 'existing-custom-spaced', title: ' Custom ', tags: ['type:custom'] },
          { id: 'existing-custom-system-title', title: 'System', tags: ['type:custom'] },
        ],
        total: 5,
        limit: 10000,
        offset: 0,
      }),
    });
    const deps = makeDeps(storage);
    const payload = {
      ...makePayload([], []),
      prompts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'System',
          content: 'system',
          version: 1,
          tags: ['type:system'],
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Untyped',
          content: 'untyped',
          version: 1,
          tags: ['legacy'],
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          title: 'Custom',
          content: 'custom',
          version: 1,
          tags: ['type:custom'],
        },
      ],
    };

    const result = await importProjectWithHelper({ projectId: PROJECT_ID, payload }, deps);

    expect(storage.deletePrompt).toHaveBeenCalledTimes(3);
    expect(storage.deletePrompt).toHaveBeenCalledWith('existing-system');
    expect(storage.deletePrompt).toHaveBeenCalledWith('existing-untyped');
    expect(storage.deletePrompt).toHaveBeenCalledWith('existing-custom');
    expect(storage.deletePrompt).not.toHaveBeenCalledWith('existing-custom-spaced');
    expect(storage.deletePrompt).not.toHaveBeenCalledWith('existing-custom-system-title');
    expect(storage.createPrompt).toHaveBeenCalledTimes(3);
    expect(storage.createPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Untyped', tags: ['legacy', 'type:system'] }),
    );
    expect(result).toMatchObject({
      success: true,
      promptTransfer: { imported: 3, deleted: 3, preserved: 2, skipped: 0 },
      counts: {
        imported: { prompts: 3 },
        deleted: { prompts: 3 },
      },
      mappings: {
        promptIdMap: {
          '11111111-1111-4111-8111-111111111111': 'new-prompt-System',
          '22222222-2222-4222-8222-222222222222': 'new-prompt-Untyped',
          '33333333-3333-4333-8333-333333333333': 'new-prompt-Custom',
        },
      },
    });
  });

  it('reuses truthful plans and converges repeated imports with duplicate Custom titles', async () => {
    type StatefulPrompt = {
      id: string;
      projectId: string;
      title: string;
      content: string;
      version: number;
      tags: string[];
      createdAt: string;
      updatedAt: string;
    };
    let nextPromptId = 1;
    let prompts: StatefulPrompt[] = [
      {
        id: 'existing-system',
        projectId: PROJECT_ID,
        title: 'Old System',
        content: 'old',
        version: 1,
        tags: ['type:system'],
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'existing-custom',
        projectId: PROJECT_ID,
        title: 'Local Only',
        content: 'local',
        version: 1,
        tags: ['type:custom'],
        createdAt: '',
        updatedAt: '',
      },
    ];
    const storage = makeStorage({
      listPrompts: jest.fn().mockImplementation(async () => ({
        items: [...prompts],
        total: prompts.length,
        limit: 10000,
        offset: 0,
      })),
      deletePrompt: jest.fn().mockImplementation(async (id: string) => {
        prompts = prompts.filter((prompt) => prompt.id !== id);
      }),
      createPrompt: jest.fn().mockImplementation(async (data: Omit<StatefulPrompt, 'id'>) => {
        const created = {
          ...data,
          id: `created-${nextPromptId++}`,
          version: 1,
          createdAt: '',
          updatedAt: '',
        };
        prompts.push(created);
        return created;
      }),
    });
    const deps = makeDeps(storage);
    const payload = {
      ...makePayload([], []),
      prompts: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          title: 'New System',
          content: 'system',
          version: 1,
          tags: ['type:system'],
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          title: 'Portable',
          content: 'first',
          version: 1,
          tags: ['type:custom'],
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          title: 'PORTABLE',
          content: 'second',
          version: 1,
          tags: ['type:custom'],
        },
      ],
    };

    const dryRun = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload, dryRun: true },
      deps,
    );
    const first = await importProjectWithHelper({ projectId: PROJECT_ID, payload }, deps);
    const cardinalityAfterFirst = prompts.length;
    const second = await importProjectWithHelper({ projectId: PROJECT_ID, payload }, deps);
    const cardinalityAfterSecond = prompts.length;
    const third = await importProjectWithHelper({ projectId: PROJECT_ID, payload }, deps);

    expect(dryRun.promptTransfer).toEqual({
      imported: 3,
      deleted: 1,
      preserved: 1,
      skipped: 0,
    });
    expect(first.promptTransfer).toEqual(dryRun.promptTransfer);
    expect(second.promptTransfer).toEqual({
      imported: 3,
      deleted: 3,
      preserved: 1,
      skipped: 0,
    });
    expect(third.promptTransfer).toEqual(second.promptTransfer);
    expect([cardinalityAfterFirst, cardinalityAfterSecond, prompts.length]).toEqual([4, 4, 4]);
    expect(prompts.filter((prompt) => prompt.title.toLowerCase() === 'portable')).toEqual([
      expect.objectContaining({ title: 'Portable', content: 'first', tags: ['type:custom'] }),
      expect.objectContaining({ title: 'PORTABLE', content: 'second', tags: ['type:custom'] }),
    ]);
    expect(prompts).toContainEqual(expect.objectContaining({ id: 'existing-custom' }));
  });

  it.each([true, false])(
    'imports Custom prompts referenced by profile instructions (dryRun=%s)',
    async (dryRun) => {
      const storage = makeStorage();
      const deps = makeDeps(storage);
      const payload = {
        ...makePayload(
          [],
          [
            {
              ...defaultProfile,
              instructions: 'Follow [[prompt:Private SOP]].',
            },
          ],
        ),
        prompts: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            title: 'Private SOP',
            content: 'private',
            version: 1,
            tags: ['type:custom'],
          },
        ],
      };

      const result = await importProjectWithHelper(
        { projectId: PROJECT_ID, payload, dryRun },
        deps,
      );

      expect(result).toMatchObject(
        dryRun
          ? {
              dryRun: true,
              promptTransfer: { imported: 1, skipped: 0 },
            }
          : {
              success: true,
              promptTransfer: { imported: 1, skipped: 0 },
            },
      );
      expect(result).not.toHaveProperty('promptReferenceValidation');
    },
  );

  it('does not let an unselected family alternative block import preflight', async () => {
    const selectedProfile = {
      id: PROFILE_TPL_ID,
      name: 'Claude Profile',
      familySlug: 'coder',
      provider: { name: 'claude' },
      instructions: null,
    };
    const unselectedProfile = {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Codex Profile',
      familySlug: 'coder',
      provider: { name: 'codex' },
      instructions: 'Follow [[prompt:Private SOP]].',
    };
    const payload = {
      ...makePayload([makeTemplateAgent('Coder')], [selectedProfile, unselectedProfile]),
      prompts: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          title: 'Private SOP',
          content: 'private',
          version: 1,
          tags: ['type:custom'],
        },
      ],
    };

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload, dryRun: true },
      makeDeps(makeStorage()),
    );

    expect(result).toMatchObject({
      dryRun: true,
      counts: { toImport: { profiles: 1 } },
    });
    expect(result).not.toHaveProperty('promptReferenceValidation');
  });

  it('accepts a matching incoming System prompt despite a Custom duplicate', async () => {
    const payload = {
      ...makePayload(
        [],
        [
          {
            ...defaultProfile,
            instructions: 'Follow [[prompt:shared sop]].',
          },
        ],
      ),
      prompts: [
        {
          id: '77777777-7777-4777-8777-777777777777',
          title: 'Shared SOP',
          content: 'private',
          version: 1,
          tags: ['type:custom'],
        },
        {
          id: '88888888-8888-4888-8888-888888888888',
          title: 'Shared SOP',
          content: 'shared',
          version: 1,
          tags: ['type:system'],
        },
      ],
    };

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload, dryRun: true },
      makeDeps(makeStorage()),
    );

    expect(result).toMatchObject({
      dryRun: true,
      promptTransfer: { imported: 2, skipped: 0 },
    });
    expect(result).not.toHaveProperty('promptReferenceValidation');
  });

  it('(h) active running session still blocks import — regression lock on ConflictError path', async () => {
    const storage = makeStorage();
    const activeSessions = jest
      .fn()
      .mockReturnValue([{ id: 'running-sess-1', agentId: 'agent-x' }]);
    const deps = makeDeps(storage, activeSessions);

    await expect(
      importProjectWithHelper(
        { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
        deps,
      ),
    ).rejects.toThrow(ConflictError);

    expect(storage.parkSessionsFromAgents).not.toHaveBeenCalled();
    expect(storage.applySessionPlan).not.toHaveBeenCalled();
  });
});
