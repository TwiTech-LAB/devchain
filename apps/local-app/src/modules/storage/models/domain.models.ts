// Domain models for the storage layer
// These represent the internal TypeScript models (camelCase)

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  rootPath: string;
  isTemplate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWorkspace {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  projectCount: number;
  deviceGrantCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeleteProjectWorkspaceResult {
  movedProjectCount: number;
  remappedDeviceGrantCount: number;
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
  createdBy: string | null;
  version: number; // For optimistic locking
  data: Record<string, unknown> | null;
  skillsRequired: string[] | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type EpicRelationType = 'related' | 'blocks' | 'blocked_by';
export type StoredEpicRelationType = 'related' | 'blocks';
export type EpicRelationDirection = 'none' | 'left_to_right' | 'right_to_left';

/**
 * The durable route effect a destructive relation change displaces. Human
 * writes must echo back the exact facts the server issued; agent command
 * writes never carry them.
 */
export interface RelationRouteEffectFacts {
  sourceEpicId: string;
  targetEpicId: string;
}

/**
 * The single derivation from a relation row's canonical endpoints plus its
 * direction to the semantic source and target. `null` means the row carries
 * no semantic direction: legacy pre-feature Related rows still store
 * direction 'none' and stay readable, but nothing may write that state for
 * Related anymore. For type=blocks the source blocks the target; for
 * type=related the target includes eligible source time.
 */
export function resolveRelationEndpoints(
  leftEpicId: string,
  rightEpicId: string,
  direction: EpicRelationDirection,
): RelationRouteEffectFacts | null {
  if (direction === 'none') {
    return null;
  }
  return direction === 'left_to_right'
    ? { sourceEpicId: leftEpicId, targetEpicId: rightEpicId }
    : { sourceEpicId: rightEpicId, targetEpicId: leftEpicId };
}

export interface EpicRelation {
  id: string;
  leftEpicId: string;
  rightEpicId: string;
  type: StoredEpicRelationType;
  direction: EpicRelationDirection;
  sourceEpicId: string | null;
  targetEpicId: string | null;
  createdBy: AuthorType | null;
  createdByAgentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetEpicRelation {
  epicId: string;
  relatedEpicId: string;
  type: EpicRelationType;
  acceptedRouteEffect?: RelationRouteEffectFacts;
  createdBy?: AuthorType | null;
  createdByAgentId?: string | null;
}

export interface EpicRelationListItem {
  relationId: string;
  epicId: string;
  projectId: string;
  projectName: string;
  title: string;
  statusId: string;
  statusLabel: string;
  statusColor: string;
  statusMcpHidden: boolean;
  type: EpicRelationType;
  sourceEpicId: string | null;
  targetEpicId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EpicRelationSummary {
  epicId: string;
  related: number;
  blocks: number;
  blockedBy: number;
  total: number;
  /**
   * Directional split of `related` naming each counterpart's role in the
   * relation: `relatedSources` counts rows whose source is the counterpart
   * (the focal Epic is the target), `relatedTargets` counts rows whose
   * target is the counterpart (the focal Epic is the source), and
   * `relatedNeutral` counts legacy direction-'none' rows. The group always
   * satisfies related = relatedSources + relatedTargets + relatedNeutral.
   */
  relatedSources: number;
  relatedTargets: number;
  relatedNeutral: number;
}

export interface EpicRelationCandidate {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  statusId: string;
  statusLabel: string;
  statusColor: string;
  statusMcpHidden: boolean;
  parentId: string | null;
}

export interface EpicRelationWriteContext {
  trustedLocalHuman?: boolean;
  actor?: { type: 'agent' | 'guest'; id: string } | null;
}

export interface SetEpicRelationResult extends EpicRelation {
  changed: boolean;
  workspaceId: string;
}

export interface DeleteEpicRelationResult {
  deleted: boolean;
  workspaceId: string;
}

export const INTEGRATION_PROVIDER_IDS = ['clickup', 'jira'] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDER_IDS)[number];

export interface ClickUpIntegrationCredentials {
  provider: 'clickup';
  token: string;
}

export interface JiraIntegrationCredentials {
  provider: 'jira';
  siteUrl: string;
  email: string;
  token: string;
}

export type IntegrationCredentials = ClickUpIntegrationCredentials | JiraIntegrationCredentials;

export interface IntegrationConnection {
  id: string;
  projectId: string | null;
  provider: IntegrationProvider;
  legacySourceConnectionId: string | null;
  generation: number;
  subtaskSyncEnabled: boolean;
  syncSettingRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ReplaceIntegrationConnection {
  projectId?: string;
  provider: IntegrationProvider;
  credentials: IntegrationCredentials;
  subtaskSyncEnabled?: boolean;
  acknowledgeOrphanRisk?: boolean;
}

export type IntegrationConnectionIdentity =
  | { projectId: string; provider: IntegrationProvider }
  | { connectionId: string };

export type IntegrationConnectionLookup = IntegrationConnectionIdentity | IntegrationProvider;

export interface ExternalTaskLink {
  id: string;
  epicId: string;
  /**
   * Owning project, always derived from the linked Epic. Part of the durable
   * task identity: one remote task may be linked once per project.
   */
  projectId: string;
  connectionId: string | null;
  provider: IntegrationProvider;
  remoteScopeKey: string;
  remoteTaskId: string;
  sourceSnapshot: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * The project id is derived from the owning Epic inside storage; callers
 * never supply it.
 */
export type CreateExternalTaskLink = Omit<
  ExternalTaskLink,
  'id' | 'projectId' | 'createdAt' | 'updatedAt'
>;

/**
 * Reserved owner for migrated checkpoint history whose owner cannot be
 * proven. Not a generatable UUID (version nibble 0, reserved variant bits),
 * so it can never collide with a real project id. Normal project-scoped
 * reads and writes reject it; only the dedicated unassigned read and the
 * one-time ownership assignment may target it.
 */
export const LEGACY_UNASSIGNED_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

export interface ExternalEstimateLogIdentity {
  /** Owning project of the checkpoint; the reserved legacy id only for the dedicated unassigned read. */
  projectId: string;
  provider: IntegrationProvider;
  remoteScopeKey: string;
  remoteTaskId: string;
}

/**
 * Batch checkpoint projection for link decoration. Only identities the caller
 * authorized (link, connection, and project checks already passed) may be
 * requested; absent rows mean "no checkpoint yet", not "unlinked".
 */
export interface ExternalEstimateLoggedMinutesEntry {
  projectId: string;
  remoteScopeKey: string;
  remoteTaskId: string;
  loggedMinutes: number;
}

export type ExternalEstimateLogPendingPhase = 'prepared' | 'outcome_unknown';
export type ExternalEstimateLogPendingResolution = 'logged' | 'not_logged';

/** One dated whole-minute total of the validated daily estimate projection. */
export interface ExternalEstimateDailyTotal {
  activityDate: string;
  minutes: number;
}

interface ExternalEstimateLogStateBase extends ExternalEstimateLogIdentity {
  loggedMinutes: number;
  revision: number;
  /** Canonical IANA zone the dated ledger groups under; null until first bound. */
  aggregationTimeZone: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExternalEstimateLogState = ExternalEstimateLogStateBase &
  (
    | {
        pendingOperationId: null;
        pendingDeltaMinutes: null;
        pendingEstimateTotalMinutes: null;
        pendingStartedAt: null;
        pendingConnectionId: null;
        pendingConnectionGeneration: null;
        pendingPhase: null;
        pendingResolution: null;
        pendingActivityDate: null;
      }
    | {
        pendingOperationId: string;
        pendingDeltaMinutes: number;
        pendingEstimateTotalMinutes: number;
        pendingStartedAt: string;
        pendingConnectionId: string;
        pendingConnectionGeneration: number;
        pendingPhase: ExternalEstimateLogPendingPhase;
        pendingResolution: ExternalEstimateLogPendingResolution | null;
        /** Migrated legacy pending rows keep null; new pending rows carry a date. */
        pendingActivityDate: string | null;
      }
  );

/** One persisted dated-ledger row of a checkpoint. */
export interface ExternalEstimateLogDay extends ExternalEstimateLogIdentity {
  activityDate: string;
  loggedMinutes: number;
}

/**
 * Checkpoint projection with the dated ledger: days ordered by activityDate
 * and the derived unallocatedLoggedMinutes (loggedMinutes minus the dated
 * sum). The scalar invariant loggedMinutes >= SUM(days) holds on every read.
 */
export interface ExternalEstimateLogDailyCheckpoint {
  state: ExternalEstimateLogState;
  days: ExternalEstimateLogDay[];
  unallocatedLoggedMinutes: number;
}

export interface SetExternalEstimateLoggedMinutes extends ExternalEstimateLogIdentity {
  loggedMinutes: number;
  expectedRevision: number;
  /** Canonical IANA zone to bind; null keeps any existing binding. */
  aggregationTimeZone: string | null;
  /**
   * Current validated daily projection. The rebuild clears the dated ledger
   * and materializes min(loggedMinutes, current total) oldest-first; an
   * empty projection leaves the full scalar as unallocated credit.
   */
  currentDailyTotals: ReadonlyArray<ExternalEstimateDailyTotal>;
}

export interface PrepareExternalEstimateLogOperation extends ExternalEstimateLogIdentity {
  operationId: string;
  deltaMinutes: number;
  estimateTotalMinutes: number;
  startedAt: string;
  connectionId: string;
  connectionGeneration: number;
  expectedRevision: number;
  /** Dated target of the pending delta; null keeps the legacy aggregate shape. */
  activityDate: string | null;
  /** Canonical IANA zone; binds when unset and rebinds when changed. */
  aggregationTimeZone: string | null;
  /**
   * Captured validated daily projection. Before the pending row is written,
   * remaining scalar credit materializes oldest-first into these buckets
   * without changing loggedMinutes; excess credit stays unallocated.
   */
  capturedDailyTotals: ReadonlyArray<ExternalEstimateDailyTotal>;
}

export interface ExternalEstimateLogOperationMutation extends ExternalEstimateLogIdentity {
  operationId: string;
  expectedRevision: number;
}

export interface StoreExternalEstimateLogResolution extends ExternalEstimateLogOperationMutation {
  resolution: ExternalEstimateLogPendingResolution;
}

/**
 * One-time claim of unassigned legacy checkpoint history: moves the complete
 * scalar state and every dated row of the reserved legacy identity to the
 * requesting project. The connection epoch is revalidated inside the same
 * transaction; the expected legacy revision fences concurrent claims so
 * exactly one winner exists.
 */
export interface AssignUnassignedExternalEstimateLogCheckpoint {
  /** Project claiming the legacy history; must be a real project id. */
  projectId: string;
  provider: IntegrationProvider;
  remoteScopeKey: string;
  remoteTaskId: string;
  expectedRevision: number;
  connectionId: string;
  connectionGeneration: number;
}

export interface CreateEpicWithExternalTaskLink {
  epic: CreateEpic;
  externalTaskLink: Omit<CreateExternalTaskLink, 'epicId'>;
}

export interface CreateEpicWithExternalTaskLinkResult {
  epic: Epic;
  externalTaskLink: ExternalTaskLink;
  created: boolean;
}

export const EXTERNAL_MANAGED_SUBTASK_OPERATION_PHASES = [
  'pre_dispatch',
  'dispatch_admitted',
  'outcome_unknown',
  'confirmed',
  'needs_attention',
] as const;
export type ExternalManagedSubtaskOperationPhase =
  (typeof EXTERNAL_MANAGED_SUBTASK_OPERATION_PHASES)[number];

export const EXTERNAL_MANAGED_SUBTASK_TOMBSTONE_STATES = [
  'active',
  'local_deleted',
  'move_out',
  'orphan_risk',
] as const;
export type ExternalManagedSubtaskTombstoneState =
  (typeof EXTERNAL_MANAGED_SUBTASK_TOMBSTONE_STATES)[number];

export interface ExternalManagedSubtaskLink {
  id: string;
  epicId: string | null;
  epicIdSnapshot: string;
  parentEpicIdSnapshot: string;
  parentSourceLinkIdSnapshot: string;
  connectionIdSnapshot: string;
  provider: IntegrationProvider;
  remoteScopeKey: string;
  workAreaRemoteId: string;
  parentRemoteTaskId: string;
  connectionGeneration: number;
  syncSettingRevision: number;
  ownershipToken: string;
  remoteTaskId: string | null;
  remoteKey: string | null;
  desiredVersion: number;
  confirmedVersion: number | null;
  desiredFingerprint: string;
  confirmedFingerprint: string | null;
  operationPhase: ExternalManagedSubtaskOperationPhase;
  safeErrorCode: string | null;
  retryAt: string | null;
  tombstoneState: ExternalManagedSubtaskTombstoneState;
  tombstonedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExternalManagedSubtaskLink {
  epicId: string;
  epicIdSnapshot: string;
  parentEpicIdSnapshot: string;
  parentSourceLinkIdSnapshot: string;
  connectionIdSnapshot: string;
  provider: IntegrationProvider;
  remoteScopeKey: string;
  workAreaRemoteId: string;
  parentRemoteTaskId: string;
  connectionGeneration: number;
  syncSettingRevision: number;
  ownershipToken: string;
  desiredVersion: number;
  desiredFingerprint: string;
  operationPhase?: ExternalManagedSubtaskOperationPhase;
  tombstoneState?: ExternalManagedSubtaskTombstoneState;
}

export interface UpdateExternalManagedSubtaskLink {
  connectionIdSnapshot?: string;
  connectionGeneration?: number;
  syncSettingRevision?: number;
  remoteTaskId?: string | null;
  remoteKey?: string | null;
  desiredVersion?: number;
  confirmedVersion?: number | null;
  desiredFingerprint?: string;
  confirmedFingerprint?: string | null;
  operationPhase?: ExternalManagedSubtaskOperationPhase;
  safeErrorCode?: string | null;
  retryAt?: string | null;
  tombstoneState?: ExternalManagedSubtaskTombstoneState;
  tombstonedAt?: string | null;
}

export interface ConfirmExternalManagedSubtaskLink {
  managedLinkId: string;
  remoteTaskId: string;
  remoteKey: string;
  confirmedVersion: number;
  confirmedFingerprint: string;
  sourceSnapshot: Record<string, unknown>;
}

export interface ConfirmExternalManagedSubtaskLinkResult {
  managedLink: ExternalManagedSubtaskLink;
  externalTaskLink: ExternalTaskLink;
}

export type SkillStatus = 'available' | 'outdated' | 'sync_error';

export interface Skill {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string | null;
  shortDescription: string | null;
  source: string;
  sourceUrl: string | null;
  sourceCommit: string | null;
  category: string | null;
  license: string | null;
  compatibility: string | null;
  frontmatter: Record<string, unknown> | null;
  instructionContent: string | null;
  contentPath: string | null;
  resources: string[];
  status: SkillStatus;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillProjectDisabled {
  id: string;
  projectId: string;
  skillId: string;
  createdAt: string;
}

export interface SkillUsageLog {
  id: string;
  skillId: string;
  skillSlug: string;
  projectId: string | null;
  agentId: string | null;
  agentNameSnapshot: string | null;
  accessedAt: string;
}

export interface CommunitySkillSource {
  id: string;
  name: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalSkillSource {
  id: string;
  name: string;
  folderPath: string;
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
  autoCompactThreshold: number | null; // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (1-100), null = don't inject
  claudeLaunchSettingsJson: string | null;
  env: Record<string, string> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderModel {
  id: string;
  providerId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderEffort {
  id: string;
  providerId: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderMcpMetadata {
  mcpConfigured: boolean;
  mcpEndpoint: string | null;
  mcpRegisteredAt: string | null;
}

export interface ProviderPluginDefault {
  providerId: string;
  pluginId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectProviderPluginOverride extends ProviderPluginDefault {
  projectId: string;
}

export type UpsertProviderPluginDefault = Pick<
  ProviderPluginDefault,
  'providerId' | 'pluginId' | 'enabled'
>;

export type UpsertProjectProviderPluginOverride = Pick<
  ProjectProviderPluginOverride,
  'projectId' | 'providerId' | 'pluginId' | 'enabled'
>;

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
  providerName?: string; // Resolved from providers.name via JOIN
  name: string; // User-friendly name to distinguish configs (unique per profile)
  description: string | null;
  options: string | null; // JSON string for provider-specific options
  env: Record<string, string> | null; // Environment variables (stored as JSON)
  model: string | null; // Structured default model selected from provider catalog
  effort: string | null; // Structured default effort selected from provider catalog
  position: number; // Order within profile (0, 1, 2, ...)
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  projectId: string;
  isProjectOwner: boolean;
  profileId: string;
  providerConfigId: string; // FK to profile_provider_configs.id
  modelOverride: string | null;
  effortOverride: string | null;
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
export type CreateProject = Omit<Project, 'id' | 'workspaceId' | 'createdAt' | 'updatedAt'> & {
  workspaceId?: string;
};
export type UpdateProject = Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateStatus = Omit<Status, 'id' | 'mcpHidden' | 'createdAt' | 'updatedAt'> & {
  mcpHidden?: boolean;
};
export type UpdateStatus = Partial<Omit<Status, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateEpic = Omit<
  Epic,
  | 'id'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
  | 'parentId'
  | 'agentId'
  | 'createdBy'
  | 'skillsRequired'
> & {
  parentId?: string | null;
  agentId?: string | null;
  createdBy?: string | null;
  skillsRequired?: string[] | null;
};
export type UpdateEpic = Partial<Omit<Epic, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'>>;

export type CreateSkill = Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateSkill = Partial<Omit<Skill, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateSkillProjectDisabled = Omit<SkillProjectDisabled, 'id' | 'createdAt'>;
export type UpdateSkillProjectDisabled = Partial<Omit<SkillProjectDisabled, 'id' | 'createdAt'>>;

export type CreateSkillUsageLog = Omit<SkillUsageLog, 'id'>;
export type UpdateSkillUsageLog = Partial<Omit<SkillUsageLog, 'id'>>;

export type CreateCommunitySkillSource = Omit<
  CommunitySkillSource,
  'id' | 'createdAt' | 'updatedAt' | 'branch'
> & {
  branch?: string;
};

export type CreateLocalSkillSource = Omit<LocalSkillSource, 'id' | 'createdAt' | 'updatedAt'>;

export type CreatePrompt = Omit<Prompt, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
export type UpdatePrompt = Partial<Omit<Prompt, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateTag = Omit<Tag, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateTag = Partial<Omit<Tag, 'id' | 'createdAt' | 'updatedAt'>>;

export interface CreateProvider extends Partial<ProviderMcpMetadata> {
  name: string;
  binPath?: string | null;
  autoCompactThreshold?: number | null;
  claudeLaunchSettingsJson?: string | null;
  env?: Record<string, string> | null;
}
export type CreateProviderModel = Omit<
  ProviderModel,
  'id' | 'createdAt' | 'updatedAt' | 'position'
> & {
  position?: number;
};
export type CreateProviderEffort = Omit<
  ProviderEffort,
  'id' | 'createdAt' | 'updatedAt' | 'position'
> & {
  position?: number;
};
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
  description?: string | null;
  options: string | null;
  env: Record<string, string> | null;
  model?: string | null;
  effort?: string | null;
  position?: number; // Optional - defaults to max(position)+1 in storage service
};
export type UpdateProfileProviderConfig = Partial<
  Omit<ProfileProviderConfig, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>
>;

export type CreateAgent = Omit<
  Agent,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'description'
  | 'providerConfigId'
  | 'modelOverride'
  | 'effortOverride'
  | 'isProjectOwner'
> & {
  description?: string | null;
  providerConfigId: string;
  modelOverride?: string | null;
  effortOverride?: string | null;
  isProjectOwner?: boolean;
};
export type UpdateAgent = Partial<Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateEpicRecord = Omit<EpicRecord, 'id' | 'version' | 'createdAt' | 'updatedAt'>;
export type UpdateEpicRecord = Partial<Omit<EpicRecord, 'id' | 'createdAt' | 'updatedAt'>>;

export type CreateEpicComment = Omit<EpicComment, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateEpicComment = Partial<Omit<EpicComment, 'id' | 'createdAt' | 'updatedAt'>>;

// ============================================
// PROVIDER ENV SCOPES
// ============================================

export type EnvScopesMap = Record<string, string[]>;

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
  idleAfterSeconds: number;
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

export interface EventFilterCondition {
  field: string;
  operator: 'equals' | 'contains' | 'regex' | 'is_null' | 'is_not_null';
  value: string;
}

export interface EventFilterGroup {
  combinator: 'and' | 'or';
  filters: [EventFilterCondition, ...EventFilterCondition[]];
}

export type EventFilter = EventFilterCondition | EventFilterGroup;

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
// TEAMS - Agent team organization
// ============================================

export interface Team {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  teamLeadAgentId: string | null;
  maxMembers: number;
  maxConcurrentTasks: number;
  allowTeamLeadCreateAgents: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  teamId: string;
  agentId: string;
  createdAt: string;
}

export interface TeamProfile {
  teamId: string;
  profileId: string;
  createdAt: string;
}

export interface TeamProfileConfig {
  teamId: string;
  profileId: string;
  providerConfigId: string;
  createdAt: string;
}

export type CreateTeam = {
  projectId: string;
  name: string;
  description?: string | null;
  teamLeadAgentId?: string | null;
  maxMembers?: number;
  maxConcurrentTasks?: number;
  allowTeamLeadCreateAgents?: boolean;
  memberAgentIds: string[];
  profileIds?: string[];
  profileConfigSelections?: Array<{ profileId: string; configIds: string[] }>;
};

export type UpdateTeam = {
  name?: string;
  description?: string | null;
  teamLeadAgentId?: string | null;
  maxMembers?: number;
  maxConcurrentTasks?: number;
  allowTeamLeadCreateAgents?: boolean;
  memberAgentIds?: string[];
  profileIds?: string[];
  profileConfigSelections?: Array<{ profileId: string; configIds: string[] }>;
};

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

// ============================================
// SCHEDULED EPICS
// ============================================

export type ScheduledEpicMissedRunPolicy = 'skip' | 'run_once' | 'run_all';
export type ScheduledEpicRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type ScheduledEpicRunSource = 'scheduler' | 'manual';

export interface ScheduledEpic {
  id: string;
  projectId: string;
  name: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  titleTemplate: string;
  descriptionTemplate: string | null;
  templateStatusId: string | null;
  templateParentEpicId: string | null;
  templateAgentId: string | null;
  templateTags: string[];
  allowOverlap: boolean;
  missedRunPolicy: ScheduledEpicMissedRunPolicy;
  configVersion: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledEpicRun {
  id: string;
  scheduleId: string;
  plannedFor: string;
  source: ScheduledEpicRunSource;
  status: ScheduledEpicRunStatus;
  createdEpicId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateScheduledEpic = Omit<
  ScheduledEpic,
  | 'id'
  | 'configVersion'
  | 'nextRunAt'
  | 'lastRunAt'
  | 'lastRunStatus'
  | 'lastError'
  | 'createdAt'
  | 'updatedAt'
> & {
  nextRunAt?: string | null;
};

export type UpdateScheduledEpic = Partial<
  Omit<
    ScheduledEpic,
    | 'id'
    | 'projectId'
    | 'configVersion'
    | 'nextRunAt'
    | 'lastRunAt'
    | 'lastRunStatus'
    | 'lastError'
    | 'createdAt'
    | 'updatedAt'
  >
>;

export type UpdateScheduledEpicRuntimeState = Partial<
  Pick<ScheduledEpic, 'nextRunAt' | 'lastRunAt' | 'lastRunStatus' | 'lastError'>
>;

export type CreateScheduledEpicRun = Omit<
  ScheduledEpicRun,
  'id' | 'createdEpicId' | 'startedAt' | 'finishedAt' | 'errorMessage' | 'createdAt' | 'updatedAt'
>;

export type UpdateScheduledEpicRun = Partial<
  Pick<ScheduledEpicRun, 'status' | 'createdEpicId' | 'startedAt' | 'finishedAt' | 'errorMessage'>
>;
