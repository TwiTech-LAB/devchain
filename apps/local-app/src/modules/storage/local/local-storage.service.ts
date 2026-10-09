import { Injectable, Inject, Optional } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { DB_CONNECTION } from '../db/db.provider';
import type { StorageService } from '../interfaces/storage.interface';
import type { SnapshotPromptWriter } from '../interfaces/snapshot-prompt-writer.interface';
import type { CreateTag, Tag } from '../models/domain.models';
import { createLogger } from '../../../common/logging/logger';
import { createStorageDelegateContext } from './delegates/base-storage.delegate';
import { ProjectStorageDelegate } from './delegates/project.delegate';
import { ProjectWorkspaceStorageDelegate } from './delegates/project-workspace.delegate';
import { RemoteStorageDelegate } from './delegates/remote.delegate';
import { ProviderAuthStorageDelegate } from './delegates/provider-auth.delegate';
import { ProjectReplicaReadStorageDelegate } from './delegates/project-replica-read.delegate';
import { ProjectReplicaStorageDelegate } from './delegates/project-replica.delegate';
import { ProjectHostStorageDelegate } from './delegates/project-host.delegate';
import { StatusStorageDelegate } from './delegates/status.delegate';
import { EpicStorageDelegate } from './delegates/epic.delegate';
import { TagStorageDelegate } from './delegates/tag.delegate';
import { PromptStorageDelegate } from './delegates/prompt.delegate';
import { ProviderStorageDelegate } from './delegates/provider.delegate';
import { SkillSourceStorageDelegate } from './delegates/skill-source.delegate';
import { AgentProfileStorageDelegate } from './delegates/agent-profile.delegate';
import { ProfileProviderConfigStorageDelegate } from './delegates/profile-provider-config.delegate';
import { AgentStorageDelegate } from './delegates/agent.delegate';
import { RecordStorageDelegate } from './delegates/record.delegate';
import { WatcherStorageDelegate } from './delegates/watcher.delegate';
import { SubscriberStorageDelegate } from './delegates/subscriber.delegate';
import { GuestStorageDelegate } from './delegates/guest.delegate';
import { ReviewStorageDelegate } from './delegates/review.delegate';
import { ProviderModelStorageDelegate } from './delegates/provider-model.delegate';
import { ProviderEffortStorageDelegate } from './delegates/provider-effort.delegate';
import { ProviderPluginPolicyStorageDelegate } from './delegates/provider-plugin-policy.delegate';
import { ScheduledEpicStorageDelegate } from './delegates/scheduled-epic.delegate';
import { SessionStorageDelegate } from './delegates/session.delegate';
import { IntegrationStorageDelegate } from './delegates/integration.delegate';
import { ExternalManagedSubtaskStorageDelegate } from './delegates/external-managed-subtask.delegate';
import { ExternalEstimateLogStorageDelegate } from './delegates/external-estimate-log.delegate';
import { IntegrationCredentialCipher } from './integration-credential-cipher';
import { CommittedEventStore } from '../../events/services/committed-event.store';
import { DurableEventRegistryService } from '../../events/services/durable-event-registry.service';
import { STORAGE_ROUTES } from './storage-routes';
import type { LocalStorageDelegates } from './storage-routes';
import { ProjectWriteGate } from '../write-gate/project-write-gate';
import { ProjectWriteLookup } from '../write-gate/storage-write-scope';
import type { StorageScopeResolver } from '../write-gate/storage-write-scope';

const logger = createLogger('LocalStorageService');

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- Members are bound from STORAGE_ROUTES, whose satisfies clause checks every signature.
export interface LocalStorageService extends StorageService, SnapshotPromptWriter {}

