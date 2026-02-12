import { z } from 'zod';
import { SkillsRequiredInputSchema } from '../../skills/dtos/skill.dto';

/**
 * MCP Tool Request schemas
 */

// devchain.create_record
export const CreateRecordParamsSchema = z
  .object({
    epicId: z.string().uuid(),
    type: z.string().min(1),
    data: z.record(z.unknown()),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export type CreateRecordParams = z.infer<typeof CreateRecordParamsSchema>;

// devchain.update_record
export const UpdateRecordParamsSchema = z
  .object({
    id: z.string().uuid(),
    data: z.record(z.unknown()).optional(),
    type: z.string().optional(),
    tags: z.array(z.string()).optional(),
    version: z.number().int().positive(),
  })
  .strict();

export type UpdateRecordParams = z.infer<typeof UpdateRecordParamsSchema>;

// devchain.get_record
export const GetRecordParamsSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export type GetRecordParams = z.infer<typeof GetRecordParamsSchema>;

// devchain.list_records
export const ListRecordsParamsSchema = z
  .object({
    epicId: z.string().uuid(),
    type: z.string().optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ListRecordsParams = z.infer<typeof ListRecordsParamsSchema>;

// devchain.add_tags
export const AddTagsParamsSchema = z
  .object({
    id: z.string().uuid(),
    tags: z.array(z.string()).min(1),
  })
  .strict();

export type AddTagsParams = z.infer<typeof AddTagsParamsSchema>;

// devchain.remove_tags
export const RemoveTagsParamsSchema = z
  .object({
    id: z.string().uuid(),
    tags: z.array(z.string()).min(1),
  })
  .strict();

export type RemoveTagsParams = z.infer<typeof RemoveTagsParamsSchema>;

// devchain.list_documents
export const ListDocumentsParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    tags: z.array(z.string()).optional(),
    q: z.string().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ListDocumentsParams = z.infer<typeof ListDocumentsParamsSchema>;

// devchain.get_document
export const GetDocumentParamsSchema = z
  .object({
    id: z.string().uuid().optional(),
    projectId: z.string().optional(),
    slug: z.string().optional(),
    includeLinks: z.enum(['none', 'meta', 'inline']).optional(),
    maxDepth: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().positive().optional(),
  })
  .strict()
  .refine((data) => data.id || data.slug, {
    message: 'Either id or slug must be provided',
    path: ['id'],
  })
  .refine((data) => !data.slug || data.projectId !== undefined, {
    message: 'projectId is required when querying by slug',
    path: ['projectId'],
  });

export type GetDocumentParams = z.infer<typeof GetDocumentParamsSchema>;

// devchain.create_document
export const CreateDocumentParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    title: z.string().min(1),
    contentMd: z.string(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export type CreateDocumentParams = z.infer<typeof CreateDocumentParamsSchema>;

// devchain.update_document
export const UpdateDocumentParamsSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    contentMd: z.string().optional(),
    tags: z.array(z.string()).optional(),
    archived: z.boolean().optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();

export type UpdateDocumentParams = z.infer<typeof UpdateDocumentParamsSchema>;

// devchain.list_prompts
export const ListPromptsParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    tags: z.array(z.string()).optional(),
    q: z.string().optional(),
  })
  .strict();

export type ListPromptsParams = z.infer<typeof ListPromptsParamsSchema>;

// devchain_list_agents
export const ListAgentsParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    q: z.string().optional(),
  })
  .strict();

export type ListAgentsParams = z.infer<typeof ListAgentsParamsSchema>;

// devchain_get_agent_by_name
export const GetAgentByNameParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    name: z.string().min(1),
  })
  .strict();

export type GetAgentByNameParams = z.infer<typeof GetAgentByNameParamsSchema>;

// devchain_list_statuses
export const ListStatusesParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
  })
  .strict();

export type ListStatusesParams = z.infer<typeof ListStatusesParamsSchema>;

// devchain_list_epics
export const ListEpicsParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    statusName: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    q: z.string().optional(),
  })
  .strict();

export type ListEpicsParams = z.infer<typeof ListEpicsParamsSchema>;

