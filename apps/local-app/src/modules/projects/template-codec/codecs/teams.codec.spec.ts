/**
 * Teams codec unit tests.
 *
 * Covers: the mode-conditional fatality CONTRACT (declaration + pipeline enforcement in
 * BOTH modes), member/lead/profile/config resolution (against live storage, verbatim from
 * createImportedTeams), and scoped partial-failure cleanup (matrix row 13: replace = fatal
 * w/ cleanup, create = non-fatal).
 *
 * The two-mode pipeline test injects stub producer codecs so the topology validator accepts
 * a minimal [profiles, agents, teams] graph without running the real profiles/agents codecs.
 */
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import { ImportContext, type ImportContextValues } from '../import-context';
import { TemplatePipeline } from '../template-pipeline';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  TemplateSectionCodec,
} from '../template-section-codec';
import { pruneUnavailableTeamProfileSelections, teamsCodec } from './teams.codec';

// --- Shared context seeding ----------------------------------------------------------
function seedCtx(): ImportContext {
  const profilesToCreate = [
    { id: 'profile-old-1', name: 'Profile 1', providerConfigs: [{ name: 'cfg-a' }] },
  ];
  const selectedProfilesByFamily = {
    profilesToCreate,
    profileNameRemapMap: undefined,
  } as unknown as ImportContextValues['selectedProfilesByFamily'];
  const ctx = new ImportContext({ selectedProfilesByFamily } as Partial<ImportContextValues>);
  ctx.set('profileIdMap', { 'profile-old-1': 'profile-new-1' });
  ctx.set('configLookupMap', new Map([['profile-new-1:cfg-a', 'config-1']]));
  ctx.markState('agentsPersisted');
  return ctx;
}

function makeTeamsService() {
  return {
    createTeam: jest.fn().mockResolvedValue({ id: 'team-1' }),
    deleteTeamsByIds: jest.fn().mockResolvedValue(undefined),
    deleteTeamsByProject: jest.fn().mockResolvedValue(undefined),
  };
}

/** Storage mock for the codec's verbatim listAgents/listAgentProfiles/listConfigs queries. */
function makeStorage(overrides?: {
  agents?: Array<{ id: string; name: string }>;
  profiles?: Array<{ id: string; name: string }>;
  configs?: Array<{ id: string; name: string; profileId: string }>;
}): StorageService {
  return {
    listAgents: jest.fn().mockResolvedValue({
      items: overrides?.agents ?? [
        { id: 'agent-1', name: 'Agent A' },
        { id: 'agent-2', name: 'Agent B' },
      ],
    }),
    listAgentProfiles: jest.fn().mockResolvedValue({
      items: overrides?.profiles ?? [{ id: 'profile-new-1', name: 'Profile 1' }],
    }),
    listProfileProviderConfigsByProfile: jest
      .fn()
      .mockResolvedValue(
        overrides?.configs ?? [{ id: 'config-1', name: 'cfg-a', profileId: 'profile-new-1' }],
      ),
  } as unknown as StorageService;
}

function rt(
  teamsService: ReturnType<typeof makeTeamsService>,
  storage: StorageService = makeStorage(),
): CodecApplyRuntime {
  return { projectId: 'project-1', storage, teamsService } as CodecApplyRuntime;
}

const teamSection = (
  teams: Array<Record<string, unknown>>,
): Parameters<typeof teamsCodec.apply>[0] =>
  teams as unknown as Parameters<typeof teamsCodec.apply>[0];

describe('teams codec — declaration', () => {
  it('declares mode-conditional fatality: replace fatal, create swallow (matrix row 13)', () => {
    expect(teamsCodec.declaration.onFailure).toEqual({ replace: 'fatal', create: 'swallow' });
  });

  it('participates in both modes and requires agentsPersisted', () => {
    expect(teamsCodec.declaration.modes).toEqual(['replace', 'create']);
    expect(teamsCodec.declaration.requiresState).toEqual(['agentsPersisted']);
  });
});

