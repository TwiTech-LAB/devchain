import { ListPromptsParamsSchema, GetPromptParamsSchema } from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const promptMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_list_prompts',
    description: 'List prompts for the project resolved from the session',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        q: { type: 'string', description: 'Search query' },
      },
      additionalProperties: false,
    },
    paramsSchema: ListPromptsParamsSchema,
  },
  {
    name: 'devchain_get_prompt',
    description:
      'Get a specific prompt by ID or by (name + sessionId). Content is rendered with template variables when sessionId is provided; raw otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Prompt UUID' },
        name: { type: 'string', description: 'Prompt name/title' },
        version: { type: 'number', description: 'Specific version number' },
        sessionId: {
          type: 'string',
          description:
            'Session ID (full UUID or 8+ char prefix). Required when querying by name. Optional with id — when provided, content is rendered with template variables.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: GetPromptParamsSchema,
  },
];
