import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { restartKeyForMain } from '@/ui/lib/restart-keys';
import { agentQueryKeys } from '@/ui/lib/agents';
import type { FetchFn } from '@/ui/lib/api-transport';

interface ConfigUpdateVars {
  providerConfigId: string;
  modelOverride?: string | null;
  effortOverride?: string | null;
}

/**
 * Build the PUT body for a config/override change. `modelOverride`/`effortOverride`
 * are only sent when explicitly provided (undefined ⇒ omit), so a plain config
 * switch never clears an existing override.
 */
function buildConfigBody({ providerConfigId, modelOverride, effortOverride }: ConfigUpdateVars) {
  const body: ConfigUpdateVars = { providerConfigId };
  if (modelOverride !== undefined) {
    body.modelOverride = modelOverride;
  }
  if (effortOverride !== undefined) {
    body.effortOverride = effortOverride;
  }
  return body;
}

export interface UseAgentConfigSwitchOptions {
  apiFetch: FetchFn;
  projectId: string | null;
  agentPresence: Record<string, { online?: boolean } | undefined>;
  markAgentsForRestart: (keys: string[]) => void;
}

export interface UseAgentConfigSwitchResult {
  handleSwitchConfig: (
    agentId: string,
    providerConfigId: string,
    modelOverride?: string | null,
    effortOverride?: string | null,
  ) => Promise<unknown>;
  updatingConfigAgentIds: Record<string, boolean>;
}

/**
 * Marks online agents for restart after a config switch and refreshes both
 * agent list variants. Pending state drives the per-row spinners.
 */
export function useAgentConfigSwitch({
  apiFetch,
  projectId,
  agentPresence,
  markAgentsForRestart,
}: UseAgentConfigSwitchOptions): UseAgentConfigSwitchResult {
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToastHelpers();

  // Track which agent is being updated
  const [updatingConfigAgentId, setUpdatingConfigAgentId] = useState<string | null>(null);

  const updateAgentConfigMutation = useMutation({
    mutationFn: async ({
      agentId,
      providerConfigId,
      modelOverride,
      effortOverride,
    }: ConfigUpdateVars & { agentId: string }) => {
      const res = await apiFetch(`/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfigBody({ providerConfigId, modelOverride, effortOverride })),
      });
      if (!res.ok) throw new Error('Failed to update agent config');
      return res.json();
    },
    onMutate: ({ agentId }) => {
      setUpdatingConfigAgentId(agentId);
    },
    onSuccess: (_, { agentId, modelOverride, effortOverride }) => {
      const isOnline = agentPresence[agentId]?.online === true;
      const isOverrideUpdate = modelOverride !== undefined || effortOverride !== undefined;

      // Mark for restart if agent has active session
      if (isOnline) {
        markAgentsForRestart([restartKeyForMain(agentId)]);
      }

      queryClient.invalidateQueries({ queryKey: agentQueryKeys.project(projectId) });
      showSuccess({
        title: isOverrideUpdate ? 'Overrides updated' : 'Config updated',
        description: isOnline ? 'Restart to apply changes.' : 'Will apply on next launch.',
      });
    },
    onError: (error) => {
      showError({
        title: 'Failed to update config',
        description: getErrorMessage(error, 'Unknown error'),
      });
    },
    onSettled: () => {
      setUpdatingConfigAgentId(null);
    },
  });

  // Handle switching provider config for an agent (returns a promise so the
  // Overrides dialog can await success/failure)
  const handleSwitchConfig = useCallback(
    (
      agentId: string,
      providerConfigId: string,
      modelOverride?: string | null,
      effortOverride?: string | null,
    ) =>
      updateAgentConfigMutation.mutateAsync({
        agentId,
        providerConfigId,
        modelOverride,
        effortOverride,
      }),
    [updateAgentConfigMutation],
  );

  // Build updating config agent IDs record for ChatSidebar
  const updatingConfigAgentIds: Record<string, boolean> = useMemo(
    () => (updatingConfigAgentId ? { [updatingConfigAgentId]: true } : {}),
    [updatingConfigAgentId],
  );

  return {
    handleSwitchConfig,
    updatingConfigAgentIds,
  };
}
