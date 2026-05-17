import { ActivityStartParamsSchema, ActivityFinishParamsSchema } from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const activityMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_activity_start',
    description:
      'Start an activity for an agent; posts a system start message and begins a running timer (DM by default).',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'title'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        title: { type: 'string', description: 'Activity title (<=256 chars)' },
        threadId: { type: 'string', description: 'Target thread UUID (optional)' },
        announce: { type: 'boolean', description: 'Whether to post the start system message' },
      },
      additionalProperties: false,
    },
    paramsSchema: ActivityStartParamsSchema,
  },
  {
    name: 'devchain_activity_finish',
    description:
      'Finish the latest running activity for an agent; optionally posts a finish system message.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        threadId: { type: 'string', description: 'Target thread UUID (optional)' },
        message: { type: 'string', description: 'Optional finish message (<=1000 chars)' },
        status: {
          type: 'string',
          enum: ['success', 'failed', 'canceled'],
          description: 'Final status (default success)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ActivityFinishParamsSchema,
  },
];
