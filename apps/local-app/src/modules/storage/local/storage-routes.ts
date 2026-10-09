import {
  combineScopes,
  entityProjects,
  ownedBy,
  projectIds,
} from '../write-gate/storage-write-scope';
import type { StorageScopeResolver } from '../write-gate/storage-write-scope';
import type { StorageService } from '../interfaces/storage.interface';
import type { SnapshotPromptWriter } from '../interfaces/snapshot-prompt-writer.interface';
import type { ProjectStorageDelegate } from './delegates/project.delegate';
import type { ProjectWorkspaceStorageDelegate } from './delegates/project-workspace.delegate';
import type { RemoteStorageDelegate } from './delegates/remote.delegate';
import type { ProviderAuthStorageDelegate } from './delegates/provider-auth.delegate';
import type { ProjectReplicaReadStorageDelegate } from './delegates/project-replica-read.delegate';
import type { ProjectReplicaStorageDelegate } from './delegates/project-replica.delegate';
import type { ProjectHostStorageDelegate } from './delegates/project-host.delegate';
import type { StatusStorageDelegate } from './delegates/status.delegate';
import type { EpicStorageDelegate } from './delegates/epic.delegate';
import type { TagStorageDelegate } from './delegates/tag.delegate';
import type { PromptStorageDelegate } from './delegates/prompt.delegate';
import type { ProviderStorageDelegate } from './delegates/provider.delegate';
import type { SkillSourceStorageDelegate } from './delegates/skill-source.delegate';
import type { AgentProfileStorageDelegate } from './delegates/agent-profile.delegate';
import type { ProfileProviderConfigStorageDelegate } from './delegates/profile-provider-config.delegate';
import type { AgentStorageDelegate } from './delegates/agent.delegate';
import type { RecordStorageDelegate } from './delegates/record.delegate';
import type { WatcherStorageDelegate } from './delegates/watcher.delegate';
import type { SubscriberStorageDelegate } from './delegates/subscriber.delegate';
import type { GuestStorageDelegate } from './delegates/guest.delegate';
import type { ReviewStorageDelegate } from './delegates/review.delegate';
import type { ProviderModelStorageDelegate } from './delegates/provider-model.delegate';
import type { ProviderEffortStorageDelegate } from './delegates/provider-effort.delegate';
import type { ProviderPluginPolicyStorageDelegate } from './delegates/provider-plugin-policy.delegate';
import type { ScheduledEpicStorageDelegate } from './delegates/scheduled-epic.delegate';
import type { SessionStorageDelegate } from './delegates/session.delegate';
import type { IntegrationStorageDelegate } from './delegates/integration.delegate';
import type { ExternalManagedSubtaskStorageDelegate } from './delegates/external-managed-subtask.delegate';
import type { ExternalEstimateLogStorageDelegate } from './delegates/external-estimate-log.delegate';

export type LocalStorageDelegates = {
  project: ProjectStorageDelegate;
  projectWorkspace: ProjectWorkspaceStorageDelegate;
  remote: RemoteStorageDelegate;
  providerAuth: ProviderAuthStorageDelegate;
  projectReplicaRead: ProjectReplicaReadStorageDelegate;
  projectReplica: ProjectReplicaStorageDelegate;
  projectHost: ProjectHostStorageDelegate;
  status: StatusStorageDelegate;
  epic: EpicStorageDelegate;
  tag: TagStorageDelegate;
  prompt: PromptStorageDelegate;
  provider: ProviderStorageDelegate;
  skillSource: SkillSourceStorageDelegate;
  agentProfile: AgentProfileStorageDelegate;
  profileProviderConfig: ProfileProviderConfigStorageDelegate;
  agent: AgentStorageDelegate;
  record: RecordStorageDelegate;
  watcher: WatcherStorageDelegate;
  subscriber: SubscriberStorageDelegate;
  guest: GuestStorageDelegate;
  review: ReviewStorageDelegate;
  providerModel: ProviderModelStorageDelegate;
  providerEffort: ProviderEffortStorageDelegate;
  providerPluginPolicy: ProviderPluginPolicyStorageDelegate;
  scheduledEpic: ScheduledEpicStorageDelegate;
  session: SessionStorageDelegate;
  integration: IntegrationStorageDelegate;
  externalManagedSubtask: ExternalManagedSubtaskStorageDelegate;
  externalEstimateLog: ExternalEstimateLogStorageDelegate;
};

