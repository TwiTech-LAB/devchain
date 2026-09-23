import type { ActionContext } from './action.interface';
import { deleteAgentAction, type DeleteAgentResultData } from './delete-agent.action';
import type { Agent, Status, Team } from '../../storage/models/domain.models';

const PROJECT_ID = 'project-1';

function makeAgent(id: string, name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    projectId: PROJECT_ID,
    isProjectOwner: false,
    profileId: 'profile-1',
    providerConfigId: 'config-1',
    modelOverride: null,
    effortOverride: null,
    name,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTeam(id: string, name: string, teamLeadAgentId: string | null): Team {
  return {
    id,
    projectId: PROJECT_ID,
    name,
    description: null,
    teamLeadAgentId,
    maxMembers: 5,
    maxConcurrentTasks: 5,
    allowTeamLeadCreateAgents: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeStatus(id: string, label: string): Status {
  return {
    id,
    projectId: PROJECT_ID,
    label,
    color: '#123456',
    position: 1,
    mcpHidden: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('DeleteAgentAction', () => {
  let context: ActionContext;
  let storage: {
    getAgentByName: jest.Mock;
    getAgent: jest.Mock;
    listAgentProfiles: jest.Mock;
    listAgents: jest.Mock;
    listStatuses: jest.Mock;
    listProjectEpics: jest.Mock;
  };
  let teamsService: {
    listTeamsByAgent: jest.Mock;
    listTeamsLedByAgent: jest.Mock;
    deleteAgentForAutomation: jest.Mock;
  };
  let sessionsService: {
    listActiveSessions: jest.Mock;
    terminateSession: jest.Mock;
  };
  let logger: { info: jest.Mock; error: jest.Mock; debug: jest.Mock };

  beforeEach(() => {
    storage = {
      getAgentByName: jest.fn(),
      getAgent: jest.fn(),
      listAgentProfiles: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 10_000,
        offset: 0,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 10_000,
        offset: 0,
      }),
      listStatuses: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      listProjectEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    teamsService = {
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
      listTeamsLedByAgent: jest.fn().mockResolvedValue([]),
      deleteAgentForAutomation: jest.fn().mockResolvedValue(undefined),
    };
    sessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([]),
      terminateSession: jest.fn().mockResolvedValue(undefined),
    };
    logger = { info: jest.fn(), error: jest.fn(), debug: jest.fn() };
    context = {
      terminalIO: {} as ActionContext['terminalIO'],
      sessionsService: sessionsService as unknown as ActionContext['sessionsService'],
      sessionRuntime: {} as ActionContext['sessionRuntime'],
      sessionCoordinator: {} as ActionContext['sessionCoordinator'],
      amd: {} as ActionContext['amd'],
      storage: storage as unknown as ActionContext['storage'],
      teamsService: teamsService as unknown as ActionContext['teamsService'],
      sessionId: 'session-event',
      agentId: 'event-agent',
      projectId: PROJECT_ID,
      tmuxSessionName: 'tmux-event',
      event: {
        eventName: 'epic.updated',
        projectId: PROJECT_ID,
        agentId: 'event-agent',
        occurredAt: '2026-01-01T00:00:00.000Z',
        payload: {},
      },
      logger: logger as unknown as ActionContext['logger'],
    };
  });

  it('exposes permanent-delete metadata and both optional selectors', () => {
    expect(deleteAgentAction).toMatchObject({
      type: 'delete_agent',
      name: 'Delete Agent',
      category: 'session',
      supportsRetry: false,
    });
    expect(deleteAgentAction.description).toMatch(/permanently delete/i);
    expect(deleteAgentAction.description).toMatch(/Project Owners and Team Leads are protected/i);
    expect(deleteAgentAction.inputs).toEqual([
      expect.objectContaining({ name: 'agentName', type: 'string', required: false }),
      expect.objectContaining({ name: 'familySlug', type: 'string', required: false }),
      expect.objectContaining({
        name: 'skipWhileEpicsInStatuses',
        label: 'Skip while epics are in statuses',
        type: 'select',
        multiple: true,
        optionsSource: 'project_statuses',
        allowedSources: ['custom'],
        required: false,
      }),
    ]);
    expect(deleteAgentAction.inputs[0].description).toMatch(/priority over Family Slug/i);
  });

  it('uses a trimmed Agent Name and ignores Family Slug', async () => {
    const named = makeAgent('named-agent', 'Named Agent');
    storage.getAgentByName.mockResolvedValue(named);

    const result = await deleteAgentAction.execute(context, {
      agentName: '  Named Agent  ',
      familySlug: 'ignored-family',
    });

    expect(storage.getAgentByName).toHaveBeenCalledWith(PROJECT_ID, 'Named Agent');
    expect(storage.listAgentProfiles).not.toHaveBeenCalled();
    expect(storage.listAgents).not.toHaveBeenCalled();
    expect(sessionsService.listActiveSessions).toHaveBeenCalledWith(
      PROJECT_ID,
      new Set(['named-agent']),
    );
    expect(teamsService.deleteAgentForAutomation).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      agentId: 'named-agent',
    });
    expect(result).toMatchObject({ success: true, retryable: false });
    expect((result.data as DeleteAgentResultData).resolvedBy).toBe('agentName');
  });

  it('normalizes family slugs, unions matching profiles, deduplicates, and sorts targets', async () => {
    const beta = makeAgent('agent-b', ' beta ', { profileId: 'profile-upper' });
    const alphaTwo = makeAgent('agent-2', 'Alpha', { profileId: 'profile-lower' });
    const alphaOne = makeAgent('agent-1', ' alpha ', { profileId: 'profile-upper' });
    storage.listAgentProfiles.mockResolvedValue({
      items: [
        { id: 'profile-upper', familySlug: ' ENGINEERING ' },
        { id: 'profile-lower', familySlug: 'engineering' },
        { id: 'profile-other', familySlug: 'other' },
      ],
      total: 3,
      limit: 10_000,
      offset: 0,
    });
    storage.listAgents.mockResolvedValue({
      items: [beta, alphaTwo, alphaOne, { ...alphaOne }],
      total: 4,
      limit: 10_000,
      offset: 0,
    });

    const result = await deleteAgentAction.execute(context, { familySlug: '  EnGiNeErInG ' });

    expect(storage.listAgentProfiles).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      limit: 10_000,
      offset: 0,
    });
    expect(storage.listAgents).toHaveBeenCalledWith(PROJECT_ID, {
      limit: 10_000,
      offset: 0,
    });
    expect(sessionsService.listActiveSessions).toHaveBeenCalledWith(
      PROJECT_ID,
      new Set(['agent-1', 'agent-2', 'agent-b']),
    );
    expect(sessionsService.listActiveSessions).toHaveBeenCalledTimes(1);
    expect(
      teamsService.deleteAgentForAutomation.mock.calls.map(([input]) => input.agentId),
    ).toEqual(['agent-1', 'agent-2', 'agent-b']);
    expect((result.data as DeleteAgentResultData).matched.map((target) => target.id)).toEqual([
      'agent-1',
      'agent-2',
      'agent-b',
    ]);
  });

  it('fails without mutation when the family slug matches no profile', async () => {
    storage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'profile-other', familySlug: 'design' }],
      total: 1,
    });
    storage.listAgents.mockResolvedValue({
      items: [makeAgent('agent-x', 'Excluded', { profileId: 'profile-other' })],
      total: 1,
    });

    const result = await deleteAgentAction.execute(context, { familySlug: 'engineering' });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain('No agents matched family slug "engineering"');
    expect(sessionsService.listActiveSessions).not.toHaveBeenCalled();
    expect(sessionsService.terminateSession).not.toHaveBeenCalled();
    expect(teamsService.deleteAgentForAutomation).not.toHaveBeenCalled();
  });

  it('uses the event agent for blank selectors after checking project ownership', async () => {
    storage.getAgent.mockResolvedValue(makeAgent('event-agent', 'Event Agent'));

    const result = await deleteAgentAction.execute(context, {
      agentName: '   ',
      familySlug: ' ',
    });

    expect(storage.getAgent).toHaveBeenCalledWith('event-agent');
    expect(teamsService.deleteAgentForAutomation).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      agentId: 'event-agent',
    });
    expect((result.data as DeleteAgentResultData).resolvedBy).toBe('event');
  });

  it('rejects a cross-project event agent before session or deletion mutation', async () => {
    storage.getAgent.mockResolvedValue(
      makeAgent('event-agent', 'Foreign Agent', { projectId: 'other-project' }),
    );

    const result = await deleteAgentAction.execute(context, {});

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain('different project');
    expect(sessionsService.listActiveSessions).not.toHaveBeenCalled();
    expect(sessionsService.terminateSession).not.toHaveBeenCalled();
    expect(teamsService.deleteAgentForAutomation).not.toHaveBeenCalled();
  });

  it('fails closed when no selector or event agent exists', async () => {
    context.agentId = null;

    const result = await deleteAgentAction.execute(context, {});

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain('Matched (0): none');
    expect(result.error).toContain('No agent matched');
  });

  it('rejects a protected Project Owner in a family batch before any mutation', async () => {
    const safe = makeAgent('safe', 'Safe', { profileId: 'family-profile' });
    const owner = makeAgent('owner', 'Owner', {
      profileId: 'family-profile',
      isProjectOwner: true,
    });
    storage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'family-profile', familySlug: 'family' }],
    });
    storage.listAgents.mockResolvedValue({ items: [safe, owner] });

    const result = await deleteAgentAction.execute(context, { familySlug: 'family' });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain('"Owner" [owner]');
    expect(result.error).toContain('protected Project Owner');
    expect((result.data as DeleteAgentResultData).matched).toHaveLength(2);
    expect(sessionsService.listActiveSessions).not.toHaveBeenCalled();
    expect(sessionsService.terminateSession).not.toHaveBeenCalled();
    expect(teamsService.deleteAgentForAutomation).not.toHaveBeenCalled();
  });

  it('rejects a Team Lead without a membership row before any mutation', async () => {
    const lead = makeAgent('lead', 'Lead');
    storage.getAgentByName.mockResolvedValue(lead);
    teamsService.listTeamsByAgent.mockResolvedValue([]);
    teamsService.listTeamsLedByAgent.mockResolvedValue([makeTeam('led-team', 'Led Team', 'lead')]);

    const result = await deleteAgentAction.execute(context, { agentName: 'Lead' });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain('protected Team Lead of "Led Team" [led-team]');
    expect(teamsService.listTeamsLedByAgent).toHaveBeenCalledWith('lead');
    expect(teamsService.listTeamsByAgent).not.toHaveBeenCalled();
    expect(sessionsService.listActiveSessions).not.toHaveBeenCalled();
    expect(sessionsService.terminateSession).not.toHaveBeenCalled();
    expect(teamsService.deleteAgentForAutomation).not.toHaveBeenCalled();
  });

  it('terminates every returned session before deleting each applicable target', async () => {
    const alpha = makeAgent('alpha', 'Alpha', { profileId: 'family-profile' });
    const beta = makeAgent('beta', 'Beta', { profileId: 'family-profile' });
    storage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'family-profile', familySlug: 'family' }],
    });
    storage.listAgents.mockResolvedValue({ items: [beta, alpha] });
    sessionsService.listActiveSessions.mockResolvedValue([
      { id: 'session-b', agentId: 'beta' },
      { id: 'session-a2', agentId: 'alpha' },
      { id: 'session-a1', agentId: 'alpha' },
    ]);
    const callOrder: string[] = [];
    sessionsService.terminateSession.mockImplementation(async (sessionId: string) => {
      callOrder.push(`terminate:${sessionId}`);
    });
    teamsService.deleteAgentForAutomation.mockImplementation(
      async ({ agentId: targetId }: { agentId: string }) => {
        callOrder.push(`delete:${targetId}`);
      },
    );

    await deleteAgentAction.execute(context, { familySlug: 'family' });

    expect(sessionsService.listActiveSessions).toHaveBeenCalledWith(
      PROJECT_ID,
      new Set(['alpha', 'beta']),
    );
    expect(callOrder).toEqual([
      'terminate:session-a1',
      'terminate:session-a2',
      'delete:alpha',
      'terminate:session-b',
      'delete:beta',
    ]);
    expect(sessionsService.terminateSession).toHaveBeenCalledWith('session-a1', {
      source: 'subscriber',
      reason: 'agent-deletion',
    });
  });

  it('skips a target after termination failure and continues with later targets', async () => {
    const alpha = makeAgent('alpha', 'Alpha', { profileId: 'family-profile' });
    const beta = makeAgent('beta', 'Beta', { profileId: 'family-profile' });
    storage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'family-profile', familySlug: 'family' }],
    });
    storage.listAgents.mockResolvedValue({ items: [alpha, beta] });
    sessionsService.listActiveSessions.mockResolvedValue([
      { id: 'alpha-session', agentId: 'alpha' },
      { id: 'beta-session', agentId: 'beta' },
    ]);
    sessionsService.terminateSession.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'alpha-session') throw new Error('tmux refused');
    });

    const result = await deleteAgentAction.execute(context, { familySlug: 'family' });
    const data = result.data as DeleteAgentResultData;

    expect(teamsService.deleteAgentForAutomation).not.toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      agentId: 'alpha',
    });
    expect(teamsService.deleteAgentForAutomation).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      agentId: 'beta',
    });
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(data.deleted).toEqual([{ id: 'beta', name: 'Beta' }]);
    expect(data.failed).toEqual([
      expect.objectContaining({ id: 'alpha', name: 'Alpha', stage: 'session_termination' }),
    ]);
    expect(result.error).toContain('Matched (2): "Alpha" [alpha], "Beta" [beta]');
    expect(result.error).toContain('Deleted (1): "Beta" [beta]');
    expect(result.error).toContain('Failed (1): "Alpha" [alpha]');
  });

  it('records a protected-facade deletion failure and continues with later targets', async () => {
    const alpha = makeAgent('alpha', 'Alpha', { profileId: 'family-profile' });
    const beta = makeAgent('beta', 'Beta', { profileId: 'family-profile' });
    storage.listAgentProfiles.mockResolvedValue({
      items: [{ id: 'family-profile', familySlug: 'family' }],
    });
    storage.listAgents.mockResolvedValue({ items: [alpha, beta] });
    teamsService.deleteAgentForAutomation.mockImplementation(
      async ({ agentId: targetId }: { agentId: string }) => {
        if (targetId === 'alpha') throw new Error('became Project Owner');
      },
    );

    const result = await deleteAgentAction.execute(context, { familySlug: 'family' });
    const data = result.data as DeleteAgentResultData;

    expect(teamsService.deleteAgentForAutomation).toHaveBeenCalledTimes(2);
    expect(data.deleted).toEqual([{ id: 'beta', name: 'Beta' }]);
    expect(data.failed).toEqual([expect.objectContaining({ id: 'alpha', stage: 'deletion' })]);
    expect(result.error).toContain('became Project Owner');
    expect(result.retryable).toBe(false);
  });

  it('reports preset cleanup failure after recording the committed agent deletion', async () => {
    const target = makeAgent('target-id', 'Target Name');
    storage.getAgentByName.mockResolvedValue(target);
    teamsService.deleteAgentForAutomation.mockResolvedValue({
      presetCleanupError: 'preset write failed',
    });

    const result = await deleteAgentAction.execute(context, { agentName: 'Target Name' });
    const data = result.data as DeleteAgentResultData;

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(data.deleted).toEqual([{ id: 'target-id', name: 'Target Name' }]);
    expect(data.failed).toEqual([
      {
        id: 'target-id',
        name: 'Target Name',
        stage: 'preset_cleanup',
        error: 'agent deleted, but project preset cleanup failed (preset write failed)',
      },
    ]);
    expect(result.error).toContain('Deleted (1): "Target Name" [target-id]');
    expect(result.error).toContain('Failed (1): "Target Name" [target-id]');
    expect(result.error).toContain('preset write failed');
  });

  it('reports deterministic matched and deleted details on full success', async () => {
    const target = makeAgent('target-id', 'Target Name');
    storage.getAgentByName.mockResolvedValue(target);

    const result = await deleteAgentAction.execute(context, { agentName: 'Target Name' });

    expect(result).toMatchObject({ success: true, retryable: false });
    expect(result.message).toBe(
      'Matched (1): "Target Name" [target-id]; Deleted (1): "Target Name" [target-id]; Failed (0): none',
    );
  });

  it('skips with success and deletes nothing while epics remain in selected statuses', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-ip', 'In Progress'), makeStatus('status-review', 'Review')],
      total: 2,
    });
    storage.listProjectEpics.mockImplementation(
      (_projectId: string, options: { statusId: string }) =>
        Promise.resolve({
          items: [],
          total: options.statusId === 'status-ip' ? 2 : 1,
        }),
    );

    const result = await deleteAgentAction.execute(context, {
      agentName: 'Target Name',
      skipWhileEpicsInStatuses: 'In Progress, Review',
    });

    expect(result.success).toBe(true);
    expect(result.retryable).toBe(false);
    expect(result.message).toBe('Skipped: 3 epic(s) still in In Progress, Review');
    expect(result.data).toEqual({
      skipped: true,
      blocking: [
        { statusId: 'status-ip', label: 'In Progress', count: 2 },
        { statusId: 'status-review', label: 'Review', count: 1 },
      ],
    });
    expect(storage.getAgentByName).not.toHaveBeenCalled();
    expect(sessionsService.listActiveSessions).not.toHaveBeenCalled();
    expect(sessionsService.terminateSession).not.toHaveBeenCalled();
    expect(teamsService.deleteAgentForAutomation).not.toHaveBeenCalled();
  });

  it('fails closed without mutation when a selected label matches no status', async () => {
    storage.listStatuses.mockResolvedValue({
      items: [makeStatus('status-review', 'Review')],
      total: 1,
    });

    const result = await deleteAgentAction.execute(context, {
      agentName: 'Target Name',
      skipWhileEpicsInStatuses: 'Review, Missing',
    });

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(result.error).toContain(
      `Unknown status label(s) in project ${PROJECT_ID}: Missing. Nothing changed.`,
    );
    expect(storage.listProjectEpics).not.toHaveBeenCalled();
    expect(storage.getAgentByName).not.toHaveBeenCalled();
    expect(teamsService.deleteAgentForAutomation).not.toHaveBeenCalled();
  });

  it('ignores the guard when the input is absent or empty', async () => {
    const target = makeAgent('target-id', 'Target Name');
    storage.getAgentByName.mockResolvedValue(target);
    const inputVariants = [
      { agentName: 'Target Name' },
      { agentName: 'Target Name', skipWhileEpicsInStatuses: '' },
      { agentName: 'Target Name', skipWhileEpicsInStatuses: ' , ' },
    ];

    for (const inputs of inputVariants) {
      const result = await deleteAgentAction.execute(context, inputs);

      expect(result).toMatchObject({ success: true, retryable: false });
      expect(teamsService.deleteAgentForAutomation).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        agentId: 'target-id',
      });
    }
    expect(storage.listStatuses).not.toHaveBeenCalled();
    expect(storage.listProjectEpics).not.toHaveBeenCalled();
    expect(storage.getAgentByName).toHaveBeenCalledTimes(3);
  });
});
