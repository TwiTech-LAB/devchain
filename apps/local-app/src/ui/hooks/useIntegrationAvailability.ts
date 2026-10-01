import { useRuntime } from '@/ui/hooks/useRuntime';

export interface IntegrationAvailability {
  canUseIntegrations: boolean;
  runtimeResolved: boolean;
  reason: 'resolving' | 'runtime_disabled' | null;
}

/**
 * Integration availability derived from the runtime admission decision.
 * Integrations are usable only once the runtime has resolved and its
 * `integrationAdmission.allowed` is true; runtime info that is still loading
 * reports `resolving`, and missing or failed runtime info fails closed as
 * `runtime_disabled`.
 */
export function useIntegrationAvailability(): IntegrationAvailability {
  const { runtimeInfo, runtimeLoading } = useRuntime();
  const runtimeResolved = !runtimeLoading;
  const runtimeEnabled = runtimeInfo?.integrationAdmission?.allowed === true;
  const canUseIntegrations = runtimeResolved && runtimeEnabled;

  return {
    canUseIntegrations,
    runtimeResolved,
    reason: !runtimeResolved ? 'resolving' : !runtimeEnabled ? 'runtime_disabled' : null,
  };
}