describe('teams codec — apply (resolution against live storage)', () => {
  it('resolves members/lead/profiles/configs and creates teams', async () => {
    const teamsService = makeTeamsService();
    const result = await teamsCodec.apply(
      teamSection([
        {
          name: 'Backend Team',
          description: 'the backend',
          teamLeadAgentName: 'Agent A',
          memberAgentNames: ['Agent A', 'Agent B'],
          profileNames: ['Profile 1'],
          profileSelections: [{ profileName: 'Profile 1', configNames: ['cfg-a'] }],
        },
      ]),
      seedCtx(),
      'replace',
      rt(teamsService),
    );
    expect(result.log).toEqual({ teams: 1 });
    expect(teamsService.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        teamLeadAgentId: 'agent-1',
        memberAgentIds: ['agent-1', 'agent-2'],
        profileIds: ['profile-new-1'],
        profileConfigSelections: [{ profileId: 'profile-new-1', configIds: ['config-1'] }],
      }),
    );
  });

  it('throws when a member agent name is not found in storage', async () => {
    const teamsService = makeTeamsService();
    await expect(
      teamsCodec.apply(
        teamSection([{ name: 'Team X', memberAgentNames: ['Agent A', 'Ghost'] }]),
        seedCtx(),
        'replace',
        rt(teamsService, makeStorage({ agents: [{ id: 'agent-1', name: 'Agent A' }] })),
      ),
    ).rejects.toThrow('references agent "Ghost" which was not found');
  });

  it('config name resolution is case-insensitive', async () => {
    const teamsService = makeTeamsService();
    await teamsCodec.apply(
      teamSection([
        {
          name: 'Team CI',
          memberAgentNames: ['Agent A'],
          profileNames: ['Profile 1'],
          profileSelections: [{ profileName: 'profile 1', configNames: ['CFG-A'] }],
        },
      ]),
      seedCtx(),
      'replace',
      rt(teamsService),
    );
    expect(teamsService.createTeam).toHaveBeenCalledWith(
      expect.objectContaining({
        profileConfigSelections: [{ profileId: 'profile-new-1', configIds: ['config-1'] }],
      }),
    );
  });

  it('throws when a profile selection references an unknown config name', async () => {
    const teamsService = makeTeamsService();
    await expect(
      teamsCodec.apply(
        teamSection([
          {
            name: 'Team Strict',
            memberAgentNames: ['Agent A'],
            profileNames: ['Profile 1'],
            profileSelections: [{ profileName: 'Profile 1', configNames: ['mystery-cfg'] }],
          },
        ]),
        seedCtx(),
        'replace',
        rt(teamsService),
      ),
    ).rejects.toThrow(
      'Team "Team Strict" references config "mystery-cfg" for profile "Profile 1" which was not found',
    );
    expect(teamsService.createTeam).not.toHaveBeenCalled();
  });

  it('returns 0 when teamsService is absent', async () => {
    const result = await teamsCodec.apply(
      teamSection([{ name: 'X', memberAgentNames: ['Agent A'] }]),
      seedCtx(),
      'replace',
      rt(undefined as unknown as ReturnType<typeof makeTeamsService>),
    );
    expect(result.log).toEqual({ teams: 0 });
  });
});

describe('teams codec — scoped partial-failure cleanup (replace)', () => {
  it('deletes only teams created this run, then re-throws', async () => {
    const teamsService = makeTeamsService();
    teamsService.createTeam
      .mockResolvedValueOnce({ id: 'imported-1' })
      .mockResolvedValueOnce({ id: 'imported-2' })
      .mockRejectedValueOnce(new Error('3rd team failed'));

    await expect(
      teamsCodec.apply(
        teamSection([
          { name: 'A', memberAgentNames: ['Agent A'] },
          { name: 'B', memberAgentNames: ['Agent B'] },
          { name: 'C', memberAgentNames: ['Agent A'] },
        ]),
        seedCtx(),
        'replace',
        rt(teamsService),
      ),
    ).rejects.toThrow('3rd team failed');

    expect(teamsService.deleteTeamsByIds).toHaveBeenCalledWith(['imported-1', 'imported-2']);
    // Scoped cleanup never calls the project-wide delete.
    expect(teamsService.deleteTeamsByProject).not.toHaveBeenCalled();
  });
});

