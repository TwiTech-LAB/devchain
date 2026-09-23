import { z } from 'zod';
import { SkillSlugSchema, SkillsRequiredInputSchema } from '../../skills/dtos/skill.dto';
import type { SyncResult } from '../../skills/services/skill-sync.types';

/**
 * MCP Tool Request schemas
 */

// Shared schema for epic ID fields that accept a full UUID or an 8–36 char hex prefix.
// Constrains input to UUID-safe characters (hex digits + hyphens) to prevent SQL LIKE
// wildcard injection and enforce true UUID-prefix semantics at the validation layer.
const EpicIdPrefixSchema = z
  .string()
  .min(8)
  .max(36)
  .regex(/^[a-f0-9-]+$/, 'Epic ID prefix must contain only hex characters and hyphens');

const EpicRelationTypeSchema = z.enum(['related', 'blocks', 'blocked_by']);
const EpicRelationInputSchema = z
  .object({
    relatedEpicId: EpicIdPrefixSchema,
    relation: EpicRelationTypeSchema,
  })
  .strict();

export const PROJECT_ID_PREFIX_PATTERN =
  /^(?:[a-fA-F0-9]{8}|[a-fA-F0-9]{8}-[a-fA-F0-9]{1,4}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{1,4}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{1,4}|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{1,12})$/;

const ProjectIdPrefixSchema = z
  .string()
  .regex(
    PROJECT_ID_PREFIX_PATTERN,
    'Project ID must be a full UUID or a valid 8+ character UUID prefix',
  );

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
    includeDescription: z.boolean().optional(),
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
    relation: EpicRelationInputSchema.optional(),
    relations: z.array(EpicRelationInputSchema).min(1).max(20).optional(),
  })
  .strict()
  .refine((data) => !(data.relation && data.relations), {
    message: 'Cannot specify both relation and relations',
    path: ['relation'],
  });

export type CreateEpicParams = z.infer<typeof CreateEpicParamsSchema>;

// devchain_get_epic_by_id
export const GetEpicByIdParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    id: EpicIdPrefixSchema, // Epic UUID or 8+ char hex prefix
    includeParentDescription: z.boolean().optional(),
  })
  .strict();

export type GetEpicByIdParams = z.infer<typeof GetEpicByIdParamsSchema>;

// devchain_epic_relations_list
export const EpicRelationsListParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    epicId: EpicIdPrefixSchema,
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type EpicRelationsListParams = z.infer<typeof EpicRelationsListParamsSchema>;

// devchain_epic_relations_list_candidates
export const EpicRelationCandidatesListParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    epicId: EpicIdPrefixSchema,
    q: z.string().trim().max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type EpicRelationCandidatesListParams = z.infer<
  typeof EpicRelationCandidatesListParamsSchema
>;

// devchain_epic_relations_set
// For relation=related, the write's endpoint order defines direction: epicId
// is the source and relatedEpicId is the target. blocks and blocked_by stay
// focal-relative to the first address.
export const EpicRelationsSetParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    epicId: EpicIdPrefixSchema,
    relatedEpicId: EpicIdPrefixSchema,
    relation: EpicRelationTypeSchema,
  })
  .strict();

export type EpicRelationsSetParams = z.infer<typeof EpicRelationsSetParamsSchema>;

// devchain_epic_relations_delete
export const EpicRelationsDeleteParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    epicId: EpicIdPrefixSchema,
    relatedEpicId: EpicIdPrefixSchema,
  })
  .strict();

export type EpicRelationsDeleteParams = z.infer<typeof EpicRelationsDeleteParamsSchema>;

// devchain_add_epic_comment
// Author identity is derived from sessionId (ctx.agent.name)
export const AddEpicCommentParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    epicId: EpicIdPrefixSchema, // Epic UUID or 8+ char hex prefix
    content: z.string().min(1),
  })
  .strict();

export type AddEpicCommentParams = z.infer<typeof AddEpicCommentParamsSchema>;

