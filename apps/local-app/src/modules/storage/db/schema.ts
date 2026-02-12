import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  unique,
  uniqueIndex,
  index,
  foreignKey,
} from 'drizzle-orm/sqlite-core';

// Projects
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  rootPath: text('root_path').notNull(),
  isTemplate: integer('is_template', { mode: 'boolean' }).notNull().default(false),
  isPrivate: integer('is_private', { mode: 'boolean' }).default(false),
  ownerUserId: text('owner_user_id'), // Optional, for cloud mode
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Statuses (Kanban columns)
export const statuses = sqliteTable(
  'statuses',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    color: text('color').notNull(),
    position: integer('position').notNull(),
    mcpHidden: integer('mcp_hidden', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    projectPositionIdx: uniqueIndex('statuses_project_position_idx').on(
      table.projectId,
      table.position,
    ),
  }),
);

// Providers (AI provider configurations)
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(), // 'claude', 'codex', etc.
  binPath: text('bin_path'), // path to provider binary, null if not configured
  mcpConfigured: integer('mcp_configured', { mode: 'boolean' }).notNull().default(false),
  mcpEndpoint: text('mcp_endpoint'),
  mcpRegisteredAt: text('mcp_registered_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Agent Profiles
// Note: providerId and options columns removed in migration 0031
// Provider configuration now lives in profile_provider_configs table
export const agentProfiles = sqliteTable(
  'agent_profiles',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = global (backfill)
    name: text('name').notNull(),
    familySlug: text('family_slug'), // Groups equivalent profiles across providers
    systemPrompt: text('system_prompt'),
    instructions: text('instructions'),
    temperature: integer('temperature'), // stored as integer, divide by 100 when using
    maxTokens: integer('max_tokens'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    projectNameUnique: uniqueIndex('agent_profiles_project_name_unique').on(
      table.projectId,
      table.name,
    ),
    // Ensure unique family_slug per project (profiles are now provider-independent)
    familyUnique: uniqueIndex('agent_profiles_family_unique')
      .on(table.projectId, table.familySlug)
      .where(sql`${table.familySlug} IS NOT NULL`),
  }),
);

// Profile Provider Configs (multiple provider configurations per profile)
export const profileProviderConfigs = sqliteTable(
  'profile_provider_configs',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => agentProfiles.id, { onDelete: 'cascade' }),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    name: text('name').notNull(), // User-friendly name to distinguish configs
    options: text('options'), // JSON string for provider-specific options
    env: text('env'), // JSON string for environment variables
    position: integer('position').notNull().default(0), // Order within profile
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    profileIdIdx: index('profile_provider_configs_profile_id_idx').on(table.profileId),
    providerIdIdx: index('profile_provider_configs_provider_id_idx').on(table.providerId),
    profileNameUnique: uniqueIndex('profile_provider_configs_profile_name_idx').on(
      table.profileId,
      table.name,
    ),
    profilePositionUnique: uniqueIndex('profile_provider_configs_profile_position_idx').on(
      table.profileId,
      table.position,
    ),
  }),
);

// Agents (project-specific instances)
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  profileId: text('profile_id')
    .notNull()
    .references(() => agentProfiles.id),
  providerConfigId: text('provider_config_id')
    .notNull()
    .references(() => profileProviderConfigs.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Epics (work items)
export const epics = sqliteTable(
  'epics',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    statusId: text('status_id')
      .notNull()
      .references(() => statuses.id),
    parentId: text('parent_id'),
    agentId: text('agent_id'),
    version: integer('version').notNull().default(1),
    data: text('data', { mode: 'json' }), // JSON object
    skillsRequired: text('skills_required'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    parentIdIdx: index('epics_parent_id_idx').on(table.parentId),
    agentIdIdx: index('epics_agent_id_idx').on(table.agentId),
    parentFk: foreignKey(() => ({
      columns: [table.parentId],
      foreignColumns: [table.id],
      onDelete: 'set null',
      name: 'epics_parent_id_fk',
    })),
    agentFk: foreignKey(() => ({
      columns: [table.agentId],
      foreignColumns: [agents.id],
      onDelete: 'set null',
      name: 'epics_agent_id_fk',
    })),
  }),
);

