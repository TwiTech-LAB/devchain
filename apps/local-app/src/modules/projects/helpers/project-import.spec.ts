import type { StorageService } from '../../storage/interfaces/storage.interface';
import {
  importProviderSettings,
  preserveImportedEnv,
  createImportedTeams,
  applyTeamOverrides,
} from './project-import';

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

describe('importProviderSettings — env merge', () => {
  let storage: {
    listProviders: jest.Mock;
    updateProvider: jest.Mock;
  };

  const baseProvider = {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: null,
    env: null as Record<string, string> | null,
  };

  const makePayload = (
    providerSettings: Array<{
      name: string;
      autoCompactThreshold?: number | null;
      env?: Record<string, string> | null;
    }>,
  ) =>
    ({
      providerSettings,
      profiles: [],
      agents: [],
      statuses: [],
      prompts: [],
    }) as unknown as Parameters<typeof importProviderSettings>[0];

  beforeEach(() => {
    storage = {
      listProviders: jest.fn().mockResolvedValue({ items: [baseProvider] }),
      updateProvider: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('applies template env when local provider has no env', async () => {
    const payload = makePayload([
      { name: 'claude', env: { API_BASE: 'https://custom.api', LOG_LEVEL: 'debug' } },
    ]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        env: { API_BASE: 'https://custom.api', LOG_LEVEL: 'debug' },
      }),
    );
  });

  it('merges with local-wins semantics (local keys not overwritten)', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, env: { API_BASE: 'local-value', EXISTING: 'keep' } }],
    });

    const payload = makePayload([
      { name: 'claude', env: { API_BASE: 'template-value', NEW_KEY: 'added' } },
    ]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        env: { API_BASE: 'local-value', EXISTING: 'keep', NEW_KEY: 'added' },
      }),
    );
  });

  it('skips env update when all template keys already exist locally', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, env: { KEY_A: 'local' } }],
    });

    const payload = makePayload([{ name: 'claude', env: { KEY_A: 'template' } }]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    // updateProvider should not be called (no changes)
    expect(storage.updateProvider).not.toHaveBeenCalled();
  });

  it('preserves *** entries so the user can see which secrets to fill in', async () => {
    const payload = makePayload([{ name: 'claude', env: { API_KEY: '***', VISIBLE: 'value' } }]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        env: { API_KEY: '***', VISIBLE: 'value' },
      }),
    );
  });

  it('merges *** entries into local when the keys are missing locally', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, env: { EXISTING: 'val' } }],
    });

    const payload = makePayload([{ name: 'claude', env: { SECRET: '***', TOKEN: '***' } }]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        env: { EXISTING: 'val', SECRET: '***', TOKEN: '***' },
      }),
    );
  });

  it('does not update when template has no env field', async () => {
    const payload = makePayload([{ name: 'claude' }]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    expect(storage.updateProvider).not.toHaveBeenCalled();
  });

  it('does not update when template env is null', async () => {
    const payload = makePayload([{ name: 'claude', env: null }]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    expect(storage.updateProvider).not.toHaveBeenCalled();
  });
});

