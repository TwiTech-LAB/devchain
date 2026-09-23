import type { StorageService } from '../../storage/interfaces/storage.interface';
import { importProjectWithHelper } from './project-import';
import { preserveImportedEnv } from './profile-mapping.helpers';
import { applyTeamOverrides } from './team-overrides.helpers';

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
    applyPreset: jest.fn().mockResolvedValue({ applied: 0, warnings: [] }),
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

  it('applies presetName only after the presets codec stores it, using fresh import maps', async () => {
    const storage = makeStorage();
    const deps = makeDeps(storage);
    const payload = {
      ...makePayload([makeTemplateAgent('Coder')]),
      presets: [
        {
          name: 'Fast',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'default' }],
        },
      ],
    };

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload, presetName: 'Fast' },
      deps,
    );

    expect(result).toMatchObject({ success: true });
    expect(deps.applyPreset).toHaveBeenCalledWith(
      PROJECT_ID,
      'Fast',
      expect.objectContaining({
        agentNameToId: expect.any(Map),
        configLookupMap: expect.any(Map),
      }),
    );
    const settings = deps.settings as unknown as { setProjectPresets: jest.Mock };
    expect(settings.setProjectPresets.mock.invocationCallOrder[0]).toBeLessThan(
      deps.applyPreset.mock.invocationCallOrder[0],
    );
    expect(deps.applyAgentConfigs).not.toHaveBeenCalled();
  });

  it('returns structured readiness and does not mutate when presetName is absent from the template', async () => {
    const storage = makeStorage();
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      {
        projectId: PROJECT_ID,
        payload: makePayload([makeTemplateAgent('Coder')]),
        presetName: 'Missing',
      },
      deps,
    );

    expect(result).toMatchObject({
      success: false,
      mutationStarted: false,
      readiness: {
        ready: false,
        issues: [{ code: 'preset_not_found', details: { presetName: 'Missing' } }],
      },
    });
    expect(storage.parkSessionsFromAgents).not.toHaveBeenCalled();
    expect(deps.applyPreset).not.toHaveBeenCalled();
  });

  it('uses selected-preset provider coverage to bypass an otherwise impossible family default', async () => {
    const storage = makeStorage();
    const deps = makeDeps(storage);
    deps.computeFamilyAlternatives.mockResolvedValue({
      alternatives: [
        {
          familySlug: 'coder',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: [],
          hasAlternatives: false,
        },
      ],
      missingProviders: ['codex'],
      canImport: false,
    });
    const presetProfile = {
      ...defaultProfile,
      familySlug: 'coder',
      provider: { name: 'codex' },
      providerConfigs: [{ name: 'claude-fast', providerName: 'claude' }],
    };
    const payload = {
      ...makePayload([makeTemplateAgent('Coder')], [presetProfile]),
      presets: [
        {
          name: 'Fast',
          agentConfigs: [{ agentName: 'Coder', providerConfigName: 'claude-fast' }],
        },
      ],
    };

    const result = await importProjectWithHelper(
      {
        projectId: PROJECT_ID,
        payload,
        dryRun: true,
        presetName: 'Fast',
        selectedProviderNames: ['claude'],
      },
      deps,
    );

    expect(result).toMatchObject({
      dryRun: true,
      readiness: { ready: true, issues: [] },
      counts: { toImport: { profiles: 1 } },
    });
    expect(result).not.toHaveProperty('providerMappingRequired');
  });

  it('does not report providerMappingRequired when the submitted family mapping is valid', async () => {
    const storage = makeStorage();
    const deps = makeDeps(storage);
    deps.computeFamilyAlternatives.mockResolvedValue({
      alternatives: [
        {
          familySlug: 'coder',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: ['claude'],
          hasAlternatives: true,
        },
      ],
      missingProviders: ['codex'],
      canImport: true,
    });
    const claudeProfileId = '33333333-3333-4333-8333-333333333333';
    const payload = makePayload(
      [makeTemplateAgent('Coder')],
      [
        { ...defaultProfile, familySlug: 'coder', provider: { name: 'codex' } },
        {
          ...defaultProfile,
          id: claudeProfileId,
          name: 'Claude Profile',
          familySlug: 'coder',
          provider: { name: 'claude' },
        },
      ],
    );

    const result = await importProjectWithHelper(
      {
        projectId: PROJECT_ID,
        payload,
        dryRun: true,
        selectedProviderNames: ['claude'],
        familyProviderMappings: { coder: 'claude' },
      },
      deps,
    );

    expect(result).toMatchObject({
      dryRun: true,
      readiness: { ready: true, issues: [] },
      counts: { toImport: { profiles: 1 } },
    });
    expect(result).not.toHaveProperty('providerMappingRequired');
  });

  it('does not let an empty family mapping object bypass unresolved provider selection', async () => {
    const storage = makeStorage();
    const deps = makeDeps(storage);
    deps.computeFamilyAlternatives.mockResolvedValue({
      alternatives: [
        {
          familySlug: 'coder',
          defaultProvider: 'codex',
          defaultProviderAvailable: false,
          availableProviders: ['claude'],
          hasAlternatives: true,
        },
      ],
      missingProviders: ['codex'],
      canImport: true,
    });

    const result = await importProjectWithHelper(
      {
        projectId: PROJECT_ID,
        payload: makePayload([makeTemplateAgent('Coder')]),
        dryRun: true,
        familyProviderMappings: {},
      },
      deps,
    );

    expect(result).toMatchObject({
      success: false,
      mutationStarted: false,
      readiness: {
        ready: false,
        issues: [{ code: 'provider_mapping_required' }],
      },
      providerMappingRequired: { canImport: true },
    });
  });

  it('returns structured readiness when selectedProviderNames includes an uninstalled provider', async () => {
    const storage = makeStorage();
    const deps = makeDeps(storage);

    const result = await importProjectWithHelper(
      {
        projectId: PROJECT_ID,
        payload: makePayload([makeTemplateAgent('Coder')]),
        dryRun: true,
        selectedProviderNames: ['claude', 'codex'],
      },
      deps,
    );

    expect(result).toMatchObject({
      success: false,
      mutationStarted: false,
      readiness: {
        ready: false,
        issues: [
          {
            code: 'selected_providers_not_installed',
            details: { providerNames: ['codex'] },
          },
        ],
      },
    });
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

  it('(e) returns structured duplicate-name readiness before any DB mutation', async () => {
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

    const result = await importProjectWithHelper(
      {
        projectId: PROJECT_ID,
        payload: makePayload([
          makeTemplateAgent('Coder', AGENT_TPL_1_ID),
          makeTemplateAgent('coder', AGENT_TPL_2_ID),
        ]),
      },
      deps,
    );

    expect(result).toMatchObject({
      success: false,
      mutationStarted: false,
      readiness: {
        ready: false,
        issues: [{ code: 'duplicate_agent_names', details: { agentNames: ['coder'] } }],
      },
    });

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

  it('counts only unmatched statuses with epics as required status deletions', async () => {
    const storage = makeStorage({
      listStatuses: jest.fn().mockResolvedValue({
        items: [
          { id: 'matching', label: 'Ready', color: '#111111', position: 0 },
          { id: 'mapped', label: 'Legacy', color: '#222222', position: 1 },
          { id: 'orphan', label: 'Unused', color: '#333333', position: 2 },
        ],
        total: 3,
        limit: 10000,
        offset: 0,
      }),
      countEpicsByStatus: jest
        .fn()
        .mockImplementation(async (statusId: string) => (statusId === 'mapped' ? 4 : 0)),
    });
    const deps = makeDeps(storage);
    const payload = {
      ...makePayload([], []),
      statuses: [{ label: 'ready', color: '#ffffff', position: 0 }],
    };

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload, dryRun: true },
      deps,
    );

    expect(result).toMatchObject({
      dryRun: true,
      unmatchedStatuses: [{ id: 'mapped', label: 'Legacy', epicCount: 4 }],
      counts: { toDelete: { statuses: 1 } },
    });
  });

  it('keeps dry-run status deletion count in parity with the wet-run codec deletion set', async () => {
    const storage = makeStorage({
      listStatuses: jest.fn().mockResolvedValue({
        items: [
          { id: 'matching', label: 'Ready', color: '#111111', position: 0 },
          { id: 'mapped', label: 'Legacy', color: '#222222', position: 1 },
          { id: 'orphan', label: 'Unused', color: '#333333', position: 2 },
        ],
        total: 3,
        limit: 10000,
        offset: 0,
      }),
      countEpicsByStatus: jest
        .fn()
        .mockImplementation(async (statusId: string) => (statusId === 'mapped' ? 4 : 0)),
      updateEpicsStatus: jest.fn().mockResolvedValue(4),
    });
    const deps = makeDeps(storage);
    const payload = {
      ...makePayload([], []),
      statuses: [{ label: 'Ready', color: '#ffffff', position: 0 }],
    };

    const dryRun = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload, dryRun: true, statusMappings: { mapped: 'Ready' } },
      deps,
    );
    const wetRun = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload, statusMappings: { mapped: 'Ready' } },
      deps,
    );

    expect(dryRun).toMatchObject({ counts: { toDelete: { statuses: 1 } } });
    expect(wetRun).toMatchObject({ success: true, counts: { deleted: { statuses: 1 } } });
    expect(storage.updateEpicsStatus).toHaveBeenCalledWith('mapped', expect.any(String));
    expect(storage.deleteStatus).toHaveBeenCalledTimes(1);
    expect(storage.deleteStatus).toHaveBeenCalledWith('mapped');
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

  it('(h) active running session returns structured readiness before mutation', async () => {
    const storage = makeStorage();
    const activeSessions = jest
      .fn()
      .mockReturnValue([{ id: 'running-sess-1', agentId: 'agent-x' }]);
    const deps = makeDeps(storage, activeSessions);

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
      deps,
    );

    expect(result).toMatchObject({
      success: false,
      mutationStarted: false,
      readiness: {
        ready: false,
        issues: [
          {
            code: 'active_sessions',
            details: { activeSessions: [{ id: 'running-sess-1', agentId: 'agent-x' }] },
          },
        ],
      },
    });

    expect(storage.parkSessionsFromAgents).not.toHaveBeenCalled();
    expect(storage.applySessionPlan).not.toHaveBeenCalled();
  });

  it('rechecks active sessions immediately before mutation and returns a non-mutating race outcome', async () => {
    const storage = makeStorage();
    const activeSessions = jest
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ id: 'late-session', agentId: 'agent-x' }]);
    const deps = makeDeps(storage, activeSessions);

    const result = await importProjectWithHelper(
      { projectId: PROJECT_ID, payload: makePayload([makeTemplateAgent('Coder')]) },
      deps,
    );

    expect(result).toMatchObject({
      success: false,
      mutationStarted: false,
      readiness: {
        issues: [
          {
            code: 'active_sessions',
            details: { activeSessions: [{ id: 'late-session', agentId: 'agent-x' }] },
          },
        ],
      },
    });
    expect(activeSessions).toHaveBeenCalledTimes(2);
    expect(storage.parkSessionsFromAgents).not.toHaveBeenCalled();
    expect(storage.deleteAgent).not.toHaveBeenCalled();
  });
});