// devchain_update_epic
// Literal find/replace edit for patch-style description changes; `find` must
// occur exactly once in the current description when the edit is applied.
export const EpicDescriptionEditInputSchema = z
  .object({
    find: z.string().min(1),
    replace: z.string(),
  })
  .strict();

export type EpicDescriptionEditInput = z.infer<typeof EpicDescriptionEditInputSchema>;

export const UpdateEpicParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    id: EpicIdPrefixSchema, // Epic UUID or 8+ char hex prefix
    version: z.number().int().positive(),
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    descriptionEdits: z.array(EpicDescriptionEditInputSchema).min(1).max(50).optional(),
    appendDescription: z.string().min(1).optional(),
    statusName: z.string().min(1).optional(),
    assignment: z
      .preprocess(
        (value) => {
          if (typeof value === 'string') {
            try {
              return JSON.parse(value);
            } catch {
              return value;
            }
          }
          return value;
        },
        z.union([
          z.object({ agentName: z.string().min(1) }).strict(),
          z.object({ clear: z.literal(true) }).strict(),
        ]),
      )
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
  })
  .refine(
    (data) =>
      !(
        data.description !== undefined &&
        (data.descriptionEdits !== undefined || data.appendDescription !== undefined)
      ),
    {
      message: 'Cannot specify description together with descriptionEdits or appendDescription',
      path: ['description'],
    },
  );

export type UpdateEpicParams = z.infer<typeof UpdateEpicParamsSchema>;

// devchain_delete_epic
export const DeleteEpicParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    id: EpicIdPrefixSchema, // Epic UUID or 8+ char hex prefix
  })
  .strict();

export type DeleteEpicParams = z.infer<typeof DeleteEpicParamsSchema>;

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
    includeDisabled: z.boolean().optional(),
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

// devchain_skills_usage_stats
export const skillsUsageStatsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

export const SkillsUsageStatsParamsSchema = skillsUsageStatsSchema;
export type SkillsUsageStatsParams = z.infer<typeof skillsUsageStatsSchema>;

// devchain_skills_set_enabled
export const skillsSetEnabledSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    slugs: z.array(SkillSlugSchema).min(1).max(200),
    enabled: z.boolean(),
  })
  .strict();

export const SkillsSetEnabledParamsSchema = skillsSetEnabledSchema;
export type SkillsSetEnabledParams = z.infer<typeof skillsSetEnabledSchema>;

// devchain_skills_set_source_enabled
export const skillsSetSourceEnabledSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    sourceName: z.string().min(1),
    enabled: z.boolean(),
  })
  .strict();

export const SkillsSetSourceEnabledParamsSchema = skillsSetSourceEnabledSchema;
export type SkillsSetSourceEnabledParams = z.infer<typeof skillsSetSourceEnabledSchema>;

// devchain_skills_sync
export const skillsSyncSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    sourceName: z.string().min(1).optional(),
  })
  .strict();

export const SkillsSyncParamsSchema = skillsSyncSchema;
export type SkillsSyncParams = z.infer<typeof skillsSyncSchema>;

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
  version: number;
}

export interface UpdateRecordResponse {
  id: string;
  version: number;
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
  version: number;
}

