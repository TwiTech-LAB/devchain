import { Injectable, Inject } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../db/db.provider';
import {
  StorageService,
  ListOptions,
  ListResult,
  DocumentListFilters,
  DocumentIdentifier,
  ListProjectEpicsOptions,
  ListAssignedEpicsOptions,
  ListSubEpicsForParentsOptions,
  CreateEpicForProjectInput,
  ProfileListOptions,
  PromptListFilters,
  PromptSummary,
  ListReviewsOptions,
  ListReviewCommentsOptions,
} from '../interfaces/storage.interface';
import {
  Project,
  CreateProject,
  UpdateProject,
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
  UpdateProvider,
  ProviderMcpMetadata,
  UpdateProviderMcpMetadata,
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
} from '../models/domain.models';
import { ValidationError, ConflictError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  DEFAULT_FEATURE_FLAGS,
  type FeatureFlagConfig,
} from '../../../common/config/feature-flags';
import { RESERVED_COMMUNITY_SOURCE_NAMES } from './helpers/storage-helpers';
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
import { ProjectStorageDelegate } from './delegates/project.delegate';
import { RecordStorageDelegate } from './delegates/record.delegate';
import { ReviewStorageDelegate } from './delegates/review.delegate';
import { SkillSourceStorageDelegate } from './delegates/skill-source.delegate';
import { StatusStorageDelegate } from './delegates/status.delegate';
import { SubscriberStorageDelegate } from './delegates/subscriber.delegate';
import { TagStorageDelegate } from './delegates/tag.delegate';
import { WatcherStorageDelegate } from './delegates/watcher.delegate';

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
export class LocalStorageService implements StorageService {
  private readonly projectDelegate: ProjectStorageDelegate;
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

  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {
    const context = createStorageDelegateContext(this.db);
    this.projectDelegate = new ProjectStorageDelegate(context);
    this.statusDelegate = new StatusStorageDelegate(context);
    this.tagDelegate = new TagStorageDelegate(context);
    this.promptDelegate = new PromptStorageDelegate(context, {
      createTag: (data) => this.createTag(data),
      getPrompt: (id) => this.getPrompt(id),
    });
    this.documentDelegate = new DocumentStorageDelegate(context, {
      createTag: (data) => this.createTag(data),
      getDocument: (identifier) => this.getDocument(identifier),
      generateDocumentSlug: (projectId, desired, excludeId) =>
        excludeId === undefined
          ? this.generateDocumentSlug(projectId, desired)
          : this.generateDocumentSlug(projectId, desired, excludeId),
      setDocumentTags: (documentId, tagNames, projectId) =>
        this.setDocumentTags(documentId, tagNames, projectId),
    });
    this.epicDelegate = new EpicStorageDelegate(context, {
      createTag: (data) => this.createTag(data),
      getAgent: (id) => this.getAgent(id),
      getAgentByName: (projectId, name) => this.getAgentByName(projectId, name),
      getStatus: (id) => this.statusDelegate.getStatus(id),
    });
    this.providerDelegate = new ProviderStorageDelegate(context, {
      updateProvider: (id, data) => this.updateProvider(id, data),
    });
    this.providerModelDelegate = new ProviderModelStorageDelegate(context);
    this.skillSourceDelegate = new SkillSourceStorageDelegate(context, {
      assertLocalSourceNameAvailableAcrossTypes: (sourceName) =>
        this.assertLocalSourceNameAvailableAcrossTypes(sourceName),
      getCommunitySkillSource: (id) => this.getCommunitySkillSource(id),
      getLocalSkillSource: (id) => this.getLocalSkillSource(id),
    });
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
      createTag: (data) => this.createTag(data),
      getRecord: (id) => this.getRecord(id),
    });
    this.watcherDelegate = new WatcherStorageDelegate(context);
    this.subscriberDelegate = new SubscriberStorageDelegate(context);
    this.guestDelegate = new GuestStorageDelegate(context);
    this.reviewDelegate = new ReviewStorageDelegate(context, {
      getReview: (id) => this.getReview(id),
      getReviewComment: (id) => this.getReviewComment(id),
    });
    logger.info('LocalStorageService initialized');
  }

  getFeatureFlags(): FeatureFlagConfig {
    return { ...DEFAULT_FEATURE_FLAGS };
  }

  private async assertLocalSourceNameAvailableAcrossTypes(sourceName: string): Promise<void> {
    if (RESERVED_COMMUNITY_SOURCE_NAMES.has(sourceName)) {
      throw new ValidationError('Local source name conflicts with a built-in source.', {
        name: sourceName,
      });
    }

    const { communitySkillSources } = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const existingCommunitySource = await this.db
      .select({ id: communitySkillSources.id })
      .from(communitySkillSources)
      .where(eq(communitySkillSources.name, sourceName))
      .limit(1);

    if (existingCommunitySource.length > 0) {
      throw new ConflictError('Local source name conflicts with an existing community source.', {
        name: sourceName,
      });
    }
  }

  // Projects
  async createProject(data: CreateProject): Promise<Project> {
    return this.projectDelegate.createProject(data);
  }

  async createProjectWithTemplate(
    data: CreateProject,
    template: import('../interfaces/storage.interface').TemplateImportPayload,
    options?: import('../interfaces/storage.interface').CreateProjectWithTemplateOptions,
  ): Promise<import('../interfaces/storage.interface').CreateProjectWithTemplateResult> {
    return this.projectDelegate.createProjectWithTemplate(data, template, options);
  }

  async getProject(id: string): Promise<Project> {
    return this.projectDelegate.getProject(id);
  }

  async findProjectByPath(path: string): Promise<Project | null> {
    return this.projectDelegate.findProjectByPath(path);
  }

  async listProjects(options: ListOptions = {}): Promise<ListResult<Project>> {
    return this.projectDelegate.listProjects(options);
  }

  async updateProject(id: string, data: UpdateProject): Promise<Project> {
    return this.projectDelegate.updateProject(id, data);
  }

  async deleteProject(id: string): Promise<void> {
    return this.projectDelegate.deleteProject(id);
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
  async createEpic(data: CreateEpic): Promise<Epic> {
    return this.epicDelegate.createEpic(data);
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

  async createEpicForProject(projectId: string, input: CreateEpicForProjectInput): Promise<Epic> {
    return this.epicDelegate.createEpicForProject(projectId, input);
  }

  async updateEpic(id: string, data: UpdateEpic, expectedVersion: number): Promise<Epic> {
    return this.epicDelegate.updateEpic(id, data, expectedVersion);
  }

  async deleteEpic(id: string): Promise<void> {
    return this.epicDelegate.deleteEpic(id);
  }

  async listSubEpics(parentId: string, options: ListOptions = {}): Promise<ListResult<Epic>> {
    return this.epicDelegate.listSubEpics(parentId, options);
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

  async createEpicComment(data: CreateEpicComment): Promise<EpicComment> {
    return this.epicDelegate.createEpicComment(data);
  }

  async deleteEpicComment(id: string): Promise<void> {
    return this.epicDelegate.deleteEpicComment(id);
  }

  async getEpicsByIdPrefix(
    projectId: string,
    prefix: string,
  ): Promise<Array<{ id: string; title: string }>> {
    return this.epicDelegate.getEpicsByIdPrefix(projectId, prefix);
  }

  // Prompts (with optimistic locking)
  async createPrompt(data: CreatePrompt): Promise<Prompt> {
    return this.promptDelegate.createPrompt(data);
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

  async seedSourceProjectDisabled(projectId: string, sourceNames: string[]): Promise<void> {
    return this.skillSourceDelegate.seedSourceProjectDisabled(projectId, sourceNames);
  }

  async deleteSourceProjectEnabledBySource(sourceName: string): Promise<void> {
    return this.skillSourceDelegate.deleteSourceProjectEnabledBySource(sourceName);
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
  ): Promise<CommunitySkillSource> {
    return this.skillSourceDelegate.createCommunitySkillSource(data);
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

  async createLocalSkillSource(data: CreateLocalSkillSource): Promise<LocalSkillSource> {
    return this.skillSourceDelegate.createLocalSkillSource(data);
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

  async getAgentByName(
    projectId: string,
    name: string,
  ): Promise<Agent & { profile?: AgentProfile }> {
    return this.agentDelegate.getAgentByName(projectId, name);
  }

  async updateAgent(id: string, data: UpdateAgent): Promise<Agent> {
    return this.agentDelegate.updateAgent(id, data);
  }

  async deleteAgent(id: string): Promise<void> {
    return this.agentDelegate.deleteAgent(id);
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

  // Chat message reads
  async markMessageAsRead(messageId: string, agentId: string, readAt: string): Promise<void> {
    return this.reviewDelegate.markMessageAsRead(messageId, agentId, readAt);
  }

  private async generateDocumentSlug(
    projectId: string | null,
    desired: string,
    excludeId?: string,
  ): Promise<string> {
    return this.documentDelegate.generateDocumentSlug(projectId, desired, excludeId);
  }

  private async setDocumentTags(
    documentId: string,
    tagNames: string[],
    projectId: string | null,
  ): Promise<void> {
    return this.documentDelegate.setDocumentTags(documentId, tagNames, projectId);
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
}