// --- Pipeline-level mode-conditional fatality (both modes) --------------------------
// Stub producer codecs so the [profiles, agents, teams] topology validates without running
// the real producer codecs; the pipeline then exercises teams' declared onFailure.
function stubCodec(
  section: string,
  decl: Partial<TemplateSectionCodec['declaration']>,
): TemplateSectionCodec {
  return {
    declaration: {
      section,
      reads: decl.reads ?? [],
      writes: decl.writes ?? [],
      requiresState: decl.requiresState,
      producesState: decl.producesState,
      modes: decl.modes ?? ['replace', 'create'],
    },
    pick: () => [],
    build: () => [],
    apply: async () => ({ section }) as CodecApplyResult,
  };
}

const STUB_PRODUCERS: TemplateSectionCodec[] = [
  stubCodec('profiles', {
    reads: ['selectedProfilesByFamily'],
    writes: ['profileIdMap', 'configLookupMap'],
  }),
  stubCodec('agents', {
    reads: ['selectedProfilesByFamily', 'profileIdMap', 'configLookupMap'],
    producesState: ['agentsPersisted'],
  }),
];

function payloadWithFailingTeam(): ParsedTemplatePayload {
  // No agents in storage → member resolution throws during apply.
  return {
    teams: [{ name: 'Failing', memberAgentNames: ['Ghost'] }],
  } as unknown as ParsedTemplatePayload;
}

describe('teams codec — pipeline fatality by mode', () => {
  it('replace mode: a failing teams section propagates (fatal)', async () => {
    const pipeline = new TemplatePipeline([...STUB_PRODUCERS, teamsCodec]);
    await expect(
      pipeline.applySections(
        ['teams'],
        payloadWithFailingTeam(),
        seedCtx(),
        'replace',
        rt(makeTeamsService(), makeStorage({ agents: [] })),
      ),
    ).rejects.toThrow('references agent "Ghost"');
  });

  it('create mode: a failing teams section is swallowed (non-fatal, logged)', async () => {
    const pipeline = new TemplatePipeline([...STUB_PRODUCERS, teamsCodec]);
    const results = await pipeline.applySections(
      ['teams'],
      payloadWithFailingTeam(),
      seedCtx(),
      'create',
      rt(makeTeamsService(), makeStorage({ agents: [] })),
    );
    // No throw; the failing section surfaces a non-fatal marker instead of a count.
    const teamsResult = results.find((r) => r.section === 'teams');
    expect(teamsResult?.log).toMatchObject({ failedNonFatal: true });
  });
});

// --- Prune (ported from project-import.spec.ts; the teams codec owns this helper) ----
describe('pruneUnavailableTeamProfileSelections', () => {
  it('drops known template configs not created because their provider was filtered out', () => {
    const result = pruneUnavailableTeamProfileSelections(
      [
        {
          name: 'Planning',
          memberAgentNames: ['Architect'],
          profileSelections: [
            { profileName: 'Architect', configNames: ['gpt-high', 'agy3', 'opus'] },
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
      { profileName: 'Architect', configNames: ['gpt-high', 'opus'] },
    ]);
  });

  it('keeps unknown config names so strict team import still reports template typos', () => {
    const result = pruneUnavailableTeamProfileSelections(
      [
        {
          name: 'Planning',
          memberAgentNames: ['Architect'],
          profileSelections: [{ profileName: 'Architect', configNames: ['typo-config'] }],
        },
      ],
      [{ id: 'profile-old-1', name: 'Architect', providerConfigs: [{ name: 'gpt-high' }] }],
      { 'profile-old-1': 'profile-new-1' },
      new Map([['profile-new-1:gpt-high', 'config-gpt']]),
    );
    expect(result[0].profileSelections).toEqual([
      { profileName: 'Architect', configNames: ['typo-config'] },
    ]);
  });

  it('removes a profile from profileNames when all selected configs are unavailable', () => {
    const result = pruneUnavailableTeamProfileSelections(
      [
        {
          name: 'Planning',
          memberAgentNames: ['Architect'],
          profileNames: ['Architect'],
          profileSelections: [{ profileName: 'Architect', configNames: ['agy3'] }],
        },
      ],
      [{ id: 'profile-old-1', name: 'Architect', providerConfigs: [{ name: 'agy3' }] }],
      { 'profile-old-1': 'profile-new-1' },
      new Map(),
    );
    expect(result[0].profileNames).toEqual([]);
    expect(result[0].profileSelections).toBeUndefined();
  });
});
