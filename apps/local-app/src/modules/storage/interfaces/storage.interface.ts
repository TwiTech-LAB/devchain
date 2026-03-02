import type { FeatureFlagConfig } from '../../../common/config/feature-flags';
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
  Document,
  CreateDocument,
  UpdateDocument,
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
} from '../models/domain.models';

export interface ListOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
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

export interface DocumentListFilters {
  projectId?: string | null;
  tags?: string[];
  tagKeys?: string[];
  q?: string;
  limit?: number;
  offset?: number;
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

export interface DocumentIdentifier {
  id?: string;
  projectId?: string | null;
  slug?: string;
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

export interface CreateEpicForProjectInput {
  title: string;
  description?: string | null;
  tags?: string[];
  statusId?: string;
  agentId?: string | null;
  agentName?: string;
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
export interface TemplateImportPayload {
  prompts: Array<{
    id?: string;
    title: string;
    content?: string;
    version?: number;
    tags?: string[];
  }>;
  profiles: Array<{
    id?: string;
    name: string;
    providerId: string;
    familySlug?: string | null;
    options?: string | null;
    instructions?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
    providerConfigs?: Array<{
      name: string;
      providerName: string;
      options?: string | null;
      env?: Record<string, string> | null;
      position?: number;
    }>;
  }>;
  agents: Array<{
    id?: string;
    name: string;
    profileId?: string;
    description?: string | null;
  }>;
  statuses: Array<{
    id?: string;
    label: string;
    color: string;
    position: number;
    mcpHidden?: boolean;
  }>;
  initialPrompt?: {
    promptId?: string;
    title?: string;
  } | null;
}

export interface CreateProjectWithTemplateResult {
  project: Project;
  imported: {
    prompts: number;
    profiles: number;
    agents: number;
    statuses: number;
  };
  mappings: {
    promptIdMap: Record<string, string>;
    profileIdMap: Record<string, string>;
    agentIdMap: Record<string, string>;
    statusIdMap: Record<string, string>;
  };
  initialPromptSet: boolean;
}

export interface CreateProjectWithTemplateOptions {
  projectId?: string;
}

export interface ProjectStorage {
  createProject(data: CreateProject): Promise<Project>;
  createProjectWithTemplate(
    data: CreateProject,
    template: TemplateImportPayload,
    options?: CreateProjectWithTemplateOptions,
  ): Promise<CreateProjectWithTemplateResult>;
  getProject(id: string): Promise<Project>;
  findProjectByPath(path: string): Promise<Project | null>;
  listProjects(options?: ListOptions): Promise<ListResult<Project>>;
  updateProject(id: string, data: UpdateProject): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  getProjectByRootPath(rootPath: string): Promise<Project | null>;
  findProjectContainingPath(absolutePath: string): Promise<Project | null>;
  getFeatureFlags(): FeatureFlagConfig;
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
  createEpic(data: CreateEpic): Promise<Epic>;
  getEpic(id: string): Promise<Epic>;
  listEpics(projectId: string, options?: ListOptions): Promise<ListResult<Epic>>;
  listEpicsByStatus(statusId: string, options?: ListOptions): Promise<ListResult<Epic>>;
  listProjectEpics(projectId: string, options?: ListProjectEpicsOptions): Promise<ListResult<Epic>>;
  listAssignedEpics(
    projectId: string,
    options: ListAssignedEpicsOptions,
  ): Promise<ListResult<Epic>>;
  createEpicForProject(projectId: string, input: CreateEpicForProjectInput): Promise<Epic>;
  updateEpic(id: string, data: UpdateEpic, expectedVersion: number): Promise<Epic>;
  deleteEpic(id: string): Promise<void>;
  listSubEpics(parentId: string, options?: ListOptions): Promise<ListResult<Epic>>;
  listSubEpicsForParents(
    projectId: string,
    parentIds: string[],
    options?: ListSubEpicsForParentsOptions,
  ): Promise<Map<string, Epic[]>>;
  countSubEpicsByStatus(parentId: string): Promise<Record<string, number>>;
  countEpicsByStatus(statusId: string): Promise<number>;
  updateEpicsStatus(oldStatusId: string, newStatusId: string): Promise<number>;
  listEpicComments(epicId: string, options?: ListOptions): Promise<ListResult<EpicComment>>;
  createEpicComment(data: CreateEpicComment): Promise<EpicComment>;
  deleteEpicComment(id: string): Promise<void>;
  getEpicsByIdPrefix(
    projectId: string,
    prefix: string,
  ): Promise<Array<{ id: string; title: string }>>;
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
  getProvider(id: string): Promise<Provider>;
  listProviders(options?: ListOptions): Promise<ListResult<Provider>>;
  listProvidersByIds(ids: string[]): Promise<Provider[]>;
  updateProvider(id: string, data: UpdateProvider): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  getProviderMcpMetadata(id: string): Promise<ProviderMcpMetadata>;
  updateProviderMcpMetadata(id: string, metadata: UpdateProviderMcpMetadata): Promise<Provider>;
}

export interface SkillSourceStorage {
  listCommunitySkillSources(): Promise<CommunitySkillSource[]>;
  getCommunitySkillSource(id: string): Promise<CommunitySkillSource>;
  getCommunitySkillSourceByName(name: string): Promise<CommunitySkillSource | null>;
  createCommunitySkillSource(data: CreateCommunitySkillSource): Promise<CommunitySkillSource>;
  deleteCommunitySkillSource(id: string): Promise<void>;
  listLocalSkillSources(): Promise<LocalSkillSource[]>;
  getLocalSkillSource(id: string): Promise<LocalSkillSource | null>;
  createLocalSkillSource(data: CreateLocalSkillSource): Promise<LocalSkillSource>;
  deleteLocalSkillSource(id: string): Promise<void>;
  getSourceProjectEnabled(projectId: string, sourceName: string): Promise<boolean | null>;
  setSourceProjectEnabled(projectId: string, sourceName: string, enabled: boolean): Promise<void>;
  listSourceProjectEnabled(
    projectId: string,
  ): Promise<Array<{ sourceName: string; enabled: boolean }>>;
  seedSourceProjectDisabled(projectId: string, sourceNames: string[]): Promise<void>;
  deleteSourceProjectEnabledBySource(sourceName: string): Promise<void>;
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

export interface ProfileProviderConfigStorage {
  createProfileProviderConfig(data: CreateProfileProviderConfig): Promise<ProfileProviderConfig>;
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

export interface AgentStorage {
  createAgent(data: CreateAgent): Promise<Agent>;
  getAgent(id: string): Promise<Agent>;
  listAgents(projectId: string, options?: ListOptions): Promise<ListResult<Agent>>;
  getAgentByName(projectId: string, name: string): Promise<Agent & { profile?: AgentProfile }>;
  updateAgent(id: string, data: UpdateAgent): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;
}

export interface RecordStorage {
  createRecord(data: CreateEpicRecord): Promise<EpicRecord>;
  getRecord(id: string): Promise<EpicRecord>;
  listRecords(epicId: string, options?: ListOptions): Promise<ListResult<EpicRecord>>;
  updateRecord(id: string, data: UpdateEpicRecord, expectedVersion: number): Promise<EpicRecord>;
  deleteRecord(id: string): Promise<void>;
}

export interface DocumentStorage {
  listDocuments(filters?: DocumentListFilters): Promise<ListResult<Document>>;
  getDocument(identifier: DocumentIdentifier): Promise<Document>;
  createDocument(data: CreateDocument): Promise<Document>;
  updateDocument(id: string, data: UpdateDocument): Promise<Document>;
  deleteDocument(id: string): Promise<void>;
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
  markMessageAsRead(messageId: string, agentId: string, readAt: string): Promise<void>;
}

export interface StorageService
  extends ProjectStorage,
    StatusStorage,
    EpicStorage,
    PromptStorage,
    TagStorage,
    ProviderStorage,
    SkillSourceStorage,
    AgentProfileStorage,
    ProfileProviderConfigStorage,
    AgentStorage,
    RecordStorage,
    DocumentStorage,
    GuestStorage,
    WatcherStorage,
    SubscriberStorage,
    ReviewStorage {}

export const STORAGE_SERVICE = 'STORAGE_SERVICE';
