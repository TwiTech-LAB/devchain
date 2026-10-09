import { HOME_BACKEND } from '@/ui/lib/api-transport';
import {
  REMOTES_QUERY_PREFIX,
  REMOTE_BINDINGS_QUERY_KEY,
  REMOTES_LIST_QUERY_KEY,
  remoteStatsHistoryQueryKey,
} from '@/ui/lib/backend-provider';

export {
  REMOTES_QUERY_PREFIX,
  REMOTE_BINDINGS_QUERY_KEY,
  REMOTES_LIST_QUERY_KEY,
  remoteStatsHistoryQueryKey,
};

export const remoteOperationsKeys = {
  all: [HOME_BACKEND, 'remote-operations'] as const,
  /** Under `all`, so any operations refresh reloads the project's newest operation. */
  newestOfProject: (projectId: string) => [...remoteOperationsKeys.all, 'newest', projectId],
};

// A remotes event must not rerun readiness, which can start Syncthing.
export const remoteReadinessQueryKey = [HOME_BACKEND, 'remote-readiness'] as const;
export const homeIdentityQueryKey = [HOME_BACKEND, 'host-install-identity'] as const;
export const hostInstallBlockQueryKey = (minDiskGib: number) =>
  [HOME_BACKEND, 'host-install-block', minDiskGib] as const;
export const vmProviderConnectionQueryKey = [HOME_BACKEND, 'vm-providers'] as const;
export const vmProviderRightsQueryKey = (connectionId: string) =>
  [HOME_BACKEND, 'vm-provider-rights', connectionId] as const;
export const remoteRunningAgentsQueryKey = (remoteId: string) =>
  [HOME_BACKEND, 'remote-running-agents', remoteId] as const;

export const providerAuthKeys = {
  all: [HOME_BACKEND, 'provider-auth'] as const,
  opencodeLogins: () => [...providerAuthKeys.all, 'opencode-logins'],
  generation: (generationId: string | null) => [
    ...providerAuthKeys.all,
    'generation',
    generationId,
  ],
};
export const fileSyncAutoFixQueryKey = (projectId: string) =>
  [HOME_BACKEND, 'file-sync-auto-fix', projectId] as const;
export const fileSyncFailuresQueryKey = (projectId: string) =>
  [HOME_BACKEND, 'file-sync-failed', projectId] as const;
export const projectIgnoresQueryKey = (projectId: string | null) =>
  [HOME_BACKEND, 'file-sync-ignores', projectId] as const;
export const connectChoicesQueryKey = (projectId: string | null) =>
  [HOME_BACKEND, 'connect-choices', projectId] as const;
export const dockerPresenceQueryKey = (projectId: string | null) =>
  [HOME_BACKEND, 'docker-presence', projectId] as const;
export const dockerSyncStateQueryKey = (projectId: string, remoteId: string) =>
  [HOME_BACKEND, 'docker-sync-state', projectId, remoteId] as const;
export const fileSyncStatusQueryKey = (projectId: string) =>
  [HOME_BACKEND, 'file-sync', projectId, 'status'] as const;
