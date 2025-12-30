import { z } from 'zod';

// Thread DTOs
export const CreateDirectThreadSchema = z.object({
  projectId: z.string().uuid(),
  agentId: z.string().uuid(),
});

export const CreateGroupThreadSchema = z.object({
  projectId: z.string().uuid(),
  agentIds: z.array(z.string().uuid()).min(2),
  title: z.string().optional(),
  createdByType: z.enum(['user', 'agent', 'system']).optional().default('user'),
  createdByAgentId: z.string().uuid().optional(),
});

export const InviteThreadMembersSchema = z.object({
  agentIds: z.array(z.string().uuid()).min(1),
  projectId: z.string().uuid().optional(),
  inviterName: z.string().min(1).max(100).optional(),
});

export const ClearThreadHistorySchema = z.object({
  announce: z.boolean().optional().default(false),
});

export const PurgeThreadHistorySchema = z.object({
  before: z.string().datetime().optional(),
  announce: z.boolean().optional().default(false),
});

export const ListThreadsQuerySchema = z.object({
  projectId: z.string().uuid(),
  createdByType: z.enum(['user', 'agent', 'system']).optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

// Message DTOs
export const CreateMessageSchema = z.object({
  content: z.string().min(1).max(100000),
  authorType: z.enum(['user', 'agent', 'system']),
  authorAgentId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  targets: z.array(z.string().uuid()).optional(),
});

export const ListMessagesQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});

// Response DTOs
export const ThreadSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().nullable(),
  isGroup: z.boolean(),
  createdByType: z.enum(['user', 'agent', 'system']),
  createdByUserId: z.string().uuid().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  members: z.array(z.string().uuid()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const MessageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  authorType: z.enum(['user', 'agent', 'system']),
  authorAgentId: z.string().uuid().nullable(),
  content: z.string(),
  targets: z.array(z.string().uuid()).optional(),
  createdAt: z.string().datetime(),
});

export const ThreadsListSchema = z.object({
  items: z.array(ThreadSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export const MessagesListSchema = z.object({
  items: z.array(MessageSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

// Type exports
export type CreateDirectThreadDto = z.infer<typeof CreateDirectThreadSchema>;
export type CreateGroupThreadDto = z.infer<typeof CreateGroupThreadSchema>;
export type InviteThreadMembersDto = z.infer<typeof InviteThreadMembersSchema>;
export type ClearThreadHistoryDto = z.infer<typeof ClearThreadHistorySchema>;
export type PurgeThreadHistoryDto = z.infer<typeof PurgeThreadHistorySchema>;
export type ListThreadsQueryDto = z.infer<typeof ListThreadsQuerySchema>;
export type CreateMessageDto = z.infer<typeof CreateMessageSchema>;
export type ListMessagesQueryDto = z.infer<typeof ListMessagesQuerySchema>;
export type ThreadDto = z.infer<typeof ThreadSchema>;
export type MessageDto = z.infer<typeof MessageSchema>;
export type ThreadsListDto = z.infer<typeof ThreadsListSchema>;
export type MessagesListDto = z.infer<typeof MessagesListSchema>;