// Skills (catalog of installed/available skills)
export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    shortDescription: text('short_description'),
    source: text('source').notNull(),
    sourceUrl: text('source_url'),
    sourceCommit: text('source_commit'),
    category: text('category'),
    license: text('license'),
    compatibility: text('compatibility'),
    frontmatter: text('frontmatter'), // JSON string
    instructionContent: text('instruction_content'),
    contentPath: text('content_path'),
    resources: text('resources'), // JSON string
    status: text('status').notNull().default('available'), // available | outdated | sync_error
    lastSyncedAt: text('last_synced_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    slugUnique: uniqueIndex('skills_slug_unique').on(table.slug),
    sourceIdx: index('skills_source_idx').on(table.source),
    categoryIdx: index('skills_category_idx').on(table.category),
    statusIdx: index('skills_status_idx').on(table.status),
  }),
);

// Community skill sources (user-defined GitHub repositories)
export const communitySkillSources = sqliteTable(
  'community_skill_sources',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    repoOwner: text('repo_owner').notNull(),
    repoName: text('repo_name').notNull(),
    branch: text('branch').notNull().default('main'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    uniqueRepo: unique().on(table.repoOwner, table.repoName),
  }),
);

// Skill-Project disabled mapping (exclude specific skills per project)
export const skillProjectDisabled = sqliteTable(
  'skill_project_disabled',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    projectSkillUnique: uniqueIndex('skill_project_disabled_project_skill_unique').on(
      table.projectId,
      table.skillId,
    ),
  }),
);

// Skill usage logs (tracking by project/agent and time)
export const skillUsageLog = sqliteTable(
  'skill_usage_log',
  {
    id: text('id').primaryKey(),
    skillId: text('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    skillSlug: text('skill_slug').notNull(),
    projectId: text('project_id'),
    agentId: text('agent_id'),
    agentNameSnapshot: text('agent_name_snapshot'),
    accessedAt: text('accessed_at').notNull(),
  },
  (table) => ({
    skillIdIdx: index('skill_usage_log_skill_id_idx').on(table.skillId),
    projectIdIdx: index('skill_usage_log_project_id_idx').on(table.projectId),
    accessedAtIdx: index('skill_usage_log_accessed_at_idx').on(table.accessedAt),
  }),
);

// Tags
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = global
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const documents = sqliteTable(
  'documents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = global
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    contentMd: text('content_md').notNull(),
    version: integer('version').notNull().default(1),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    projectSlugUnique: uniqueIndex('documents_project_slug_unique').on(table.projectId, table.slug),
  }),
);

