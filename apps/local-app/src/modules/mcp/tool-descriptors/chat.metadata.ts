import {
  SendMessageParamsSchema,
  ChatAckParamsSchema,
  ChatReadHistoryParamsSchema,
  ChatListMembersParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const chatMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_send_message',
    description:
      'Send a chat message. Sender is derived from session agent. Provide threadId to reply in a thread, recipientAgentNames to create a new agent-initiated group, or teamName for pooled team routing. Omit all recipient fields to fan out to your own team (resolved from session).',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'message'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        threadId: {
          type: 'string',
          description:
            'Existing thread UUID. When provided, recipients may be omitted to fan-out to thread members.',
        },
        recipientAgentNames: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'Agent names (case-insensitive) to receive the message. Required only when creating a new thread (no threadId).',
        },
        teamName: {
          type: 'string',
          description:
            'Team name (case-insensitive). Routes to team lead if assigned, otherwise to all members. Mutually exclusive with recipientAgentNames. Cannot be combined with threadId. Omit all recipient fields to fan out to your own team (resolved from session).',
        },
        message: { type: 'string', description: 'Message content to deliver.' },
      },
      additionalProperties: false,
    },
    paramsSchema: SendMessageParamsSchema,
  },
  {
    name: 'devchain_chat_ack',
    description: 'Mark a chat message as read for an agent and emit a message.read event.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'thread_id', 'message_id'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        thread_id: { type: 'string', description: 'Chat thread UUID.' },
        message_id: { type: 'string', description: 'Chat message UUID to acknowledge.' },
      },
      additionalProperties: false,
    },
    paramsSchema: ChatAckParamsSchema,
  },
  {
    name: 'devchain_chat_read_history',
    description: 'Fetch recent messages for a chat thread so agents can catch up after an invite.',
    inputSchema: {
      type: 'object',
      required: ['thread_id'],
      properties: {
        thread_id: { type: 'string', description: 'Chat thread UUID.' },
        limit: { type: 'number', description: 'Max messages to return (default 50, max 200).' },
        since: {
          type: 'string',
          description: 'ISO timestamp; only messages after this time are returned.',
        },
        exclude_system: {
          type: 'boolean',
          description:
            'Exclude system messages. Defaults to true when omitted to show only user/agent authored messages.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ChatReadHistoryParamsSchema,
  },
  {
    name: 'devchain_chat_list_members',
    description: 'List members of a chat thread along with their online status.',
    inputSchema: {
      type: 'object',
      required: ['thread_id'],
      properties: { thread_id: { type: 'string', description: 'Chat thread UUID.' } },
      additionalProperties: false,
    },
    paramsSchema: ChatListMembersParamsSchema,
  },
];
