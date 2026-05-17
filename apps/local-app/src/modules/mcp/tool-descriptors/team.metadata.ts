import {
  TeamsListParamsSchema,
  TeamsMembersListParamsSchema,
  TeamsConfigsListParamsSchema,
  TeamsCreateAgentParamsSchema,
  TeamsDeleteAgentParamsSchema,
  DevchainTeamParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const teamMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_teams_list',
    description: 'List teams in the current project.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        q: {
          type: 'string',
          description: 'Optional search query matched against team name',
        },
        limit: { type: 'number', description: 'Max results (default: 100)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
      },
      additionalProperties: false,
    },
    paramsSchema: TeamsListParamsSchema,
  },
  {
    name: 'devchain_teams_members_list',
    description:
      'List members of a team. If teamId is omitted, returns members of all teams the calling agent belongs to.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        teamId: {
          type: 'string',
          description: 'Optional team UUID. If omitted, returns all teams the caller belongs to.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: TeamsMembersListParamsSchema,
  },
  {
    name: 'devchain_teams_configs_list',
    description:
      'List provider configurations available to teams you lead. For team leads only. Each entry shows configName, description, profileName, and teamName. Use these when calling devchain_teams_create_agent.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: TeamsConfigsListParamsSchema,
  },
  {
    name: 'devchain_teams_create_agent',
    description:
      "Create a new team agent for your team using one of your team's provider configurations. For team leads only. Required: name, configName. Optional: description (defaults to config description if omitted), profileName (required if configName is ambiguous), teamName (required if you lead multiple teams). The new agent is automatically added as a member of the chosen team.",
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'name', 'configName'],
      properties: {
        sessionId: {
          type: 'string',
        },
        name: {
          type: 'string',
          description: 'Name for the new team agent',
        },
        description: {
          type: 'string',
          description: 'Purpose and responsibilities of the new team agent',
        },
        configName: {
          type: 'string',
          description: 'Provider configuration name from devchain_teams_configs_list',
        },
        profileName: {
          type: 'string',
          description: 'Profile name — required if configName is ambiguous across profiles',
        },
        teamName: {
          type: 'string',
          description: 'Team name — required if you lead multiple teams',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: TeamsCreateAgentParamsSchema,
  },
  {
    name: 'devchain_teams_delete_agent',
    description:
      "Delete a team agent. Restricted to team leads. Auto-terminates the agent's running sessions before deletion. Cannot delete a team lead. Cannot delete an agent that belongs to another team.",
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'name'],
      properties: {
        sessionId: {
          type: 'string',
        },
        name: {
          type: 'string',
          description: 'Name of the team agent to delete (case-insensitive)',
        },
        teamName: {
          type: 'string',
          description: 'Team name — required if you lead multiple teams',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: TeamsDeleteAgentParamsSchema,
  },
  {
    name: 'devchain_team',
    description:
      'Get detailed team information including capacity counts (maxMembers, maxConcurrentTasks, freeSeats, freeConcurrentSlots), member list with profile and config details, and busy-member counts. If teamName is omitted, auto-resolves when the calling agent belongs to exactly one team.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        teamName: {
          type: 'string',
          description:
            'Team name to look up. If omitted, auto-resolves when the caller belongs to exactly one team.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: DevchainTeamParamsSchema,
  },
];
