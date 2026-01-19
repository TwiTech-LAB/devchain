/**
 * Tool→Schema Registry for MCP parameter validation.
 *
 * Maps each tool name to its Zod param schema. Used by:
 * - Error handler (mcp.service.ts) for generating helpful suggestions
 * - Contract tests to verify schema coverage
 */
import { z, ZodSchema } from 'zod';

import {
  // Document tools
  ListDocumentsParamsSchema,
  GetDocumentParamsSchema,
  CreateDocumentParamsSchema,
  UpdateDocumentParamsSchema,
  // Prompt tools
  ListPromptsParamsSchema,
  GetPromptParamsSchema,
  // Agent tools
  ListAgentsParamsSchema,
  GetAgentByNameParamsSchema,
  // Status tools
  ListStatusesParamsSchema,
  // Epic tools
  ListEpicsParamsSchema,
  ListAssignedEpicsTasksParamsSchema,
  CreateEpicParamsSchema,
  GetEpicByIdParamsSchema,
  AddEpicCommentParamsSchema,
  UpdateEpicParamsSchema,
  // Record tools
  CreateRecordParamsSchema,
  UpdateRecordParamsSchema,
  GetRecordParamsSchema,
  ListRecordsParamsSchema,
  AddTagsParamsSchema,
  RemoveTagsParamsSchema,
  // Chat tools
  SendMessageParamsSchema,
  ChatAckParamsSchema,
  ChatReadHistoryParamsSchema,
  ChatListMembersParamsSchema,
  // Activity tools
  ActivityStartParamsSchema,
  ActivityFinishParamsSchema,
  // Session/Guest tools
  RegisterGuestParamsSchema,
  // Review tools
  ListReviewsParamsSchema,
  GetReviewParamsSchema,
  GetReviewCommentsParamsSchema,
  ReplyCommentParamsSchema,
  ResolveCommentParamsSchema,
} from './mcp.dto';

/**
 * Schema for devchain_list_sessions (no parameters required).
 */
export const ListSessionsParamsSchema = z.object({}).strict();

/**
 * Registry mapping tool names to their Zod param schemas.
 * All tools defined in tool-definitions.ts must have an entry here.
 */
export const toolSchemaRegistry: ReadonlyMap<string, ZodSchema> = new Map<string, ZodSchema>([
  // Session/Bootstrap tools
  ['devchain_list_sessions', ListSessionsParamsSchema],
  ['devchain_register_guest', RegisterGuestParamsSchema],

  // Document tools
  ['devchain_list_documents', ListDocumentsParamsSchema],
  ['devchain_get_document', GetDocumentParamsSchema],
  ['devchain_create_document', CreateDocumentParamsSchema],
  ['devchain_update_document', UpdateDocumentParamsSchema],

  // Prompt tools
  ['devchain_list_prompts', ListPromptsParamsSchema],
  ['devchain_get_prompt', GetPromptParamsSchema],

  // Agent tools
  ['devchain_list_agents', ListAgentsParamsSchema],
  ['devchain_get_agent_by_name', GetAgentByNameParamsSchema],

  // Status tools
  ['devchain_list_statuses', ListStatusesParamsSchema],

  // Epic tools
  ['devchain_list_epics', ListEpicsParamsSchema],
  ['devchain_list_assigned_epics_tasks', ListAssignedEpicsTasksParamsSchema],
  ['devchain_create_epic', CreateEpicParamsSchema],
  ['devchain_get_epic_by_id', GetEpicByIdParamsSchema],
  ['devchain_add_epic_comment', AddEpicCommentParamsSchema],
  ['devchain_update_epic', UpdateEpicParamsSchema],

  // Record tools
  ['devchain_create_record', CreateRecordParamsSchema],
  ['devchain_update_record', UpdateRecordParamsSchema],
  ['devchain_get_record', GetRecordParamsSchema],
  ['devchain_list_records', ListRecordsParamsSchema],
  ['devchain_add_tags', AddTagsParamsSchema],
  ['devchain_remove_tags', RemoveTagsParamsSchema],

  // Chat/Message tools
  ['devchain_send_message', SendMessageParamsSchema],
  ['devchain_chat_ack', ChatAckParamsSchema],
  ['devchain_chat_read_history', ChatReadHistoryParamsSchema],
  ['devchain_chat_list_members', ChatListMembersParamsSchema],

  // Activity tools
  ['devchain_activity_start', ActivityStartParamsSchema],
  ['devchain_activity_finish', ActivityFinishParamsSchema],

  // Code Review tools
  ['devchain_list_reviews', ListReviewsParamsSchema],
  ['devchain_get_review', GetReviewParamsSchema],
  ['devchain_get_review_comments', GetReviewCommentsParamsSchema],
  ['devchain_reply_comment', ReplyCommentParamsSchema],
  ['devchain_resolve_comment', ResolveCommentParamsSchema],
]);

/**
 * Get the Zod schema for a tool by name.
 * @param toolName - The MCP tool name
 * @returns The Zod schema or undefined if not found
 */
export function getToolSchema(toolName: string): ZodSchema | undefined {
  return toolSchemaRegistry.get(toolName);
}

/**
 * Check if a tool has a registered schema.
 * @param toolName - The MCP tool name
 * @returns true if the tool has a registered schema
 */
export function hasToolSchema(toolName: string): boolean {
  return toolSchemaRegistry.has(toolName);
}

/**
 * Get all registered tool names.
 * @returns Array of tool names
 */
export function getRegisteredToolNames(): string[] {
  return Array.from(toolSchemaRegistry.keys());
}

/**
 * Total count of registered tools (for verification).
 */
export const REGISTERED_TOOL_COUNT = toolSchemaRegistry.size;