@Injectable()
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- Members are bound from STORAGE_ROUTES, whose satisfies clause checks every signature.
export class LocalStorageService {
  constructor(
    @Inject(DB_CONNECTION) db: BetterSQLite3Database,
    @Optional() integrationCredentialCipher?: IntegrationCredentialCipher,
    @Optional() committedEventStore?: CommittedEventStore,
    @Optional() gate?: ProjectWriteGate,
  ) {
    const context = createStorageDelegateContext(db);
    const eventStore =
      committedEventStore ?? new CommittedEventStore(db, new DurableEventRegistryService());
    const credentialCipher = integrationCredentialCipher ?? new IntegrationCredentialCipher();
    const createTag = (data: CreateTag): Tag => delegates.tag.createTagSync(data);
    const delegates: LocalStorageDelegates = {
      project: new ProjectStorageDelegate(context),
      projectWorkspace: new ProjectWorkspaceStorageDelegate(context),
      remote: new RemoteStorageDelegate(context, credentialCipher),
      providerAuth: new ProviderAuthStorageDelegate(context, credentialCipher),
      projectReplicaRead: new ProjectReplicaReadStorageDelegate(context),
      projectReplica: new ProjectReplicaStorageDelegate(context, {
        appendEvent: (event) => eventStore.appendInCurrentTransaction(event),
      }),
      projectHost: new ProjectHostStorageDelegate(context),
      status: new StatusStorageDelegate(context),
      tag: new TagStorageDelegate(context),
      prompt: new PromptStorageDelegate(context, {
        createTag,
      }),
      epic: new EpicStorageDelegate(context, {
        createTag,
        getAgent: (id) => delegates.agent.getAgentSync(id),
        getAgentByName: (projectId, name) => delegates.agent.getAgentByName(projectId, name),
        getStatus: (id) => delegates.status.getStatus(id),
        appendEvent: (event) => eventStore.appendInCurrentTransaction(event),
      }),
      provider: new ProviderStorageDelegate(context, {
        updateProvider: (id, data) => delegates.provider.updateProvider(id, data),
      }),
      providerModel: new ProviderModelStorageDelegate(context),
      providerEffort: new ProviderEffortStorageDelegate(context),
      providerPluginPolicy: new ProviderPluginPolicyStorageDelegate(context),
      skillSource: new SkillSourceStorageDelegate(context, gate),
      agentProfile: new AgentProfileStorageDelegate(context, {
        getAgentProfile: (id) => delegates.agentProfile.getAgentProfile(id),
        listAgentProfiles: (options) => delegates.agentProfile.listAgentProfiles(options),
      }),
      profileProviderConfig: new ProfileProviderConfigStorageDelegate(context, {
        getProfileProviderConfig: (id) =>
          delegates.profileProviderConfig.getProfileProviderConfig(id),
      }),
      agent: new AgentStorageDelegate(context, {
        getAgent: (id) => delegates.agent.getAgent(id),
        getAgentProfile: (id) => delegates.agentProfile.getAgentProfile(id),
        getProfileProviderConfig: (id) =>
          delegates.profileProviderConfig.getProfileProviderConfig(id),
      }),
      record: new RecordStorageDelegate(context, {
        createTag,
      }),
      watcher: new WatcherStorageDelegate(context),
      subscriber: new SubscriberStorageDelegate(context),
      guest: new GuestStorageDelegate(context),
      review: new ReviewStorageDelegate(context),
      scheduledEpic: new ScheduledEpicStorageDelegate(context),
      session: new SessionStorageDelegate(context),
      externalManagedSubtask: new ExternalManagedSubtaskStorageDelegate(context),
      externalEstimateLog: new ExternalEstimateLogStorageDelegate(context),
      integration: new IntegrationStorageDelegate(context, credentialCipher, {
        createEpicWithinTransaction: (data) => delegates.epic.createEpicWithinTransaction(data),
        getEpic: (id) => delegates.epic.getEpic(id),
        appendEvent: (event) => eventStore.appendInCurrentTransaction(event),
        handleConnectionMutation: (connectionId, provider, acknowledgeOrphanRisk) =>
          delegates.externalManagedSubtask.handleConnectionMutationSync(
            connectionId,
            provider,
            acknowledgeOrphanRisk,
          ),
      }),
    };

    const lookup = new ProjectWriteLookup(context.rawClient);
    for (const method of Object.keys(STORAGE_ROUTES) as Array<keyof typeof STORAGE_ROUTES>) {
      const route = STORAGE_ROUTES[method];
      const delegate: Partial<Record<keyof typeof STORAGE_ROUTES, unknown>> =
        delegates[route.delegate];
      const implementation = delegate[method];
      if (typeof implementation !== 'function') {
        throw new Error(`Storage route ${method} does not resolve to a function`);
      }
      const bound = implementation.bind(delegate) as (...args: unknown[]) => unknown;
      const scope = route.scope;
      const resolve =
        typeof scope === 'function' ? (scope as StorageScopeResolver<readonly unknown[]>) : null;
      const value =
        resolve && gate
          ? (...args: unknown[]): unknown => {
              if (!gate.hasBlockedProjects()) return bound(...args);
              try {
                for (const projectId of resolve(args, lookup)) {
                  if (projectId !== null) gate.assertWritable(projectId);
                }
              } catch (error) {
                return Promise.reject(error);
              }
              // An await here would lose the outer transaction's synchronous join window.
              return bound(...args);
            }
          : bound;
      Object.defineProperty(this, method, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
    logger.info('LocalStorageService initialized');
  }
}
