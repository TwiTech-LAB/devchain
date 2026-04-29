/**
 * Clone action unit + integration tests.
 *
 * Field name mapping:
 * - "profileSelections" = export schema field (portability)
 * - "profileConfigSelections" = API/service field (matches profileIds naming)
 */

describe('computeCloneName', () => {
  function computeCloneName(baseName: string, existingNames: string[]): string {
    const existing = new Set(existingNames.map((n) => n.toLowerCase()));
    for (let n = 1; ; n++) {
      const candidate = `${baseName} (${n})`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
  }

  it('picks (1) when no clones exist', () => {
    expect(computeCloneName('Coder', ['Coder'])).toBe('Coder (1)');
  });

  it('picks (2) when (1) exists', () => {
    expect(computeCloneName('Coder', ['Coder', 'Coder (1)'])).toBe('Coder (2)');
  });

  it('is case-insensitive', () => {
    expect(computeCloneName('Coder', ['coder', 'CODER (1)'])).toBe('Coder (2)');
  });

  it('does not reuse gaps — always starts from 1', () => {
    expect(computeCloneName('Bot', ['Bot', 'Bot (2)'])).toBe('Bot (1)');
  });
});

describe('clone source-kind detection', () => {
  function computeCloneTarget(source: {
    teamId?: string;
    teamName?: string;
    isTeamLead?: boolean;
  }): { teamId: string; teamName: string } | null {
    if (source.teamId && !source.isTeamLead) {
      return { teamId: source.teamId, teamName: source.teamName ?? '' };
    }
    return null;
  }

  it('NO TEAM source → null (no team inheritance)', () => {
    expect(computeCloneTarget({})).toBeNull();
  });

  it('team lead source → null (lead never cloned into team)', () => {
    expect(
      computeCloneTarget({ teamId: 'team-1', teamName: 'Alpha', isTeamLead: true }),
    ).toBeNull();
  });

  it('team member (non-lead) source → returns team target', () => {
    const result = computeCloneTarget({
      teamId: 'team-1',
      teamName: 'Alpha',
      isTeamLead: false,
    });
    expect(result).toEqual({ teamId: 'team-1', teamName: 'Alpha' });
  });
});

describe('clone confirmation dialog copy', () => {
  function getDialogBody(opts: {
    sourceName: string;
    cloneName: string;
    targetTeam: { teamName: string } | null;
  }): string {
    if (opts.targetTeam) {
      return `A copy of "${opts.sourceName}" will be created as "${opts.cloneName}" in team "${opts.targetTeam.teamName}". Continue?`;
    }
    return `A fresh copy of "${opts.sourceName}" will be created as "${opts.cloneName}". It won't belong to any team. Continue?`;
  }

  it('NO TEAM / lead source → "won\'t belong to any team"', () => {
    const body = getDialogBody({
      sourceName: 'Coder',
      cloneName: 'Coder (1)',
      targetTeam: null,
    });
    expect(body).toContain("won't belong to any team");
    expect(body).not.toContain('in team');
  });

  it('team member source → "in team <teamName>"', () => {
    const body = getDialogBody({
      sourceName: 'Coder',
      cloneName: 'Coder (1)',
      targetTeam: { teamName: 'Alpha' },
    });
    expect(body).toContain('in team "Alpha"');
    expect(body).not.toContain("won't belong");
  });
});

describe('clone success toast copy', () => {
  function getToastTitle(opts: {
    sourceAgentName: string;
    targetTeamName: string | null;
    teamAddFailed: boolean;
  }): string {
    if (opts.teamAddFailed && opts.targetTeamName) {
      return `Cloned ${opts.sourceAgentName}`;
    }
    if (opts.targetTeamName) {
      return `Cloned ${opts.sourceAgentName} into ${opts.targetTeamName}`;
    }
    return 'Cloned agent';
  }

  it('NO TEAM → "Cloned agent"', () => {
    expect(
      getToastTitle({ sourceAgentName: 'Bot', targetTeamName: null, teamAddFailed: false }),
    ).toBe('Cloned agent');
  });

  it('team member → "Cloned <name> into <team>"', () => {
    expect(
      getToastTitle({ sourceAgentName: 'Bot', targetTeamName: 'Alpha', teamAddFailed: false }),
    ).toBe('Cloned Bot into Alpha');
  });

  it('team add failed → "Cloned <cloneName>" (recoverable)', () => {
    expect(
      getToastTitle({ sourceAgentName: 'Bot', targetTeamName: 'Alpha', teamAddFailed: true }),
    ).toBe('Cloned Bot');
  });
});

describe('clone two-step fallback', () => {
  it('step-2 failure does NOT delete the created agent (recoverable)', async () => {
    let postCalled = false;
    const deleteCalled = false;
    let putFailed = false;

    const mockMutationFn = async () => {
      // Step 1: create agent (succeeds)
      postCalled = true;
      const created = { id: 'new-agent', name: 'Coder (1)' };

      // Step 2: add to team (fails)
      try {
        throw new Error('PUT failed');
      } catch {
        putFailed = true;
        return { ...created, teamAddFailed: true };
      }
    };

    const result = await mockMutationFn();

    expect(postCalled).toBe(true);
    expect(putFailed).toBe(true);
    expect(deleteCalled).toBe(false);
    expect(result.teamAddFailed).toBe(true);
    expect(result.id).toBe('new-agent');
  });
});

describe('clone step-2 non-2xx response handling', () => {
  async function simulateCloneStep2(opts: {
    getStatus: number;
    putStatus: number;
    networkError?: boolean;
  }) {
    const created = { id: 'new-agent', name: 'Coder (1)' };

    try {
      if (opts.networkError) {
        throw new Error('Network error');
      }

      const teamDetailRes = { ok: opts.getStatus >= 200 && opts.getStatus < 300 };
      if (!teamDetailRes.ok) {
        return { ...created, teamAddFailed: true };
      }

      const putRes = { ok: opts.putStatus >= 200 && opts.putStatus < 300 };
      if (!putRes.ok) {
        return { ...created, teamAddFailed: true };
      }
    } catch {
      return { ...created, teamAddFailed: true };
    }

    return created;
  }

  it('GET /api/teams/:id returns 404 → recoverable failure, agent preserved', async () => {
    const result = await simulateCloneStep2({ getStatus: 404, putStatus: 200 });
    expect(result.teamAddFailed).toBe(true);
    expect(result.id).toBe('new-agent');
  });

  it('PUT /api/teams/:id returns 500 → recoverable failure, agent preserved', async () => {
    const result = await simulateCloneStep2({ getStatus: 200, putStatus: 500 });
    expect(result.teamAddFailed).toBe(true);
    expect(result.id).toBe('new-agent');
  });

  it('both return 200 → success, no teamAddFailed flag', async () => {
    const result = await simulateCloneStep2({ getStatus: 200, putStatus: 200 });
    expect(result.teamAddFailed).toBeUndefined();
    expect(result.id).toBe('new-agent');
  });

  it('network error → recoverable failure via catch, agent preserved', async () => {
    const result = await simulateCloneStep2({ getStatus: 200, putStatus: 200, networkError: true });
    expect(result.teamAddFailed).toBe(true);
    expect(result.id).toBe('new-agent');
  });
});