// devchain_list_assigned_epics_tasks
export const ListAssignedEpicsTasksParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    agentName: z.string().min(1), // Target agent name to filter assignments
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ListAssignedEpicsTasksParams = z.infer<typeof ListAssignedEpicsTasksParamsSchema>;

// devchain_create_epic
export const CreateEpicParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    title: z.string().min(1),
    description: z.string().optional(),
    statusName: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    agentName: z.string().min(1).optional(), // Target agent to assign epic to
    parentId: z.string().uuid().optional(),
    skillsRequired: SkillsRequiredInputSchema.optional(),
  })
  .strict();

export type CreateEpicParams = z.infer<typeof CreateEpicParamsSchema>;

// devchain_get_epic_by_id
export const GetEpicByIdParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    id: z.string().uuid(),
  })
  .strict();

export type GetEpicByIdParams = z.infer<typeof GetEpicByIdParamsSchema>;

// devchain_add_epic_comment
// Author identity is derived from sessionId (ctx.agent.name)
export const AddEpicCommentParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    epicId: z.string().uuid(),
    content: z.string().min(1),
  })
  .strict();

export type AddEpicCommentParams = z.infer<typeof AddEpicCommentParamsSchema>;

// devchain_update_epic
export const UpdateEpicParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    id: z.string().uuid(),
    version: z.number().int().positive(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    statusName: z.string().min(1).optional(),
    assignment: z
      .union([
        z.object({ agentName: z.string().min(1) }).strict(),
        z.object({ clear: z.literal(true) }).strict(),
      ])
      .optional(),
    parentId: z.string().uuid().optional(),
    clearParent: z.boolean().optional(),
    setTags: z.array(z.string()).optional(),
    addTags: z.array(z.string()).optional(),
    removeTags: z.array(z.string()).optional(),
    skillsRequired: SkillsRequiredInputSchema.optional(),
  })
  .strict()
  .refine((data) => !(data.parentId && data.clearParent), {
    message: 'Cannot specify both parentId and clearParent',
    path: ['parentId'],
  })
  .refine((data) => !(data.setTags && (data.addTags || data.removeTags)), {
    message: 'Cannot use setTags together with addTags or removeTags',
    path: ['setTags'],
  });

export type UpdateEpicParams = z.infer<typeof UpdateEpicParamsSchema>;

// devchain.get_prompt
export const GetPromptParamsSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().optional(),
    version: z.number().int().positive().optional(),
    // Session ID required when querying by name to resolve project
    sessionId: z.string().min(8).optional(),
  })
  .strict()
  .refine((data) => data.id || data.name, {
    message: 'Either id or name must be provided',
    path: ['id'],
  })
  .refine((data) => data.id || data.sessionId, {
    message: 'sessionId is required when querying by name (without id)',
    path: ['sessionId'],
  });

export type GetPromptParams = z.infer<typeof GetPromptParamsSchema>;

// devchain_list_skills
export const listSkillsSchema = z
  .object({
    sessionId: z.string(),
    q: z.string().optional(),
  })
  .strict();

export const ListSkillsParamsSchema = listSkillsSchema;
export type ListSkillsParams = z.infer<typeof listSkillsSchema>;

// devchain_get_skill
export const getSkillSchema = z
  .object({
    sessionId: z.string(),
    slug: z.string(),
  })
  .strict();

export const GetSkillParamsSchema = getSkillSchema;
export type GetSkillParams = z.infer<typeof getSkillSchema>;

/**
 * MCP Tool Call envelope (terminal marker format)
 */
export const McpToolCallSchema = z.object({
  tool: z.string(),
  params: z.record(z.unknown()),
});

export type McpToolCall = z.infer<typeof McpToolCallSchema>;

export const McpResourceRequestSchema = z.object({
  uri: z.string().min(1),
});

export type McpResourceRequest = z.infer<typeof McpResourceRequestSchema>;

/**
 * MCP Response payloads
 */
export interface McpResponse {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    data?: unknown;
  };
}

