import {
  ListEpicsParamsSchema,
  ListAssignedEpicsTasksParamsSchema,
  CreateEpicParamsSchema,
  GetEpicByIdParamsSchema,
  AddEpicCommentParamsSchema,
  UpdateEpicParamsSchema,
  DeleteEpicParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const epicMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_list_epics',
    description: 'List epics for the project resolved from the session with optional filters',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        statusName: {
          type: 'string',
          description: 'Optional status name filter (case-insensitive)',
        },
        limit: { type: 'number', description: 'Max results (default: 100)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
        q: {
          type: 'string',
          description: 'Optional search query applied to epic titles and descriptions',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ListEpicsParamsSchema,
  },
  {
    name: 'devchain_list_assigned_epics_tasks',
    description:
      'List epics assigned to the specified agent within the project resolved from the session',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'agentName'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        agentName: { type: 'string', description: 'Agent name to match (case-insensitive)' },
        limit: { type: 'number', description: 'Max results (default: 100)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
      },
      additionalProperties: false,
    },
    paramsSchema: ListAssignedEpicsTasksParamsSchema,
  },
  {
    name: 'devchain_create_epic',
    description: 'Create a new epic within the project resolved from the session',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'title'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        title: { type: 'string', description: 'Epic title' },
        description: { type: 'string', description: 'Optional epic description' },
        statusName: {
          type: 'string',
          description: 'Optional status name (case-insensitive)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of tags to assign to the epic',
        },
        agentName: {
          type: 'string',
          description: 'Optional agent name to assign (case-insensitive)',
        },
        parentId: {
          type: 'string',
          description: 'Optional parent epic UUID to nest this epic under',
        },
        skillsRequired: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of required skill slugs for this epic',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: CreateEpicParamsSchema,
  },
  {
    name: 'devchain_get_epic_by_id',
    description: 'Fetch a single epic, including comments and related hierarchy details',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'id'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        id: {
          type: 'string',
          description: 'Epic UUID or 8+ char hex prefix (a-f, 0-9, hyphens only; max 36 chars)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: GetEpicByIdParamsSchema,
  },
  {
    name: 'devchain_add_epic_comment',
    description:
      'Add a comment to the specified epic within the project resolved from the session. Author is derived from session agent.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'epicId', 'content'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        epicId: {
          type: 'string',
          description: 'Epic UUID or 8+ char hex prefix (a-f, 0-9, hyphens only; max 36 chars)',
        },
        content: { type: 'string', description: 'Comment body content' },
      },
      additionalProperties: false,
    },
    paramsSchema: AddEpicCommentParamsSchema,
  },
  {
    name: 'devchain_update_epic',
    description:
      'Update an epic with flexible field updates including status (by name), assignment (by agent name or clear), parent hierarchy, and tags. Uses optimistic locking via version. Tag-only examples: replace `{ sessionId, id, version, setTags: [...] }`, add `{ sessionId, id, version, addTags: [...] }`, remove `{ sessionId, id, version, removeTags: [...] }`.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'id', 'version'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        id: {
          type: 'string',
          description: 'Epic UUID or 8+ char hex prefix (a-f, 0-9, hyphens only; max 36 chars)',
        },
        version: { type: 'number', description: 'Current version for optimistic locking' },
        title: { type: 'string', description: 'New epic title' },
        description: { type: 'string', description: 'New epic description' },
        statusName: {
          type: 'string',
          description: 'Status name (case-insensitive exact match)',
        },
        assignment: {
          type: 'object',
          description:
            'Assignment update: either { agentName: string } to assign or { clear: true } to unassign',
          oneOf: [
            {
              type: 'object',
              required: ['agentName'],
              properties: {
                agentName: {
                  type: 'string',
                  description: 'Agent name (case-insensitive exact match)',
                },
              },
              additionalProperties: false,
            },
            {
              type: 'object',
              required: ['clear'],
              properties: {
                clear: {
                  type: 'boolean',
                  const: true,
                  description: 'Set to true to clear assignment',
                },
              },
              additionalProperties: false,
            },
          ],
        },
        parentId: {
          type: 'string',
          description: 'Parent epic UUID (mutually exclusive with clearParent)',
        },
        clearParent: {
          type: 'boolean',
          description: 'Set to true to remove parent (mutually exclusive with parentId)',
        },
        setTags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace all tags with this array',
        },
        addTags: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        removeTags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
        skillsRequired: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace required skill slugs for this epic',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: UpdateEpicParamsSchema,
  },
  {
    name: 'devchain_delete_epic',
    description:
      'Delete an epic within the project resolved from the session. Do not delete epics without explicit user approval. Deleting an epic also deletes its sub-epics. Current event contract publishes one epic.deleted event for the top-level deleted epic.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'id'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        id: {
          type: 'string',
          description: 'Epic UUID or 8+ char hex prefix (a-f, 0-9, hyphens only; max 36 chars)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: DeleteEpicParamsSchema,
  },
];