export interface RemoveTagsResponse {
  id: string;
  version: number;
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
 * Full prompt details including content; no preview — the full text is here.
 */
export interface PromptDetail extends Omit<PromptSummary, 'contentPreview'> {
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
  /** Present only when listing with includeDisabled: true. Effective state: any of the three blocks below applies. */
  disabled?: boolean;
  /** Present only when listing with includeDisabled: true. The project disabled this skill. */
  skillDisabled?: boolean;
  /** Present only when listing with includeDisabled: true. The project enables the skill's source (default true). */
  sourceProjectEnabled?: boolean;
  /** Present only when listing with includeDisabled: true. Settings enable the skill's source (default true). */
  sourceGloballyEnabled?: boolean;
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

export interface SkillsUsageStatsSummaryDto {
  totalEvents: number;
  distinctSkills: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
}

export interface SkillUsageStatItem {
  slug: string;
  name: string | null;
  displayName: string | null;
  usageCount: number;
  firstAccessedAt: string | null;
  lastAccessedAt: string | null;
}

export interface SkillEpicReferenceItem {
  slug: string;
  total: number;
  byStatus: Record<string, number>;
}

export interface SkillsUsageStatsResponse {
  summary: SkillsUsageStatsSummaryDto;
  /** Always true: every used skill of the project is present; a missing slug means zero use. */
  complete: true;
  skills: SkillUsageStatItem[];
  /** Current epic requirements; never filtered by from/to. */
  epicReferences: SkillEpicReferenceItem[];
}

/**
 * Changed slugs are not echoed: they are the requested slugs minus
 * `unchanged` and `notFound`, so a large batch returns only its exceptions.
 */
export interface SkillsSetEnabledResponse {
  /** Number of slugs whose skill-level enablement state changed. */
  updatedCount: number;
  /** Normalized slugs already in the requested skill-level state. */
  unchanged: string[];
  /** Normalized slugs that do not exist or whose source is disabled globally. */
  notFound: string[];
}

export interface SkillsSetSourceEnabledResponse {
  name: string;
  projectId: string;
  projectEnabled: boolean;
}

/**
 * Mirrors SkillSourceLifecycleService's SyncResult so devchain_skills_sync
 * returns the lifecycle result unchanged.
 */
export type SkillsSyncResponse = SyncResult;

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
    providerConfigId: string | null;
    providerConfigName: string | null;
    teams: Array<{
      teamId: string;
      teamName: string;
      isLead: boolean;
    }>;
    presence: {
      online: boolean;
      activityState: 'idle' | 'busy' | null;
      lastActivityAt: string | null;
      busySince: string | null;
      idleSince: string | null;
      currentActivityTitle: string | null;
    } | null;
    assignedEpics: {
      items: Array<{
        id: string;
        parentId: string | null;
        title: string;
        status: string;
      }>;
      total: number;
    };
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
  createdBy: string | null;
  version: number; // Required for optimistic locking in updates
  // Optional resolved status name for convenience without returning full status metadata
  status?: string;
  agentName?: string | null;
  parentId?: string | null;
  // Optional tags for filtering/categorization
  tags?: string[];
  // Optional required skill slugs attached to this epic
  skillsRequired?: string[];
  // Optional nested sub-epics for hierarchical list response
  subEpics?: EpicChildSummary[];
}

/**
 * Item of devchain_list_epics. By default the description ships as a bounded
 * preview plus the full length; `includeDescription: true` returns the full
 * `description` instead of the preview fields.
 */
export type EpicListItem = Omit<EpicSummary, 'description'> & {
  description?: string | null;
  descriptionPreview?: string | null;
  /** Length of the full description. */
  descriptionLength?: number;
};

export interface ListEpicsResponse {
  epics: EpicListItem[];
  total: number;
  limit: number;
  offset: number;
}

/** devchain_list_assigned_epics_tasks keeps full descriptions per item. */
export interface ListAssignedEpicsTasksResponse {
  epics: EpicSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface EpicChildSummary {
  id: string;
  title: string;
  // Optional resolved status name to avoid extra lookups
  status?: string;
}

/**
 * Parent projection of devchain_get_epic_by_id: a summary by default; the
 * full `description` ships only with `includeParentDescription: true`.
 */
export interface EpicParentSummary {
  id: string;
  title: string;
  /** Present only with includeParentDescription: true. */
  description?: string | null;
  /** Resolved status label. */
  status?: string;
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
  relations: EpicRelationsPageResponse & { truncated: boolean };
}

export interface CreateEpicResponse {
  id: string;
  version: number;
}

export interface AddEpicCommentResponse {
  id: string;
}

export interface UpdateEpicResponse {
  id: string;
  version: number;
  hint?: string;
  /**
   * Present only when descriptionEdits ran: context around each replacement,
   * taken from the final description, so no re-read is needed.
   */
  descriptionEdits?: Array<{ index: number; context: string }>;
  /** Present only when appendDescription ran: junction context of the append. */
  appended?: { context: string };
  /** Length of the final description; present when edits or an append ran. */
  descriptionLength?: number;
}

export interface DeleteEpicResponse {
  id: string;
  deleted: true;
}

export interface EpicRelationTargetSummary {
  id: string;
  shortId: string;
  title: string;
  status: { id: string; label: string; color: string };
  project: { id: string; name: string };
}

export interface EpicRelationSummary {
  relationId: string;
  relation: 'related' | 'blocks' | 'blocked_by';
  /**
   * Semantic source and target derived from the stored canonical direction.
   * Null marks a legacy neutral row (direction 'none') with no semantic
   * direction.
   */
  sourceEpicId: string | null;
  targetEpicId: string | null;
  relatedEpic: EpicRelationTargetSummary;
  createdAt: string;
  updatedAt: string;
}

export interface EpicRelationCandidateSummary extends EpicRelationTargetSummary {
  parentId: string | null;
}

export interface EpicRelationsPageResponse {
  items: EpicRelationSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface EpicRelationCandidatesPageResponse {
  items: EpicRelationCandidateSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface EpicRelationMutationResponse {
  epicId: string;
  relatedEpicId: string;
  relation: 'related' | 'blocks' | 'blocked_by';
  sourceEpicId: string | null;
  targetEpicId: string | null;
}

export interface DeleteEpicRelationResponse {
  epicId: string;
  relatedEpicId: string;
  deleted: boolean;
}

// devchain_send_message
// Sender identity is derived from sessionId (ctx.agent).
// Allows:
// - recipientAgentNames (pooled terminal delivery to explicit agents)
// - teamName (pooled team routing; handler logic resolved separately)
// - recipientProjectId (delivery to the target project's current Project Owner)
export const SendMessageParamsSchema = z
  .object({
    sessionId: z.string().min(8), // Session ID (full UUID or 8+ char prefix)
    recipientAgentNames: z.array(z.string().min(1)).min(1).optional(), // Target agents to message
    teamName: z.string().min(1).optional(),
    recipientProjectId: ProjectIdPrefixSchema.optional(),
    message: z.string().min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasRecipientAgentNames = Boolean(
      v.recipientAgentNames && v.recipientAgentNames.length > 0,
    );

    if (v.recipientProjectId) {
      const conflictingFields = [
        hasRecipientAgentNames ? 'recipientAgentNames' : null,
        v.teamName ? 'teamName' : null,
      ].filter((field): field is string => field !== null);

      if (conflictingFields.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['recipientProjectId'],
          message: `recipientProjectId cannot be combined with ${conflictingFields.join(', ')}`,
        });
      }
    }

    if (v.teamName && hasRecipientAgentNames) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['teamName'],
        message: 'teamName and recipientAgentNames are mutually exclusive',
      });
    }

