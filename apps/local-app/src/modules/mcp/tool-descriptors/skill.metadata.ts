import { ListSkillsParamsSchema, GetSkillParamsSchema } from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const skillMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_list_skills',
    description:
      "List skills available to the session's project, excluding disabled skills. Supports optional q for multi-term keyword filtering across skill fields — space-separated terms match independently (e.g. 'react typescript test').",
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
          description:
            'Multi-term keyword filter. Space-separated terms match independently across slug, name, display name, and description. Results are ranked by relevance.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ListSkillsParamsSchema,
  },
  {
    name: 'devchain_get_skill',
    description:
      'Get a skill by slug with full content/details and record usage from session context. Works even when the skill is disabled (disable only affects discovery).',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'slug'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        slug: {
          type: 'string',
          description: 'Skill slug in source/name form (for example: anthropic/code-review)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: GetSkillParamsSchema,
  },
];