export type StorageContract = StorageService & SnapshotPromptWriter;

/** Delegate keys whose member `K` matches the contract signature; a wrong route fails to compile. */
type RouteFor<K extends keyof StorageContract> = {
  [D in keyof LocalStorageDelegates]: LocalStorageDelegates[D] extends Record<K, StorageContract[K]>
    ? D
    : never;
}[keyof LocalStorageDelegates];

export type StorageRoutes = {
  [K in keyof StorageContract]: { delegate: RouteFor<K> } & (
    | { scope: 'exempt'; reason: string }
    | { scope: 'read' | 'global' | StorageScopeResolver<Parameters<StorageContract[K]>> }
  );
};

const HOME_OWNED_INTEGRATION_REASON =
  'External integration state remains owned by home when projects run remotely.';

export const STORAGE_ROUTES = {
  getFeatureFlags: { delegate: 'project', scope: 'read' },
  createProject: { delegate: 'project', scope: 'global' },
  runInTransaction: { delegate: 'project', scope: 'read' },
  createProjectShell: { delegate: 'project', scope: 'global' },
  getProject: { delegate: 'project', scope: 'read' },
  findProjectByPath: { delegate: 'project', scope: 'read' },
  listProjects: { delegate: 'project', scope: 'read' },
  getProjectsByIdPrefix: { delegate: 'project', scope: 'read' },
  getProjectWorkspaceSnapshot: { delegate: 'project', scope: 'read' },
  updateProject: { delegate: 'project', scope: projectIds(([id]) => [id]) },
  deleteProject: { delegate: 'project', scope: projectIds(([id]) => [id]) },
  listProjectWorkspaces: { delegate: 'projectWorkspace', scope: 'read' },
  getProjectWorkspace: { delegate: 'projectWorkspace', scope: 'read' },
  createProjectWorkspace: { delegate: 'projectWorkspace', scope: 'global' },
  renameProjectWorkspace: { delegate: 'projectWorkspace', scope: 'global' },
  reorderProjectWorkspaces: { delegate: 'projectWorkspace', scope: 'global' },
  deleteProjectWorkspace: { delegate: 'projectWorkspace', scope: 'global' },
  readRemoteApiKey: { delegate: 'remote', scope: 'read' },
  saveRemoteApiKey: { delegate: 'remote', scope: 'global' },
  createRemote: { delegate: 'remote', scope: 'global' },
  getRemote: { delegate: 'remote', scope: 'read' },
  listRemotes: { delegate: 'remote', scope: 'read' },
  updateRemoteName: { delegate: 'remote', scope: 'global' },
  updateRemoteBaseUrl: { delegate: 'remote', scope: 'global' },
  updateRemoteVmIdentity: { delegate: 'remote', scope: 'global' },
  updateRemoteTlsCertificate: { delegate: 'remote', scope: 'global' },
  createVmProviderConnection: { delegate: 'remote', scope: 'global' },
  listVmProviderConnections: { delegate: 'remote', scope: 'read' },
  getVmProviderConnection: { delegate: 'remote', scope: 'read' },
  readVmProviderTokenSecret: { delegate: 'remote', scope: 'read' },
  deleteVmProviderConnection: { delegate: 'remote', scope: 'global' },
  deleteRemote: { delegate: 'remote', scope: 'global' },
  listProviderAuthEntries: { delegate: 'providerAuth', scope: 'read' },
  getProviderAuthEntry: { delegate: 'providerAuth', scope: 'read' },
  readProviderAuthPayload: { delegate: 'providerAuth', scope: 'read' },
  createProviderAuthEntry: { delegate: 'providerAuth', scope: 'global' },
  deleteProviderAuthEntry: { delegate: 'providerAuth', scope: 'global' },
  updateProviderAuthPayload: { delegate: 'providerAuth', scope: 'global' },
  renameProviderAuthEntry: { delegate: 'providerAuth', scope: 'global' },
  checkoutProviderAuthEntry: { delegate: 'providerAuth', scope: 'global' },
  releaseProviderAuthEntry: { delegate: 'providerAuth', scope: 'global' },
  listRemoteProjectBindings: { delegate: 'remote', scope: 'read' },
  getRemoteProjectBinding: { delegate: 'remote', scope: 'read' },
  createRemoteProjectBinding: {
    delegate: 'remote',
    scope: 'exempt',
    reason: 'Binding changes establish remote ownership during handoff.',
  },
  updateRemoteProjectBinding: {
    delegate: 'remote',
    scope: 'exempt',
    reason: 'Binding changes transition ownership while the project is blocked.',
  },
  deleteRemoteProjectBinding: {
    delegate: 'remote',
    scope: 'exempt',
    reason: 'Binding deletion returns remote ownership to home.',
  },
  createRemoteOperation: { delegate: 'remote', scope: 'global' },
  getRemoteOperation: { delegate: 'remote', scope: 'read' },
  listRemoteOperations: { delegate: 'remote', scope: 'read' },
  updateRemoteOperation: { delegate: 'remote', scope: 'global' },
  readProjectReplicaSource: { delegate: 'projectReplicaRead', scope: 'read' },
  applyProjectReplica: {
    delegate: 'projectReplica',
    scope: 'exempt',
    reason: 'Replica application writes the non-owning mirror during handoff and live sync.',
  },
  setProjectFrozen: {
    delegate: 'projectHost',
    scope: 'exempt',
    reason: 'Handoff must persist the freeze while the project is blocked.',
  },
  listFrozenProjects: { delegate: 'projectHost', scope: 'read' },
  releaseProject: {
    delegate: 'projectHost',
    scope: 'exempt',
    reason: 'Host release removes a frozen replica.',
  },
  findEpicIdByIdempotencyKey: { delegate: 'projectHost', scope: 'read' },
  createStatus: { delegate: 'status', scope: projectIds(([data]) => [data.projectId]) },
  getStatus: { delegate: 'status', scope: 'read' },
  listStatuses: { delegate: 'status', scope: 'read' },
  findStatusByName: { delegate: 'status', scope: 'read' },
  updateStatus: {
    delegate: 'status',
    scope: combineScopes(
      ownedBy('status'),
      projectIds(([, data]) => [data.projectId]),
    ),
  },
  deleteStatus: { delegate: 'status', scope: ownedBy('status') },
  createEpic: { delegate: 'epic', scope: projectIds(([data]) => [data.projectId]) },
  createEpicWithinTransaction: {
    delegate: 'epic',
    scope: projectIds(([data]) => [data.projectId]),
  },
  getEpic: { delegate: 'epic', scope: 'read' },
  listEpics: { delegate: 'epic', scope: 'read' },
  listEpicsByStatus: { delegate: 'epic', scope: 'read' },
  listProjectEpics: { delegate: 'epic', scope: 'read' },
  listAssignedEpics: { delegate: 'epic', scope: 'read' },
  createEpicForProject: { delegate: 'epic', scope: projectIds(([projectId]) => [projectId]) },
  updateEpic: {
    delegate: 'epic',
    scope: combineScopes(
      ownedBy('epic'),
      projectIds(([, data]) => [data.projectId]),
    ),
  },
  deleteEpic: { delegate: 'epic', scope: ownedBy('epic') },
  listSubEpics: { delegate: 'epic', scope: 'read' },
  listParentChildren: { delegate: 'epic', scope: 'read' },
  listSubEpicsForParents: { delegate: 'epic', scope: 'read' },
  countSubEpicsByStatus: { delegate: 'epic', scope: 'read' },
  countEpicsByStatus: { delegate: 'epic', scope: 'read' },
  updateEpicsStatus: {
    delegate: 'epic',
    scope: entityProjects('status', ([oldId, newId]) => [oldId, newId]),
  },
  listEpicComments: { delegate: 'epic', scope: 'read' },
  createEpicComment: { delegate: 'epic', scope: entityProjects('epic', ([data]) => [data.epicId]) },
  deleteEpicComment: { delegate: 'epic', scope: ownedBy('epicComment') },
  deleteEpicCommentScoped: { delegate: 'epic', scope: ownedBy('epic') },
  getEpicsByIdPrefix: { delegate: 'epic', scope: 'read' },
  setEpicRelation: {
    delegate: 'epic',
    scope: entityProjects('epic', ([data]) => [data.epicId, data.relatedEpicId]),
  },
  deleteEpicRelation: {
    delegate: 'epic',
    scope: entityProjects('epic', ([epicId, relatedEpicId]) => [epicId, relatedEpicId]),
  },
  listEpicRelations: { delegate: 'epic', scope: 'read' },
  summarizeEpicRelationsBatch: { delegate: 'epic', scope: 'read' },
  listEpicRelationCandidates: { delegate: 'epic', scope: 'read' },
  getWorkspaceEpicsByIdPrefix: { delegate: 'epic', scope: 'read' },
  createPrompt: { delegate: 'prompt', scope: projectIds(([data]) => [data.projectId]) },
  createPromptFromSnapshot: { delegate: 'prompt', scope: projectIds(([data]) => [data.projectId]) },
  getPrompt: { delegate: 'prompt', scope: 'read' },
  listPrompts: { delegate: 'prompt', scope: 'read' },
  updatePrompt: {
    delegate: 'prompt',
    scope: combineScopes(
      ownedBy('prompt'),
      projectIds(([, data]) => [data.projectId]),
    ),
  },
  deletePrompt: { delegate: 'prompt', scope: ownedBy('prompt') },
  getInitialSessionPrompt: { delegate: 'prompt', scope: 'read' },
  createTag: { delegate: 'tag', scope: projectIds(([data]) => [data.projectId]) },
  getTag: { delegate: 'tag', scope: 'read' },
  listTags: { delegate: 'tag', scope: 'read' },
  updateTag: {
    delegate: 'tag',
    scope: combineScopes(
      ownedBy('tag'),
      projectIds(([, data]) => [data.projectId]),
    ),
  },
  deleteTag: { delegate: 'tag', scope: ownedBy('tag') },
  createProvider: { delegate: 'provider', scope: 'global' },
  createProviderModel: { delegate: 'providerModel', scope: 'global' },
  listProviderModelsByProvider: { delegate: 'providerModel', scope: 'read' },
  listProviderModelsByProviderIds: { delegate: 'providerModel', scope: 'read' },
  deleteProviderModel: { delegate: 'providerModel', scope: 'global' },
  bulkCreateProviderModels: { delegate: 'providerModel', scope: 'global' },
  createProviderEffort: { delegate: 'providerEffort', scope: 'global' },
  listProviderEffortsByProvider: { delegate: 'providerEffort', scope: 'read' },
  listProviderEffortsByProviderIds: { delegate: 'providerEffort', scope: 'read' },
  deleteProviderEffort: { delegate: 'providerEffort', scope: 'global' },
  bulkCreateProviderEfforts: { delegate: 'providerEffort', scope: 'global' },
  getProvider: { delegate: 'provider', scope: 'read' },
  listProviders: { delegate: 'provider', scope: 'read' },
  listProvidersByIds: { delegate: 'provider', scope: 'read' },
  updateProvider: { delegate: 'provider', scope: 'global' },
  deleteProvider: { delegate: 'provider', scope: 'global' },
  upsertProviderPluginDefault: { delegate: 'providerPluginPolicy', scope: 'global' },
  getProviderPluginDefault: { delegate: 'providerPluginPolicy', scope: 'read' },
  listProviderPluginDefaults: { delegate: 'providerPluginPolicy', scope: 'read' },
  deleteProviderPluginDefault: { delegate: 'providerPluginPolicy', scope: 'global' },
  upsertProjectProviderPluginOverride: {
    delegate: 'providerPluginPolicy',
    scope: projectIds(([data]) => [data.projectId]),
  },
  getProjectProviderPluginOverride: { delegate: 'providerPluginPolicy', scope: 'read' },
  listProjectProviderPluginOverrides: { delegate: 'providerPluginPolicy', scope: 'read' },
  deleteProjectProviderPluginOverride: {
    delegate: 'providerPluginPolicy',
    scope: projectIds(([projectId]) => [projectId]),
  },
  getProviderEnvForProject: { delegate: 'provider', scope: 'read' },
  listEnvScopesByProviderIds: { delegate: 'provider', scope: 'read' },
  updateProviderWithScopes: {
    delegate: 'provider',
    scope: ([id, , envScopes, currentEnvKeys], lookup) =>
      lookup.changedProviderScopeProjects(id, envScopes, currentEnvKeys),
  },
  getProviderMcpMetadata: { delegate: 'provider', scope: 'read' },
  updateProviderMcpMetadata: { delegate: 'provider', scope: 'global' },
  getSourceProjectEnabled: { delegate: 'skillSource', scope: 'read' },
  setSourceProjectEnabled: {
    delegate: 'skillSource',
    scope: 'exempt',
    reason: 'The host mirrors home switches even while a handoff freezes it.',
  },
  listSourceProjectEnabled: { delegate: 'skillSource', scope: 'read' },
  listCommunitySkillSources: { delegate: 'skillSource', scope: 'read' },
  getCommunitySkillSource: { delegate: 'skillSource', scope: 'read' },
  getCommunitySkillSourceByName: { delegate: 'skillSource', scope: 'read' },
  createCommunitySkillSource: { delegate: 'skillSource', scope: 'global' },
  deleteCommunitySkillSource: { delegate: 'skillSource', scope: 'global' },
  listLocalSkillSources: { delegate: 'skillSource', scope: 'read' },
  getLocalSkillSource: { delegate: 'skillSource', scope: 'read' },
  getLocalSkillSourceByName: { delegate: 'skillSource', scope: 'read' },
  createLocalSkillSource: { delegate: 'skillSource', scope: 'global' },
  deleteLocalSkillSource: { delegate: 'skillSource', scope: 'global' },
  createAgentProfile: { delegate: 'agentProfile', scope: projectIds(([data]) => [data.projectId]) },
  getAgentProfile: { delegate: 'agentProfile', scope: 'read' },
  listAgentProfiles: { delegate: 'agentProfile', scope: 'read' },
  updateAgentProfile: {
    delegate: 'agentProfile',
    scope: combineScopes(
      ownedBy('profile'),
      projectIds(([, data]) => [data.projectId]),
    ),
  },
  deleteAgentProfile: { delegate: 'agentProfile', scope: ownedBy('profile') },
  setAgentProfilePrompts: { delegate: 'agentProfile', scope: ownedBy('profile') },
  getAgentProfilePrompts: { delegate: 'agentProfile', scope: 'read' },
  getAgentProfileWithPrompts: { delegate: 'agentProfile', scope: 'read' },
  listAgentProfilesWithPrompts: { delegate: 'agentProfile', scope: 'read' },
  createProfileProviderConfig: {
    delegate: 'profileProviderConfig',
    scope: entityProjects('profile', ([data]) => [data.profileId]),
  },
  createIfMissing: {
    delegate: 'profileProviderConfig',
    scope: entityProjects('profile', ([data]) => [data.profileId]),
  },
  getProfileProviderConfig: { delegate: 'profileProviderConfig', scope: 'read' },
  listProfileProviderConfigsByProfile: { delegate: 'profileProviderConfig', scope: 'read' },
  listProfileProviderConfigsByIds: { delegate: 'profileProviderConfig', scope: 'read' },
  listAllProfileProviderConfigs: { delegate: 'profileProviderConfig', scope: 'read' },
  updateProfileProviderConfig: {
    delegate: 'profileProviderConfig',
    scope: ownedBy('profileConfig'),
  },
  deleteProfileProviderConfig: {
    delegate: 'profileProviderConfig',
    scope: ownedBy('profileConfig'),
  },
  reorderProfileProviderConfigs: {
    delegate: 'profileProviderConfig',
    scope: combineScopes(
      ownedBy('profile'),
      entityProjects('profileConfig', ([, configIds]) => configIds),
    ),
  },
  createAgent: { delegate: 'agent', scope: projectIds(([data]) => [data.projectId]) },
  getAgent: { delegate: 'agent', scope: 'read' },
  listAgents: { delegate: 'agent', scope: 'read' },
  listProjectOwners: { delegate: 'agent', scope: 'read' },
  getAgentByName: { delegate: 'agent', scope: 'read' },
  updateAgent: {
    delegate: 'agent',
    scope: combineScopes(
      ownedBy('agent'),
      projectIds(([, data]) => [data.projectId]),
    ),
  },
  deleteAgent: { delegate: 'agent', scope: ownedBy('agent') },
  createRecord: { delegate: 'record', scope: entityProjects('epic', ([data]) => [data.epicId]) },
  getRecord: { delegate: 'record', scope: 'read' },
  listRecords: { delegate: 'record', scope: 'read' },
  updateRecord: { delegate: 'record', scope: ownedBy('record') },
  deleteRecord: { delegate: 'record', scope: ownedBy('record') },
  listWatchers: { delegate: 'watcher', scope: 'read' },
  getWatcher: { delegate: 'watcher', scope: 'read' },
  createWatcher: { delegate: 'watcher', scope: projectIds(([data]) => [data.projectId]) },
  updateWatcher: { delegate: 'watcher', scope: ownedBy('watcher') },
  deleteWatcher: { delegate: 'watcher', scope: ownedBy('watcher') },
  listEnabledWatchers: { delegate: 'watcher', scope: 'read' },
  listSubscribers: { delegate: 'subscriber', scope: 'read' },
  getSubscriber: { delegate: 'subscriber', scope: 'read' },
  createSubscriber: { delegate: 'subscriber', scope: projectIds(([data]) => [data.projectId]) },
  updateSubscriber: { delegate: 'subscriber', scope: ownedBy('subscriber') },
  deleteSubscriber: { delegate: 'subscriber', scope: ownedBy('subscriber') },
  findSubscribersByEventName: { delegate: 'subscriber', scope: 'read' },
  getProjectByRootPath: { delegate: 'project', scope: 'read' },
  findProjectContainingPath: { delegate: 'project', scope: 'read' },
  createGuest: { delegate: 'guest', scope: projectIds(([data]) => [data.projectId]) },
  getGuest: { delegate: 'guest', scope: 'read' },
  getGuestByName: { delegate: 'guest', scope: 'read' },
  getGuestByTmuxSessionId: { delegate: 'guest', scope: 'read' },
  getGuestsByIdPrefix: { delegate: 'guest', scope: 'read' },
  listGuests: { delegate: 'guest', scope: 'read' },
  listAllGuests: { delegate: 'guest', scope: 'read' },
  deleteGuest: { delegate: 'guest', scope: ownedBy('guest') },
  updateGuestLastSeen: { delegate: 'guest', scope: ownedBy('guest') },
  createReview: { delegate: 'review', scope: projectIds(([data]) => [data.projectId]) },
  getReview: { delegate: 'review', scope: 'read' },
  updateReview: { delegate: 'review', scope: ownedBy('review') },
  deleteReview: { delegate: 'review', scope: ownedBy('review') },
  listReviews: { delegate: 'review', scope: 'read' },
  createReviewComment: {
    delegate: 'review',
    scope: combineScopes(
      entityProjects('review', ([data]) => [data.reviewId]),
      entityProjects('agent', ([, agentIds]) => agentIds ?? []),
    ),
  },
  getReviewComment: { delegate: 'review', scope: 'read' },
  updateReviewComment: { delegate: 'review', scope: ownedBy('reviewComment') },
  listReviewComments: { delegate: 'review', scope: 'read' },
  addReviewCommentTargets: {
    delegate: 'review',
    scope: combineScopes(
      ownedBy('reviewComment'),
      entityProjects('agent', ([, agentIds]) => agentIds),
    ),
  },
  getReviewCommentTargets: { delegate: 'review', scope: 'read' },
  deleteReviewComment: { delegate: 'review', scope: ownedBy('reviewComment') },
  deleteNonResolvedComments: { delegate: 'review', scope: ownedBy('review') },
  createScheduledEpic: {
    delegate: 'scheduledEpic',
    scope: projectIds(([data]) => [data.projectId]),
  },
  getScheduledEpic: { delegate: 'scheduledEpic', scope: 'read' },
  listScheduledEpics: { delegate: 'scheduledEpic', scope: 'read' },
  updateScheduledEpic: { delegate: 'scheduledEpic', scope: ownedBy('schedule') },
  deleteScheduledEpic: { delegate: 'scheduledEpic', scope: ownedBy('schedule') },
  updateScheduledEpicRuntimeState: { delegate: 'scheduledEpic', scope: ownedBy('schedule') },
  listDueScheduledEpics: { delegate: 'scheduledEpic', scope: 'read' },
  createScheduledEpicRun: {
    delegate: 'scheduledEpic',
    scope: entityProjects('schedule', ([data]) => [data.scheduleId]),
  },
  getScheduledEpicRun: { delegate: 'scheduledEpic', scope: 'read' },
  listScheduledEpicRuns: { delegate: 'scheduledEpic', scope: 'read' },
  updateScheduledEpicRun: { delegate: 'scheduledEpic', scope: ownedBy('scheduledRun') },
  claimScheduledEpicRun: { delegate: 'scheduledEpic', scope: ownedBy('scheduledRun') },
  parkSessionsFromAgents: {
    delegate: 'session',
    scope: entityProjects('agent', ([agentIds]) => agentIds),
  },
  applySessionPlan: {
    delegate: 'session',
    scope: combineScopes(
      entityProjects('session', ([toReassign, toDelete]) => [
        ...toReassign.map((entry) => entry.sessionId),
        ...toDelete,
      ]),
      entityProjects('agent', ([toReassign]) => toReassign.map((entry) => entry.newAgentId)),
    ),
  },
  replaceIntegrationConnection: {
    delegate: 'integration',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  getIntegrationConnection: { delegate: 'integration', scope: 'read' },
  getIntegrationConnectionById: { delegate: 'integration', scope: 'read' },
  assignUnassignedIntegrationConnection: {
    delegate: 'integration',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  listIntegrationConnectionsByLegacySourceConnectionId: { delegate: 'integration', scope: 'read' },
  listIntegrationConnections: { delegate: 'integration', scope: 'read' },
  getIntegrationConnectionCredentials: { delegate: 'integration', scope: 'read' },
  getIntegrationConnectionCredentialsById: { delegate: 'integration', scope: 'read' },
  disconnectIntegrationConnection: {
    delegate: 'integration',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  disconnectIntegrationConnectionById: {
    delegate: 'integration',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  disconnectUnassignedIntegrationConnection: {
    delegate: 'integration',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  updateIntegrationConnectionSyncSetting: {
    delegate: 'integration',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  updateIntegrationConnectionSyncSettingById: {
    delegate: 'integration',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  createExternalTaskLink: {
    delegate: 'integration',
    scope: 'exempt',
    reason: 'Home maintains external task links for remote-owned projects.',
  },
  createEpicWithExternalTaskLink: {
    delegate: 'integration',
    scope: projectIds(([data]) => [data.epic.projectId]),
  },
  findExternalTaskLink: { delegate: 'integration', scope: 'read' },
  listExternalTaskLinksByRemoteScope: { delegate: 'integration', scope: 'read' },
  listExternalTaskLinksByRemoteTask: { delegate: 'integration', scope: 'read' },
  listExternalTaskLinksForEpic: { delegate: 'integration', scope: 'read' },
  listExternalTaskLinksForEpics: { delegate: 'integration', scope: 'read' },
  createExternalManagedSubtaskLink: {
    delegate: 'externalManagedSubtask',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  getExternalManagedSubtaskLink: { delegate: 'externalManagedSubtask', scope: 'read' },
  listExternalManagedSubtaskLinksByProvider: { delegate: 'externalManagedSubtask', scope: 'read' },
  listExternalManagedSubtaskLinksByConnection: {
    delegate: 'externalManagedSubtask',
    scope: 'read',
  },
  listExternalManagedSubtaskLinksForEpicSnapshot: {
    delegate: 'externalManagedSubtask',
    scope: 'read',
  },
  updateExternalManagedSubtaskLink: {
    delegate: 'externalManagedSubtask',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  findRecognizedManagedSubtask: { delegate: 'externalManagedSubtask', scope: 'read' },
  confirmExternalManagedSubtaskLink: {
    delegate: 'externalManagedSubtask',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  removeExternalManagedSubtaskLink: {
    delegate: 'externalManagedSubtask',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  getExternalEstimateLogState: { delegate: 'externalEstimateLog', scope: 'read' },
  getExternalEstimateLogDailyCheckpoint: { delegate: 'externalEstimateLog', scope: 'read' },
  listExternalEstimateLogStatesByRemoteTask: { delegate: 'externalEstimateLog', scope: 'read' },
  findUnassignedExternalEstimateLogCheckpoint: { delegate: 'externalEstimateLog', scope: 'read' },
  assignUnassignedExternalEstimateLogCheckpoint: {
    delegate: 'externalEstimateLog',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  listExternalEstimateLoggedMinutes: { delegate: 'externalEstimateLog', scope: 'read' },
  setExternalEstimateLoggedMinutes: {
    delegate: 'externalEstimateLog',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  prepareExternalEstimateLogOperation: {
    delegate: 'externalEstimateLog',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  markExternalEstimateLogOperationOutcomeUnknown: {
    delegate: 'externalEstimateLog',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  confirmExternalEstimateLogOperation: {
    delegate: 'externalEstimateLog',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  clearExternalEstimateLogOperation: {
    delegate: 'externalEstimateLog',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  storeExternalEstimateLogResolution: {
    delegate: 'externalEstimateLog',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
  applyExternalEstimateLogResolution: {
    delegate: 'externalEstimateLog',
    scope: 'exempt',
    reason: HOME_OWNED_INTEGRATION_REASON,
  },
} as const satisfies StorageRoutes;