    // All routing fields absent is allowed (self-team fallback in handler).
  });

export type SendMessageParams = z.infer<typeof SendMessageParamsSchema>;

export type SendMessageResponse =
  | {
      mode: 'pooled';
      queuedCount: number;
      queued: Array<{
        name: string;
        type: 'agent' | 'guest';
        status: 'queued' | 'launched' | 'delivered' | 'unconfirmed' | 'failed';
        error?: string;
      }>;
      estimatedDeliveryMs: number;
      teamDelivery?: {
        teamName: string;
        recipientCount: number;
        routedToLead: boolean;
        summary: string;
      };
    }
  | {
      mode: 'project';
      targetProject: {
        id: string;
        shortId: string;
        name: string;
      };
      deliveryStatus: 'queued' | 'delivered' | 'failed' | 'unconfirmed' | 'partial';
      error?: {
        code: string;
        message: string;
      };
    };

// devchain_projects_list
export const ProjectsListParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    limit: z.number().int().min(1).max(100).default(100),
    offset: z.number().int().nonnegative().default(0),
  })
  .strict();

export type ProjectsListParams = z.infer<typeof ProjectsListParamsSchema>;

export interface ProjectsListResponse {
  projects: Array<{
    id: string;
    shortId: string;
    name: string;
    description: string | null;
    hasProjectOwner: boolean;
  }>;
  total: number;
  limit: number;
  offset: number;
}

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
// Team MCP Tools
// ============================================

