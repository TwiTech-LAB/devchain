import type { IntegrationProvider } from './integration-connections';

export type ManagedSubtaskSyncStatus =
  | 'disabled'
  | 'idle'
  | 'syncing'
  | 'needs_attention'
  | 'orphan_risk';

export interface ManagedSubtaskSyncHealthItem {
  id: string;
  epicId: string;
  phase: 'pre_dispatch' | 'dispatch_admitted' | 'outcome_unknown' | 'confirmed' | 'needs_attention';
  tombstoneState: 'active' | 'local_deleted' | 'move_out' | 'orphan_risk';
  safeErrorCode: string | null;
  retryAt: string | null;
  remoteTaskId: string | null;
  openInSourceUrl: string | null;
  canVerify: boolean;
  canRetry: boolean;
}

export interface ManagedSubtaskSyncHealth {
  provider: IntegrationProvider;
  enabled: boolean;
  syncSettingRevision: number | null;
  status: ManagedSubtaskSyncStatus;
  counts: {
    total: number;
    pending: number;
    outcomeUnknown: number;
    needsAttention: number;
    orphanRisk: number;
  };
  items: ManagedSubtaskSyncHealthItem[];
  truncated: boolean;
}

export const managedSubtaskSyncQueryKeys = {
  all: ['managed-subtask-sync'] as const,
  project: (projectId: string) => [...managedSubtaskSyncQueryKeys.all, projectId] as const,
  provider: (projectId: string, provider: IntegrationProvider) =>
    [...managedSubtaskSyncQueryKeys.project(projectId), provider] as const,
  legacy: (connectionId: string) =>
    [...managedSubtaskSyncQueryKeys.all, 'legacy', connectionId] as const,
};
