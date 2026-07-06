import { applyTeamOverrides, type RemappableTeam } from './team-overrides.helpers';

const baseTeam: RemappableTeam = {
  name: 'Dev Team',
  description: 'A team',
  memberAgentNames: ['Agent A'],
  maxMembers: 4,
  maxConcurrentTasks: 2,
  allowTeamLeadCreateAgents: false,
  profileNames: ['Profile A'],
  profileSelections: [{ profileName: 'Profile A', configNames: ['Config 1'] }],
};

describe('applyTeamOverrides — passthrough', () => {
  it('returns the exact same array reference when there are no overrides and no remap map', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, undefined, undefined, undefined);
    expect(result).toBe(teams);
  });

  it('returns teams unchanged when overrides is undefined', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, undefined, new Map(), []);
    expect(result).toStrictEqual(teams);
  });

  it('returns teams unchanged when overrides array is empty', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(teams, [], new Map(), []);
    expect(result).toStrictEqual(teams);
  });

  it('does not fast-return when a remap map is present even without overrides', () => {
    // A remap map alone must still drive profile-name remapping on the teams.
    const remapMap = new Map([['profile a', 'profile b']]);
    const resolvedProfiles = [{ name: 'Profile B' }];
    const teams: RemappableTeam[] = [
      { ...baseTeam, profileNames: ['Profile A'], profileSelections: [] },
    ];
    const result = applyTeamOverrides(teams, undefined, remapMap, resolvedProfiles);
    expect(result).not.toBe(teams);
    expect(result[0].profileNames).toEqual(['Profile B']);
  });
});

describe('applyTeamOverrides — override precedence', () => {
  it('applies maxMembers, maxConcurrentTasks, and allowTeamLeadCreateAgents overrides', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(
      teams,
      [
        {
          teamName: 'Dev Team',
          maxMembers: 8,
          maxConcurrentTasks: 5,
          allowTeamLeadCreateAgents: true,
        },
      ],
      undefined,
      [],
    );
    expect(result[0].maxMembers).toBe(8);
    expect(result[0].maxConcurrentTasks).toBe(5);
    expect(result[0].allowTeamLeadCreateAgents).toBe(true);
  });

  it('only overrides the fields actually present on the override entry', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Dev Team', maxMembers: 8 }],
      undefined,
      [],
    );
    expect(result[0].maxMembers).toBe(8);
    // Untouched fields keep the team's own values.
    expect(result[0].maxConcurrentTasks).toBe(2);
    expect(result[0].allowTeamLeadCreateAgents).toBe(false);
  });

  it('does not modify teams not referenced by an override', () => {
    const otherTeam: RemappableTeam = { ...baseTeam, name: 'QA Team', maxMembers: 3 };
    const teams = [baseTeam, otherTeam];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Dev Team', maxMembers: 10 }],
      undefined,
      [],
    );
    expect(result[0].maxMembers).toBe(10);
    expect(result[1].maxMembers).toBe(3);
  });

  it('matches team names case-insensitively', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'DEV TEAM', maxMembers: 6 }],
      undefined,
      [],
    );
    expect(result[0].maxMembers).toBe(6);
  });
});

describe('applyTeamOverrides — unknown-team override', () => {
  // The unknown-team *warning* is emitted by each call site (helper is pure and
  // does not log). Here we only assert the helper safely ignores overrides that
  // reference teams which do not exist.
  it('silently ignores overrides referencing a non-existent team', () => {
    const teams = [baseTeam];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Ghost Team', maxMembers: 10 }],
      undefined,
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0].maxMembers).toBe(4);
  });
});

