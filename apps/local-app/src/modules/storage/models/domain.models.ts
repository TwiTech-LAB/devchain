// Domain models for the storage layer
// These represent the internal TypeScript models (camelCase)

export interface Project {
  id: string;
  name: string;
  description: string | null;
  rootPath: string;
  isTemplate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Status {
  id: string;
  projectId: string;
  label: string;
  color: string;
  position: number;
  mcpHidden: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Epic {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  statusId: string;
  parentId: string | null;
  agentId: string | null;
  version: number; // For optimistic locking
  data: Record<string, unknown> | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Prompt {
  id: string;
  projectId: string | null;
  title: string;
  content: string;
  version: number; // For optimistic locking
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  projectId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Provider {
  id: string;
  name: string; // 'claude', 'codex', etc.
  binPath: string | null; // path to provider binary
  mcpConfigured: boolean;
  mcpEndpoint: string | null;
  mcpRegisteredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderMcpMetadata {
  mcpConfigured: boolean;
  mcpEndpoint: string | null;
  mcpRegisteredAt: string | null;
}

export interface AgentProfile {
  id: string;
  projectId?: string | null;
  name: string;
  familySlug?: string | null; // Groups equivalent profiles across providers
  systemPrompt?: string | null;
  instructions?: string | null;
  temperature?: number | null;
  maxTokens?: number | null;
  createdAt: string;
  updatedAt: string;
  // Note: providerId and options removed in Phase 4
  // Provider configuration now lives in ProfileProviderConfig
}

export interface ProfileProviderConfig {
  id: string;
  profileId: string; // FK to agent_profiles.id
  providerId: string; // FK to providers.id
  name: string; // User-friendly name to distinguish configs (unique per profile)
  options: string | null; // JSON string for provider-specific options
  env: Record<string, string> | null; // Environment variables (stored as JSON)
  position: number; // Order within profile (0, 1, 2, ...)
  createdAt: string;
  updatedAt: string;
}

export interface Document {
  id: string;
  projectId: string | null;
  title: string;
  slug: string;
  contentMd: string;
  archived: boolean;
  version: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  projectId: string;
  profileId: string;
  providerConfigId: string; // FK to profile_provider_configs.id
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EpicRecord {
  id: string;
  epicId: string;
  type: string; // record type (e.g., 'note', 'decision', 'task')
  data: Record<string, unknown>; // JSON object
  tags: string[]; // array of tag names
  version: number; // For optimistic locking
  createdAt: string;
  updatedAt: string;
}

export interface EpicComment {
  id: string;
  epicId: string;
  authorName: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

// Create/Update DTOs (omit auto-generated fields)
export type CreateProject = Omit<Project, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateProject = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateStatus = Omit<Status, 'id' | 'mcpHidden' | 'createdAt' | 'updatedAt'> & {
  mcpHidden?: boolean;
};
export type UpdateStatus = Partial<Omit<Status, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateEpic = Omit<
  Epic,
  'id' | 'version' | 'createdAt' | 'updatedAt' | 'parentId' | 'agentId'
> & {
  parentId?: string | null;
  agentId?: string | null;
};
export type UpdateEpic = Partial<Omit<Epic, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreatePrompt = Omit<Prompt, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
export type UpdatePrompt = Partial<Omit<Prompt, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateTag = Omit<Tag, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateTag = Partial<Omit<Tag, 'id' | 'createdAt' | 'updatedAt'>>;

export interface CreateProvider extends Partial<ProviderMcpMetadata> {
  name: string;
  binPath?: string | null;
}
export type UpdateProvider = Partial<Omit<Provider, 'id' | 'createdAt' | 'updatedAt'>>;
export type UpdateProviderMcpMetadata = Partial<ProviderMcpMetadata>;

export type CreateAgentProfile = Omit<
  AgentProfile,
  'id' | 'createdAt' | 'updatedAt' | 'instructions' | 'familySlug'
> & {
  instructions?: string | null;
  familySlug?: string | null;
};
export type UpdateAgentProfile = Partial<Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateProfileProviderConfig = {
  profileId: string;
  providerId: string;
  name: string;
  options: string | null;
  env: Record<string, string> | null;
  position?: number; // Optional - defaults to max(position)+1 in storage service
};
export type UpdateProfileProviderConfig = Partial<
  Omit<ProfileProviderConfig, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>
>;

export type CreateDocument = Omit<
  Document,
  'id' | 'slug' | 'version' | 'archived' | 'tags' | 'createdAt' | 'updatedAt'
> & {
  slug?: string;
  tags?: string[];
};
export type UpdateDocument = Partial<Omit<Document, 'id' | 'createdAt' | 'updatedAt' | 'tags'>> & {
  tags?: string[];
};

export type CreateAgent = Omit<
  Agent,
  'id' | 'createdAt' | 'updatedAt' | 'description' | 'providerConfigId'
> & {
  description?: string | null;
  providerConfigId: string;
};
export type UpdateAgent = Partial<Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateEpicRecord = Omit<EpicRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
export type UpdateEpicRecord = Partial<Omit<EpicRecord, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateEpicComment = Omit<EpicComment, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateEpicComment = Partial<Omit<EpicComment, 'id' | 'createdAt' | 'updatedAt'>>;

// ============================================
// GUESTS - External agents registered via MCP
// ============================================

export interface Guest {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  tmuxSessionId: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateGuest = Omit<Guest, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateGuest = Partial<Pick<Guest, 'lastSeenAt'>>;

// ============================================
// TERMINAL WATCHERS
// ============================================

export interface TriggerCondition {
  type: 'contains' | 'regex' | 'not_contains';
  pattern: string;
  flags?: string;
}

export interface Watcher {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  scope: 'all' | 'agent' | 'profile' | 'provider';
  scopeFilterId: string | null;
  pollIntervalMs: number;
  viewportLines: number;
  condition: TriggerCondition;
  cooldownMs: number;
  cooldownMode: 'time' | 'until_clear';
  eventName: string;
  createdAt: string;
  updatedAt: string;
}

export type CreateWatcher = Omit<Watcher, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateWatcher = Partial<Omit<Watcher, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>;

// ============================================
// AUTOMATION SUBSCRIBERS
// ============================================

export interface ActionInput {
  source: 'event_field' | 'custom';
  eventField?: string;
  customValue?: string;
}

export interface EventFilter {
  field: string;
  operator: 'equals' | 'contains' | 'regex';
  value: string;
}

export interface Subscriber {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  eventName: string;
  eventFilter: EventFilter | null;
  actionType: string;
  actionInputs: Record<string, ActionInput>;
  delayMs: number;
  cooldownMs: number;
  retryOnError: boolean;
  // Grouping & ordering (for deterministic execution order)
  groupName: string | null; // Null means implicit group "event:<eventName>"
  position: number; // Order within group (lower first)
  priority: number; // Tie-break across groups (higher first)
  createdAt: string;
  updatedAt: string;
}

export type CreateSubscriber = Omit<Subscriber, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateSubscriber = Partial<
  Omit<Subscriber, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>
>;

// ============================================
// CODE REVIEWS
// ============================================

export type ReviewStatus = 'draft' | 'pending' | 'changes_requested' | 'approved' | 'closed';
export type ReviewMode = 'working_tree' | 'commit';
export type ReviewCommentStatus = 'open' | 'resolved' | 'wont_fix';
export type ReviewCommentType = 'comment' | 'suggestion' | 'issue' | 'approval';
export type AuthorType = 'user' | 'agent';
export type DiffSide = 'left' | 'right';

export interface Review {
  id: string;
  projectId: string;
  epicId: string | null;
  title: string;
  description: string | null;
  status: ReviewStatus;
  mode: ReviewMode;
  baseRef: string; // e.g., 'main', 'develop', 'HEAD'
  headRef: string; // e.g., 'feature/my-branch', 'HEAD'
  baseSha: string | null; // SHA at time of review creation (null for working_tree mode)
  headSha: string | null; // SHA at time of review creation (null for working_tree mode)
  createdBy: AuthorType;
  createdByAgentId: string | null;
  version: number; // For optimistic locking
  commentCount?: number; // Eager loaded count
  createdAt: string;
  updatedAt: string;
}

export interface ReviewComment {
  id: string;
  reviewId: string;
  filePath: string | null; // null for general review comments
  parentId: string | null; // null for top-level comments, references self for threads
  lineStart: number | null; // starting line number
  lineEnd: number | null; // ending line number
  side: DiffSide | null; // 'left' | 'right' (left=base, right=head)
  content: string;
  commentType: ReviewCommentType;
  status: ReviewCommentStatus;
  authorType: AuthorType;
  authorAgentId: string | null;
  version: number; // For optimistic locking
  editedAt: string | null; // timestamp of last edit, null if never edited
  createdAt: string;
  updatedAt: string;
}

export interface ReviewCommentTarget {
  id: string;
  commentId: string;
  agentId: string;
  createdAt: string;
}

/** Target agent with resolved name */
export interface ReviewCommentTargetAgent {
  agentId: string;
  name: string;
}

/** ReviewComment enriched with resolved agent names and targets (for list queries) */
export interface ReviewCommentEnriched extends ReviewComment {
  /** Agent name for agent-authored comments (null if user-authored or agent deleted) */
  authorAgentName: string | null;
  /** Target agents with resolved names */
  targetAgents: ReviewCommentTargetAgent[];
}

export type CreateReview = Omit<
  Review,
  'id' | 'version' | 'commentCount' | 'createdAt' | 'updatedAt'
>;
export type UpdateReview = Partial<Pick<Review, 'title' | 'description' | 'status' | 'headSha'>>;

export type CreateReviewComment = Omit<
  ReviewComment,
  'id' | 'version' | 'editedAt' | 'createdAt' | 'updatedAt'
>;
export type UpdateReviewComment = Partial<Pick<ReviewComment, 'content' | 'status'>>;

export type CreateReviewCommentTarget = Omit<ReviewCommentTarget, 'id' | 'createdAt'>;
