import { useRuntime } from '@/ui/hooks/useRuntime';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';

export interface IntegrationAvailability {
  canUseIntegrations: boolean;
  runtimeResolved: boolean;
  reason: 'resolving' | 'runtime_disabled' | 'worktree' | null;
}

export function useIntegrationAvailability(): IntegrationAvailability {
  const { runtimeInfo } = useRuntime();
  const { runtimeResolved, apiBase } = useOptionalWorktreeTab();
  const runtimeEnabled = runtimeInfo?.integrationAdmission?.allowed === true;
  const canUseIntegrations = runtimeResolved && runtimeEnabled && apiBase === '';

  return {
    canUseIntegrations,
    runtimeResolved,
    reason: !runtimeResolved
      ? 'resolving'
      : apiBase !== ''
        ? 'worktree'
        : !runtimeEnabled
          ? 'runtime_disabled'
          : null,
  };
}