export interface CreateRecordResponse {
  id: string;
  epicId: string;
  type: string;
  data: Record<string, unknown>;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateRecordResponse {
  id: string;
  epicId: string;
  type: string;
  data: Record<string, unknown>;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GetRecordResponse {
  id: string;
  epicId: string;
  type: string;
  data: Record<string, unknown>;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListRecordsResponse {
  records: {
    id: string;
    epicId: string;
    type: string;
    data: Record<string, unknown>;
    tags: string[];
    version: number;
    createdAt: string;
    updatedAt: string;
  }[];
  total: number;
}

export interface AddTagsResponse {
  id: string;
  tags: string[];
}

export interface RemoveTagsResponse {
  id: string;
  tags: string[];
}

export interface DocumentSummary {
  id: string;
  projectId: string | null;
  title: string;
  slug: string;
  tags: string[];
  archived: boolean;
  version: number;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  contentMd: string;
  createdAt: string;
}

export interface DocumentLinkMeta {
  slug: string;
  title?: string;
  id?: string;
  projectId?: string | null;
  exists: boolean;
}

export interface DocumentInlineResolution {
  contentMd: string;
  depthUsed: number;
  bytes: number;
  truncated: boolean;
}

export interface ListDocumentsResponse {
  documents: DocumentSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface GetDocumentResponse {
  document: DocumentDetail;
  links: DocumentLinkMeta[];
  resolved?: DocumentInlineResolution;
}

export interface CreateDocumentResponse {
  document: DocumentDetail;
}

export interface UpdateDocumentResponse {
  document: DocumentDetail;
}

/**
 * Summary of a prompt with content preview (for list operations).
 */
export interface PromptSummary {
  id: string;
  projectId: string | null;
  title: string;
  contentPreview: string;
  tags: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Full prompt details including content.
 */
export interface PromptDetail extends PromptSummary {
  content: string;
}

export interface ListPromptsResponse {
  prompts: PromptSummary[];
  total: number;
}

export interface GetPromptResponse {
  prompt: PromptDetail;
}

export interface SkillListItem {
  slug: string;
  description: string;
}

export interface ListSkillsResponse {
  skills: SkillListItem[];
  total: number;
}

export interface GetSkillResponse {
  slug: string;
  name: string;
  description: string | null;
  instructionContent: string | null;
  contentPath: string | null;
  resources: string[];
  sourceUrl: string | null;
  license: string | null;
  compatibility: string | null;
  status: 'available' | 'outdated' | 'sync_error';
  frontmatter: Record<string, unknown> | null;
}

export interface AgentSummary {
  id: string;
  name: string;
  profileId: string | null;
  description?: string | null;
  /** 'agent' for regular agents, 'guest' for guest agents */
  type?: 'agent' | 'guest';
  /** Whether the agent/guest is currently online */
  online?: boolean;
}

export interface AgentProfileSummary {
  id: string;
  name: string;
  instructions?: string | null;
  instructionsResolved?: InstructionsResolved;
}

export interface InstructionsResolved {
  contentMd: string;
  bytes: number;
  truncated: boolean;
  docs: {
    id: string;
    slug: string;
    title: string;
  }[];
  prompts: {
    id: string;
    title: string;
  }[];
}

export interface ListAgentsResponse {
  agents: AgentSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface GetAgentByNameResponse {
  agent: AgentSummary & {
    profile?: AgentProfileSummary;
  };
}

export interface StatusSummary {
  id: string;
  name: string;
  position: number;
  color: string | null;
}

export interface ListStatusesResponse {
  statuses: StatusSummary[];
}

export interface EpicSummary {
  id: string;
  title: string;
  description: string | null;
  statusId: string;
  version: number; // Required for optimistic locking in updates
  // Optional resolved status for convenience in detail views
  status?: StatusSummary;
  agentName?: string | null;
  parentId?: string | null;
  // Optional tags for filtering/categorization
  tags?: string[];
  // Optional required skill slugs attached to this epic
  skillsRequired?: string[];
  // Optional nested sub-epics for hierarchical list response
  subEpics?: EpicChildSummary[];
}

export interface ListEpicsResponse {
  epics: EpicSummary[];
  total: number;
  limit: number;
  offset: number;
}

export type ListAssignedEpicsTasksResponse = ListEpicsResponse;

export interface EpicChildSummary {
  id: string;
  title: string;
  statusId: string;
  // Optional resolved status to avoid extra lookups
  status?: StatusSummary;
}

export interface EpicParentSummary {
  id: string;
  title: string;
  description: string | null;
  agentName?: string | null;
}

export interface EpicCommentSummary {
  id: string;
  authorName: string;
  content: string;
  createdAt: string;
  // Sequential number within the comments array of devchain_get_epic_by_id
  // Populated by the service when listing comments; starts at 1
  commentNumber?: number;
}

export interface GetEpicByIdResponse {
  epic: EpicSummary;
  comments: EpicCommentSummary[];
  subEpics: EpicChildSummary[];
  parent?: EpicParentSummary;
}

export interface CreateEpicResponse {
  epic: EpicSummary;
}

export interface AddEpicCommentResponse {
  comment: EpicCommentSummary;
}

export interface UpdateEpicResponse {
  epic: EpicSummary;
}

// devchain_send_message
// Sender identity is derived from sessionId (ctx.agent).
// Allows:
// - threadId (agent replies into existing thread; recipients optional for fan-out)
// - recipientAgentNames (creates new agent-initiated injection if threadId omitted)
// - recipient: "user" (agent DMs the user without threadId)
export const SendMessageParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    threadId: z.string().uuid().optional(),
    recipientAgentNames: z.array(z.string().min(1)).optional(), // Target agents to message
    message: z.string().min(1),
    // Allow agent-initiated DM to user without threadId
    recipient: z.enum(['user', 'agents']).optional(),
  })
  .strict()
  .refine(
    (v) =>
      Boolean(
        v.threadId ||
          (v.recipientAgentNames && v.recipientAgentNames.length > 0) ||
          v.recipient === 'user',
      ),
    {
      message: 'Provide threadId, recipientAgentNames, or set { recipient: "user" } to DM the user',
    },
  );

export type SendMessageParams = z.infer<typeof SendMessageParamsSchema>;

export type SendMessageResponse =
  | {
      mode: 'pooled';
      queuedCount: number;
      queued: Array<{
        name: string;
        type: 'agent' | 'guest';
        status: 'queued' | 'launched' | 'delivered' | 'failed';
        error?: string;
      }>;
      estimatedDeliveryMs: number;
    }
  | {
      mode: 'thread';
      threadId: string;
      messageId: string;
      deliveryCount: number;
      delivered: Array<{
        agentName: string;
        agentId: string;
        sessionId: string;
        status: 'delivered' | 'queued' | 'failed';
        error?: string;
      }>;
    };

// devchain_chat_ack
export const ChatAckParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID for agent identity
    thread_id: z.string().uuid(),
    message_id: z.string().uuid(),
  })
  .strict();

export type ChatAckParams = z.infer<typeof ChatAckParamsSchema>;

export interface ChatAckResponse {
  threadId: string;
  messageId: string;
  agentId: string;
  agentName: string;
  acknowledged: boolean;
}

// devchain_chat_read_history
export const ChatReadHistoryParamsSchema = z
  .object({
    thread_id: z.string().uuid(),
    limit: z.number().int().positive().max(200).optional(),
    since: z.string().datetime().optional(),
    // When undefined, service defaults to true (exclude system messages)
    exclude_system: z.boolean().optional(),
  })
  .strict();

export type ChatReadHistoryParams = z.infer<typeof ChatReadHistoryParamsSchema>;

export const ChatHistoryMessageSchema = z.object({
  id: z.string().uuid(),
  author_type: z.enum(['user', 'agent', 'system']),
  author_agent_id: z.string().uuid().nullable(),
  author_agent_name: z.string().nullable().optional(),
  content: z.string(),
  created_at: z.string().datetime(),
  targets: z.array(z.string().uuid()).optional(),
  target_agent_names: z.array(z.string()).optional(),
});

export const ChatHistoryThreadSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
});