describe('applyTeamOverrides — profileNames remapping', () => {
  it('remaps override profileNames, re-resolving the original casing', () => {
    // Family substitution 'Coder Codex' -> 'Coder Claude'; the remap map value is the
    // selected profile name lowercased (matches profile-mapping.helpers invariant).
    const remapMap = new Map([['coder codex', 'coder claude']]);
    const resolvedProfiles = [{ name: 'Coder Claude' }];
    const teams: RemappableTeam[] = [{ ...baseTeam, profileNames: ['Coder Codex'] }];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Dev Team', profileNames: ['Coder Codex'] }],
      remapMap,
      resolvedProfiles,
    );
    expect(result[0].profileNames).toEqual(['Coder Claude']);
  });

  it('remaps the team own profileNames when the override does not supply profileNames', () => {
    const remapMap = new Map([['coder codex', 'coder claude']]);
    const resolvedProfiles = [{ name: 'Coder Claude' }];
    const teams: RemappableTeam[] = [{ ...baseTeam, profileNames: ['Coder Codex'] }];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Dev Team', maxMembers: 9 }],
      remapMap,
      resolvedProfiles,
    );
    expect(result[0].profileNames).toEqual(['Coder Claude']);
  });

  it('preserves profile names not present in the remap map', () => {
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
      [{ name: 'Profile B' }],
    );
    expect(result[0].profileNames).toEqual(['Profile A']);
    expect(result[0].profileSelections).toEqual([
      { profileName: 'Profile A', configNames: ['Config 1'] },
    ]);
  });

  it('looks up remap keys case-insensitively', () => {
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

describe('applyTeamOverrides — profileSelections remapping', () => {
  it('remaps override profileSelections, re-resolving the profile name casing', () => {
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

  it('falls back to the team own profileSelections when the override omits them', () => {
    const remapMap = new Map([['profile a', 'profile b']]);
    const resolvedProfiles = [{ name: 'Profile B' }];
    const teams: RemappableTeam[] = [
      {
        ...baseTeam,
        profileSelections: [{ profileName: 'Profile A', configNames: ['Config 1'] }],
      },
    ];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Dev Team', maxMembers: 7 }],
      remapMap,
      resolvedProfiles,
    );
    expect(result[0].profileSelections).toEqual([
      { profileName: 'Profile B', configNames: ['Config 1'] },
    ]);
  });

  it('treats an explicit null profileSelections override as absent (nullish guard)', () => {
    // null must fall through to the team's own value instead of crashing on .map(null).
    const teams: RemappableTeam[] = [
      {
        ...baseTeam,
        profileSelections: [{ profileName: 'Profile A', configNames: ['Config 1'] }],
      },
    ];
    const result = applyTeamOverrides(
      teams,
      [
        {
          teamName: 'Dev Team',
          // Intentionally null to exercise the guard.
          profileSelections: null as unknown as RemappableTeam['profileSelections'],
          maxMembers: 5,
        },
      ],
      undefined,
      [],
    );
    expect(result[0].profileSelections).toEqual([
      { profileName: 'Profile A', configNames: ['Config 1'] },
    ]);
  });
});

describe('applyTeamOverrides — re-resolution fallback (no raw lowercase leak)', () => {
  it('returns the pre-remap input name when no resolved profile matches the remap target', () => {
    const remapMap = new Map([['coder codex', 'coder claude']]);
    // No resolved profile named 'Coder Claude' -> must NOT return the raw lowercase value.
    const resolvedProfiles = [{ name: 'Something Else' }];
    const teams: RemappableTeam[] = [{ ...baseTeam, profileNames: ['Coder Codex'] }];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Dev Team', profileNames: ['Coder Codex'] }],
      remapMap,
      resolvedProfiles,
    );
    expect(result[0].profileNames).toEqual(['Coder Codex']);
  });

  it('returns the pre-remap input name when no resolved profiles list is provided', () => {
    const remapMap = new Map([['coder codex', 'coder claude']]);
    const teams: RemappableTeam[] = [{ ...baseTeam, profileNames: ['Coder Codex'] }];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Dev Team', profileNames: ['Coder Codex'] }],
      remapMap,
      undefined,
    );
    expect(result[0].profileNames).toEqual(['Coder Codex']);
  });
});

describe('applyTeamOverrides — object shape', () => {
  it('omits profileNames/profileSelections keys entirely when both team and override lack them', () => {
    const teams: RemappableTeam[] = [
      { name: 'Dev Team', memberAgentNames: ['Agent A'], maxMembers: 4 },
    ];
    const result = applyTeamOverrides(
      teams,
      [{ teamName: 'Dev Team', maxMembers: 9 }],
      undefined,
      [],
    );
    expect('profileNames' in result[0]).toBe(false);
    expect('profileSelections' in result[0]).toBe(false);
    expect(result[0].maxMembers).toBe(9);
    expect(result[0].memberAgentNames).toEqual(['Agent A']);
  });

  it('preserves pass-through fields (description, teamLeadAgentName) from the team', () => {
    const teams: RemappableTeam[] = [
      {
        name: 'Dev Team',
        description: 'desc',
        teamLeadAgentName: 'Lead',
        memberAgentNames: ['Agent A'],
      },
    ];
    const result = applyTeamOverrides(teams, undefined, undefined, undefined);
    expect(result[0].description).toBe('desc');
    expect(result[0].teamLeadAgentName).toBe('Lead');
  });
});
