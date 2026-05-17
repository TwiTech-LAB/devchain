import {
  McpResponse,
  CreateRecordResponse,
  UpdateRecordResponse,
  GetRecordResponse,
  ListRecordsResponse,
  AddTagsResponse,
  RemoveTagsResponse,
  type CreateRecordParams,
  type UpdateRecordParams,
  type GetRecordParams,
  type ListRecordsParams,
  type AddTagsParams,
  type RemoveTagsParams,
} from '../../dtos/mcp.dto';
import type { RecordToolContext } from './record-context';

export async function handleCreateRecord(
  ctx: RecordToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as CreateRecordParams;
  const record = await ctx.storage.createRecord({
    epicId: validated.epicId,
    type: validated.type,
    data: validated.data,
    tags: validated.tags || [],
  });

  const response: CreateRecordResponse = {
    id: record.id,
    version: record.version,
  };

  return { success: true, data: response };
}

export async function handleUpdateRecord(
  ctx: RecordToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as UpdateRecordParams;
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
    version: record.version,
  };

  return { success: true, data: response };
}

export async function handleGetRecord(
  ctx: RecordToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as GetRecordParams;
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
  ctx: RecordToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as ListRecordsParams;
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

export async function handleAddTags(ctx: RecordToolContext, params: unknown): Promise<McpResponse> {
  const validated = params as AddTagsParams;
  const record = await ctx.storage.getRecord(validated.id);

  const newTags = Array.from(new Set([...record.tags, ...validated.tags]));

  const updated = await ctx.storage.updateRecord(validated.id, { tags: newTags }, record.version);

  const response: AddTagsResponse = {
    id: updated.id,
    version: updated.version,
  };

  return { success: true, data: response };
}

export async function handleRemoveTags(
  ctx: RecordToolContext,
  params: unknown,
): Promise<McpResponse> {
  const validated = params as RemoveTagsParams;
  const record = await ctx.storage.getRecord(validated.id);

  const newTags = record.tags.filter((tag) => !validated.tags.includes(tag));

  const updated = await ctx.storage.updateRecord(validated.id, { tags: newTags }, record.version);

  const response: RemoveTagsResponse = {
    id: updated.id,
    version: updated.version,
  };

  return { success: true, data: response };
}
