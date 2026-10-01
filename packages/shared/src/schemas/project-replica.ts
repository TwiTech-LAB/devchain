import { z } from 'zod';

/**
 * ProjectReplicaV1 — a lossless, ID-preserving copy of one or more projects of a
 * single workspace, exchanged between a home instance and a remote host.
 *
 * Table rows keep their SQLite storage shape: snake_case column names, booleans
 * as 0/1 integers, JSON columns as their stored text, timestamps as stored ISO
 * strings. Replica-only metadata and deliberate departures from the storage shape:
 * - `epic_tags` carry the tag name instead of `tag_id` (the receiver resolves by name).
 * - `providers` carries only `{ id, name }`; receivers map provider IDs by name.
 * - `provider_settings`, `provider_models`, `provider_efforts` and
 *   `provider_plugin_defaults` key the provider by name; `provider_settings`
 *   also carries each provider's full env and project scope map. Catalog
 *   positions are receiver-local, so catalog rows travel in source order
 *   without one.
 * - `skill_project_disabled` carries `skills.slug` instead of the local `skill_id`.
 * - `sender_skill_slugs` lists the sender's skill catalog to gate switch deletion.
 *
 * The payload carries provider env values and profile-config env in clear text.
 * Never log it.
 */

export const PROJECT_REPLICA_VERSION = 1 as const;

export const ProjectReplicaScopeSchema = z.enum(['attach', 'detach', 'live']);
export type ProjectReplicaScope = z.infer<typeof ProjectReplicaScopeSchema>;

/**
 * Settings rows whose JSON value is a map keyed by project ID. The replica
 * carries each project's slice of these maps.
 */
export const PROJECT_REPLICA_SETTING_KEYS = [
  'initialSessionPromptIds',
  'autoClean.statusIds',
  'messagePool.projects',
  'registryTemplates',
  'projectPresets',
  'projectActivePresets',
] as const;
export type ProjectReplicaSettingKey = (typeof PROJECT_REPLICA_SETTING_KEYS)[number];

/**
 * Home's instance-level agent settings, carried by attach replicas so the
 * receiving host batches messages, notifies, sources skills and idles agents
 * exactly like home. The values are home's effective (default-resolved)
 * settings; the receiver overwrites its own rows with them. They never travel
 * in detach or live scope, so a disconnect and a live pull never write them.
 */
export const ReplicaInstanceSettingsSchema = z
  .object({
    messagePool: z
      .object({
        enabled: z.boolean(),
        delayMs: z.number().int().positive(),
        maxWaitMs: z.number().int().positive(),
        maxMessages: z.number().int().positive(),
        separator: z.string(),
      })
      .strict(),
    /** Stored value of `events.epicAssigned.template`, default-resolved. */
    eventsEpicAssignedTemplate: z.string(),
    /** Effective value for every registered home source (built-ins included); home wins on merge. */
    skillsSources: z.record(z.string().min(1), z.boolean()),
    /** Stored value of `activity.idleTimeoutMs`, default-resolved. */
    activityIdleTimeoutMs: z.number().int().positive(),
    /**
     * Home's terminal preferences, default-resolved and clamped to the same
     * bounds the settings readers enforce. `inputMode` mirrors the app's
     * 'form' | 'tty' input modes.
     */
    terminal: z
      .object({
        inputMode: z.enum(['form', 'tty']),
        scrollbackLines: z.number().int().positive(),
        seedingMaxBytes: z.number().int().positive(),
        suppressCtrlCWithSelection: z.boolean(),
      })
      .strict(),
    /** Stored value of `skills.syncOnStartup`, default-resolved. */
    skillsSyncOnStartup: z.boolean(),
    /** Stored value of `messaging.followNote`, default-resolved. */
    messagingFollowNote: z.boolean(),
  })
  .strict();
export type ReplicaInstanceSettings = z.infer<typeof ReplicaInstanceSettingsSchema>;

