import type {
  ProjectReplicaAttachTables,
  ProjectReplicaIdSets,
  ProjectReplicaRow,
  ProjectReplicaV1,
  ReplicaInstanceSettings,
} from '@devchain/shared';
import type { FeatureFlagConfig } from '../../../common/config/feature-flags';
import type { PreparedEvent } from '../../events/services/durable-event-registry.service';
import {
  Project,
  CreateProject,
  UpdateProject,
  ProjectWorkspace,
  DeleteProjectWorkspaceResult,
  Remote,
  CreateRemote,
  VmProviderConnection,
  CreateVmProviderConnection,
  RemoteProjectBinding,
  UpdateRemoteProjectBinding,
  RemoteOperation,
  CreateRemoteOperation,
  UpdateRemoteOperation,
  RemoteOperationState,
  RemoteOperationKind,
  Status,
  CreateStatus,
  UpdateStatus,
  Epic,
  CreateEpic,
  UpdateEpic,
  Prompt,
  CreatePrompt,
  UpdatePrompt,
  Tag,
  CreateTag,
  UpdateTag,
  Provider,
  CreateProvider,
  ProviderModel,
  CreateProviderModel,
  ProviderEffort,
  CreateProviderEffort,
  UpdateProvider,
  ProviderMcpMetadata,
  UpdateProviderMcpMetadata,
  ProviderPluginDefault,
  ProjectProviderPluginOverride,
  UpsertProviderPluginDefault,
  UpsertProjectProviderPluginOverride,
  EnvScopesMap,
  AgentProfile,
  CreateAgentProfile,
  UpdateAgentProfile,
  ProfileProviderConfig,
  CreateProfileProviderConfig,
  UpdateProfileProviderConfig,
  Agent,
  CreateAgent,
  UpdateAgent,
  EpicRecord,
  CreateEpicRecord,
  UpdateEpicRecord,
  EpicComment,
  CreateEpicComment,
  Guest,
  CreateGuest,
  Watcher,
  CreateWatcher,
  UpdateWatcher,
  Subscriber,
  CreateSubscriber,
  UpdateSubscriber,
  Review,
  CreateReview,
  UpdateReview,
  ReviewComment,
  ReviewCommentEnriched,
  CreateReviewComment,
  UpdateReviewComment,
  ReviewCommentTarget,
  ReviewStatus,
  ReviewCommentStatus,
  CommunitySkillSource,
  CreateCommunitySkillSource,
  LocalSkillSource,
  CreateLocalSkillSource,
  ScheduledEpic,
  CreateScheduledEpic,
  UpdateScheduledEpic,
  UpdateScheduledEpicRuntimeState,
  ScheduledEpicRun,
  CreateScheduledEpicRun,
  UpdateScheduledEpicRun,
  ScheduledEpicRunStatus,
  CreateExternalTaskLink,
  ExternalTaskLink,
  IntegrationConnection,
  IntegrationConnectionLookup,
  IntegrationCredentials,
  IntegrationProvider,
  ReplaceIntegrationConnection,
  CreateEpicWithExternalTaskLink,
  CreateEpicWithExternalTaskLinkResult,
  CreateExternalManagedSubtaskLink,
  UpdateExternalManagedSubtaskLink,
  ExternalManagedSubtaskLink,
  ConfirmExternalManagedSubtaskLink,
  ConfirmExternalManagedSubtaskLinkResult,
  EpicRelationCandidate,
  EpicRelationListItem,
  EpicRelationSummary,
  EpicRelationWriteContext,
  SetEpicRelationResult,
  DeleteEpicRelationResult,
  SetEpicRelation,
  AssignUnassignedExternalEstimateLogCheckpoint,
  ExternalEstimateLoggedMinutesEntry,
  ExternalEstimateLogDailyCheckpoint,
  ExternalEstimateLogIdentity,
  ExternalEstimateLogOperationMutation,
  ExternalEstimateLogState,
  PrepareExternalEstimateLogOperation,
  SetExternalEstimateLoggedMinutes,
  StoreExternalEstimateLogResolution,
  CreateProviderAuthEntry,
  ProviderAuthEntry,
  ProviderAuthPayload,
} from '../models/domain.models';

export type VerifyIntegrationCredentials = (credentials: IntegrationCredentials) => Promise<void>;

export interface ListOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
}

