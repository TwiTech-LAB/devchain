import type { ToolBindingEntry } from './types';
import {
  handleTeamsList,
  handleTeamsMembersList,
  handleTeamsConfigsList,
  handleTeamsCreateAgent,
  handleTeamsDeleteAgent,
  handleDevchainTeam,
} from '../services/handlers/teams-tools';

export const teamBindings: ToolBindingEntry[] = [
  ['devchain_teams_list', handleTeamsList as unknown as ToolBindingEntry[1]],
  ['devchain_teams_members_list', handleTeamsMembersList as unknown as ToolBindingEntry[1]],
  ['devchain_teams_configs_list', handleTeamsConfigsList as unknown as ToolBindingEntry[1]],
  ['devchain_teams_create_agent', handleTeamsCreateAgent as unknown as ToolBindingEntry[1]],
  ['devchain_teams_delete_agent', handleTeamsDeleteAgent as unknown as ToolBindingEntry[1]],
  ['devchain_team', handleDevchainTeam as unknown as ToolBindingEntry[1]],
];
