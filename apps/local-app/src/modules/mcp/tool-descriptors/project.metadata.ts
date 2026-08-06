import { ProjectsListParamsSchema } from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const projectMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_projects_list',
    description:
      'List other non-template local projects available for cross-project messaging. Requires the current Project Owner and returns owner availability without paths or agent internals.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          minLength: 8,
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          default: 100,
          description: 'Max results (default: 100, max: 100)',
        },
        offset: {
          type: 'number',
          minimum: 0,
          default: 0,
          description: 'Pagination offset (default: 0)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ProjectsListParamsSchema,
  },
];