export const documentTags = sqliteTable('document_tags', {
  documentId: text('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),
});

// Epic-Tag junction
export const epicTags = sqliteTable('epic_tags', {
  epicId: text('epic_id')
    .notNull()
    .references(() => epics.id, { onDelete: 'cascade' }),
  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
});

// Prompts
export const prompts = sqliteTable('prompts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = global
  title: text('title').notNull(),
  content: text('content').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Prompt-Tag junction
export const promptTags = sqliteTable('prompt_tags', {
  promptId: text('prompt_id')
    .notNull()
    .references(() => prompts.id, { onDelete: 'cascade' }),
  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
});

// Agent Profile-Prompt junction
export const agentProfilePrompts = sqliteTable('agent_profile_prompts', {
  profileId: text('profile_id')
    .notNull()
    .references(() => agentProfiles.id, { onDelete: 'cascade' }),
  promptId: text('prompt_id')
    .notNull()
    .references(() => prompts.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
});

// Records (typed JSON data for epics, with tags)
export const records = sqliteTable('records', {
  id: text('id').primaryKey(),
  epicId: text('epic_id')
    .notNull()
    .references(() => epics.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // record type (e.g., 'note', 'decision', 'task')
  data: text('data', { mode: 'json' }).notNull(), // JSON object
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Record-Tag junction
export const recordTags = sqliteTable('record_tags', {
  recordId: text('record_id')
    .notNull()
    .references(() => records.id, { onDelete: 'cascade' }),
  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
});

export const epicComments = sqliteTable(
  'epic_comments',
  {
    id: text('id').primaryKey(),
    epicId: text('epic_id')
      .notNull()
      .references(() => epics.id, { onDelete: 'cascade' }),
    authorName: text('author_name').notNull(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    epicIdCreatedAtIdx: index('epic_comments_epic_id_created_at_idx').on(
      table.epicId,
      table.createdAt,
    ),
  }),
);

// Sessions (terminal/agent sessions)
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    epicId: text('epic_id').references(() => epics.id, { onDelete: 'set null' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'restrict' }),
    tmuxSessionId: text('tmux_session_id'),
    status: text('status').notNull(), // 'running' | 'stopped' | 'failed'
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    lastActivityAt: text('last_activity_at'),
    activityState: text('activity_state'), // 'idle' | 'busy'
    busySince: text('busy_since'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    // Partial unique index: ensures only one running session per agent
    // This is a safety net for the application-level lock (withAgentLock)
    // to catch any edge cases where concurrent requests might create duplicates
    agentRunningUnique: uniqueIndex('idx_sessions_agent_running')
      .on(table.agentId)
      .where(sql`status = 'running' AND agent_id IS NOT NULL`),
  }),
);

// Transcripts (session logs)
export const transcripts = sqliteTable('transcripts', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  archivedAt: text('archived_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    payloadJson: text('payload_json').notNull(),
    requestId: text('request_id'),
    publishedAt: text('published_at').notNull(),
  },
  (table) => ({
    nameIdx: index('events_name_idx').on(table.name),
    publishedAtIdx: index('events_published_at_idx').on(table.publishedAt),
  }),
);

export const eventHandlers = sqliteTable(
  'event_handlers',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    handler: text('handler').notNull(),
    status: text('status').notNull(),
    detail: text('detail'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
  },
  (table) => ({
    eventIdIdx: index('event_handlers_event_id_idx').on(table.eventId),
    handlerIdx: index('event_handlers_handler_idx').on(table.handler),
    statusIdx: index('event_handlers_status_idx').on(table.status),
  }),
);

// Settings (app configuration)
export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  value: text('value', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Project Paths (recently accessed projects)
export const projectPaths = sqliteTable('project_paths', {
  id: text('id').primaryKey(),
  path: text('path').notNull().unique(),
  lastAccessedAt: text('last_accessed_at').notNull(),
  createdAt: text('created_at').notNull(),
});

// Optional placeholders for cloud mode (not fully implemented yet)
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const companies = sqliteTable('companies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const memberships = sqliteTable('memberships', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'owner' | 'admin' | 'member'
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull(),
  name: text('name').notNull(),
  lastUsedAt: text('last_used_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Chat Threads
export const chatThreads = sqliteTable('chat_threads', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title'), // null for direct messages, custom name for groups
  isGroup: integer('is_group', { mode: 'boolean' }).notNull().default(false),
  createdByType: text('created_by_type').notNull(), // 'user' | 'agent' | 'system'
  createdByUserId: text('created_by_user_id'),
  createdByAgentId: text('created_by_agent_id'),
  lastUserClearedAt: text('last_user_cleared_at'), // timestamp when user cleared history (UI filter)
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Chat Members (thread participants)
export const chatMembers = sqliteTable('chat_members', {
  threadId: text('thread_id')
    .notNull()
    .references(() => chatThreads.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
});

// Chat Messages
export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    authorType: text('author_type').notNull(), // 'user' | 'agent' | 'system'
    authorAgentId: text('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    threadIdIdx: index('chat_messages_thread_id_idx').on(table.threadId),
    createdAtIdx: index('chat_messages_created_at_idx').on(table.createdAt),
  }),
);

// Chat Message Targets (for mentions)
export const chatMessageTargets = sqliteTable('chat_message_targets', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => chatMessages.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
});

// Chat Message Reads (track which agents have read which messages)
export const chatMessageReads = sqliteTable(
  'chat_message_reads',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    readAt: text('read_at').notNull(),
  },
  (table) => ({
    // Composite primary key
    pk: uniqueIndex('chat_message_reads_pk').on(table.messageId, table.agentId),
    messageIdIdx: index('chat_message_reads_message_id_idx').on(table.messageId),
    agentIdIdx: index('chat_message_reads_agent_id_idx').on(table.agentId),
  }),
);

// Chat Thread Session Invites (track per-session invite delivery and acknowledgment)
export const chatThreadSessionInvites = sqliteTable(
  'chat_thread_session_invites',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(), // tmux session identifier
    inviteMessageId: text('invite_message_id')
      .notNull()
      .references(() => chatMessages.id, { onDelete: 'cascade' }),
    sentAt: text('sent_at').notNull(),
    acknowledgedAt: text('acknowledged_at'),
  },
  (table) => ({
    // Unique constraint to prevent duplicate invites for same thread/agent/session
    uniqueThreadAgentSession: uniqueIndex('chat_thread_session_invites_unique').on(
      table.threadId,
      table.agentId,
      table.sessionId,
    ),
    // Index for lookups by thread and agent
    threadAgentIdx: index('chat_thread_session_invites_thread_agent_idx').on(
      table.threadId,
      table.agentId,
    ),
  }),
);

// Chat Activities (explicit activity start/finish via MCP tools)
export const chatActivities = sqliteTable(
  'chat_activities',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    status: text('status').notNull(), // 'running' | 'success' | 'failed' | 'canceled' | 'auto_finished'
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    startMessageId: text('start_message_id').references(() => chatMessages.id, {
      onDelete: 'set null',
    }),
    finishMessageId: text('finish_message_id').references(() => chatMessages.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    threadAgentIdx: index('chat_activities_thread_agent_idx').on(table.threadId, table.agentId),
    startedAtIdx: index('chat_activities_started_at_idx').on(table.startedAt),
  }),
);

// ============================================
// GUESTS - External agents registered via MCP
// ============================================
// NOTE: SQLite COLLATE NOCASE Pattern
// ------------------------------------
// For case-insensitive unique constraints in SQLite, use:
//   sql`${table.column} COLLATE NOCASE`
// This generates: `column_name` COLLATE NOCASE in the index.
// drizzle-kit may show minor quoting differences ("col" vs `col`) but they're
// functionally equivalent for SQLite.
export const guests = sqliteTable(
  'guests',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'), // Optional description for guest purpose
    tmuxSessionId: text('tmux_session_id').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    // Case-insensitive unique index on (project_id, name)
    // Uses COLLATE NOCASE for SQLite case-insensitive comparison
    projectNameUnique: uniqueIndex('guests_project_name_unique').on(
      table.projectId,
      sql`${table.name} COLLATE NOCASE`,
    ),
    // Unique index on tmux_session_id
    tmuxSessionIdUnique: uniqueIndex('guests_tmux_session_id_unique').on(table.tmuxSessionId),
    // Index for listing by project
    projectIdIdx: index('guests_project_id_idx').on(table.projectId),
  }),
);

// ============================================
// CODE REVIEWS - Review metadata and comments
// ============================================

// Reviews (code review metadata with SHA-pinned refs)
export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    epicId: text('epic_id').references(() => epics.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull(), // 'draft' | 'pending' | 'changes_requested' | 'approved' | 'closed'
    mode: text('mode').notNull().default('commit'), // 'working_tree' | 'commit'
    baseRef: text('base_ref').notNull(), // e.g., 'main', 'develop', 'HEAD'
    headRef: text('head_ref').notNull(), // e.g., 'feature/my-branch', 'HEAD'
    baseSha: text('base_sha'), // SHA at time of review creation (null for working_tree mode)
    headSha: text('head_sha'), // SHA at time of review creation (null for working_tree mode)
    createdBy: text('created_by').notNull(), // 'user' | 'agent'
    createdByAgentId: text('created_by_agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    projectIdIdx: index('reviews_project_id_idx').on(table.projectId),
    epicIdIdx: index('reviews_epic_id_idx').on(table.epicId),
    statusIdx: index('reviews_status_idx').on(table.status),
  }),
);