export const ChatReadHistoryResponseSchema = z.object({
  thread: ChatHistoryThreadSchema,
  messages: z.array(ChatHistoryMessageSchema),
  has_more: z.boolean(),
});

export type ChatReadHistoryResponse = z.infer<typeof ChatReadHistoryResponseSchema>;

// devchain_chat_list_members
export const ChatListMembersParamsSchema = z
  .object({
    thread_id: z.string().uuid(),
  })
  .strict();

export type ChatListMembersParams = z.infer<typeof ChatListMembersParamsSchema>;

export const ChatThreadMemberSchema = z.object({
  agent_id: z.string().uuid(),
  agent_name: z.string(),
  online: z.boolean(),
});

export const ChatListMembersResponseSchema = z.object({
  thread: ChatHistoryThreadSchema,
  members: z.array(ChatThreadMemberSchema),
  total: z.number().int().nonnegative(),
});

export type ChatListMembersResponse = z.infer<typeof ChatListMembersResponseSchema>;

// devchain_activity_start
export const ActivityStartParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix) - agent resolved from session
    title: z.string().min(1).max(256),
    threadId: z.string().uuid().optional(),
    announce: z.boolean().optional().default(true),
  })
  .strict();

export type ActivityStartParams = z.infer<typeof ActivityStartParamsSchema>;

