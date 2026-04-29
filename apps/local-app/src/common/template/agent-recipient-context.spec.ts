import { loadAgentRecipientContext, type TeamsLookup } from './agent-recipient-context';
import type { Team } from '@/modules/storage/models/domain.models';

function makeTeam(overrides: Partial<Team> & { name: string }): Team {
  return {
    id: overrides.id ?? 'team-1',
    projectId: 'proj-1',
    name: overrides.name,
    description: null,
    teamLeadAgentId: overrides.teamLeadAgentId ?? null,
    maxMembers: 10,
    maxConcurrentTasks: 3,
    allowTeamLeadCreateAgents: false,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  };
}

function mockLookup(teams: Team[]): TeamsLookup {
  return { listTeamsByAgent: jest.fn().mockResolvedValue(teams) };
}

const AGENT_ID = 'agent-aaa';

describe('loadAgentRecipientContext', () => {
  it('0 teams', async () => {
    const result = await loadAgentRecipientContext(mockLookup([]), AGENT_ID);
    expect(result).toEqual({ team_name: '', team_names: '', is_team_lead: false });
  });

  it('1 team, agent is lead', async () => {
    const teams = [makeTeam({ name: 'Backend', teamLeadAgentId: AGENT_ID })];
    const result = await loadAgentRecipientContext(mockLookup(teams), AGENT_ID);
    expect(result).toEqual({
      team_name: 'Backend',
      team_names: 'Backend',
      is_team_lead: true,
    });
  });

  it('1 team, agent is member (not lead)', async () => {
    const teams = [makeTeam({ name: 'Backend', teamLeadAgentId: 'other-agent' })];
    const result = await loadAgentRecipientContext(mockLookup(teams), AGENT_ID);
    expect(result).toEqual({
      team_name: 'Backend',
      team_names: 'Backend',
      is_team_lead: false,
    });
  });

  it('2 teams unsorted — team_names sorted asc, team_name is empty', async () => {
    const teams = [
      makeTeam({ id: 't2', name: 'Zebra', teamLeadAgentId: 'other' }),
      makeTeam({ id: 't1', name: 'Alpha', teamLeadAgentId: 'other' }),
    ];
    const result = await loadAgentRecipientContext(mockLookup(teams), AGENT_ID);
    expect(result).toEqual({
      team_name: '',
      team_names: 'Alpha, Zebra',
      is_team_lead: false,
    });
  });

  it('2 teams, agent is lead of one', async () => {
    const teams = [
      makeTeam({ id: 't1', name: 'Backend', teamLeadAgentId: AGENT_ID }),
      makeTeam({ id: 't2', name: 'Frontend', teamLeadAgentId: 'other' }),
    ];
    const result = await loadAgentRecipientContext(mockLookup(teams), AGENT_ID);
    expect(result).toEqual({
      team_name: '',
      team_names: 'Backend, Frontend',
      is_team_lead: true,
    });
  });
});
