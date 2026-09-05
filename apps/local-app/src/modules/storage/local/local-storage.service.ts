import { Injectable, Inject, Optional } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../db/db.provider';
import {
  StorageService,
  ListOptions,
  ListResult,
  ProjectListOptions,
  DocumentListFilters,
  DocumentIdentifier,
  ListProjectEpicsOptions,
  ListAssignedEpicsOptions,
  ListEpicRelationCandidatesOptions,
  ListEpicRelationsOptions,
  EpicRelationReadOptions,
  ListParentChildrenOptions,
  ListSubEpicsForParentsOptions,
  CreateEpicForProjectInput,
  ProfileListOptions,
  PromptListFilters,
  PromptSummary,
  ListReviewsOptions,
  ListReviewCommentsOptions,
  type CreateIfMissingInput,
  type CreateIfMissingResult,
  ListScheduledEpicsOptions,
  ListScheduledEpicRunsOptions,
  type ClaimRunResult,
  type CreateSkillSourceOptions,
  type DeleteAgentOptions,
  type UpdateScheduledEpicOptions,
  type VerifyIntegrationCredentials,
} from '../interfaces/storage.interface';
import type { SnapshotPromptWriter } from '../interfaces/snapshot-prompt-writer.interface';
import {
  Project,
  CreateProject,
  UpdateProject,
  ProjectWorkspace,
  DeleteProjectWorkspaceResult,
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
  Document,
  CreateDocument,
  UpdateDocument,
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
  ExternalEstimateLoggedMinutesEntry,
  ExternalEstimateLogDailyCheckpoint,
  ExternalEstimateLogIdentity,
  ExternalEstimateLogOperationMutation,
  ExternalEstimateLogState,
  PrepareExternalEstimateLogOperation,
  SetExternalEstimateLoggedMinutes,
  StoreExternalEstimateLogResolution,
} from '../models/domain.models';
import { createLogger } from '../../../common/logging/logger';
import {
  DEFAULT_FEATURE_FLAGS,
  type FeatureFlagConfig,
} from '../../../common/config/feature-flags';
import { createStorageDelegateContext } from './delegates/base-storage.delegate';
import { AgentStorageDelegate } from './delegates/agent.delegate';
import { AgentProfileStorageDelegate } from './delegates/agent-profile.delegate';
import { DocumentStorageDelegate } from './delegates/document.delegate';
import { EpicStorageDelegate } from './delegates/epic.delegate';
import { GuestStorageDelegate } from './delegates/guest.delegate';
import { ProfileProviderConfigStorageDelegate } from './delegates/profile-provider-config.delegate';
import { PromptStorageDelegate } from './delegates/prompt.delegate';
import { ProviderStorageDelegate } from './delegates/provider.delegate';
import { ProviderModelStorageDelegate } from './delegates/provider-model.delegate';
import { ProviderEffortStorageDelegate } from './delegates/provider-effort.delegate';
import { ProviderPluginPolicyStorageDelegate } from './delegates/provider-plugin-policy.delegate';
import { ProjectStorageDelegate } from './delegates/project.delegate';
import { ProjectWorkspaceStorageDelegate } from './delegates/project-workspace.delegate';
import { RecordStorageDelegate } from './delegates/record.delegate';
import { ReviewStorageDelegate } from './delegates/review.delegate';
import { SkillSourceStorageDelegate } from './delegates/skill-source.delegate';
import { StatusStorageDelegate } from './delegates/status.delegate';
import { SubscriberStorageDelegate } from './delegates/subscriber.delegate';
import { TagStorageDelegate } from './delegates/tag.delegate';
import { ScheduledEpicStorageDelegate } from './delegates/scheduled-epic.delegate';
import { SessionStorageDelegate } from './delegates/session.delegate';
import { IntegrationStorageDelegate } from './delegates/integration.delegate';
import { IntegrationCredentialCipher } from './integration-credential-cipher';
import { WatcherStorageDelegate } from './delegates/watcher.delegate';
import { ExternalManagedSubtaskStorageDelegate } from './delegates/external-managed-subtask.delegate';
import { ExternalEstimateLogStorageDelegate } from './delegates/external-estimate-log.delegate';
import { CommittedEventStore } from '../../events/services/committed-event.store';
import { DurableEventRegistryService } from '../../events/services/durable-event-registry.service';
import type { PreparedEvent } from '../../events/services/durable-event-registry.service';
import type { FactualEventFactory } from '../interfaces/storage.interface';

const logger = createLogger('LocalStorageService');

/**
 * LocalStorage implementation of StorageService
 * Uses Drizzle ORM with SQLite (better-sqlite3)
 *
 * NOTE: This implementation requires database schemas from task 004.
 * The actual Drizzle queries will be implemented once schemas are available.
 * Current implementation provides the structure and error handling patterns.
 */