// Review Comments (comments with threading, line references, and status)
export const reviewComments = sqliteTable(
  'review_comments',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    filePath: text('file_path'), // null for general review comments
    parentId: text('parent_id'), // null for top-level comments, references reviewComments.id for threads
    lineStart: integer('line_start'), // starting line number (null for file-level or general comments)
    lineEnd: integer('line_end'), // ending line number (null for single-line or general comments)
    side: text('side'), // 'left' | 'right' | null (for diff context: left=base, right=head)
    content: text('content').notNull(),
    commentType: text('comment_type').notNull(), // 'comment' | 'suggestion' | 'issue' | 'approval'
    status: text('status').notNull(), // 'open' | 'resolved' | 'wont_fix'
    authorType: text('author_type').notNull(), // 'user' | 'agent'
    authorAgentId: text('author_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    version: integer('version').notNull().default(1),
    editedAt: text('edited_at'), // timestamp of last edit, null if never edited
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    reviewIdIdx: index('review_comments_review_id_idx').on(table.reviewId),
    parentIdIdx: index('review_comments_parent_id_idx').on(table.parentId),
    filePathIdx: index('review_comments_file_path_idx').on(table.filePath),
    statusIdx: index('review_comments_status_idx').on(table.status),
    parentFk: foreignKey(() => ({
      columns: [table.parentId],
      foreignColumns: [table.id],
      onDelete: 'cascade',
      name: 'review_comments_parent_id_fk',
    })),
  }),
);

