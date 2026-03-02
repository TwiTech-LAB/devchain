import {
  McpResponse,
  CreateRecordResponse,
  UpdateRecordResponse,
  GetRecordResponse,
  ListRecordsResponse,
  AddTagsResponse,
  RemoveTagsResponse,
  CreateRecordParamsSchema,
  UpdateRecordParamsSchema,
  GetRecordParamsSchema,
  ListRecordsParamsSchema,
  AddTagsParamsSchema,
  RemoveTagsParamsSchema,
} from '../../dtos/mcp.dto';
import type { McpToolContext } from './types';

export async function handleCreateRecord(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = CreateRecordParamsSchema.parse(params);
  const record = await ctx.storage.createRecord({
    epicId: validated.epicId,
    type: validated.type,
    data: validated.data,
    tags: validated.tags || [],
  });

  const response: CreateRecordResponse = {
    id: record.id,
    epicId: record.epicId,
    type: record.type,
    data: record.data,
    tags: record.tags,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  return { success: true, data: response };
}

export async function handleUpdateRecord(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = UpdateRecordParamsSchema.parse(params);
  const record = await ctx.storage.updateRecord(
    validated.id,
    {
      data: validated.data,
      type: validated.type,
      tags: validated.tags,
    },
    validated.version,
  );

  const response: UpdateRecordResponse = {
    id: record.id,
    epicId: record.epicId,
    type: record.type,
    data: record.data,
    tags: record.tags,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  return { success: true, data: response };
}

export async function handleGetRecord(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  const validated = GetRecordParamsSchema.parse(params);
  const record = await ctx.storage.getRecord(validated.id);

  const response: GetRecordResponse = {
    id: record.id,
    epicId: record.epicId,
    type: record.type,
    data: record.data,
    tags: record.tags,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };

  return { success: true, data: response };
}

export async function handleListRecords(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = ListRecordsParamsSchema.parse(params);
  const result = await ctx.storage.listRecords(validated.epicId, {
    limit: validated.limit,
    offset: validated.offset,
  });

  let filtered = result.items;
  if (validated.type) {
    filtered = filtered.filter((record) => record.type === validated.type);
  }

  if (validated.tags && validated.tags.length > 0) {
    filtered = filtered.filter((record) =>
      validated.tags!.every((tag) => record.tags.includes(tag)),
    );
  }

  const response: ListRecordsResponse = {
    records: filtered.map((record) => ({
      id: record.id,
      epicId: record.epicId,
      type: record.type,
      data: record.data,
      tags: record.tags,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })),
    total: filtered.length,
  };

  return { success: true, data: response };
}

export async function handleAddTags(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  const validated = AddTagsParamsSchema.parse(params);
  const record = await ctx.storage.getRecord(validated.id);

  const newTags = Array.from(new Set([...record.tags, ...validated.tags]));

  const updated = await ctx.storage.updateRecord(validated.id, { tags: newTags }, record.version);

  const response: AddTagsResponse = {
    id: updated.id,
    tags: updated.tags,
  };

  return { success: true, data: response };
}

export async function handleRemoveTags(ctx: McpToolContext, params: unknown): Promise<McpResponse> {
  const validated = RemoveTagsParamsSchema.parse(params);
  const record = await ctx.storage.getRecord(validated.id);

  const newTags = record.tags.filter((tag) => !validated.tags.includes(tag));

  const updated = await ctx.storage.updateRecord(validated.id, { tags: newTags }, record.version);

  const response: RemoveTagsResponse = {
    id: updated.id,
    tags: updated.tags,
  };

  return { success: true, data: response };
}
