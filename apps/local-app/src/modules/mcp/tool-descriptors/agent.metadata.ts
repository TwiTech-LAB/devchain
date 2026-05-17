import {
  ListAgentsParamsSchema,
  GetAgentByNameParamsSchema,
  ListStatusesParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const agentMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_list_agents',
    description: 'List agents for the project resolved from the session',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        limit: { type: 'number', description: 'Max results (default: 100)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
        q: {
          type: 'string',
          description: 'Optional case-insensitive substring filter on agent name',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ListAgentsParamsSchema,
  },
  {
    name: 'devchain_get_agent_by_name',
    description: 'Fetch a single agent by name for the project resolved from the session',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'name'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        name: {
          type: 'string',
          description: 'Agent name to look up (case-insensitive match)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: GetAgentByNameParamsSchema,
  },
  {
    name: 'devchain_list_statuses',
    description: 'List project statuses resolved from the session',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ListStatusesParamsSchema,
  },
];