// Review Comment Targets (agent assignment join table)
export const reviewCommentTargets = sqliteTable(
  'review_comment_targets',
  {
    id: text('id').primaryKey(),
    commentId: text('comment_id')
      .notNull()
      .references(() => reviewComments.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    commentIdIdx: index('review_comment_targets_comment_id_idx').on(table.commentId),
    agentIdIdx: index('review_comment_targets_agent_id_idx').on(table.agentId),
  }),
);

// ============================================
// TERMINAL WATCHERS - Monitor sessions for patterns
// ============================================
export const terminalWatchers = sqliteTable(
  'terminal_watchers',
  {
    id: text('id').primaryKey(), // UUID
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    // Scope: which sessions to watch
    scope: text('scope').notNull().default('all'), // 'all' | 'agent' | 'profile' | 'provider'
    scopeFilterId: text('scope_filter_id'), // agentId, profileId, or providerId when scope != 'all'

    // Polling configuration
    pollIntervalMs: integer('poll_interval_ms').notNull().default(5000), // 1000-60000
    viewportLines: integer('viewport_lines').notNull().default(50), // Lines to capture (10-200)

    // Trigger condition (JSON)
    // Schema: { type: 'contains' | 'regex' | 'not_contains', pattern: string, flags?: string }
    condition: text('condition', { mode: 'json' }).notNull(),
    // Optional idle gate (seconds). 0 disables idle gating.
    idleAfterSeconds: integer('idle_after_seconds').notNull().default(0),

    // Cooldown configuration
    cooldownMs: integer('cooldown_ms').notNull().default(60000), // Min time between triggers
    cooldownMode: text('cooldown_mode').notNull().default('time'), // 'time' | 'until_clear'

    // Output event
    eventName: text('event_name').notNull(), // User-defined event name, e.g., 'claude.context_full'

    // Timestamps
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    // Index for listing watchers by project
    projectIdIdx: index('terminal_watchers_project_id_idx').on(table.projectId),
    // Index for enabled watchers (runtime queries)
    enabledIdx: index('terminal_watchers_enabled_idx').on(table.enabled),
  }),
);

// ============================================
// AUTOMATION SUBSCRIBERS - Listen for events, execute actions
// ============================================
export const automationSubscribers = sqliteTable(
  'automation_subscribers',
  {
    id: text('id').primaryKey(), // UUID
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    // Event to listen for
    eventName: text('event_name').notNull(), // Must match a watcher's eventName

    // Optional filter (JSON)
    // Schema: { field: string, operator: 'equals' | 'contains' | 'regex', value: string } | null
    eventFilter: text('event_filter', { mode: 'json' }),

    // Action configuration
    actionType: text('action_type').notNull(), // 'send_agent_message' (MVP), future actions TBD

    // Action inputs (JSON)
    // Schema: Record<string, { source: 'event_field' | 'custom', eventField?: string, customValue?: string }>
    actionInputs: text('action_inputs', { mode: 'json' }).notNull(),

    // Execution options
    delayMs: integer('delay_ms').notNull().default(0), // Delay before executing action (0-30000)
    cooldownMs: integer('cooldown_ms').notNull().default(5000), // Subscriber-level cooldown (0-60000)
    retryOnError: integer('retry_on_error', { mode: 'boolean' }).notNull().default(false),

    // Grouping & ordering (for deterministic execution order)
    groupName: text('group_name'), // Nullable - null means implicit group "event:<eventName>"
    position: integer('position').notNull().default(0), // Order within group (lower first)
    priority: integer('priority').notNull().default(0), // Tie-break across groups (higher first)

    // Timestamps
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    // Index for listing subscribers by project
    projectIdIdx: index('automation_subscribers_project_id_idx').on(table.projectId),
    // Index for finding subscribers by event name (runtime queries)
    eventNameIdx: index('automation_subscribers_event_name_idx').on(table.eventName),
    // Index for enabled subscribers
    enabledIdx: index('automation_subscribers_enabled_idx').on(table.enabled),
  }),
);
