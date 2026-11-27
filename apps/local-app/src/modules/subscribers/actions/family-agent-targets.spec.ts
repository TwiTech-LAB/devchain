import { resolveFamilyAgentTargets } from './family-agent-targets';
import type { Agent } from '../../storage/models/domain.models';

const PROJECT_ID = 'project-1';

function makeAgent(id: string, name: string, profileId: string): Agent {
  return {
    id,
    projectId: PROJECT_ID,
    isProjectOwner: false,
    disabled: false,
    profileId,
    providerConfigId: 'config-1',
    modelOverride: null,
    effortOverride: null,
    name,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('resolveFamilyAgentTargets', () => {
  let storage: {
    listAgentProfiles: jest.Mock;
    listAgents: jest.Mock;
  };

  beforeEach(() => {
    storage = {
      listAgentProfiles: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
  });

  it('scopes both queries to the project with the fixed list window', async () => {
    await resolveFamilyAgentTargets(storage, PROJECT_ID, 'engineering');

    expect(storage.listAgentProfiles).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      limit: 10_000,
      offset: 0,
    });
    expect(storage.listAgents).toHaveBeenCalledWith(PROJECT_ID, {
      limit: 10_000,
      offset: 0,
      excludeDisabled: true,
    });
  });

  it('matches stored slugs case-insensitively after trimming and unions every matching profile', async () => {
    storage.listAgentProfiles.mockResolvedValue({
      items: [
        { id: 'profile-upper', familySlug: ' ENGINEERING ' },
        { id: 'profile-lower', familySlug: 'engineering' },
        { id: 'profile-null', familySlug: null },
        { id: 'profile-missing', familySlug: undefined },
        { id: 'profile-other', familySlug: 'design' },
      ],
      total: 5,
    });
    storage.listAgents.mockResolvedValue({
      items: [
        makeAgent('agent-b', 'Beta', 'profile-upper'),
        makeAgent('agent-a', 'Alpha', 'profile-lower'),
        makeAgent('agent-x', 'Excluded', 'profile-other'),
        makeAgent('agent-n', 'NullSlug', 'profile-null'),
        makeAgent('agent-m', 'MissingSlug', 'profile-missing'),
      ],
      total: 5,
    });

    const targets = await resolveFamilyAgentTargets(storage, PROJECT_ID, '  EnGiNeErInG  ');

    expect(targets.map((target) => target.id)).toEqual(['agent-a', 'agent-b']);
  });

  it('returns an empty array when no stored family matches', async () => {
    storage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'profile-other', familySlug: 'design' }],
      total: 1,
    });
    storage.listAgents.mockResolvedValue({
      items: [makeAgent('agent-x', 'Excluded', 'profile-other')],
      total: 1,
    });

    const targets = await resolveFamilyAgentTargets(storage, PROJECT_ID, 'engineering');

    expect(targets).toEqual([]);
  });

  it('deduplicates targets by agent ID, keeping one entry per agent', async () => {
    storage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'profile-family', familySlug: 'engineering' }],
      total: 1,
    });
    const first = makeAgent('agent-1', 'Alpha', 'profile-family');
    const duplicate = makeAgent('agent-1', 'Alpha', 'profile-family');
    storage.listAgents.mockResolvedValue({ items: [first, duplicate], total: 2 });

    const targets = await resolveFamilyAgentTargets(storage, PROJECT_ID, 'engineering');

    expect(targets).toEqual([first]);
    expect(targets).toHaveLength(1);
  });

  it('sorts by normalized name then agent ID for a deterministic order', async () => {
    storage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'profile-family', familySlug: 'engineering' }],
      total: 1,
    });
    storage.listAgents.mockResolvedValue({
      items: [
        makeAgent('agent-z', '  beta  ', 'profile-family'),
        makeAgent('agent-9', 'ALPHA', 'profile-family'),
        makeAgent('agent-2', ' alpha ', 'profile-family'),
        makeAgent('agent-1', 'Alpha', 'profile-family'),
      ],
      total: 4,
    });

    const targets = await resolveFamilyAgentTargets(storage, PROJECT_ID, 'engineering');

    expect(targets.map((target) => target.id)).toEqual([
      'agent-1',
      'agent-2',
      'agent-9',
      'agent-z',
    ]);
  });
});
