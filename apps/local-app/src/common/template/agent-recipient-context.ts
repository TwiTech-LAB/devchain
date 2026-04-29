import type { Team } from '@/modules/storage/models/domain.models';

export interface TeamsLookup {
  listTeamsByAgent(agentId: string): Promise<Team[]>;
}

export interface AgentRecipientContext {
  team_name: string;
  team_names: string;
  is_team_lead: boolean;
}

export async function loadAgentRecipientContext(
  teams: TeamsLookup,
  agentId: string,
): Promise<AgentRecipientContext> {
  const allTeams = await teams.listTeamsByAgent(agentId);
  const sorted = allTeams.slice().sort((a, b) => a.name.localeCompare(b.name));

  return {
    team_name: sorted.length === 1 ? sorted[0].name : '',
    team_names: sorted.map((t) => t.name).join(', '),
    is_team_lead: sorted.some((t) => t.teamLeadAgentId === agentId),
  };
}