const id = z.string().min(1);
const timestamp = z.string().min(1);
const sqliteBool = z.union([z.literal(0), z.literal(1)]);
const int = z.number().int();
const text = z.string();

// ---------------------------------------------------------------------------
// Row shapes (one per stored table)
// ---------------------------------------------------------------------------

export const ReplicaProjectRowSchema = z
  .object({
    id,
    workspace_id: id,
    name: text,
    description: text.nullable(),
    root_path: text,
    is_template: sqliteBool.nullable(),
    is_private: sqliteBool.nullable(),
    owner_user_id: text.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaPairedDeviceWorkspaceGrantRowSchema = z
  .object({ device_kid: id, workspace_id: id })
  .strict();

export const ReplicaStatusRowSchema = z
  .object({
    id,
    project_id: id,
    label: text,
    color: text,
    position: int,
    mcp_hidden: sqliteBool,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaTagRowSchema = z
  .object({
    id,
    project_id: id.nullable(),
    name: text,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaPromptRowSchema = z
  .object({
    id,
    project_id: id.nullable(),
    title: text,
    content: text,
    version: int,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaPromptTagRowSchema = z
  .object({
    prompt_id: id,
    tag_id: id,
    created_at: timestamp,
  })
  .strict();

export const ReplicaAgentProfileRowSchema = z
  .object({
    id,
    project_id: id.nullable(),
    name: text,
    family_slug: text.nullable(),
    system_prompt: text.nullable(),
    instructions: text.nullable(),
    temperature: int.nullable(),
    max_tokens: int.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaAgentProfilePromptRowSchema = z
  .object({
    profile_id: id,
    prompt_id: id,
    created_at: timestamp,
  })
  .strict();

export const ReplicaProviderRefSchema = z
  .object({
    id,
    name: text.min(1),
  })
  .strict();

export const ReplicaProfileProviderConfigRowSchema = z
  .object({
    id,
    profile_id: id,
    provider_id: id,
    name: text,
    description: text.nullable(),
    options: text.nullable(),
    env: text.nullable(),
    model: text.nullable(),
    effort: text.nullable(),
    position: int,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaProviderSettingsRowSchema = z
  .object({
    providerName: text.min(1),
    env: z.record(text).nullable(),
    envScopes: z.record(z.array(id)),
    auto_compact_threshold: int.nullable(),
    claude_launch_settings_json: text.nullable(),
  })
  .strict();

export const ReplicaProviderCatalogRowSchema = z
  .object({
    providerName: text.min(1),
    name: text.min(1),
    created_at: timestamp,
  })
  .strict();

export const ReplicaProviderPluginDefaultRowSchema = z
  .object({
    providerName: text.min(1),
    plugin_id: text.min(1),
    enabled: sqliteBool,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaProjectPluginOverrideRowSchema = z
  .object({
    project_id: id,
    provider_id: id,
    plugin_id: text.min(1),
    enabled: sqliteBool,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaAgentRowSchema = z
  .object({
    id,
    project_id: id,
    is_project_owner: sqliteBool,
    profile_id: id,
    provider_config_id: id,
    model_override: text.nullable(),
    effort_override: text.nullable(),
    name: text,
    description: text.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaTeamRowSchema = z
  .object({
    id,
    project_id: id,
    name: text,
    description: text.nullable(),
    team_lead_agent_id: id.nullable(),
    max_members: int,
    max_concurrent_tasks: int,
    allow_team_lead_create_agents: sqliteBool,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaTeamMemberRowSchema = z
  .object({
    team_id: id,
    agent_id: id,
    created_at: timestamp,
  })
  .strict();

export const ReplicaTeamProfileRowSchema = z
  .object({
    team_id: id,
    profile_id: id,
    created_at: timestamp,
  })
  .strict();

export const ReplicaTeamProfileConfigRowSchema = z
  .object({
    team_id: id,
    profile_id: id,
    provider_config_id: id,
    created_at: timestamp,
  })
  .strict();

export const ReplicaTerminalWatcherRowSchema = z
  .object({
    id,
    project_id: id,
    name: text,
    description: text.nullable(),
    enabled: sqliteBool,
    scope: text,
    scope_filter_id: text.nullable(),
    poll_interval_ms: int,
    viewport_lines: int,
    condition: text,
    idle_after_seconds: int,
    cooldown_ms: int,
    cooldown_mode: text,
    event_name: text,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaAutomationSubscriberRowSchema = z
  .object({
    id,
    project_id: id,
    name: text,
    description: text.nullable(),
    enabled: sqliteBool,
    event_name: text,
    event_filter: text.nullable(),
    action_type: text,
    action_inputs: text,
    delay_ms: int,
    cooldown_ms: int,
    retry_on_error: sqliteBool,
    group_name: text.nullable(),
    position: int,
    priority: int,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaScheduledEpicRowSchema = z
  .object({
    id,
    project_id: id,
    name: text,
    cron_expression: text,
    timezone: text,
    enabled: sqliteBool,
    title_template: text,
    description_template: text.nullable(),
    template_status_id: id.nullable(),
    template_parent_epic_id: id.nullable(),
    template_agent_id: id.nullable(),
    template_tags: text.nullable(),
    allow_overlap: sqliteBool,
    missed_run_policy: text,
    config_version: int,
    next_run_at: text.nullable(),
    last_run_at: text.nullable(),
    last_run_status: text.nullable(),
    last_error: text.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaProjectSettingEntrySchema = z
  .object({
    project_id: id,
    key: z.enum(PROJECT_REPLICA_SETTING_KEYS),
    /** This project's slice of the stored JSON map. */
    value: z.unknown().refine((value) => value !== undefined, { message: 'Required' }),
  })
  .strict();

export const ReplicaEpicRowSchema = z
  .object({
    id,
    project_id: id,
    title: text,
    description: text.nullable(),
    status_id: id,
    parent_id: id.nullable(),
    agent_id: id.nullable(),
    created_by: text.nullable(),
    version: int,
    data: text.nullable(),
    skills_required: text.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaEpicTagEntrySchema = z
  .object({
    epic_id: id,
    tag_name: text.min(1),
    created_at: timestamp,
  })
  .strict();

export const ReplicaEpicCommentRowSchema = z
  .object({
    id,
    epic_id: id,
    author_name: text,
    content: text,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaEpicRelationRowSchema = z
  .object({
    id,
    left_epic_id: id,
    right_epic_id: id,
    type: z.enum(['related', 'blocks']),
    direction: z.enum(['none', 'left_to_right', 'right_to_left']),
    created_by: z.enum(['user', 'agent']).nullable(),
    created_by_agent_id: id.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaReviewRowSchema = z
  .object({
    id,
    project_id: id,
    epic_id: id.nullable(),
    title: text,
    description: text.nullable(),
    status: text,
    mode: text,
    base_ref: text,
    head_ref: text,
    base_sha: text.nullable(),
    head_sha: text.nullable(),
    created_by: text,
    created_by_agent_id: id.nullable(),
    version: int,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaReviewCommentRowSchema = z
  .object({
    id,
    review_id: id,
    file_path: text.nullable(),
    parent_id: id.nullable(),
    line_start: int.nullable(),
    line_end: int.nullable(),
    side: text.nullable(),
    content: text,
    comment_type: text,
    status: text,
    author_type: text,
    author_agent_id: id.nullable(),
    version: int,
    edited_at: text.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

/** Settled segments only: `closed_at` set and no team batch. */
export const ReplicaEpicTimeSegmentRowSchema = z
  .object({
    id,
    project_id: id,
    epic_id: id.nullable(),
    team_batch_id: z.null(),
    attribution_source: z.enum(['direct', 'team']),
    team_id_snapshot: text.nullable(),
    team_name_snapshot: text.nullable(),
    session_id_snapshot: text,
    agent_id_snapshot: text,
    agent_name_snapshot: text,
    started_at: timestamp,
    last_activity_at: timestamp,
    closed_at: timestamp,
    duration_ms: int,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaSessionRowSchema = z
  .object({
    id,
    epic_id: id.nullable(),
    agent_id: id.nullable(),
    tmux_session_id: text.nullable(),
    status: text,
    started_at: timestamp,
    ended_at: text.nullable(),
    last_activity_at: text.nullable(),
    activity_state: text.nullable(),
    busy_since: text.nullable(),
    transcript_path: text.nullable(),
    name: text.nullable(),
    provider_session_id: text.nullable(),
    provider_name_at_launch: text.nullable(),
    size_bytes: int.nullable(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const ReplicaEpicTimeSessionWatermarkRowSchema = z
  .object({
    session_id: id,
    project_id: id,
    last_activity_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

/** A local skill ID is replaced by its unique slug on the wire. */
export const ReplicaSkillProjectDisabledRowSchema = z
  .object({
    id,
    project_id: id,
    skill_slug: id,
    created_at: timestamp,
  })
  .strict();

export const ReplicaSourceProjectEnabledRowSchema = z
  .object({
    id,
    project_id: id,
    source_name: id,
    enabled: sqliteBool,
    created_at: timestamp,
  })
  .strict();

export const ReplicaWorkspaceSchema = z
  .object({
    id,
    name: text.min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// Per-scope table sets
// ---------------------------------------------------------------------------

/** Tables that travel on every pull; the other scopes extend this set. */
const liveTablesShape = {
  projects: z.array(ReplicaProjectRowSchema).min(1),
  statuses: z.array(ReplicaStatusRowSchema),
  tags: z.array(ReplicaTagRowSchema),
  providers: z.array(ReplicaProviderRefSchema),
  agent_profiles: z.array(ReplicaAgentProfileRowSchema),
  profile_provider_configs: z.array(ReplicaProfileProviderConfigRowSchema),
  agents: z.array(ReplicaAgentRowSchema),
  epics: z.array(ReplicaEpicRowSchema),
  epic_tags: z.array(ReplicaEpicTagEntrySchema),
  epic_comments: z.array(ReplicaEpicCommentRowSchema),
  epic_relations: z.array(ReplicaEpicRelationRowSchema),
  epic_time_segments: z.array(ReplicaEpicTimeSegmentRowSchema),
};

/** Configuration and history tables that live tier pulls leave out. */
const configurationTablesShape = {
  prompts: z.array(ReplicaPromptRowSchema),
  prompt_tags: z.array(ReplicaPromptTagRowSchema),
  agent_profile_prompts: z.array(ReplicaAgentProfilePromptRowSchema),
  teams: z.array(ReplicaTeamRowSchema),
  team_members: z.array(ReplicaTeamMemberRowSchema),
  team_profiles: z.array(ReplicaTeamProfileRowSchema),
  team_profile_configs: z.array(ReplicaTeamProfileConfigRowSchema),
  terminal_watchers: z.array(ReplicaTerminalWatcherRowSchema),
  automation_subscribers: z.array(ReplicaAutomationSubscriberRowSchema),
  scheduled_epics: z.array(ReplicaScheduledEpicRowSchema),
  project_settings: z.array(ReplicaProjectSettingEntrySchema),
  project_provider_plugin_overrides: z.array(ReplicaProjectPluginOverrideRowSchema),
  sender_skill_slugs: z.array(id),
  skill_project_disabled: z.array(ReplicaSkillProjectDisabledRowSchema),
  source_project_enabled: z.array(ReplicaSourceProjectEnabledRowSchema),
  reviews: z.array(ReplicaReviewRowSchema),
  review_comments: z.array(ReplicaReviewCommentRowSchema),
};

/** Stopped sessions with their watermarks, so the receiving sweep counts no time twice. */
const sessionTablesShape = {
  sessions: z.array(ReplicaSessionRowSchema),
  epic_time_session_watermarks: z.array(ReplicaEpicTimeSessionWatermarkRowSchema),
};

export const ProjectReplicaLiveTablesSchema = z.object(liveTablesShape).strict();

/**
 * Attach carries the configuration tier plus the project's stopped sessions
 * with their watermarks, so the host can list and restore them and its sweep
 * counts no time twice. The provider instance tables are one-way: the host
 * applies them only when it imports the project, and they never travel back.
 */
export const ProjectReplicaAttachTablesSchema = z
  .object({
    ...liveTablesShape,
    ...configurationTablesShape,
    provider_settings: z.array(ReplicaProviderSettingsRowSchema),
    provider_models: z.array(ReplicaProviderCatalogRowSchema),
    provider_efforts: z.array(ReplicaProviderCatalogRowSchema),
    provider_plugin_defaults: z.array(ReplicaProviderPluginDefaultRowSchema),
    instance_settings: ReplicaInstanceSettingsSchema,
    // Absent together on older senders; authority is limited to home's known and revoked kids.
    paired_device_workspace_grants: z.array(ReplicaPairedDeviceWorkspaceGrantRowSchema).optional(),
    authorityKids: z.array(id).optional(),
    ...sessionTablesShape,
  })
  .strict();

/**
 * Detach returns everything the host owned, plus its sessions with their
 * watermarks. Provider env values and the instance-level provider config
 * (catalogs, scalars, plugin defaults) never travel back: home stays
 * authoritative for them.
 */
export const ProjectReplicaDetachTablesSchema = z
  .object({
    ...liveTablesShape,
    ...configurationTablesShape,
    ...sessionTablesShape,
  })
  .strict();

const envelopeShape = {
  version: z.literal(PROJECT_REPLICA_VERSION),
  generatedAt: timestamp,
  workspace: ReplicaWorkspaceSchema,
};

export const ProjectReplicaV1Schema = z
  .discriminatedUnion('scope', [
    z
      .object({
        ...envelopeShape,
        scope: z.literal('attach'),
        tables: ProjectReplicaAttachTablesSchema,
      })
      .strict(),
    z
      .object({
        ...envelopeShape,
        scope: z.literal('detach'),
        tables: ProjectReplicaDetachTablesSchema,
      })
      .strict(),
    z
      .object({
        ...envelopeShape,
        scope: z.literal('live'),
        tables: ProjectReplicaLiveTablesSchema,
      })
      .strict(),
  ])
  .superRefine((replica, ctx) => {
    if (replica.scope !== 'attach') return;
    const grants = replica.tables.paired_device_workspace_grants;
    const authority = replica.tables.authorityKids;
    if (
      (grants === undefined) !== (authority === undefined) ||
      (authority && new Set(authority).size !== authority.length)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tables', 'authorityKids'],
        message: 'Unique authorityKids and grant snapshot must be provided together',
      });
    }
    const seen = new Set<string>();
    for (const [index, grant] of (replica.tables.paired_device_workspace_grants ?? []).entries()) {
      if (
        grant.workspace_id !== replica.workspace.id ||
        seen.has(grant.device_kid) ||
        !authority?.includes(grant.device_kid)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tables', 'paired_device_workspace_grants', index],
          message: 'Grant must uniquely identify a device in the replica workspace',
        });
      }
      seen.add(grant.device_kid);
    }
  });

export type ProjectReplicaV1 = z.infer<typeof ProjectReplicaV1Schema>;
export type ProjectReplicaOfScope<S extends ProjectReplicaScope> = Extract<
  ProjectReplicaV1,
  { scope: S }
>;
export type ProjectReplicaLiveTables = z.infer<typeof ProjectReplicaLiveTablesSchema>;
export type ProjectReplicaAttachTables = z.infer<typeof ProjectReplicaAttachTablesSchema>;
export type ProjectReplicaDetachTables = z.infer<typeof ProjectReplicaDetachTablesSchema>;
export type ReplicaSkillProjectDisabledRow = z.infer<typeof ReplicaSkillProjectDisabledRowSchema>;
export type ReplicaSourceProjectEnabledRow = z.infer<typeof ReplicaSourceProjectEnabledRowSchema>;

/** Union of every table any scope can carry, keyed by table name. */
export type ProjectReplicaTables = ProjectReplicaAttachTables & ProjectReplicaDetachTables;
export type ProjectReplicaTableName = keyof ProjectReplicaTables;
/**
 * Row type of an array-valued table. `instance_settings` is a single object,
 * not a table of rows, so it resolves to `never`.
 */
export type ProjectReplicaRow<T extends ProjectReplicaTableName> =
  NonNullable<ProjectReplicaTables[T]> extends readonly unknown[]
    ? NonNullable<ProjectReplicaTables[T]>[number]
    : never;

// ---------------------------------------------------------------------------
// Preflight errors (returned instead of a payload)
// ---------------------------------------------------------------------------

export const ReplicaRowRefSchema = z
  .object({
    table: text.min(1),
    id: text.min(1),
  })
  .strict();

export const ProjectReplicaPreflightErrorSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('PROJECT_NOT_FOUND'), projectId: id }).strict(),
  z
    .object({
      code: z.literal('WORKSPACE_MISMATCH'),
      workspaceIds: z.array(id).min(2),
    })
    .strict(),
  z
    .object({
      code: z.literal('PROVIDER_ROW_MISSING'),
      providerId: id,
      referencedBy: ReplicaRowRefSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal('PROVIDER_NOT_ON_TARGET'),
      providerName: text.min(1),
    })
    .strict(),
  z
    .object({
      code: z.literal('PROVIDER_ENV_INVALID'),
      providerName: text.min(1),
    })
    .strict(),
  z
    .object({
      code: z.literal('REFERENCED_ROW_UNAVAILABLE'),
      table: z.enum([
        'project_workspaces',
        'agent_profiles',
        'profile_provider_configs',
        'prompts',
        'tags',
      ]),
      id,
      reason: z.enum(['missing', 'other_project']),
      referencedBy: ReplicaRowRefSchema,
    })
    .strict(),
]);

export type ProjectReplicaPreflightError = z.infer<typeof ProjectReplicaPreflightErrorSchema>;

// ---------------------------------------------------------------------------
// Host API wire shapes
// ---------------------------------------------------------------------------

/**
 * Request content type for replica bodies sent to a host. Hosts accept it with
 * a larger body limit than the default JSON parser.
 */
export const PROJECT_REPLICA_CONTENT_TYPE = 'application/vnd.devchain.project-replica+json';

/** Complete ID sets of the tables a changes feed sends partially, for delete detection. */
export const ProjectReplicaIdSetsSchema = z
  .object({
    epics: z.array(id),
    epic_comments: z.array(id),
    epic_relations: z.array(id),
    epic_time_segments: z.array(id),
  })
  .strict();

export type ProjectReplicaIdSets = z.infer<typeof ProjectReplicaIdSetsSchema>;

export const ProjectReplicaChangesSchema = z
  .object({
    /** Host time read in the same transaction as the rows; pass it back as `since`. */
    cursor: timestamp,
    replica: ProjectReplicaV1Schema.refine((replica) => replica.scope === 'live', {
      message: 'changes carry a live replica',
    }),
    idSets: ProjectReplicaIdSetsSchema.optional(),
  })
  .strict();

export type ProjectReplicaChanges = z.infer<typeof ProjectReplicaChangesSchema>;

export const ProjectReplicaImportResultSchema = z
  .object({
    projectId: id,
    cursor: timestamp,
  })
  .strict();

export type ProjectReplicaImportResult = z.infer<typeof ProjectReplicaImportResultSchema>;
