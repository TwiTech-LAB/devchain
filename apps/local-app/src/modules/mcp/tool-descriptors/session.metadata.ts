import { z } from 'zod';
import { RegisterGuestParamsSchema } from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const ListSessionsParamsSchema = z.object({}).strict();

export const sessionMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_list_sessions',
    description:
      'List active sessions for discovery. This is the bootstrap tool that requires no sessionId - use it to discover valid session IDs for other MCP calls.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    paramsSchema: ListSessionsParamsSchema,
  },
  {
    name: 'devchain_register_guest',
    description:
      'Register as a guest agent to join the DevChain system. Use this when you are an external AI agent running in a tmux session and want to appear in the Chat page alongside other agents. Returns a guestId that must be used as sessionId for all subsequent MCP tool calls. Your project is auto-detected from your tmux working directory.',
    inputSchema: {
      type: 'object',
      required: ['name', 'tmuxSessionId'],
      properties: {
        name: {
          type: 'string',
          description: 'Display name for the guest agent (must be unique within the project)',
        },
        tmuxSessionId: {
          type: 'string',
          description: 'The tmux session ID where the guest is running',
        },
        description: {
          type: 'string',
          description: 'Optional description of the guest agent',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: RegisterGuestParamsSchema,
  },
];