export const ActivityStartResponseSchema = z.object({
  activity_id: z.string().uuid(),
  thread_id: z.string().uuid(),
  start_message_id: z.string().uuid().nullable(),
  started_at: z.string().datetime(),
  auto_finished_prior: z.boolean().optional().default(false),
});
export type ActivityStartResponse = z.infer<typeof ActivityStartResponseSchema>;

// devchain_activity_finish
export const ActivityFinishParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix) - agent resolved from session
    threadId: z.string().uuid().optional(),
    message: z.string().max(1000).optional(),
    status: z.enum(['success', 'failed', 'canceled']).optional(),
  })
  .strict();

export type ActivityFinishParams = z.infer<typeof ActivityFinishParamsSchema>;

export const ActivityFinishResponseSchema = z.object({
  activity_id: z.string().uuid(),
  thread_id: z.string().uuid(),
  finish_message_id: z.string().uuid().nullable(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  status: z.enum(['success', 'failed', 'canceled', 'running']),
});
export type ActivityFinishResponse = z.infer<typeof ActivityFinishResponseSchema>;

// devchain_list_sessions
export interface SessionSummary {
  sessionIdShort: string; // Only expose 8-char prefix for security
  agentName: string;
  projectName: string;
  status: string;
  startedAt: string;
}

export interface ListSessionsResponse {
  sessions: SessionSummary[];
}

// Secure tmuxSessionId validation - prevents command injection
// Only allows alphanumeric, dash, underscore, and period (common tmux session name chars)
const TMUX_SESSION_ID_REGEX = /^[a-zA-Z0-9_.-]+$/;
const TMUX_SESSION_ID_MAX_LENGTH = 128;

export const TmuxSessionIdSchema = z
  .string()
  .min(1, 'tmuxSessionId is required')
  .max(
    TMUX_SESSION_ID_MAX_LENGTH,
    `tmuxSessionId must be at most ${TMUX_SESSION_ID_MAX_LENGTH} characters`,
  )
  .regex(
    TMUX_SESSION_ID_REGEX,
    'tmuxSessionId must only contain alphanumeric characters, dashes, underscores, or periods',
  );

// devchain_register_guest (bootstrap tool - no sessionId required)
export const RegisterGuestParamsSchema = z
  .object({
    name: z.string().min(1),
    tmuxSessionId: TmuxSessionIdSchema,
    description: z.string().optional(),
  })
  .strict();

export type RegisterGuestParams = z.infer<typeof RegisterGuestParamsSchema>;

export interface RegisterGuestResponse {
  guestId: string;
  name: string;
  projectId: string;
  projectName: string;
  isSandbox: boolean;
  registeredAt: string;
}

// resolveSessionContext - discriminated union for agent and guest contexts
export interface AgentSessionContext {
  type: 'agent';
  session: {
    id: string;
    agentId: string | null;
    status: string;
    startedAt: string;
  };
  agent: {
    id: string;
    name: string;
    projectId: string;
  } | null;
  project: {
    id: string;
    name: string;
    rootPath: string;
  } | null;
}

export interface GuestSessionContext {
  type: 'guest';
  guest: {
    id: string;
    name: string;
    projectId: string;
    tmuxSessionId: string;
  };
  project: {
    id: string;
    name: string;
    rootPath: string;
  };
}

export type SessionContext = AgentSessionContext | GuestSessionContext;

// Legacy SessionContext for backwards compatibility (agent context)
export interface LegacySessionContext {
  session: {
    id: string;
    agentId: string | null;
    status: string;
    startedAt: string;
  };
  agent: {
    id: string;
    name: string;
    projectId: string;
  } | null;
  project: {
    id: string;
    name: string;
    rootPath: string;
  } | null;
}

// ============================================
// Review MCP Tools
// ============================================

// devchain_list_reviews
export const ListReviewsParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    status: z.enum(['draft', 'pending', 'changes_requested', 'approved', 'closed']).optional(),
    epicId: z.string().uuid().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ListReviewsParams = z.infer<typeof ListReviewsParamsSchema>;

export interface ReviewSummary {
  id: string;
  title: string;
  description: string | null;
  status: 'draft' | 'pending' | 'changes_requested' | 'approved' | 'closed';
  baseRef: string;
  headRef: string;
  baseSha: string | null;
  headSha: string | null;
  epicId: string | null;
  createdBy: 'user' | 'agent';
  createdByAgentId: string | null;
  version: number;
  commentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ListReviewsResponse {
  reviews: ReviewSummary[];
  total: number;
  limit: number;
  offset: number;
}

// devchain_get_review
export const GetReviewParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    reviewId: z.string().uuid(),
  })
  .strict();

