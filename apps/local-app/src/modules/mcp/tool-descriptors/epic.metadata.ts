import {
  ListEpicsParamsSchema,
  ListAssignedEpicsTasksParamsSchema,
  CreateEpicParamsSchema,
  GetEpicByIdParamsSchema,
  EpicRelationsListParamsSchema,
  EpicRelationCandidatesListParamsSchema,
  EpicRelationsSetParamsSchema,
  EpicRelationsDeleteParamsSchema,
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
        relation: {
          type: 'object',
          required: ['relatedEpicId', 'relation'],
          properties: {
            relatedEpicId: {
              type: 'string',
              pattern: '^[a-f0-9-]{8,36}$',
              description:
                'Related Epic UUID or 8+ character UUID prefix, resolved in the new Epic workspace',
            },
            relation: {
              type: 'string',
              enum: ['related', 'blocks', 'blocked_by'],
              description: 'Relation value relative to the new Epic',
            },
          },
          additionalProperties: false,
          description: 'Optional single relation created atomically with the Epic',
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
    name: 'devchain_epic_relations_list',
    description:
      'List a bounded page of focal-relative Epic relations visible in the caller workspace; each item reports sourceEpicId and targetEpicId derived from the stored direction (null on legacy neutral rows)',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'epicId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID (full UUID or 8+ char prefix)' },
        epicId: {
          type: 'string',
          pattern: '^[a-f0-9-]{8,36}$',
          description: 'Focal Epic UUID or 8+ character UUID prefix',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum relations to return (default: 50)',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Pagination offset (default: 0)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: EpicRelationsListParamsSchema,
  },
  {
    name: 'devchain_epic_relations_list_candidates',
    description:
      'Search a bounded page of same-workspace Epic relation candidates, excluding invalid and existing pairs',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'epicId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID (full UUID or 8+ char prefix)' },
        epicId: {
          type: 'string',
          pattern: '^[a-f0-9-]{8,36}$',
          description: 'Focal Epic UUID or 8+ character UUID prefix',
        },
        q: {
          type: 'string',
          maxLength: 200,
          description: 'Optional title or Epic ID-prefix search',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum candidates to return (default: 50)',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Pagination offset (default: 0)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: EpicRelationCandidatesListParamsSchema,
  },
  {
    name: 'devchain_epic_relations_set',
    description:
      'Create or replace one Epic relation after rechecking current caller authority; for relation=related, epicId is the source and relatedEpicId is the target — endpoint order defines the stored direction; blocks and blocked_by stay focal-relative',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'epicId', 'relatedEpicId', 'relation'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID (full UUID or 8+ char prefix)' },
        epicId: {
          type: 'string',
          pattern: '^[a-f0-9-]{8,36}$',
          description: 'Focal Epic UUID or 8+ character UUID prefix',
        },
        relatedEpicId: {
          type: 'string',
          pattern: '^[a-f0-9-]{8,36}$',
          description: 'Related Epic UUID or same-workspace 8+ character UUID prefix',
        },
        relation: {
          type: 'string',
          enum: ['related', 'blocks', 'blocked_by'],
          description: 'Relation value relative to the focal Epic',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: EpicRelationsSetParamsSchema,
  },
  {
    name: 'devchain_epic_relations_delete',
    description:
      'Delete one Epic relation after resolving both endpoints and rechecking current caller authority',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'epicId', 'relatedEpicId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID (full UUID or 8+ char prefix)' },
        epicId: {
          type: 'string',
          pattern: '^[a-f0-9-]{8,36}$',
          description: 'Focal Epic UUID or 8+ character UUID prefix',
        },
        relatedEpicId: {
          type: 'string',
          pattern: '^[a-f0-9-]{8,36}$',
          description:
            'Full UUID addresses the exact pair and may delete a target whose status is hidden from MCP reads (the exact ID a replacement refusal returned); prefixes resolve visible targets only',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: EpicRelationsDeleteParamsSchema,
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
