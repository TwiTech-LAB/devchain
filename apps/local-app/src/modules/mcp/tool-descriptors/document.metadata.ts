import {
  ListDocumentsParamsSchema,
  GetDocumentParamsSchema,
  CreateDocumentParamsSchema,
  UpdateDocumentParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const documentMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_list_documents',
    description: 'List all documents for the project resolved from the session.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags (all must match)',
        },
        q: { type: 'string', description: 'Search query for title/content' },
        limit: { type: 'number', description: 'Max results (default: 100)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
      },
      additionalProperties: false,
    },
    paramsSchema: ListDocumentsParamsSchema,
  },
  {
    name: 'devchain_get_document',
    description: 'Get a single document by ID or slug, with optional link resolution',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document UUID' },
        slug: { type: 'string', description: 'Document slug (requires projectId)' },
        projectId: { type: 'string', description: 'Project ID when using slug' },
        includeLinks: {
          type: 'string',
          enum: ['none', 'meta', 'inline'],
          description:
            'Link resolution: none (no links), meta (link metadata), inline (full content)',
        },
        maxDepth: {
          type: 'number',
          description: 'Max depth for inline resolution (default: 1)',
        },
        maxBytes: {
          type: 'number',
          description: 'Max bytes for inline content (default: 64KB)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: GetDocumentParamsSchema,
  },
  {
    name: 'devchain_create_document',
    description: 'Create a new markdown document in the project resolved from the session',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'title', 'contentMd'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        title: { type: 'string', description: 'Document title' },
        contentMd: { type: 'string', description: 'Markdown content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Document tags' },
      },
      additionalProperties: false,
    },
    paramsSchema: CreateDocumentParamsSchema,
  },
  {
    name: 'devchain_update_document',
    description: 'Update an existing document',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Document UUID' },
        title: { type: 'string', description: 'New title' },
        slug: { type: 'string', description: 'New slug' },
        contentMd: { type: 'string', description: 'New markdown content' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
        archived: { type: 'boolean', description: 'Archive status' },
        version: { type: 'number', description: 'Version for optimistic locking' },
      },
      additionalProperties: false,
    },
    paramsSchema: UpdateDocumentParamsSchema,
  },
];