@Injectable()
export class LocalStorageService implements StorageService, SnapshotPromptWriter {
  private readonly projectDelegate: ProjectStorageDelegate;
  private readonly projectWorkspaceDelegate: ProjectWorkspaceStorageDelegate;
  private readonly statusDelegate: StatusStorageDelegate;
  private readonly epicDelegate: EpicStorageDelegate;
  private readonly tagDelegate: TagStorageDelegate;
  private readonly promptDelegate: PromptStorageDelegate;
  private readonly documentDelegate: DocumentStorageDelegate;
  private readonly providerDelegate: ProviderStorageDelegate;
  private readonly skillSourceDelegate: SkillSourceStorageDelegate;
  private readonly agentProfileDelegate: AgentProfileStorageDelegate;
  private readonly profileProviderConfigDelegate: ProfileProviderConfigStorageDelegate;
  private readonly agentDelegate: AgentStorageDelegate;
  private readonly recordDelegate: RecordStorageDelegate;
  private readonly watcherDelegate: WatcherStorageDelegate;
  private readonly subscriberDelegate: SubscriberStorageDelegate;
  private readonly guestDelegate: GuestStorageDelegate;
  private readonly reviewDelegate: ReviewStorageDelegate;
  private readonly providerModelDelegate: ProviderModelStorageDelegate;
  private readonly providerEffortDelegate: ProviderEffortStorageDelegate;
  private readonly providerPluginPolicyDelegate: ProviderPluginPolicyStorageDelegate;
  private readonly scheduledEpicDelegate: ScheduledEpicStorageDelegate;
  private readonly sessionDelegate: SessionStorageDelegate;
  private readonly integrationDelegate: IntegrationStorageDelegate;
  private readonly externalManagedSubtaskDelegate: ExternalManagedSubtaskStorageDelegate;
  private readonly externalEstimateLogDelegate: ExternalEstimateLogStorageDelegate;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    @Optional() integrationCredentialCipher?: IntegrationCredentialCipher,
    @Optional() committedEventStore?: CommittedEventStore,
  ) {
    const context = createStorageDelegateContext(this.db);
    const eventStore =
      committedEventStore ?? new CommittedEventStore(this.db, new DurableEventRegistryService());
    this.projectDelegate = new ProjectStorageDelegate(context);
    this.projectWorkspaceDelegate = new ProjectWorkspaceStorageDelegate(context);
    this.statusDelegate = new StatusStorageDelegate(context);
    this.tagDelegate = new TagStorageDelegate(context);
    const createTag = (data: CreateTag): Tag => this.tagDelegate.createTagSync(data);
    this.promptDelegate = new PromptStorageDelegate(context, {
      createTag,
    });
    this.documentDelegate = new DocumentStorageDelegate(context, {
      createTag,
    });
    this.epicDelegate = new EpicStorageDelegate(context, {
      createTag,
      getAgent: (id) => this.agentDelegate.getAgentSync(id),
      getAgentByName: (projectId, name) => this.getAgentByName(projectId, name),
      getStatus: (id) => this.statusDelegate.getStatus(id),
      appendEvent: (event) => eventStore.appendInCurrentTransaction(event),
    });
    this.providerDelegate = new ProviderStorageDelegate(context, {
      updateProvider: (id, data) => this.updateProvider(id, data),
    });
    this.providerModelDelegate = new ProviderModelStorageDelegate(context);
    this.providerEffortDelegate = new ProviderEffortStorageDelegate(context);
    this.providerPluginPolicyDelegate = new ProviderPluginPolicyStorageDelegate(context);
    this.skillSourceDelegate = new SkillSourceStorageDelegate(context);
    this.agentProfileDelegate = new AgentProfileStorageDelegate(context, {
      getAgentProfile: (id) => this.getAgentProfile(id),
      listAgentProfiles: (options) => this.listAgentProfiles(options),
    });
    this.profileProviderConfigDelegate = new ProfileProviderConfigStorageDelegate(context, {
      getProfileProviderConfig: (id) => this.getProfileProviderConfig(id),
    });
    this.agentDelegate = new AgentStorageDelegate(context, {
      getAgent: (id) => this.getAgent(id),
      getAgentProfile: (id) => this.getAgentProfile(id),
      getProfileProviderConfig: (id) => this.getProfileProviderConfig(id),
    });
    this.recordDelegate = new RecordStorageDelegate(context, {
      createTag,
    });
    this.watcherDelegate = new WatcherStorageDelegate(context);
    this.subscriberDelegate = new SubscriberStorageDelegate(context);
    this.guestDelegate = new GuestStorageDelegate(context);
    this.reviewDelegate = new ReviewStorageDelegate(context);
    this.scheduledEpicDelegate = new ScheduledEpicStorageDelegate(context);
    this.sessionDelegate = new SessionStorageDelegate(context);
    this.externalManagedSubtaskDelegate = new ExternalManagedSubtaskStorageDelegate(context);
    this.externalEstimateLogDelegate = new ExternalEstimateLogStorageDelegate(context);
    this.integrationDelegate = new IntegrationStorageDelegate(
      context,
      integrationCredentialCipher ?? new IntegrationCredentialCipher(),
      {
        createEpicInCurrentTransaction: (data) =>
          this.epicDelegate.createEpicInCurrentTransaction(data),
        getEpic: (id) => this.epicDelegate.getEpic(id),
        appendEvent: (event) => eventStore.appendInCurrentTransaction(event),
        handleConnectionMutation: (connectionId, provider, acknowledgeOrphanRisk) =>
          this.externalManagedSubtaskDelegate.handleConnectionMutationSync(
            connectionId,
            provider,
            acknowledgeOrphanRisk,
          ),
      },
    );
    logger.info('LocalStorageService initialized');
  }

  getFeatureFlags(): FeatureFlagConfig {
    return { ...DEFAULT_FEATURE_FLAGS };
  }

  // Projects
  async createProject(data: CreateProject): Promise<Project> {
    return this.projectDelegate.createProject(data);
  }

  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.projectDelegate.runInTransaction(fn);
  }

  async createProjectShell(
    data: CreateProject,
    options?: import('../interfaces/storage.interface').CreateProjectWithTemplateOptions,
  ): Promise<Project> {
    return this.projectDelegate.createProjectShell(data, options);
  }

  async getProject(id: string): Promise<Project> {
    return this.projectDelegate.getProject(id);
  }

  async findProjectByPath(path: string): Promise<Project | null> {
    return this.projectDelegate.findProjectByPath(path);
  }

  async listProjects(options: ProjectListOptions = {}): Promise<ListResult<Project>> {
    return this.projectDelegate.listProjects(options);
  }

  async getProjectsByIdPrefix(prefix: string): Promise<Project[]> {
    return this.projectDelegate.getProjectsByIdPrefix(prefix);
  }

  async getProjectWorkspaceSnapshot(projectId: string): Promise<Project[]> {
    return this.projectDelegate.getProjectWorkspaceSnapshot(projectId);
  }

  async updateProject(id: string, data: UpdateProject): Promise<Project> {
    return this.projectDelegate.updateProject(id, data);
  }

  async deleteProject(id: string): Promise<void> {
    return this.projectDelegate.deleteProject(id);
  }

  async listProjectWorkspaces(): Promise<ProjectWorkspace[]> {
    return this.projectWorkspaceDelegate.listProjectWorkspaces();
  }

  async getProjectWorkspace(id: string): Promise<ProjectWorkspace> {
    return this.projectWorkspaceDelegate.getProjectWorkspace(id);
  }

  async createProjectWorkspace(name: string): Promise<ProjectWorkspace> {
    return this.projectWorkspaceDelegate.createProjectWorkspace(name);
  }

  async renameProjectWorkspace(id: string, name: string): Promise<ProjectWorkspace> {
    return this.projectWorkspaceDelegate.renameProjectWorkspace(id, name);
  }

  async reorderProjectWorkspaces(workspaceIds: string[]): Promise<ProjectWorkspace[]> {
    return this.projectWorkspaceDelegate.reorderProjectWorkspaces(workspaceIds);
  }

  async deleteProjectWorkspace(
    id: string,
    replacementId: string,
  ): Promise<DeleteProjectWorkspaceResult> {
    return this.projectWorkspaceDelegate.deleteProjectWorkspace(id, replacementId);
  }

  // Statuses
  async createStatus(data: CreateStatus): Promise<Status> {
    return this.statusDelegate.createStatus(data);
  }

  async getStatus(id: string): Promise<Status> {
    return this.statusDelegate.getStatus(id);
  }

  async listStatuses(projectId: string, options: ListOptions = {}): Promise<ListResult<Status>> {
    return this.statusDelegate.listStatuses(projectId, options);
  }

  async findStatusByName(projectId: string, name: string): Promise<Status | null> {
    return this.statusDelegate.findStatusByName(projectId, name);
  }

  async updateStatus(id: string, data: UpdateStatus): Promise<Status> {
    return this.statusDelegate.updateStatus(id, data);
  }

  async deleteStatus(id: string): Promise<void> {
    return this.statusDelegate.deleteStatus(id);
  }

  // Epics (with optimistic locking)
  async createEpic(
    data: CreateEpic,
    eventFactory?: (epic: Epic) => PreparedEvent | null,
  ): Promise<Epic> {
    return this.epicDelegate.createEpic(data, eventFactory);
  }

  async createEpicWithinTransaction(
    data: CreateEpic,
    eventFactory?: (epic: Epic) => PreparedEvent | null,
    beforeEventAppend?: (epic: Epic) => Promise<void>,
  ): Promise<Epic> {
    return this.epicDelegate.createEpicInCurrentTransaction(data, eventFactory, beforeEventAppend);
  }

  async getEpic(id: string): Promise<Epic> {
    return this.epicDelegate.getEpic(id);
  }

  async listEpics(projectId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    return this.epicDelegate.listEpics(projectId, options);
  }

  async listEpicsByStatus(statusId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    return this.epicDelegate.listEpicsByStatus(statusId, options);
  }

  async listProjectEpics(
    projectId: string,
    options: ListProjectEpicsOptions = {},
  ): Promise<ListResult<Epic>> {
    return this.epicDelegate.listProjectEpics(projectId, options);
  }

  async listAssignedEpics(
    projectId: string,
    options: ListAssignedEpicsOptions,
  ): Promise<ListResult<Epic>> {
    return this.epicDelegate.listAssignedEpics(projectId, options);
  }

  async createEpicForProject(
    projectId: string,
    input: CreateEpicForProjectInput,
    eventFactory?: (epic: Epic) => PreparedEvent | null,
  ): Promise<Epic> {
    return this.epicDelegate.createEpicForProject(projectId, input, eventFactory);
  }

  async updateEpic(
    id: string,
    data: UpdateEpic,
    expectedVersion: number,
    eventFactory?: FactualEventFactory<Epic, Epic>,
  ): Promise<Epic> {
    return this.epicDelegate.updateEpic(id, data, expectedVersion, eventFactory);
  }

  async deleteEpic(
    id: string,
    eventFactory?: (epic: Epic, workspaceId: string) => PreparedEvent | null,
  ): Promise<void> {
    return this.epicDelegate.deleteEpic(id, eventFactory);
  }

  async listSubEpics(parentId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    return this.epicDelegate.listSubEpics(parentId, options);
  }

  async listParentChildren(
    parentId: string,
    options: ListParentChildrenOptions = {},
  ): Promise<ListResult<Epic>> {
    return this.epicDelegate.listParentChildren(parentId, options);
  }

  async listSubEpicsForParents(
    projectId: string,
    parentIds: string[],
    options: ListSubEpicsForParentsOptions = {},
  ): Promise<Map<string, Epic[]>> {
    return this.epicDelegate.listSubEpicsForParents(projectId, parentIds, options);
  }

  async countSubEpicsByStatus(parentId: string): Promise<Record<string, number>> {
    return this.epicDelegate.countSubEpicsByStatus(parentId);
  }

  async countEpicsByStatus(statusId: string): Promise<number> {
    return this.epicDelegate.countEpicsByStatus(statusId);
  }

  async updateEpicsStatus(oldStatusId: string, newStatusId: string): Promise<number> {
    return this.epicDelegate.updateEpicsStatus(oldStatusId, newStatusId);
  }

  async listEpicComments(
    epicId: string,
    options: ListOptions = {},
  ): Promise<ListResult<EpicComment>> {
    return this.epicDelegate.listEpicComments(epicId, options);
  }

  async createEpicComment(
    data: CreateEpicComment,
    eventFactory?: FactualEventFactory<EpicComment, Epic>,
  ): Promise<EpicComment> {
    return this.epicDelegate.createEpicComment(data, eventFactory);
  }

  async deleteEpicComment(id: string): Promise<void> {
    return this.epicDelegate.deleteEpicComment(id);
  }

  async deleteEpicCommentScoped(epicId: string, commentId: string): Promise<boolean> {
    return this.epicDelegate.deleteEpicCommentScoped(epicId, commentId);
  }

  async getEpicsByIdPrefix(
    projectId: string,
    prefix: string,
  ): Promise<Array<{ id: string; title: string }>> {
    return this.epicDelegate.getEpicsByIdPrefix(projectId, prefix);
  }

  async setEpicRelation(
    data: SetEpicRelation,
    context: EpicRelationWriteContext = { trustedLocalHuman: true },
  ): Promise<SetEpicRelationResult> {
    return this.epicDelegate.setEpicRelation(data, context);
  }

  async deleteEpicRelation(
    epicId: string,
    relatedEpicId: string,
    context: EpicRelationWriteContext = { trustedLocalHuman: true },
  ): Promise<DeleteEpicRelationResult> {
    return this.epicDelegate.deleteEpicRelation(epicId, relatedEpicId, context);
  }

  async listEpicRelations(
    epicId: string,
    options: ListEpicRelationsOptions = {},
  ): Promise<ListResult<EpicRelationListItem>> {
    return this.epicDelegate.listEpicRelations(epicId, options);
  }

  async summarizeEpicRelationsBatch(
    epicIds: string[],
    options: EpicRelationReadOptions = {},
  ): Promise<Map<string, EpicRelationSummary>> {
    return this.epicDelegate.summarizeEpicRelationsBatch(epicIds, options);
  }

  async listEpicRelationCandidates(
    epicId: string,
    options: ListEpicRelationCandidatesOptions = {},
  ): Promise<ListResult<EpicRelationCandidate>> {
    return this.epicDelegate.listEpicRelationCandidates(epicId, options);
  }

  async getWorkspaceEpicsByIdPrefix(
    epicId: string,
    prefix: string,
    options: EpicRelationReadOptions = {},
  ): Promise<EpicRelationCandidate[]> {
    return this.epicDelegate.getWorkspaceEpicsByIdPrefix(epicId, prefix, options);
  }

  // Prompts (with optimistic locking)
  async createPrompt(data: CreatePrompt): Promise<Prompt> {
    return this.promptDelegate.createPrompt(data);
  }

  async createPromptFromSnapshot(data: CreatePrompt): Promise<Prompt> {
    return this.promptDelegate.createPromptFromSnapshot(data);
  }

  async getPrompt(id: string): Promise<Prompt> {
    return this.promptDelegate.getPrompt(id);
  }

  async listPrompts(filters: PromptListFilters = {}): Promise<ListResult<PromptSummary>> {
    return this.promptDelegate.listPrompts(filters);
  }

  async updatePrompt(id: string, data: UpdatePrompt, expectedVersion: number): Promise<Prompt> {
    return this.promptDelegate.updatePrompt(id, data, expectedVersion);
  }

  async deletePrompt(id: string): Promise<void> {
    return this.promptDelegate.deletePrompt(id);
  }

  async getInitialSessionPrompt(projectId: string | null): Promise<Prompt | null> {
    return this.promptDelegate.getInitialSessionPrompt(projectId);
  }

  // Documents
  async listDocuments(filters: DocumentListFilters = {}): Promise<ListResult<Document>> {
    return this.documentDelegate.listDocuments(filters);
  }

  async getDocument(identifier: DocumentIdentifier): Promise<Document> {
    return this.documentDelegate.getDocument(identifier);
  }

  async createDocument(data: CreateDocument): Promise<Document> {
    return this.documentDelegate.createDocument(data);
  }

  async updateDocument(id: string, data: UpdateDocument): Promise<Document> {
    return this.documentDelegate.updateDocument(id, data);
  }

  async deleteDocument(id: string): Promise<void> {
    return this.documentDelegate.deleteDocument(id);
  }

  // Tags
  async createTag(data: CreateTag): Promise<Tag> {
    return this.tagDelegate.createTag(data);
  }

  async getTag(id: string): Promise<Tag> {
    return this.tagDelegate.getTag(id);
  }

  async listTags(projectId: string | null, options: ListOptions = {}): Promise<ListResult<Tag>> {
    return this.tagDelegate.listTags(projectId, options);
  }

  async updateTag(id: string, data: UpdateTag): Promise<Tag> {
    return this.tagDelegate.updateTag(id, data);
  }

  async deleteTag(id: string): Promise<void> {
    return this.tagDelegate.deleteTag(id);
  }

  // Providers
  async createProvider(data: CreateProvider): Promise<Provider> {
    return this.providerDelegate.createProvider(data);
  }

  async createProviderModel(data: CreateProviderModel): Promise<ProviderModel> {
    return this.providerModelDelegate.createProviderModel(data);
  }

  async listProviderModelsByProvider(providerId: string): Promise<ProviderModel[]> {
    return this.providerModelDelegate.listProviderModelsByProvider(providerId);
  }

  async listProviderModelsByProviderIds(providerIds: string[]): Promise<ProviderModel[]> {
    return this.providerModelDelegate.listProviderModelsByProviderIds(providerIds);
  }

  async deleteProviderModel(id: string): Promise<void> {
    return this.providerModelDelegate.deleteProviderModel(id);
  }

  async bulkCreateProviderModels(
    providerId: string,
    names: string[],
  ): Promise<{ added: string[]; existing: string[] }> {
    return this.providerModelDelegate.bulkCreateProviderModels(providerId, names);
  }

  async createProviderEffort(data: CreateProviderEffort): Promise<ProviderEffort> {
    return this.providerEffortDelegate.createProviderEffort(data);
  }

  async listProviderEffortsByProvider(providerId: string): Promise<ProviderEffort[]> {
    return this.providerEffortDelegate.listProviderEffortsByProvider(providerId);
  }

  async listProviderEffortsByProviderIds(providerIds: string[]): Promise<ProviderEffort[]> {
    return this.providerEffortDelegate.listProviderEffortsByProviderIds(providerIds);
  }

  async deleteProviderEffort(id: string): Promise<void> {
    return this.providerEffortDelegate.deleteProviderEffort(id);
  }

  async bulkCreateProviderEfforts(
    providerId: string,
    names: string[],
  ): Promise<{ added: string[]; existing: string[] }> {
    return this.providerEffortDelegate.bulkCreateProviderEfforts(providerId, names);
  }

  async getProvider(id: string): Promise<Provider> {
    return this.providerDelegate.getProvider(id);
  }

  async listProviders(options: ListOptions = {}): Promise<ListResult<Provider>> {
    return this.providerDelegate.listProviders(options);
  }

  async listProvidersByIds(ids: string[]): Promise<Provider[]> {
    return this.providerDelegate.listProvidersByIds(ids);
  }

  async updateProvider(id: string, data: UpdateProvider): Promise<Provider> {
    return this.providerDelegate.updateProvider(id, data);
  }

  async deleteProvider(id: string): Promise<void> {
    return this.providerDelegate.deleteProvider(id);
  }

  async upsertProviderPluginDefault(
    data: UpsertProviderPluginDefault,
  ): Promise<ProviderPluginDefault> {
    return this.providerPluginPolicyDelegate.upsertProviderPluginDefault(data);
  }

  async getProviderPluginDefault(
    providerId: string,
    pluginId: string,
  ): Promise<ProviderPluginDefault | null> {
    return this.providerPluginPolicyDelegate.getProviderPluginDefault(providerId, pluginId);
  }

  async listProviderPluginDefaults(providerId: string): Promise<ProviderPluginDefault[]> {
    return this.providerPluginPolicyDelegate.listProviderPluginDefaults(providerId);
  }

  async deleteProviderPluginDefault(providerId: string, pluginId: string): Promise<boolean> {
    return this.providerPluginPolicyDelegate.deleteProviderPluginDefault(providerId, pluginId);
  }

  async upsertProjectProviderPluginOverride(
    data: UpsertProjectProviderPluginOverride,
  ): Promise<ProjectProviderPluginOverride> {
    return this.providerPluginPolicyDelegate.upsertProjectProviderPluginOverride(data);
  }

  async getProjectProviderPluginOverride(
    projectId: string,
    providerId: string,
    pluginId: string,
  ): Promise<ProjectProviderPluginOverride | null> {
    return this.providerPluginPolicyDelegate.getProjectProviderPluginOverride(
      projectId,
      providerId,
      pluginId,
    );
  }

  async listProjectProviderPluginOverrides(
    projectId: string,
    providerId: string,
  ): Promise<ProjectProviderPluginOverride[]> {
    return this.providerPluginPolicyDelegate.listProjectProviderPluginOverrides(
      projectId,
      providerId,
    );
  }

  async deleteProjectProviderPluginOverride(
    projectId: string,
    providerId: string,
    pluginId: string,
  ): Promise<boolean> {
    return this.providerPluginPolicyDelegate.deleteProjectProviderPluginOverride(
      projectId,
      providerId,
      pluginId,
    );
  }

  getProviderEnvForProject(providerId: string, projectId: string): Record<string, string> | null {
    return this.providerDelegate.getProviderEnvForProject(providerId, projectId);
  }

  listEnvScopesByProviderIds(providerIds: string[]): Map<string, Record<string, string[]>> {
    return this.providerDelegate.listEnvScopesByProviderIds(providerIds);
  }

  async updateProviderWithScopes(
    id: string,
    data: UpdateProvider,
    envScopes: Record<string, string[]> | undefined,
    currentEnvKeys: string[],
  ): Promise<Provider> {
    return Promise.resolve(
      this.providerDelegate.updateProviderWithScopes(id, data, envScopes, currentEnvKeys),
    );
  }

  async getProviderMcpMetadata(id: string): Promise<ProviderMcpMetadata> {
    return this.providerDelegate.getProviderMcpMetadata(id);
  }

  async updateProviderMcpMetadata(
    id: string,
    metadata: UpdateProviderMcpMetadata,
  ): Promise<Provider> {
    return this.providerDelegate.updateProviderMcpMetadata(id, metadata);
  }

  // Source-Project enablement mapping
  async getSourceProjectEnabled(projectId: string, sourceName: string): Promise<boolean | null> {
    return this.skillSourceDelegate.getSourceProjectEnabled(projectId, sourceName);
  }

  async setSourceProjectEnabled(
    projectId: string,
    sourceName: string,
    enabled: boolean,
  ): Promise<void> {
    return this.skillSourceDelegate.setSourceProjectEnabled(projectId, sourceName, enabled);
  }

  async listSourceProjectEnabled(
    projectId: string,
  ): Promise<Array<{ sourceName: string; enabled: boolean }>> {
    return this.skillSourceDelegate.listSourceProjectEnabled(projectId);
  }

  // Community Skill Sources
  async listCommunitySkillSources(): Promise<CommunitySkillSource[]> {
    return this.skillSourceDelegate.listCommunitySkillSources();
  }

  async getCommunitySkillSource(id: string): Promise<CommunitySkillSource> {
    return this.skillSourceDelegate.getCommunitySkillSource(id);
  }

  async getCommunitySkillSourceByName(name: string): Promise<CommunitySkillSource | null> {
    return this.skillSourceDelegate.getCommunitySkillSourceByName(name);
  }

  async createCommunitySkillSource(
    data: CreateCommunitySkillSource,
    options?: CreateSkillSourceOptions,
  ): Promise<CommunitySkillSource> {
    return this.skillSourceDelegate.createCommunitySkillSource(data, options);
  }

  async deleteCommunitySkillSource(id: string): Promise<void> {
    return this.skillSourceDelegate.deleteCommunitySkillSource(id);
  }

  // Local Skill Sources
  async listLocalSkillSources(): Promise<LocalSkillSource[]> {
    return this.skillSourceDelegate.listLocalSkillSources();
  }

  async getLocalSkillSource(id: string): Promise<LocalSkillSource | null> {
    return this.skillSourceDelegate.getLocalSkillSource(id);
  }

  async getLocalSkillSourceByName(name: string): Promise<LocalSkillSource | null> {
    return this.skillSourceDelegate.getLocalSkillSourceByName(name);
  }

  async createLocalSkillSource(
    data: CreateLocalSkillSource,
    options?: CreateSkillSourceOptions,
  ): Promise<LocalSkillSource> {
    return this.skillSourceDelegate.createLocalSkillSource(data, options);
  }

  async deleteLocalSkillSource(id: string): Promise<void> {
    return this.skillSourceDelegate.deleteLocalSkillSource(id);
  }

  // Agent Profiles
  // Note: providerId and options columns removed in Phase 4
  // Provider configuration now lives in profile_provider_configs table
  async createAgentProfile(data: CreateAgentProfile): Promise<AgentProfile> {
    return this.agentProfileDelegate.createAgentProfile(data);
  }

  async getAgentProfile(id: string): Promise<AgentProfile> {
    return this.agentProfileDelegate.getAgentProfile(id);
  }

  async listAgentProfiles(options: ProfileListOptions = {}): Promise<ListResult<AgentProfile>> {
    return this.agentProfileDelegate.listAgentProfiles(options);
  }

  async updateAgentProfile(id: string, data: UpdateAgentProfile): Promise<AgentProfile> {
    return this.agentProfileDelegate.updateAgentProfile(id, data);
  }

  async deleteAgentProfile(id: string): Promise<void> {
    return this.agentProfileDelegate.deleteAgentProfile(id);
  }

  async setAgentProfilePrompts(profileId: string, promptIdsOrdered: string[]): Promise<void> {
    return this.agentProfileDelegate.setAgentProfilePrompts(profileId, promptIdsOrdered);
  }

  async getAgentProfilePrompts(
    profileId: string,
  ): Promise<Array<{ promptId: string; createdAt: string }>> {
    return this.agentProfileDelegate.getAgentProfilePrompts(profileId);
  }

  async getAgentProfileWithPrompts(
    id: string,
  ): Promise<
    AgentProfile & { prompts: Array<{ promptId: string; title: string; order: number }> }
  > {
    return this.agentProfileDelegate.getAgentProfileWithPrompts(id);
  }

  async listAgentProfilesWithPrompts(options: ProfileListOptions = {}): Promise<
    ListResult<
      AgentProfile & {
        prompts: Array<{ promptId: string; title: string; order: number }>;
        provider?: { id: string; name: string };
      }
    >
  > {
    return this.agentProfileDelegate.listAgentProfilesWithPrompts(options);
  }

  // Profile Provider Configs
  async createProfileProviderConfig(
    data: CreateProfileProviderConfig,
  ): Promise<ProfileProviderConfig> {
    return this.profileProviderConfigDelegate.createProfileProviderConfig(data);
  }

  async createIfMissing(input: CreateIfMissingInput): Promise<CreateIfMissingResult> {
    return this.profileProviderConfigDelegate.createIfMissing(input);
  }

  async getProfileProviderConfig(id: string): Promise<ProfileProviderConfig> {
    return this.profileProviderConfigDelegate.getProfileProviderConfig(id);
  }

  async listProfileProviderConfigsByProfile(profileId: string): Promise<ProfileProviderConfig[]> {
    return this.profileProviderConfigDelegate.listProfileProviderConfigsByProfile(profileId);
  }

  async listProfileProviderConfigsByIds(ids: string[]): Promise<ProfileProviderConfig[]> {
    return this.profileProviderConfigDelegate.listProfileProviderConfigsByIds(ids);
  }

  async listAllProfileProviderConfigs(): Promise<ProfileProviderConfig[]> {
    return this.profileProviderConfigDelegate.listAllProfileProviderConfigs();
  }

  async updateProfileProviderConfig(
    id: string,
    data: UpdateProfileProviderConfig,
  ): Promise<ProfileProviderConfig> {
    return this.profileProviderConfigDelegate.updateProfileProviderConfig(id, data);
  }

  async deleteProfileProviderConfig(id: string): Promise<void> {
    return this.profileProviderConfigDelegate.deleteProfileProviderConfig(id);
  }

  async reorderProfileProviderConfigs(profileId: string, configIds: string[]): Promise<void> {
    return this.profileProviderConfigDelegate.reorderProfileProviderConfigs(profileId, configIds);
  }

  // Agents
  async createAgent(data: CreateAgent): Promise<Agent> {
    return this.agentDelegate.createAgent(data);
  }

  async getAgent(id: string): Promise<Agent> {
    return this.agentDelegate.getAgent(id);
  }

  async listAgents(projectId: string, options: ListOptions = {}): Promise<ListResult<Agent>> {
    return this.agentDelegate.listAgents(projectId, options);
  }

  async listProjectOwners(projectIds: string[]): Promise<Agent[]> {
    return this.agentDelegate.listProjectOwners(projectIds);
  }

  async getAgentByName(
    projectId: string,
    name: string,
  ): Promise<Agent & { profile?: AgentProfile }> {
    return this.agentDelegate.getAgentByName(projectId, name);
  }

  async updateAgent(id: string, data: UpdateAgent): Promise<Agent> {
    return this.agentDelegate.updateAgent(id, data);
  }

  async deleteAgent(id: string, options?: DeleteAgentOptions): Promise<void> {
    return this.agentDelegate.deleteAgent(id, options);
  }

  // Records (with optimistic locking)
  async createRecord(data: CreateEpicRecord): Promise<EpicRecord> {
    return this.recordDelegate.createRecord(data);
  }

  async getRecord(id: string): Promise<EpicRecord> {
    return this.recordDelegate.getRecord(id);
  }

  async listRecords(epicId: string, options: ListOptions = {}): Promise<ListResult<EpicRecord>> {
    return this.recordDelegate.listRecords(epicId, options);
  }

  async updateRecord(
    id: string,
    data: UpdateEpicRecord,
    expectedVersion: number,
  ): Promise<EpicRecord> {
    return this.recordDelegate.updateRecord(id, data, expectedVersion);
  }

  async deleteRecord(id: string): Promise<void> {
    return this.recordDelegate.deleteRecord(id);
  }

  // ============================================
  // TERMINAL WATCHERS
  // ============================================

  async listWatchers(projectId: string): Promise<Watcher[]> {
    return this.watcherDelegate.listWatchers(projectId);
  }

  async getWatcher(id: string): Promise<Watcher | null> {
    return this.watcherDelegate.getWatcher(id);
  }

  async createWatcher(data: CreateWatcher): Promise<Watcher> {
    return this.watcherDelegate.createWatcher(data);
  }

  async updateWatcher(id: string, data: UpdateWatcher): Promise<Watcher> {
    return this.watcherDelegate.updateWatcher(id, data);
  }

  async deleteWatcher(id: string): Promise<void> {
    return this.watcherDelegate.deleteWatcher(id);
  }

  async listEnabledWatchers(): Promise<Watcher[]> {
    return this.watcherDelegate.listEnabledWatchers();
  }

  // ============================================
  // AUTOMATION SUBSCRIBERS
  // ============================================

  async listSubscribers(projectId: string): Promise<Subscriber[]> {
    return this.subscriberDelegate.listSubscribers(projectId);
  }

  async getSubscriber(id: string): Promise<Subscriber | null> {
    return this.subscriberDelegate.getSubscriber(id);
  }

  async createSubscriber(data: CreateSubscriber): Promise<Subscriber> {
    return this.subscriberDelegate.createSubscriber(data);
  }

  async updateSubscriber(id: string, data: UpdateSubscriber): Promise<Subscriber> {
    return this.subscriberDelegate.updateSubscriber(id, data);
  }

  async deleteSubscriber(id: string): Promise<void> {
    return this.subscriberDelegate.deleteSubscriber(id);
  }

  async findSubscribersByEventName(projectId: string, eventName: string): Promise<Subscriber[]> {
    return this.subscriberDelegate.findSubscribersByEventName(projectId, eventName);
  }

  // ============================================
  // PROJECT PATH LOOKUPS
  // ============================================

  async getProjectByRootPath(rootPath: string): Promise<Project | null> {
    return this.projectDelegate.getProjectByRootPath(rootPath);
  }

  async findProjectContainingPath(absolutePath: string): Promise<Project | null> {
    return this.projectDelegate.findProjectContainingPath(absolutePath);
  }

  // ============================================
  // GUESTS - External agents registered via MCP
  // ============================================

  async createGuest(data: CreateGuest): Promise<Guest> {
    return this.guestDelegate.createGuest(data);
  }

  async getGuest(id: string): Promise<Guest> {
    return this.guestDelegate.getGuest(id);
  }

  async getGuestByName(projectId: string, name: string): Promise<Guest | null> {
    return this.guestDelegate.getGuestByName(projectId, name);
  }

  async getGuestByTmuxSessionId(tmuxSessionId: string): Promise<Guest | null> {
    return this.guestDelegate.getGuestByTmuxSessionId(tmuxSessionId);
  }

  async getGuestsByIdPrefix(prefix: string): Promise<Guest[]> {
    return this.guestDelegate.getGuestsByIdPrefix(prefix);
  }

  async listGuests(projectId: string): Promise<Guest[]> {
    return this.guestDelegate.listGuests(projectId);
  }

  async listAllGuests(): Promise<Guest[]> {
    return this.guestDelegate.listAllGuests();
  }

  async deleteGuest(id: string): Promise<void> {
    return this.guestDelegate.deleteGuest(id);
  }

  async updateGuestLastSeen(id: string, lastSeenAt: string): Promise<Guest> {
    return this.guestDelegate.updateGuestLastSeen(id, lastSeenAt);
  }

  // ============================================
  // CODE REVIEWS
  // ============================================

  async createReview(data: CreateReview): Promise<Review> {
    return this.reviewDelegate.createReview(data);
  }

  async getReview(id: string): Promise<Review> {
    return this.reviewDelegate.getReview(id);
  }

  async updateReview(id: string, data: UpdateReview, expectedVersion: number): Promise<Review> {
    return this.reviewDelegate.updateReview(id, data, expectedVersion);
  }

  async deleteReview(id: string): Promise<void> {
    return this.reviewDelegate.deleteReview(id);
  }

  async listReviews(
    projectId: string,
    options: ListReviewsOptions = {},
  ): Promise<ListResult<Review>> {
    return this.reviewDelegate.listReviews(projectId, options);
  }

  // Review Comments

  async createReviewComment(
    data: CreateReviewComment,
    targetAgentIds?: string[],
  ): Promise<ReviewComment> {
    return this.reviewDelegate.createReviewComment(data, targetAgentIds);
  }

  async getReviewComment(id: string): Promise<ReviewComment> {
    return this.reviewDelegate.getReviewComment(id);
  }

  async updateReviewComment(
    id: string,
    data: UpdateReviewComment,
    expectedVersion: number,
  ): Promise<ReviewComment> {
    return this.reviewDelegate.updateReviewComment(id, data, expectedVersion);
  }

  async listReviewComments(
    reviewId: string,
    options: ListReviewCommentsOptions = {},
  ): Promise<ListResult<ReviewCommentEnriched>> {
    return this.reviewDelegate.listReviewComments(reviewId, options);
  }

  // Review Comment Targets

  async addReviewCommentTargets(
    commentId: string,
    agentIds: string[],
  ): Promise<ReviewCommentTarget[]> {
    return this.reviewDelegate.addReviewCommentTargets(commentId, agentIds);
  }

  async getReviewCommentTargets(commentId: string): Promise<ReviewCommentTarget[]> {
    return this.reviewDelegate.getReviewCommentTargets(commentId);
  }

  async deleteReviewComment(id: string): Promise<void> {
    return this.reviewDelegate.deleteReviewComment(id);
  }

  async deleteNonResolvedComments(reviewId: string): Promise<number> {
    return this.reviewDelegate.deleteNonResolvedComments(reviewId);
  }

  // ============================================
  // SCHEDULED EPICS
  // ============================================

  async createScheduledEpic(data: CreateScheduledEpic): Promise<ScheduledEpic> {
    return this.scheduledEpicDelegate.createScheduledEpic(data);
  }

  async getScheduledEpic(id: string): Promise<ScheduledEpic> {
    return this.scheduledEpicDelegate.getScheduledEpic(id);
  }

  async listScheduledEpics(
    projectId: string,
    options: ListScheduledEpicsOptions = {},
  ): Promise<ListResult<ScheduledEpic>> {
    return this.scheduledEpicDelegate.listScheduledEpics(projectId, options);
  }

  async updateScheduledEpic(
    id: string,
    data: UpdateScheduledEpic,
    expectedVersion: number,
    options?: UpdateScheduledEpicOptions,
  ): Promise<ScheduledEpic> {
    return this.scheduledEpicDelegate.updateScheduledEpic(id, data, expectedVersion, options);
  }

  async deleteScheduledEpic(id: string): Promise<void> {
    return this.scheduledEpicDelegate.deleteScheduledEpic(id);
  }

  async updateScheduledEpicRuntimeState(
    id: string,
    data: UpdateScheduledEpicRuntimeState,
  ): Promise<ScheduledEpic> {
    return this.scheduledEpicDelegate.updateScheduledEpicRuntimeState(id, data);
  }

  async listDueScheduledEpics(projectId: string, before: string): Promise<ScheduledEpic[]> {
    return this.scheduledEpicDelegate.listDueScheduledEpics(projectId, before);
  }

  async createScheduledEpicRun(data: CreateScheduledEpicRun): Promise<ClaimRunResult> {
    return this.scheduledEpicDelegate.createScheduledEpicRun(data);
  }

  async getScheduledEpicRun(id: string): Promise<ScheduledEpicRun> {
    return this.scheduledEpicDelegate.getScheduledEpicRun(id);
  }

  async listScheduledEpicRuns(
    scheduleId: string,
    options: ListScheduledEpicRunsOptions = {},
  ): Promise<ListResult<ScheduledEpicRun>> {
    return this.scheduledEpicDelegate.listScheduledEpicRuns(scheduleId, options);
  }

  async updateScheduledEpicRun(
    id: string,
    data: UpdateScheduledEpicRun,
  ): Promise<ScheduledEpicRun> {
    return this.scheduledEpicDelegate.updateScheduledEpicRun(id, data);
  }

  async claimScheduledEpicRun(runId: string): Promise<ClaimRunResult> {
    return this.scheduledEpicDelegate.claimScheduledEpicRun(runId);
  }

  // ============================================
  // SESSION PARK-AND-REBIND
  // ============================================

  async parkSessionsFromAgents(agentIds: string[]): Promise<Map<string, string[]>> {
    return this.sessionDelegate.parkSessionsFromAgents(agentIds);
  }

  async applySessionPlan(
    toReassign: Array<{ sessionId: string; newAgentId: string }>,
    toDelete: string[],
  ): Promise<void> {
    return this.sessionDelegate.applySessionPlan(toReassign, toDelete);
  }

  async replaceIntegrationConnection(
    data: ReplaceIntegrationConnection,
    verify: VerifyIntegrationCredentials,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection | null>,
  ): Promise<IntegrationConnection> {
    return this.integrationDelegate.replaceIntegrationConnection(data, verify, eventFactory);
  }

  async getIntegrationConnection(
    identity: IntegrationConnectionLookup,
  ): Promise<IntegrationConnection | null> {
    return this.integrationDelegate.getIntegrationConnection(identity);
  }

  async getIntegrationConnectionById(connectionId: string): Promise<IntegrationConnection | null> {
    return this.integrationDelegate.getIntegrationConnectionById(connectionId);
  }

  async assignUnassignedIntegrationConnection(
    connectionId: string,
    projectId: string,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection> {
    return this.integrationDelegate.assignUnassignedIntegrationConnection(
      connectionId,
      projectId,
      eventFactory,
    );
  }

  async listIntegrationConnectionsByLegacySourceConnectionId(
    legacySourceConnectionId: string,
  ): Promise<IntegrationConnection[]> {
    return this.integrationDelegate.listIntegrationConnectionsByLegacySourceConnectionId(
      legacySourceConnectionId,
    );
  }

  async listIntegrationConnections(projectId?: string): Promise<IntegrationConnection[]> {
    return this.integrationDelegate.listIntegrationConnections(projectId);
  }

  async getIntegrationConnectionCredentials(
    identity: IntegrationConnectionLookup,
  ): Promise<IntegrationCredentials | null> {
    return this.integrationDelegate.getIntegrationConnectionCredentials(identity);
  }

  async getIntegrationConnectionCredentialsById(
    connectionId: string,
  ): Promise<IntegrationCredentials | null> {
    return this.integrationDelegate.getIntegrationConnectionCredentialsById(connectionId);
  }

  async disconnectIntegrationConnection(
    identity: IntegrationConnectionLookup,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean> {
    return this.integrationDelegate.disconnectIntegrationConnection(
      identity,
      eventFactory,
      options,
    );
  }

  async disconnectIntegrationConnectionById(
    connectionId: string,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean> {
    return this.integrationDelegate.disconnectIntegrationConnectionById(
      connectionId,
      eventFactory,
      options,
    );
  }

  async disconnectUnassignedIntegrationConnection(
    connectionId: string,
    eventFactory?: (connection: IntegrationConnection) => PreparedEvent | null,
    options?: { acknowledgeOrphanRisk?: boolean },
  ): Promise<boolean> {
    return this.integrationDelegate.disconnectUnassignedIntegrationConnection(
      connectionId,
      eventFactory,
      options,
    );
  }

  async updateIntegrationConnectionSyncSetting(
    identity: IntegrationConnectionLookup,
    subtaskSyncEnabled: boolean,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection> {
    return this.integrationDelegate.updateIntegrationConnectionSyncSetting(
      identity,
      subtaskSyncEnabled,
      eventFactory,
    );
  }

  async updateIntegrationConnectionSyncSettingById(
    connectionId: string,
    subtaskSyncEnabled: boolean,
    eventFactory?: FactualEventFactory<IntegrationConnection, IntegrationConnection>,
  ): Promise<IntegrationConnection> {
    return this.integrationDelegate.updateIntegrationConnectionSyncSettingById(
      connectionId,
      subtaskSyncEnabled,
      eventFactory,
    );
  }

  async createExternalTaskLink(data: CreateExternalTaskLink): Promise<ExternalTaskLink> {
    return this.integrationDelegate.createExternalTaskLink(data);
  }

  async createEpicWithExternalTaskLink(
    data: CreateEpicWithExternalTaskLink,
    eventFactory?: (result: CreateEpicWithExternalTaskLinkResult) => PreparedEvent | null,
  ): Promise<CreateEpicWithExternalTaskLinkResult> {
    return this.integrationDelegate.createEpicWithExternalTaskLink(data, eventFactory);
  }

  async findExternalTaskLink(
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalTaskLink | null> {
    return this.integrationDelegate.findExternalTaskLink(provider, remoteScopeKey, remoteTaskId);
  }

  async listExternalTaskLinksByRemoteScope(
    provider: IntegrationProvider,
    remoteScopeKey: string,
  ): Promise<ExternalTaskLink[]> {
    return this.integrationDelegate.listExternalTaskLinksByRemoteScope(provider, remoteScopeKey);
  }

  async listExternalTaskLinksByRemoteTask(
    provider: IntegrationProvider,
    remoteTaskId: string,
  ): Promise<ExternalTaskLink[]> {
    return this.integrationDelegate.listExternalTaskLinksByRemoteTask(provider, remoteTaskId);
  }

  async listExternalTaskLinksForEpic(epicId: string): Promise<ExternalTaskLink[]> {
    return this.integrationDelegate.listExternalTaskLinksForEpic(epicId);
  }

  async listExternalTaskLinksForEpics(epicIds: string[]): Promise<ExternalTaskLink[]> {
    return this.integrationDelegate.listExternalTaskLinksForEpics(epicIds);
  }

  async createExternalManagedSubtaskLink(
    data: CreateExternalManagedSubtaskLink,
  ): Promise<ExternalManagedSubtaskLink> {
    return this.externalManagedSubtaskDelegate.create(data);
  }

  async getExternalManagedSubtaskLink(id: string): Promise<ExternalManagedSubtaskLink> {
    return this.externalManagedSubtaskDelegate.get(id);
  }

  async listExternalManagedSubtaskLinksByProvider(
    provider: IntegrationProvider,
  ): Promise<ExternalManagedSubtaskLink[]> {
    return this.externalManagedSubtaskDelegate.listByProvider(provider);
  }

  async listExternalManagedSubtaskLinksByConnection(
    connectionId: string,
  ): Promise<ExternalManagedSubtaskLink[]> {
    return this.externalManagedSubtaskDelegate.listByConnection(connectionId);
  }

  async listExternalManagedSubtaskLinksForEpicSnapshot(
    epicIdSnapshot: string,
  ): Promise<ExternalManagedSubtaskLink[]> {
    return this.externalManagedSubtaskDelegate.listForEpicSnapshot(epicIdSnapshot);
  }

  async updateExternalManagedSubtaskLink(
    id: string,
    data: UpdateExternalManagedSubtaskLink,
  ): Promise<ExternalManagedSubtaskLink> {
    return this.externalManagedSubtaskDelegate.update(id, data);
  }

  async findRecognizedManagedSubtask(
    epicId: string,
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalManagedSubtaskLink | null> {
    return this.externalManagedSubtaskDelegate.findRecognition(
      epicId,
      provider,
      remoteScopeKey,
      remoteTaskId,
    );
  }

  async confirmExternalManagedSubtaskLink(
    data: ConfirmExternalManagedSubtaskLink,
  ): Promise<ConfirmExternalManagedSubtaskLinkResult> {
    return this.externalManagedSubtaskDelegate.confirm(data);
  }

  async removeExternalManagedSubtaskLink(id: string): Promise<boolean> {
    return this.externalManagedSubtaskDelegate.remove(id);
  }

  async getExternalEstimateLogState(
    identity: ExternalEstimateLogIdentity,
  ): Promise<ExternalEstimateLogState | null> {
    return this.externalEstimateLogDelegate.get(identity);
  }

  async getExternalEstimateLogDailyCheckpoint(
    identity: ExternalEstimateLogIdentity,
  ): Promise<ExternalEstimateLogDailyCheckpoint | null> {
    return this.externalEstimateLogDelegate.getDailyCheckpoint(identity);
  }

  async listExternalEstimateLogStatesByRemoteTask(
    provider: IntegrationProvider,
    remoteTaskId: string,
  ): Promise<ExternalEstimateLogState[]> {
    return this.externalEstimateLogDelegate.listByRemoteTask(provider, remoteTaskId);
  }

  async listExternalEstimateLoggedMinutes(
    provider: IntegrationProvider,
    identities: ReadonlyArray<{ remoteScopeKey: string; remoteTaskId: string }>,
  ): Promise<ExternalEstimateLoggedMinutesEntry[]> {
    return this.externalEstimateLogDelegate.listLoggedMinutes(provider, identities);
  }

  async setExternalEstimateLoggedMinutes(
    data: SetExternalEstimateLoggedMinutes,
  ): Promise<ExternalEstimateLogState> {
    return this.externalEstimateLogDelegate.setLoggedMinutes(data);
  }

  async prepareExternalEstimateLogOperation(
    data: PrepareExternalEstimateLogOperation,
  ): Promise<ExternalEstimateLogState> {
    return this.externalEstimateLogDelegate.prepare(data);
  }

  async markExternalEstimateLogOperationOutcomeUnknown(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState> {
    return this.externalEstimateLogDelegate.markOutcomeUnknown(data);
  }

  async confirmExternalEstimateLogOperation(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState> {
    return this.externalEstimateLogDelegate.confirm(data);
  }

  async clearExternalEstimateLogOperation(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState> {
    return this.externalEstimateLogDelegate.clear(data);
  }

  async storeExternalEstimateLogResolution(
    data: StoreExternalEstimateLogResolution,
  ): Promise<ExternalEstimateLogState> {
    return this.externalEstimateLogDelegate.storeResolution(data);
  }

  async applyExternalEstimateLogResolution(
    data: ExternalEstimateLogOperationMutation,
  ): Promise<ExternalEstimateLogState> {
    return this.externalEstimateLogDelegate.applyResolution(data);
  }
}
