import {
  CreateRecordParamsSchema,
  UpdateRecordParamsSchema,
  GetRecordParamsSchema,
  ListRecordsParamsSchema,
  AddTagsParamsSchema,
  RemoveTagsParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const recordMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_create_record',
    description: 'Create a new record (generic data storage for epics)',
    inputSchema: {
      type: 'object',
      required: ['epicId', 'type', 'data'],
      properties: {
        epicId: { type: 'string', description: 'Epic UUID this record belongs to' },
        type: { type: 'string', description: 'Record type identifier' },
        data: { type: 'object', description: 'Arbitrary JSON data' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Record tags' },
      },
      additionalProperties: false,
    },
    paramsSchema: CreateRecordParamsSchema,
  },
  {
    name: 'devchain_update_record',
    description: 'Update an existing record',
    inputSchema: {
      type: 'object',
      required: ['id', 'version'],
      properties: {
        id: { type: 'string', description: 'Record UUID' },
        data: { type: 'object', description: 'New data (merged)' },
        type: { type: 'string', description: 'New type' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
        version: { type: 'number', description: 'Current version for optimistic locking' },
      },
      additionalProperties: false,
    },
    paramsSchema: UpdateRecordParamsSchema,
  },
  {
    name: 'devchain_get_record',
    description: 'Get a record by ID',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', description: 'Record UUID' } },
      additionalProperties: false,
    },
    paramsSchema: GetRecordParamsSchema,
  },
  {
    name: 'devchain_list_records',
    description: 'List records for an epic with optional filtering',
    inputSchema: {
      type: 'object',
      required: ['epicId'],
      properties: {
        epicId: { type: 'string', description: 'Epic UUID' },
        type: { type: 'string', description: 'Filter by record type' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        limit: { type: 'number', description: 'Max results' },
        offset: { type: 'number', description: 'Pagination offset' },
      },
      additionalProperties: false,
    },
    paramsSchema: ListRecordsParamsSchema,
  },
  {
    name: 'devchain_add_tags',
    description: 'Add tags to a record',
    inputSchema: {
      type: 'object',
      required: ['id', 'tags'],
      properties: {
        id: { type: 'string', description: 'Record UUID' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Tags to add',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: AddTagsParamsSchema,
  },
  {
    name: 'devchain_remove_tags',
    description: 'Remove tags from a record',
    inputSchema: {
      type: 'object',
      required: ['id', 'tags'],
      properties: {
        id: { type: 'string', description: 'Record UUID' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Tags to remove',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: RemoveTagsParamsSchema,
  },
];