// devchain_teams_list
export const TeamsListParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    q: z.string().optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type TeamsListParams = z.infer<typeof TeamsListParamsSchema>;

export interface TeamSummary {
  id: string;
  name: string;
  description: string | null;
  teamLeadAgentId: string | null;
  teamLeadName: string | null;
  memberCount: number;
}

export interface ListTeamsResponse {
  teams: TeamSummary[];
  total: number;
  limit: number;
  offset: number;
}

// devchain_teams_members_list
export const TeamsMembersListParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    teamId: z.string().uuid().optional(),
  })
  .strict();

export type TeamsMembersListParams = z.infer<typeof TeamsMembersListParamsSchema>;

export interface TeamMemberSummary {
  agentId: string;
  agentName: string;
  isTeamLead: boolean;
}

export interface TeamMembersEntry {
  teamId: string;
  teamName: string;
  members: TeamMemberSummary[];
}

export interface ListTeamMembersResponse {
  teams: TeamMembersEntry[];
}

// devchain_teams_configs_list
export const TeamsConfigsListParamsSchema = z
  .object({
    sessionId: z.string().min(8),
  })
  .strict();

export type TeamsConfigsListParams = z.infer<typeof TeamsConfigsListParamsSchema>;

export interface TeamsConfigsListEntry {
  configName: string;
  description: string | null;
  profileName: string;
  teamName: string;
}

export interface TeamsConfigsListResponse {
  configs: TeamsConfigsListEntry[];
}

// devchain_teams_create_agent
export const TeamsCreateAgentParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    name: z.string().trim().min(1, 'Name is required and must not be whitespace-only'),
    description: z.string().trim().min(1, 'Description must not be whitespace-only').optional(),
    configName: z.string().trim().min(1, 'configName is required and must not be whitespace-only'),
    profileName: z.string().trim().min(1, 'profileName must not be whitespace-only').optional(),
    teamName: z.string().trim().min(1, 'teamName must not be whitespace-only').optional(),
  })
  .strict();

export type TeamsCreateAgentParams = z.infer<typeof TeamsCreateAgentParamsSchema>;

export const TeamsDeleteAgentParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    name: z.string().trim().min(1, 'Name is required and must not be whitespace-only'),
    teamName: z.string().trim().min(1, 'teamName must not be whitespace-only').optional(),
  })
  .strict();

export type TeamsDeleteAgentParams = z.infer<typeof TeamsDeleteAgentParamsSchema>;

export interface TeamsDeleteAgentResponse {
  deletedAgentId: string;
  deleted: true;
}

export const DevchainTeamParamsSchema = z
  .object({
    sessionId: z.string().min(8),
    teamName: z.string().optional(),
  })
  .strict();

export type DevchainTeamParams = z.infer<typeof DevchainTeamParamsSchema>;

export interface DevchainTeamMemberProjection {
  agentId: string;
  agentName: string;
  description: string | null;
  isLead: boolean;
  profileId: string | null;
  profileName: string | null;
  providerConfigId: string | null;
  providerConfigName: string | null;
}

export interface DevchainTeamResponse {
  id: string;
  name: string;
  description: string | null;
  teamLeadAgentId: string | null;
  teamLeadAgentName: string | null;
  members: DevchainTeamMemberProjection[];
  maxMembers: number;
  maxConcurrentTasks: number;
  allowTeamLeadCreateAgents: boolean;
  currentMemberCount: number;
  busyMembersCount: number;
  freeSeats: number;
  freeConcurrentSlots: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamsCreateAgentResponse {
  agentId: string;
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
  id: string;
  version: number;
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
  id: string;
  version: number;
  status: 'open' | 'resolved' | 'wont_fix';
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
  commentId: string;
  version: number;
  applied: {
    filePath: string;
    lineStart: number;
    lineEnd: number;
  };
}