export type GetReviewParams = z.infer<typeof GetReviewParamsSchema>;

export interface ChangedFileSummary {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
  oldPath?: string;
}

export interface ReviewCommentSummary {
  id: string;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  side: 'left' | 'right' | null;
  content: string;
  commentType: 'comment' | 'suggestion' | 'issue' | 'approval';
  status: 'open' | 'resolved' | 'wont_fix';
  authorType: 'user' | 'agent';
  authorAgentId: string | null;
  authorAgentName?: string;
  parentId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GetReviewResponse {
  review: ReviewSummary;
  changedFiles: ChangedFileSummary[];
  comments: ReviewCommentSummary[];
}

// devchain_get_review_comments
export const GetReviewCommentsParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    reviewId: z.string().uuid(),
    status: z.enum(['open', 'resolved', 'wont_fix']).optional(),
    filePath: z.string().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type GetReviewCommentsParams = z.infer<typeof GetReviewCommentsParamsSchema>;

export interface GetReviewCommentsResponse {
  comments: ReviewCommentSummary[];
  total: number;
  limit: number;
  offset: number;
}

// devchain_reply_comment
export const ReplyCommentParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    reviewId: z.string().uuid(),
    parentCommentId: z.string().uuid().optional(),
    content: z.string().min(1),
    filePath: z.string().optional(),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
    commentType: z.enum(['comment', 'suggestion', 'issue', 'approval']).optional(),
    targetAgentIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

export type ReplyCommentParams = z.infer<typeof ReplyCommentParamsSchema>;

export interface ReplyCommentResponse {
  comment: ReviewCommentSummary;
}

// devchain_resolve_comment
export const ResolveCommentParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    commentId: z.string().uuid(),
    resolution: z.enum(['resolved', 'wont_fix']).optional().default('resolved'),
    version: z.number().int().positive(),
  })
  .strict();

export type ResolveCommentParams = z.infer<typeof ResolveCommentParamsSchema>;

export interface ResolveCommentResponse {
  comment: ReviewCommentSummary;
}

// devchain_apply_suggestion
export const ApplySuggestionParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    commentId: z.string().uuid(),
    version: z.number().int().positive(),
  })
  .strict();

export type ApplySuggestionParams = z.infer<typeof ApplySuggestionParamsSchema>;

export interface ApplySuggestionResponse {
  comment: ReviewCommentSummary;
  applied: {
    filePath: string;
    lineStart: number;
    lineEnd: number;
    suggestedCode: string;
  };
}
