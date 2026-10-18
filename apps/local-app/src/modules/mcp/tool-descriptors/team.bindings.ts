import type { TeamsService } from '../../teams/services/teams.service';
import type { TeamsToolContext } from '../services/handlers/teams-context';
import {
  handleTeamsList,
  handleTeamsMembersList,
  handleTeamsConfigsList,
  handleTeamsCreateAgent,
  handleTeamsDeleteAgent,
  handleTeamsSessionControl,
  handleDevchainTeam,
} from '../services/handlers/teams-tools';
import { createNullAdapter } from '../services/handlers/null-adapter';
import { defineToolGroup, type McpBindingRuntime } from './binding-types';

function createTeamsContext(runtime: McpBindingRuntime): TeamsToolContext {
  return {
    storage: runtime.storage,
    teamsService: runtime.teamsService ?? createNullAdapter<TeamsService>('TeamsService'),
    resolveSessionContext: runtime.resolveSessionContext,
  };
}

export const teamBindings = defineToolGroup<TeamsToolContext>(createTeamsContext, [
  ['devchain_teams_list', handleTeamsList],
  ['devchain_teams_members_list', handleTeamsMembersList],
  ['devchain_teams_configs_list', handleTeamsConfigsList],
  ['devchain_teams_create_agent', handleTeamsCreateAgent],
  ['devchain_teams_delete_agent', handleTeamsDeleteAgent],
  ['devchain_teams_session_control', handleTeamsSessionControl],
  ['devchain_team', handleDevchainTeam],
]);
