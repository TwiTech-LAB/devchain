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
  UpdateProvider,
  ProviderMcpMetadata,
  UpdateProviderMcpMetadata,
  AgentProfile,
  CreateAgentProfile,
  UpdateAgentProfile,
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
  Watcher,
  CreateWatcher,
  UpdateWatcher,
  Subscriber,
  CreateSubscriber,
  UpdateSubscriber,
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
    options?: string | null;
    instructions?: string | null;
    temperature?: number | null;
    maxTokens?: number | null;
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

export interface StorageService {
  // Projects
  createProject(data: CreateProject): Promise<Project>;
  createProjectWithTemplate(
    data: CreateProject,
    template: TemplateImportPayload,
  ): Promise<CreateProjectWithTemplateResult>;
  getProject(id: string): Promise<Project>;
  findProjectByPath(path: string): Promise<Project | null>;
  listProjects(options?: ListOptions): Promise<ListResult<Project>>;
  updateProject(id: string, data: UpdateProject): Promise<Project>;
  deleteProject(id: string): Promise<void>;

  // Statuses
  createStatus(data: CreateStatus): Promise<Status>;
  getStatus(id: string): Promise<Status>;
  listStatuses(projectId: string, options?: ListOptions): Promise<ListResult<Status>>;
  findStatusByName(projectId: string, name: string): Promise<Status | null>;
  updateStatus(id: string, data: UpdateStatus): Promise<Status>;
  deleteStatus(id: string): Promise<void>;

  // Epics (with optimistic locking)
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
  /**
   * Batch-fetch sub-epics for multiple parent IDs efficiently.
   * Returns a Map where keys are parentIds and values are arrays of sub-epics.
   */
  listSubEpicsForParents(
    projectId: string,
    parentIds: string[],
    options?: ListSubEpicsForParentsOptions,
  ): Promise<Map<string, Epic[]>>;
  countSubEpicsByStatus(parentId: string): Promise<Record<string, number>>;
  countEpicsByStatus(statusId: string): Promise<number>;
  updateEpicsStatus(oldStatusId: string, newStatusId: string): Promise<number>;

  // Prompts (with optimistic locking)
  createPrompt(data: CreatePrompt): Promise<Prompt>;
  getPrompt(id: string): Promise<Prompt>;
  listPrompts(filters?: PromptListFilters): Promise<ListResult<PromptSummary>>;
  updatePrompt(id: string, data: UpdatePrompt, expectedVersion: number): Promise<Prompt>;
  deletePrompt(id: string): Promise<void>;
  getInitialSessionPrompt(projectId: string | null): Promise<Prompt | null>;

  // Tags
  createTag(data: CreateTag): Promise<Tag>;
  getTag(id: string): Promise<Tag>;
  listTags(projectId: string | null, options?: ListOptions): Promise<ListResult<Tag>>;
  updateTag(id: string, data: UpdateTag): Promise<Tag>;
  deleteTag(id: string): Promise<void>;

  // Providers
  createProvider(data: CreateProvider): Promise<Provider>;
  getProvider(id: string): Promise<Provider>;
  listProviders(options?: ListOptions): Promise<ListResult<Provider>>;
  updateProvider(id: string, data: UpdateProvider): Promise<Provider>;
  deleteProvider(id: string): Promise<void>;
  getProviderMcpMetadata(id: string): Promise<ProviderMcpMetadata>;
  updateProviderMcpMetadata(id: string, metadata: UpdateProviderMcpMetadata): Promise<Provider>;

  // Agent Profiles
  createAgentProfile(data: CreateAgentProfile): Promise<AgentProfile>;
  getAgentProfile(id: string): Promise<AgentProfile>;
  listAgentProfiles(options?: ProfileListOptions): Promise<ListResult<AgentProfile>>;
  updateAgentProfile(id: string, data: UpdateAgentProfile): Promise<AgentProfile>;
  deleteAgentProfile(id: string): Promise<void>;
  // Profile prompt assignments
  setAgentProfilePrompts(profileId: string, promptIdsOrdered: string[]): Promise<void>;
  getAgentProfilePrompts(
    profileId: string,
  ): Promise<Array<{ promptId: string; createdAt: string }>>;
  // Joined helpers to avoid N+1 when hydrating prompts with titles
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

  // Agents
  createAgent(data: CreateAgent): Promise<Agent>;
  getAgent(id: string): Promise<Agent>;
  listAgents(projectId: string, options?: ListOptions): Promise<ListResult<Agent>>;
  getAgentByName(projectId: string, name: string): Promise<Agent & { profile?: AgentProfile }>;
  updateAgent(id: string, data: UpdateAgent): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;

  // Records (with optimistic locking)
  createRecord(data: CreateEpicRecord): Promise<EpicRecord>;
  getRecord(id: string): Promise<EpicRecord>;
  listRecords(epicId: string, options?: ListOptions): Promise<ListResult<EpicRecord>>;
  updateRecord(id: string, data: UpdateEpicRecord, expectedVersion: number): Promise<EpicRecord>;
  deleteRecord(id: string): Promise<void>;

  // Epic comments
  listEpicComments(epicId: string, options?: ListOptions): Promise<ListResult<EpicComment>>;
  createEpicComment(data: CreateEpicComment): Promise<EpicComment>;
  deleteEpicComment(id: string): Promise<void>;

  // Documents
  listDocuments(filters?: DocumentListFilters): Promise<ListResult<Document>>;
  getDocument(identifier: DocumentIdentifier): Promise<Document>;
  createDocument(data: CreateDocument): Promise<Document>;
  updateDocument(id: string, data: UpdateDocument): Promise<Document>;
  deleteDocument(id: string): Promise<void>;

  // Chat message reads
  markMessageAsRead(messageId: string, agentId: string, readAt: string): Promise<void>;

  // Feature flags
  getFeatureFlags(): FeatureFlagConfig;

  // ============================================
  // TERMINAL WATCHERS
  // ============================================
  listWatchers(projectId: string): Promise<Watcher[]>;
  getWatcher(id: string): Promise<Watcher | null>;
  createWatcher(data: CreateWatcher): Promise<Watcher>;
  updateWatcher(id: string, data: UpdateWatcher): Promise<Watcher>;
  deleteWatcher(id: string): Promise<void>;
  listEnabledWatchers(): Promise<Watcher[]>; // All enabled watchers across all projects (for runtime)

  // ============================================
  // AUTOMATION SUBSCRIBERS
  // ============================================
  listSubscribers(projectId: string): Promise<Subscriber[]>;
  getSubscriber(id: string): Promise<Subscriber | null>;
  createSubscriber(data: CreateSubscriber): Promise<Subscriber>;
  updateSubscriber(id: string, data: UpdateSubscriber): Promise<Subscriber>;
  deleteSubscriber(id: string): Promise<void>;
  findSubscribersByEventName(projectId: string, eventName: string): Promise<Subscriber[]>;
}

export const STORAGE_SERVICE = 'STORAGE_SERVICE';