describe('importProviderSettings — autoCompactThreshold1m compat', () => {
  let storage: {
    listProviders: jest.Mock;
    updateProvider: jest.Mock;
  };

  const baseProvider = {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: null,
  };

  const makePayload = (
    providerSettings: Array<{
      name: string;
      autoCompactThreshold?: number | null;
      autoCompactThreshold1m?: number | null;
      oneMillionContextEnabled?: boolean;
    }>,
  ) =>
    ({
      providerSettings,
      _manifest: { slug: 'test' },
      profiles: [],
      agents: [],
      statuses: [],
      prompts: [],
      documents: [],
      skills: [],
      hooks: [],
    }) as unknown as Parameters<typeof importProviderSettings>[0];

  beforeEach(() => {
    storage = {
      listProviders: jest.fn().mockResolvedValue({ items: [baseProvider] }),
      updateProvider: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('legacy template: promotes old threshold to 1M value and sets standard to 95 on probe success', async () => {
    // Legacy template: 1M enabled but no autoCompactThreshold1m field
    const payload = makePayload([
      { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: true, status: 'supported' });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: 50,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: true,
      }),
    );
  });

  it('new template: uses both threshold fields as-is on probe success', async () => {
    // New template: both autoCompactThreshold and autoCompactThreshold1m present
    const payload = makePayload([
      {
        name: 'claude',
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 40,
        oneMillionContextEnabled: true,
      },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: true, status: 'supported' });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: 40,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: true,
      }),
    );
  });

  it('probe failure: clears 1M fields and forces standard threshold to 95', async () => {
    const payload = makePayload([
      {
        name: 'claude',
        autoCompactThreshold: 50,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
      },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: false, status: 'unsupported' });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: null,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: false,
      }),
    );
  });

  it('no binPath: disables 1M and forces standard threshold to 95', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, binPath: null }],
    });

    const payload = makePayload([
      { name: 'claude', autoCompactThreshold1m: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn();

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: null,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: false,
      }),
    );
    expect(probe1m).not.toHaveBeenCalled();
  });

  it('probe success: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, autoCompactThreshold: 80 }],
    });

    const payload = makePayload([
      {
        name: 'claude',
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
      },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: true });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBe(50);
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
  });

  it('probe failure: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, autoCompactThreshold: 80 }],
    });

    const payload = makePayload([
      { name: 'claude', autoCompactThreshold1m: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: false });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBeNull();
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
  });

  it('legacy template + probe success: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, autoCompactThreshold: 80 }],
    });

    // Legacy template: 1M enabled but no autoCompactThreshold1m
    const payload = makePayload([
      { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: true });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBe(50); // legacy value promoted
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
    expect(updateCall.oneMillionContextEnabled).toBe(true);
  });

  it('legacy template + probe failure: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, autoCompactThreshold: 80 }],
    });

    const payload = makePayload([
      { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: false });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBeNull();
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
    expect(updateCall.oneMillionContextEnabled).toBe(false);
  });

  it('no-probe: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, binPath: null, autoCompactThreshold: 80 }],
    });

    const payload = makePayload([
      { name: 'claude', autoCompactThreshold1m: 50, oneMillionContextEnabled: true },
    ]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBeNull();
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
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

    it('remaps override profileNames through the remap map', () => {
      const remapMap = new Map([['codex-default', 'claude-default']]);
      const teams = [{ ...baseTeam, profileNames: ['codex-default'] }];
      const result = applyTeamOverrides(
        teams,
        [{ teamName: 'Dev Team', profileNames: ['codex-default'] }],
        remapMap,
      );
      expect(result[0].profileNames).toEqual(['claude-default']);
    });

    it('remaps override profileSelections.profileName through the remap map', () => {
      const remapMap = new Map([['codex-default', 'claude-default']]);
      const teams = [baseTeam];
      const result = applyTeamOverrides(
        teams,
        [
          {
            teamName: 'Dev Team',
            profileSelections: [{ profileName: 'codex-default', configNames: ['claude-local'] }],
          },
        ],
        remapMap,
      );
      expect(result[0].profileSelections).toEqual([
        { profileName: 'claude-default', configNames: ['claude-local'] },
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
      const remapMap = new Map([['codex-default', 'claude-default']]);
      const teams = [baseTeam];
      const result = applyTeamOverrides(
        teams,
        [{ teamName: 'Dev Team', profileNames: ['CODEX-DEFAULT'] }],
        remapMap,
      );
      expect(result[0].profileNames).toEqual(['claude-default']);
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
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await createImportedTeams('proj-1', overridden, deps as any);
      const createArg = (deps.teamsService.createTeam as jest.Mock).mock.calls[0][0];
      // profileConfigSelections should reference the post-remap profile id (p-claude)
      expect(createArg.profileConfigSelections?.[0]?.profileId).toBe('p-claude');
    });
  });
});