export interface ProjectListOptions extends ListOptions {
  workspaceId?: string;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProfileListOptions extends ListOptions {
  // When provided, filters profiles to a specific project.
  // When null, lists only global profiles (if any).
  // When undefined, lists across all projects (back-compat for admin/provider checks).
  projectId?: string | null;
}

export interface PromptListFilters {
  projectId?: string | null;
  q?: string;
  limit?: number;
  offset?: number;
}

/**
 * Prompt summary with content preview (for list operations).
 * Used in autocomplete and list results where full content is not needed.
 */
export interface PromptSummary {
  id: string;
  projectId: string | null;
  title: string;
  contentPreview: string;
  version: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type EpicListType = 'active' | 'archived' | 'all';

export interface ListProjectEpicsOptions {
  statusId?: string;
  q?: string;
  limit?: number;
  offset?: number;
  // When provided, filters by archived type:
  //  - 'active' (default): exclude items in the 'Archived' status (case-insensitive)
  //  - 'archived': include only items in the 'Archived' status
  //  - 'all': include both active and archived
  type?: EpicListType;
  /**
   * When true, excludes epics whose status has mcpHidden=true, as well as
   * all descendants of such epics (regardless of their own status).
   * Default: false (no filtering) to maintain backward compatibility with Board UI.
   * Used by MCP tools to hide epics from agent visibility.
   */
  excludeMcpHidden?: boolean;
  /**
   * When true, returns only top-level epics (where parentId IS NULL).
   * Used for hierarchical list responses where sub-epics are nested.
   * Default: false (returns all epics regardless of parent).
   */
  parentOnly?: boolean;
}

export interface ListAssignedEpicsOptions {
  agentName: string;
  limit?: number;
  offset?: number;
  /**
   * When true, excludes epics whose status has mcpHidden=true, as well as
   * all descendants of such epics (regardless of their own status).
   * Default: false (no filtering) to maintain backward compatibility.
   */
  excludeMcpHidden?: boolean;
}

export interface ListSubEpicsForParentsOptions {
  /**
   * When true, excludes sub-epics whose status has mcpHidden=true.
   * Default: false (no filtering).
   */
  excludeMcpHidden?: boolean;
  /**
   * Archived filter type: 'active' (default), 'archived', or 'all'.
   */
  type?: EpicListType;
  /**
   * Maximum sub-epics to return per parent. Default: 50.
   */
  limitPerParent?: number;
}

export interface ListParentChildrenOptions extends ListOptions {
  statusId?: string;
}

export interface ListEpicRelationCandidatesOptions extends ListOptions {
  q?: string;
  excludeMcpHidden?: boolean;
  workspaceId?: string;
}

export interface EpicRelationReadOptions {
  excludeMcpHidden?: boolean;
  workspaceId?: string;
}

export interface ListEpicRelationsOptions extends EpicRelationReadOptions, ListOptions {
  relatedEpicId?: string;
}

export interface CreateEpicForProjectInput {
  title: string;
  description?: string | null;
  tags?: string[];
  statusId?: string;
  agentId?: string | null;
  agentName?: string;
  createdBy?: string | null;
  parentId?: string | null;
  skillsRequired?: string[] | null;
}

export interface ListReviewsOptions extends ListOptions {
  status?: ReviewStatus;
  epicId?: string;
}

export interface ListReviewCommentsOptions extends ListOptions {
  status?: ReviewCommentStatus;
  filePath?: string;
  parentId?: string | null; // null for top-level only, undefined for all
}

/**
 * StorageService interface
 * Provides CRUD operations for all domain entities
 * Implementation: LocalStorage (SQLite)
 */
export interface CreateProjectWithTemplateOptions {
  projectId?: string;
}

export type ExistingProjectsEnablement =
  | { mode: 'none' }
  | { mode: 'all' }
  | { mode: 'selected'; projectIds: string[] };

export interface CreateSkillSourceOptions {
  existingProjects?: ExistingProjectsEnablement;
}

export type FactualEventFactory<TCurrent, TPrevious = never> = (
  current: TCurrent,
  previous: TPrevious,
) => PreparedEvent | null;

export interface ProjectStorage {
  createProject(data: CreateProject): Promise<Project>;
  /**
   * Run `fn` inside a single WAL-safe IMMEDIATE transaction. Storage calls made by `fn`
   * (which share the connection) participate in the transaction and roll back together on
   * throw. Used by the pipeline create-new core so the project row + statuses + prompts +
   * profiles + configs + agents are atomic (no orphan project row on mid-core failure).
   */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Insert a project row and seed enabled skill sources without default statuses. The method
   * joins the exact outer `runInTransaction` owner when present, otherwise it opens its own
   * queued transaction. The template supplies statuses via the statuses codec.
   */
  createProjectShell(
    data: CreateProject,
    options?: CreateProjectWithTemplateOptions,
  ): Promise<Project>;
  getProject(id: string): Promise<Project>;
  findProjectByPath(path: string): Promise<Project | null>;
  listProjects(options?: ProjectListOptions): Promise<ListResult<Project>>;
  /**
   * Return every project whose stored ID starts with `prefix`, matching the
   * address case-insensitively. A full UUID can be supplied and is therefore
   * treated as an exact address match. Invalid or wildcard-bearing prefixes
   * return an empty array rather than being interpreted as a pattern.
   */
  getProjectsByIdPrefix(prefix: string): Promise<Project[]>;
  updateProject(id: string, data: UpdateProject): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  getProjectByRootPath(rootPath: string): Promise<Project | null>;
  findProjectContainingPath(absolutePath: string): Promise<Project | null>;
  /**
   * Return the project and its same-workspace peers in project-ID order from one SQL snapshot.
   * The caller derives the owning project from the returned rows.
   */
  getProjectWorkspaceSnapshot(projectId: string): Promise<Project[]>;
  getFeatureFlags(): FeatureFlagConfig;
}

export interface ProjectWorkspaceStorage {
  listProjectWorkspaces(): Promise<ProjectWorkspace[]>;
  getProjectWorkspace(id: string): Promise<ProjectWorkspace>;
  createProjectWorkspace(name: string): Promise<ProjectWorkspace>;
  renameProjectWorkspace(id: string, name: string): Promise<ProjectWorkspace>;
  reorderProjectWorkspaces(workspaceIds: string[]): Promise<ProjectWorkspace[]>;
  deleteProjectWorkspace(id: string, replacementId: string): Promise<DeleteProjectWorkspaceResult>;
}

export interface ReadProjectReplicaSourceOptions {
  /** Prompts, teams, watchers, subscribers, schedules, settings, reviews, skill switches and env scopes. */
  includeConfiguration: boolean;
  /** Sessions and epic-time watermarks. */
  includeSessions: boolean;
  /** Workspace grant snapshot for a one-way attach. */
  includeWorkspaceGrants?: boolean;
  /**
   * Limits epics (with their tags and comments) to those whose row or any
   * comment changed after this ISO time, and segments to those updated after it.
   */
  changedSince?: string;
  /** Adds the complete epic, comment and segment ID sets of the projects. */
  includeIdSets?: boolean;
}

/** A stored `provider_models` or `provider_efforts` row. */
export interface ProviderCatalogSourceRow {
  id: string;
  provider_id: string;
  name: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/**
 * Raw storage rows for a replica, read in one transaction. Referenced profiles,
 * provider configs, prompts and tags are fetched by ID even when they belong to
 * another project, so the caller can decide whether they may travel.
 */
export interface ProjectReplicaSource {
  /** Host time read inside the same transaction as the rows. */
  readAt: string;
  projects: ProjectReplicaRow<'projects'>[];
  workspaces: Array<{ id: string; name: string }>;
  paired_device_workspace_grants: ProjectReplicaRow<'paired_device_workspace_grants'>[];
  authorityKids: string[];
  statuses: ProjectReplicaRow<'statuses'>[];
  tags: ProjectReplicaRow<'tags'>[];
  providers: Array<{ id: string; name: string; env: string | null }>;
  agent_profiles: ProjectReplicaRow<'agent_profiles'>[];
  profile_provider_configs: ProjectReplicaRow<'profile_provider_configs'>[];
  agents: ProjectReplicaRow<'agents'>[];
  epics: ProjectReplicaRow<'epics'>[];
  epic_tags: ProjectReplicaRow<'epic_tags'>[];
  epic_comments: ProjectReplicaRow<'epic_comments'>[];
  /** Every relation touching a requested project's epic, with each end's project. */
  epic_relations: Array<
    ProjectReplicaRow<'epic_relations'> & { left_project_id: string; right_project_id: string }
  >;
  epic_time_segments: ProjectReplicaRow<'epic_time_segments'>[];
  prompts: ProjectReplicaRow<'prompts'>[];
  prompt_tags: ProjectReplicaRow<'prompt_tags'>[];
  agent_profile_prompts: ProjectReplicaRow<'agent_profile_prompts'>[];
  teams: ProjectReplicaRow<'teams'>[];
  team_members: ProjectReplicaRow<'team_members'>[];
  team_profiles: ProjectReplicaRow<'team_profiles'>[];
  team_profile_configs: ProjectReplicaRow<'team_profile_configs'>[];
  terminal_watchers: ProjectReplicaRow<'terminal_watchers'>[];
  automation_subscribers: ProjectReplicaRow<'automation_subscribers'>[];
  scheduled_epics: ProjectReplicaRow<'scheduled_epics'>[];
  reviews: ProjectReplicaRow<'reviews'>[];
  review_comments: ProjectReplicaRow<'review_comments'>[];
  /** All scope rows of the referenced providers, including projects outside the replica. */
  provider_env_scopes: Array<{ provider_id: string; env_key: string; project_id: string }>;
  /**
   * Instance-level provider rows of the read closure's providers: scalars,
   * catalogs and plugin defaults. They travel on attach replicas only, with
   * the provider keyed by name in the builder.
   */
  provider_settings: Array<{
    provider_id: string;
    auto_compact_threshold: number | null;
    claude_launch_settings_json: string | null;
  }>;
  provider_models: ProviderCatalogSourceRow[];
  provider_efforts: ProviderCatalogSourceRow[];
  provider_plugin_defaults: Array<{
    provider_id: string;
    plugin_id: string;
    enabled: 0 | 1;
    created_at: string;
    updated_at: string;
  }>;
  project_provider_plugin_overrides: ProjectReplicaAttachTables['project_provider_plugin_overrides'];
  sender_skill_slugs: string[];
  skill_project_disabled: ProjectReplicaAttachTables['skill_project_disabled'];
  source_project_enabled: ProjectReplicaAttachTables['source_project_enabled'];
  /** Stored `settings` rows for `PROJECT_REPLICA_SETTING_KEYS`; `value` is the raw JSON text. */
  settings: Array<{ key: string; value: string }>;
  /**
   * This instance's effective global agent settings (message pool, epic
   * template, skill sources, idle timeout), resolved with defaults. Read with
   * the configuration tier; only the builder's attach scope carries them.
   */
  instanceSettings: ReplicaInstanceSettings;
  sessions: ProjectReplicaRow<'sessions'>[];
  epic_time_session_watermarks: ProjectReplicaRow<'epic_time_session_watermarks'>[];
  idSets?: { epics: string[]; epic_comments: string[]; epic_time_segments: string[] };
}

/**
 * `full` reconciles every table the payload carries: rows of the payload's
 * projects that the payload omits are deleted. `live` deletes only from the
 * tables that arrive whole on every pull (statuses, tags, profiles, provider
 * configs, agents, relations); epics, comments and segments are upsert-only.
 */
export type ProjectReplicaApplyMode = 'full' | 'live';

export interface ProjectReplicaApplySummary {
  projectId: string;
  /** Epics inserted or updated, including epics whose tags or comments changed. */
  changedEpicIds: string[];
  deletedEpicIds: string[];
  /** Per-project rows skipped because their skill slug is not installed here. */
  skippedUnknownSkillCount: number;
}

export interface ProjectReplicaStorage {
  readProjectReplicaSource(
    projectIds: readonly string[],
    options: ReadProjectReplicaSourceOptions,
  ): Promise<ProjectReplicaSource>;
  /**
   * Applies a replica with its IDs in one transaction and appends the factory's
   * event for each payload project inside it. Throws `ReplicaApplyError` after
   * rolling back.
   */
  applyProjectReplica(
    replica: ProjectReplicaV1,
    mode: ProjectReplicaApplyMode,
    eventFactory: (summary: ProjectReplicaApplySummary) => PreparedEvent,
    options?: ApplyProjectReplicaStorageOptions,
  ): Promise<ProjectReplicaApplySummary[]>;
}

export interface ApplyProjectReplicaStorageOptions {
  /** Throw `ConflictError` (`PROJECT_EXISTS`) inside the transaction if a payload project exists. */
  requireNewProjects?: boolean;
  /**
   * The host's complete ID sets. In `live` mode, epics, comments and settled
   * segments of the payload projects that are not in them are deleted.
   */
  idSets?: ProjectReplicaIdSets;
  /**
   * Leave this instance's provider env values, provider catalogs, provider
   * scalars and plugin policy untouched: this instance is authoritative for
   * them (home re-snapshots and live pulls).
   */
  keepInstanceConfig?: boolean;
  /**
   * Written to `projects.frozen_at` of the payload projects in the apply
   * transaction, so a project created by the apply is never committed writable.
   */
  frozenAt?: string;
}

export interface FrozenProject {
  projectId: string;
  frozenAt: string;
}

export interface ProjectHostStorage {
  /** `frozenAt` null thaws. Throws `NotFoundError` for an unknown project. */
  setProjectFrozen(projectId: string, frozenAt: string | null): Promise<void>;
  listFrozenProjects(): Promise<FrozenProject[]>;
  /** Throws `ConflictError` (`PROJECT_NOT_FROZEN`) unless the project is frozen. */
  releaseProject(projectId: string): Promise<void>;
  findEpicIdByIdempotencyKey(projectId: string, key: string): Promise<string | null>;
}

export interface RemoteStorage {
  readRemoteApiKey(id: string): Promise<string | null>;
  saveRemoteApiKey(id: string, key: string, onlyIfAbsent?: boolean): Promise<void>;
  createRemote(data: CreateRemote): Promise<Remote>;
  getRemote(id: string): Promise<Remote>;
  listRemotes(options?: ListOptions): Promise<ListResult<Remote>>;
  updateRemoteName(id: string, name: string): Promise<Remote>;
  updateRemoteBaseUrl(id: string, baseUrl: string | null): Promise<Remote>;
  updateRemoteVmIdentity(id: string, vmIdentity: string | null): Promise<Remote>;
  /** Stores the VM certificate (PEM), or clears it with null; refuses one that does not parse. */
  updateRemoteTlsCertificate(id: string, certificate: string | null): Promise<Remote>;
  createVmProviderConnection(data: CreateVmProviderConnection): Promise<VmProviderConnection>;
  listVmProviderConnections(): Promise<VmProviderConnection[]>;
  getVmProviderConnection(id: string): Promise<VmProviderConnection>;
  readVmProviderTokenSecret(id: string): Promise<string>;
  deleteVmProviderConnection(id: string): Promise<void>;
  /** Refuses (409) while any binding still references the remote. */
  deleteRemote(id: string): Promise<void>;
  listRemoteProjectBindings(): Promise<RemoteProjectBinding[]>;
  getRemoteProjectBinding(projectId: string): Promise<RemoteProjectBinding | null>;
  /** Creates the binding in state `attaching`; 409 `REMOTE_BINDING_EXISTS` if the project has one. */
  createRemoteProjectBinding(data: {
    projectId: string;
    remoteId: string;
  }): Promise<RemoteProjectBinding>;
  updateRemoteProjectBinding(
    projectId: string,
    data: UpdateRemoteProjectBinding,
  ): Promise<RemoteProjectBinding>;
  /** Returns the deleted row, or null when the project had no binding. */
  deleteRemoteProjectBinding(projectId: string): Promise<RemoteProjectBinding | null>;
  /** 409 `REMOTE_OPERATION_IN_PROGRESS` while the project has a `running` or `failed` operation. */
  createRemoteOperation(data: CreateRemoteOperation): Promise<RemoteOperation>;
  getRemoteOperation(id: string): Promise<RemoteOperation>;
  /** Newest first. */
  listRemoteOperations(filter?: {
    states?: readonly RemoteOperationState[];
    projectId?: string;
    remoteId?: string;
    kinds?: readonly RemoteOperationKind[];
    limit?: number;
  }): Promise<RemoteOperation[]>;
  updateRemoteOperation(id: string, data: UpdateRemoteOperation): Promise<RemoteOperation>;
}

export interface ProviderAuthStorage {
  listProviderAuthEntries(): Promise<ProviderAuthEntry[]>;
  getProviderAuthEntry(id: string): Promise<ProviderAuthEntry>;
  /** Decrypts one entry's payload; only the claim/compose path may call this. */
  readProviderAuthPayload(id: string): Promise<ProviderAuthPayload>;
  createProviderAuthEntry(data: CreateProviderAuthEntry): Promise<ProviderAuthEntry>;
  deleteProviderAuthEntry(id: string): Promise<void>;
  /** Re-encrypts one entry's payload and stamps `last_writeback_at` (family write-back only). */
  updateProviderAuthPayload(id: string, payload: ProviderAuthPayload): Promise<ProviderAuthEntry>;
  /** Renames one entry; `label` and `updated_at` change, the payload and checkout state stay. */
  renameProviderAuthEntry(id: string, label: string): Promise<ProviderAuthEntry>;
  /** 409 `PROVIDER_AUTH_ALREADY_CHECKED_OUT` for a family held by another remote; static never checks out. */
  checkoutProviderAuthEntry(id: string, remoteId: string): Promise<ProviderAuthEntry>;
  releaseProviderAuthEntry(id: string): Promise<ProviderAuthEntry>;
}

export interface StatusStorage {
  createStatus(data: CreateStatus): Promise<Status>;
  getStatus(id: string): Promise<Status>;
  listStatuses(projectId: string, options?: ListOptions): Promise<ListResult<Status>>;
  findStatusByName(projectId: string, name: string): Promise<Status | null>;
  updateStatus(id: string, data: UpdateStatus): Promise<Status>;
  deleteStatus(id: string): Promise<void>;
}

export interface EpicStorage {
  createEpic(data: CreateEpic, eventFactory?: (epic: Epic) => PreparedEvent | null): Promise<Epic>;
  /**
   * The optional hook runs after the Epic and tags exist but before the durable event is
   * appended. It runs inside the caller-owned transaction; throwing rolls back all three.
   */
  createEpicWithinTransaction(
    data: CreateEpic,
    eventFactory?: (epic: Epic) => PreparedEvent | null,
    beforeEventAppend?: (epic: Epic) => Promise<void>,
  ): Promise<Epic>;
  getEpic(id: string): Promise<Epic>;
  listEpics(projectId: string, options?: ListOptions): Promise<ListResult<Epic>>;
  listEpicsByStatus(statusId: string, options?: ListOptions): Promise<ListResult<Epic>>;
  listProjectEpics(projectId: string, options?: ListProjectEpicsOptions): Promise<ListResult<Epic>>;
  listAssignedEpics(
    projectId: string,
    options: ListAssignedEpicsOptions,
  ): Promise<ListResult<Epic>>;
  createEpicForProject(
    projectId: string,
    input: CreateEpicForProjectInput,
    eventFactory?: (epic: Epic) => PreparedEvent | null,
  ): Promise<Epic>;
  updateEpic(
    id: string,
    data: UpdateEpic,
    expectedVersion: number,
    eventFactory?: FactualEventFactory<Epic, Epic>,
  ): Promise<Epic>;
  deleteEpic(
    id: string,
    eventFactory?: (epic: Epic, workspaceId: string) => PreparedEvent | null,
  ): Promise<void>;
  listSubEpics(parentId: string, options?: ListOptions): Promise<ListResult<Epic>>;
  listParentChildren(
    parentId: string,
    options?: ListParentChildrenOptions,
  ): Promise<ListResult<Epic>>;
  listSubEpicsForParents(
    projectId: string,
    parentIds: string[],
    options?: ListSubEpicsForParentsOptions,
  ): Promise<Map<string, Epic[]>>;
  countSubEpicsByStatus(parentId: string): Promise<Record<string, number>>;
  countEpicsByStatus(statusId: string): Promise<number>;
  updateEpicsStatus(oldStatusId: string, newStatusId: string): Promise<number>;
  listEpicComments(epicId: string, options?: ListOptions): Promise<ListResult<EpicComment>>;
  /**
   * Create a comment. When `eventFactory` is provided, the comment insert and the
   * factual event append (with its delivery rows) commit in one transaction; the
   * factory receives the stored comment and the transaction-loaded Epic. A factory
   * or append failure rolls back the comment.
   */
  createEpicComment(
    data: CreateEpicComment,
    eventFactory?: FactualEventFactory<EpicComment, Epic>,
  ): Promise<EpicComment>;
  deleteEpicComment(id: string): Promise<void>;
  /**
   * Delete a comment scoped to its owning epic (`WHERE id = ? AND epic_id = ?`).
   * Returns true when a row was deleted, false when none matched (comment from a
   * different epic, or already gone) so callers can surface a clean not-found.
   */
  deleteEpicCommentScoped(epicId: string, commentId: string): Promise<boolean>;
  getEpicsByIdPrefix(
    projectId: string,
    prefix: string,
  ): Promise<Array<{ id: string; title: string }>>;
  setEpicRelation(
    data: SetEpicRelation,
    context?: EpicRelationWriteContext,
  ): Promise<SetEpicRelationResult>;
  deleteEpicRelation(
    epicId: string,
    relatedEpicId: string,
    context?: EpicRelationWriteContext,
  ): Promise<DeleteEpicRelationResult>;
  listEpicRelations(
    epicId: string,
    options?: ListEpicRelationsOptions,
  ): Promise<ListResult<EpicRelationListItem>>;
  summarizeEpicRelationsBatch(
    epicIds: string[],
    options?: EpicRelationReadOptions,
  ): Promise<Map<string, EpicRelationSummary>>;
  listEpicRelationCandidates(
    epicId: string,
    options?: ListEpicRelationCandidatesOptions,
  ): Promise<ListResult<EpicRelationCandidate>>;
  getWorkspaceEpicsByIdPrefix(
    epicId: string,
    prefix: string,
    options?: EpicRelationReadOptions,
  ): Promise<EpicRelationCandidate[]>;
}

export interface PromptStorage {
  createPrompt(data: CreatePrompt): Promise<Prompt>;
  getPrompt(id: string): Promise<Prompt>;
  listPrompts(filters?: PromptListFilters): Promise<ListResult<PromptSummary>>;
  updatePrompt(id: string, data: UpdatePrompt, expectedVersion: number): Promise<Prompt>;
  deletePrompt(id: string): Promise<void>;
  getInitialSessionPrompt(projectId: string | null): Promise<Prompt | null>;
}

export interface TagStorage {
  createTag(data: CreateTag): Promise<Tag>;
  getTag(id: string): Promise<Tag>;
  listTags(projectId: string | null, options?: ListOptions): Promise<ListResult<Tag>>;
  updateTag(id: string, data: UpdateTag): Promise<Tag>;
  deleteTag(id: string): Promise<void>;
}

export interface ProviderStorage {
  createProvider(data: CreateProvider): Promise<Provider>;
  createProviderModel(data: CreateProviderModel): Promise<ProviderModel>;
  listProviderModelsByProvider(providerId: string): Promise<ProviderModel[]>;
  listProviderModelsByProviderIds(providerIds: string[]): Promise<ProviderModel[]>;
  deleteProviderModel(id: string): Promise<void>;
  bulkCreateProviderModels(
    providerId: string,
    names: string[],
  ): Promise<{ added: string[]; existing: string[] }>;
  createProviderEffort(data: CreateProviderEffort): Promise<ProviderEffort>;
  listProviderEffortsByProvider(providerId: string): Promise<ProviderEffort[]>;
  listProviderEffortsByProviderIds(providerIds: string[]): Promise<ProviderEffort[]>;
  deleteProviderEffort(id: string): Promise<void>;
  bulkCreateProviderEfforts(
    providerId: string,
    names: string[],
  ): Promise<{ added: string[]; existing: string[] }>;
  getProvider(id: string): Promise<Provider>;
  listProviders(options?: ListOptions): Promise<ListResult<Provider>>;
  listProvidersByIds(ids: string[]): Promise<Provider[]>;
  updateProvider(id: string, data: UpdateProvider): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  getProviderEnvForProject(providerId: string, projectId: string): Record<string, string> | null;
  listEnvScopesByProviderIds(providerIds: string[]): Map<string, EnvScopesMap>;
  updateProviderWithScopes(
    id: string,
    data: UpdateProvider,
    envScopes: EnvScopesMap | undefined,
    currentEnvKeys: string[],
  ): Promise<Provider>;
  getProviderMcpMetadata(id: string): Promise<ProviderMcpMetadata>;
  updateProviderMcpMetadata(id: string, metadata: UpdateProviderMcpMetadata): Promise<Provider>;
}

export interface ProviderPluginPolicyStorage {
  upsertProviderPluginDefault(data: UpsertProviderPluginDefault): Promise<ProviderPluginDefault>;
  getProviderPluginDefault(
    providerId: string,
    pluginId: string,
  ): Promise<ProviderPluginDefault | null>;
  listProviderPluginDefaults(providerId: string): Promise<ProviderPluginDefault[]>;
  deleteProviderPluginDefault(providerId: string, pluginId: string): Promise<boolean>;
  upsertProjectProviderPluginOverride(
    data: UpsertProjectProviderPluginOverride,
  ): Promise<ProjectProviderPluginOverride>;
  getProjectProviderPluginOverride(
    projectId: string,
    providerId: string,
    pluginId: string,
  ): Promise<ProjectProviderPluginOverride | null>;
  listProjectProviderPluginOverrides(
    projectId: string,
    providerId: string,
  ): Promise<ProjectProviderPluginOverride[]>;
  deleteProjectProviderPluginOverride(
    projectId: string,
    providerId: string,
    pluginId: string,
  ): Promise<boolean>;
}

export interface SkillSourceStorage {
  listCommunitySkillSources(): Promise<CommunitySkillSource[]>;
  getCommunitySkillSource(id: string): Promise<CommunitySkillSource>;
  getCommunitySkillSourceByName(name: string): Promise<CommunitySkillSource | null>;
  createCommunitySkillSource(
    data: CreateCommunitySkillSource,
    options?: CreateSkillSourceOptions,
  ): Promise<CommunitySkillSource>;
  deleteCommunitySkillSource(id: string): Promise<void>;
  listLocalSkillSources(): Promise<LocalSkillSource[]>;
  getLocalSkillSource(id: string): Promise<LocalSkillSource | null>;
  getLocalSkillSourceByName(name: string): Promise<LocalSkillSource | null>;
  createLocalSkillSource(
    data: CreateLocalSkillSource,
    options?: CreateSkillSourceOptions,
  ): Promise<LocalSkillSource>;
  deleteLocalSkillSource(id: string): Promise<void>;
  getSourceProjectEnabled(projectId: string, sourceName: string): Promise<boolean | null>;
  setSourceProjectEnabled(
    projectId: string,
    sourceName: string,
    enabled: boolean,
    options?: { onlyIfMissing?: boolean },
  ): Promise<void>;
  listSourceProjectEnabled(
    projectId: string,
  ): Promise<Array<{ sourceName: string; enabled: boolean }>>;
}

export interface AgentProfileStorage {
  createAgentProfile(data: CreateAgentProfile): Promise<AgentProfile>;
  getAgentProfile(id: string): Promise<AgentProfile>;
  listAgentProfiles(options?: ProfileListOptions): Promise<ListResult<AgentProfile>>;
  updateAgentProfile(id: string, data: UpdateAgentProfile): Promise<AgentProfile>;
  deleteAgentProfile(id: string): Promise<void>;
  setAgentProfilePrompts(profileId: string, promptIdsOrdered: string[]): Promise<void>;
  getAgentProfilePrompts(
    profileId: string,
  ): Promise<Array<{ promptId: string; createdAt: string }>>;
  getAgentProfileWithPrompts(
    id: string,
  ): Promise<AgentProfile & { prompts: Array<{ promptId: string; title: string; order: number }> }>;
  listAgentProfilesWithPrompts(
    options?: ProfileListOptions,
  ): Promise<
    ListResult<
      AgentProfile & { prompts: Array<{ promptId: string; title: string; order: number }> }
    >
  >;
}

export interface CreateIfMissingInput {
  profileId: string;
  providerId: string;
  name: string;
  description?: string | null;
  options?: string | null;
  env?: Record<string, string>;
  model?: string | null;
  effort?: string | null;
}

export interface CreateIfMissingResult {
  inserted: boolean;
  reason?:
    | 'name_exists_same_provider'
    | 'name_exists_other_provider'
    | 'position_conflict'
    | 'unknown_constraint';
  existingRow?: ProfileProviderConfig;
}

export interface ProfileProviderConfigStorage {
  createProfileProviderConfig(data: CreateProfileProviderConfig): Promise<ProfileProviderConfig>;
  createIfMissing(input: CreateIfMissingInput): Promise<CreateIfMissingResult>;
  getProfileProviderConfig(id: string): Promise<ProfileProviderConfig>;
  listProfileProviderConfigsByProfile(profileId: string): Promise<ProfileProviderConfig[]>;
  listProfileProviderConfigsByIds(ids: string[]): Promise<ProfileProviderConfig[]>;
  listAllProfileProviderConfigs(): Promise<ProfileProviderConfig[]>;
  updateProfileProviderConfig(
    id: string,
    data: UpdateProfileProviderConfig,
  ): Promise<ProfileProviderConfig>;
  deleteProfileProviderConfig(id: string): Promise<void>;
  reorderProfileProviderConfigs(profileId: string, configIds: string[]): Promise<void>;
}

export interface DeleteAgentOptions {
  protectProjectOwner?: boolean;
  protectTeamLead?: boolean;
}

export interface AgentStorage {
  createAgent(data: CreateAgent): Promise<Agent>;
  getAgent(id: string): Promise<Agent>;
  listAgents(projectId: string, options?: ListOptions): Promise<ListResult<Agent>>;
  /** Return the at-most-one designated owner for each requested project. */
  listProjectOwners(projectIds: string[]): Promise<Agent[]>;
  getAgentByName(projectId: string, name: string): Promise<Agent & { profile?: AgentProfile }>;
  updateAgent(id: string, data: UpdateAgent): Promise<Agent>;
  deleteAgent(id: string, options?: DeleteAgentOptions): Promise<void>;
}

export interface RecordStorage {
  createRecord(data: CreateEpicRecord): Promise<EpicRecord>;
  getRecord(id: string): Promise<EpicRecord>;
  listRecords(epicId: string, options?: ListOptions): Promise<ListResult<EpicRecord>>;
  updateRecord(id: string, data: UpdateEpicRecord, expectedVersion: number): Promise<EpicRecord>;
  deleteRecord(id: string): Promise<void>;
}

export interface GuestStorage {
  createGuest(data: CreateGuest): Promise<Guest>;
  getGuest(id: string): Promise<Guest>;
  getGuestByName(projectId: string, name: string): Promise<Guest | null>;
  getGuestByTmuxSessionId(tmuxSessionId: string): Promise<Guest | null>;
  getGuestsByIdPrefix(prefix: string): Promise<Guest[]>;
  listGuests(projectId: string): Promise<Guest[]>;
  listAllGuests(): Promise<Guest[]>;
  deleteGuest(id: string): Promise<void>;
  updateGuestLastSeen(id: string, lastSeenAt: string): Promise<Guest>;
}

export interface WatcherStorage {
  listWatchers(projectId: string): Promise<Watcher[]>;
  getWatcher(id: string): Promise<Watcher | null>;
  createWatcher(data: CreateWatcher): Promise<Watcher>;
  updateWatcher(id: string, data: UpdateWatcher): Promise<Watcher>;
  deleteWatcher(id: string): Promise<void>;
  listEnabledWatchers(): Promise<Watcher[]>;
}

export interface SubscriberStorage {
  listSubscribers(projectId: string): Promise<Subscriber[]>;
  getSubscriber(id: string): Promise<Subscriber | null>;
  createSubscriber(data: CreateSubscriber): Promise<Subscriber>;
  updateSubscriber(id: string, data: UpdateSubscriber): Promise<Subscriber>;
  deleteSubscriber(id: string): Promise<void>;
  findSubscribersByEventName(projectId: string, eventName: string): Promise<Subscriber[]>;
}

export interface ListScheduledEpicsOptions extends ListOptions {
  enabled?: boolean;
}

export interface ListScheduledEpicRunsOptions extends ListOptions {
  status?: ScheduledEpicRunStatus;
}

export interface ClaimRunResult {
  claimed: boolean;
  run: ScheduledEpicRun;
}

export interface UpdateScheduledEpicOptions {
  derivedRuntimeState?: {
    nextRunAt: string | null;
  };
}

export interface ScheduledEpicStorage {
  createScheduledEpic(data: CreateScheduledEpic): Promise<ScheduledEpic>;
  getScheduledEpic(id: string): Promise<ScheduledEpic>;
  listScheduledEpics(
    projectId: string,
    options?: ListScheduledEpicsOptions,
  ): Promise<ListResult<ScheduledEpic>>;
  updateScheduledEpic(
    id: string,
    data: UpdateScheduledEpic,
    expectedVersion: number,
    options?: UpdateScheduledEpicOptions,
  ): Promise<ScheduledEpic>;
  deleteScheduledEpic(id: string): Promise<void>;
  updateScheduledEpicRuntimeState(
    id: string,
    data: UpdateScheduledEpicRuntimeState,
  ): Promise<ScheduledEpic>;
  listDueScheduledEpics(projectId: string, before: string): Promise<ScheduledEpic[]>;
  createScheduledEpicRun(data: CreateScheduledEpicRun): Promise<ClaimRunResult>;
  getScheduledEpicRun(id: string): Promise<ScheduledEpicRun>;
  listScheduledEpicRuns(
    scheduleId: string,
    options?: ListScheduledEpicRunsOptions,
  ): Promise<ListResult<ScheduledEpicRun>>;
  updateScheduledEpicRun(id: string, data: UpdateScheduledEpicRun): Promise<ScheduledEpicRun>;
  claimScheduledEpicRun(runId: string): Promise<ClaimRunResult>;
}

export interface ReviewStorage {
  createReview(data: CreateReview): Promise<Review>;
  getReview(id: string): Promise<Review>;
  updateReview(id: string, data: UpdateReview, expectedVersion: number): Promise<Review>;
  deleteReview(id: string): Promise<void>;
  listReviews(projectId: string, options?: ListReviewsOptions): Promise<ListResult<Review>>;
  createReviewComment(data: CreateReviewComment, targetAgentIds?: string[]): Promise<ReviewComment>;
  getReviewComment(id: string): Promise<ReviewComment>;
  updateReviewComment(
    id: string,
    data: UpdateReviewComment,
    expectedVersion: number,
  ): Promise<ReviewComment>;
  deleteReviewComment(id: string): Promise<void>;
  listReviewComments(
    reviewId: string,
    options?: ListReviewCommentsOptions,
  ): Promise<ListResult<ReviewCommentEnriched>>;
  addReviewCommentTargets(commentId: string, agentIds: string[]): Promise<ReviewCommentTarget[]>;
  getReviewCommentTargets(commentId: string): Promise<ReviewCommentTarget[]>;
  deleteNonResolvedComments(reviewId: string): Promise<number>;
}

export interface SessionStorage {
  parkSessionsFromAgents(agentIds: string[]): Promise<Map<string, string[]>>;
  applySessionPlan(
    toReassign: Array<{ sessionId: string; newAgentId: string }>,
    toDelete: string[],
  ): Promise<void>;
}

export interface IntegrationStorage {
  replaceIntegrationConnection(
    data: ReplaceIntegrationConnection,
    verify: VerifyIntegrationCredentials,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection | null>,
  ): Promise<IntegrationConnection>;
  getIntegrationConnection(
    identity: IntegrationConnectionLookup,
  ): Promise<IntegrationConnection | null>;
  getIntegrationConnectionById(connectionId: string): Promise<IntegrationConnection | null>;
  assignUnassignedIntegrationConnection(
    connectionId: string,
    projectId: string,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection>;
  listIntegrationConnectionsByLegacySourceConnectionId(
    legacySourceConnectionId: string,
  ): Promise<IntegrationConnection[]>;
  listIntegrationConnections(projectId?: string): Promise<IntegrationConnection[]>;
  getIntegrationConnectionCredentials(
    identity: IntegrationConnectionLookup,
  ): Promise<IntegrationCredentials | null>;
  getIntegrationConnectionCredentialsById(
    connectionId: string,
  ): Promise<IntegrationCredentials | null>;
  disconnectIntegrationConnection(
    identity: IntegrationConnectionLookup,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean>;
  disconnectIntegrationConnectionById(
    connectionId: string,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean>;
  disconnectUnassignedIntegrationConnection(
    connectionId: string,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean>;
  updateIntegrationConnectionSyncSetting(
    identity: IntegrationConnectionLookup,
    subtaskSyncEnabled: boolean,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection>;
  updateIntegrationConnectionSyncSettingById(
    connectionId: string,
    subtaskSyncEnabled: boolean,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection>;
  createExternalTaskLink(data: CreateExternalTaskLink): Promise<ExternalTaskLink>;
  createEpicWithExternalTaskLink(
    data: CreateEpicWithExternalTaskLink,
    eventFactory?: (result: CreateEpicWithExternalTaskLinkResult) => PreparedEvent | null,
  ): Promise<CreateEpicWithExternalTaskLinkResult>;
  /** Single-link lookup scoped to one project's durable task identity. */
  findExternalTaskLink(
    projectId: string,
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalTaskLink | null>;
  listExternalTaskLinksByRemoteScope(
    provider: IntegrationProvider,
    remoteScopeKey: string,
  ): Promise<ExternalTaskLink[]>;
  listExternalTaskLinksByRemoteTask(
    provider: IntegrationProvider,
    remoteTaskId: string,
  ): Promise<ExternalTaskLink[]>;
  listExternalTaskLinksForEpic(epicId: string): Promise<ExternalTaskLink[]>;
  listExternalTaskLinksForEpics(epicIds: string[]): Promise<ExternalTaskLink[]>;
  createExternalManagedSubtaskLink(
    data: CreateExternalManagedSubtaskLink,
  ): Promise<ExternalManagedSubtaskLink>;
  getExternalManagedSubtaskLink(id: string): Promise<ExternalManagedSubtaskLink>;
  listExternalManagedSubtaskLinksByProvider(
    provider: IntegrationProvider,
  ): Promise<ExternalManagedSubtaskLink[]>;
  listExternalManagedSubtaskLinksByConnection(
    connectionId: string,
  ): Promise<ExternalManagedSubtaskLink[]>;
  listExternalManagedSubtaskLinksForEpicSnapshot(
    epicIdSnapshot: string,
  ): Promise<ExternalManagedSubtaskLink[]>;
  updateExternalManagedSubtaskLink(
    id: string,
    data: UpdateExternalManagedSubtaskLink,
  ): Promise<ExternalManagedSubtaskLink>;
  findRecognizedManagedSubtask(
    epicId: string,
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalManagedSubtaskLink | null>;
  confirmExternalManagedSubtaskLink(
    data: ConfirmExternalManagedSubtaskLink,
  ): Promise<ConfirmExternalManagedSubtaskLinkResult>;
  removeExternalManagedSubtaskLink(id: string): Promise<boolean>;
}

export interface ExternalEstimateLogStorage {
  getExternalEstimateLogState(
    identity: ExternalEstimateLogIdentity,
  ): Promise<ExternalEstimateLogState | null>;
  getExternalEstimateLogDailyCheckpoint(
    identity: ExternalEstimateLogIdentity,
  ): Promise<ExternalEstimateLogDailyCheckpoint | null>;
  /**
   * Explicitly remote-global internal probe for pending protection and
   * attribution inspection; never a public listing. Callers apply
   * project-aware predicates to the results.
   */
  listExternalEstimateLogStatesByRemoteTask(
    provider: IntegrationProvider,
    remoteTaskId: string,
  ): Promise<ExternalEstimateLogState[]>;
  /**
   * Exact-identity read of history still owned by the reserved legacy
   * identity. Deliberately ignores the requesting project's id; services
   * authorize project, connection, and link before exposing the result.
   */
  findUnassignedExternalEstimateLogCheckpoint(
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalEstimateLogState | null>;
  /**
   * Atomic one-time ownership recovery: moves the complete legacy scalar
   * state and every dated row to the claiming project under link,
   * connection-epoch, and revision revalidation. Concurrent claims produce
   * exactly one winner.
   */
  assignUnassignedExternalEstimateLogCheckpoint(
    data: AssignUnassignedExternalEstimateLogCheckpoint,
  ): Promise<ExternalEstimateLogDailyCheckpoint>;
  listExternalEstimateLoggedMinutes(
    provider: IntegrationProvider,
    identities: ReadonlyArray<{
      projectId: string;
      remoteScopeKey: string;
      remoteTaskId: string;
    }>,
  ): Promise<ExternalEstimateLoggedMinutesEntry[]>;
  setExternalEstimateLoggedMinutes(
    data: SetExternalEstimateLoggedMinutes,
  ): Promise<ExternalEstimateLogState>;
  prepareExternalEstimateLogOperation(
    data: PrepareExternalEstimateLogOperation,
  ): Promise<ExternalEstimateLogState>;
  markExternalEstimateLogOperationOutcomeUnknown(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState>;
  confirmExternalEstimateLogOperation(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState>;
  clearExternalEstimateLogOperation(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState>;
  storeExternalEstimateLogResolution(
    data: StoreExternalEstimateLogResolution,
  ): Promise<ExternalEstimateLogState>;
  applyExternalEstimateLogResolution(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState>;
}

export interface StorageService
  extends ProjectStorage,
    ProjectWorkspaceStorage,
    RemoteStorage,
    ProviderAuthStorage,
    ProjectReplicaStorage,
    ProjectHostStorage,
    StatusStorage,
    EpicStorage,
    PromptStorage,
    TagStorage,
    ProviderStorage,
    ProviderPluginPolicyStorage,
    SkillSourceStorage,
    AgentProfileStorage,
    ProfileProviderConfigStorage,
    AgentStorage,
    RecordStorage,
    GuestStorage,
    WatcherStorage,
    SubscriberStorage,
    ReviewStorage,
    ScheduledEpicStorage,
    SessionStorage,
    IntegrationStorage,
    ExternalEstimateLogStorage {}

export const STORAGE_SERVICE = 'STORAGE_SERVICE';
