import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { restartKeyForMain, restartKeyForWorktree } from '@/ui/lib/restart-keys';
import type { WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';
import type { OverridesConfigOption } from '@/ui/components/chat/AgentOverridesDialog';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  worktreeAgentGroups: WorktreeAgentGroup[];
  markAgentsForRestart: (keys: string[]) => void;
}

export interface UseAgentConfigSwitchResult {
  handleSwitchConfig: (
    agentId: string,
    providerConfigId: string,
    modelOverride?: string | null,
    effortOverride?: string | null,
  ) => Promise<unknown>;
  handleSwitchWorktreeConfig: (
    group: WorktreeAgentGroup,
    agentId: string,
    providerConfigId: string,
    modelOverride?: string | null,
    effortOverride?: string | null,
  ) => Promise<unknown>;
  fetchProviderConfigsForProfile: (profileId: string) => Promise<OverridesConfigOption[]>;
  updatingConfigAgentIds: Record<string, boolean>;
  updatingWorktreeConfigKey: string | null;
}

/**
 * Provider-config / overrides switching for main and worktree agents, extracted
 * from ChatPage. Both variants share the request-body shape but diverge in target
 * (injected `apiFetch` vs. the worktree's absolute `apiBase` on the module default
 * fetch), invalidation key (`['agents', projectId]` vs.
 * `['chat-worktree-agent-groups']`), and restart-key scheme — all preserved
 * verbatim. Pending state is tracked per-variant and surfaced for row spinners.
 */
export function useAgentConfigSwitch({
  apiFetch,
  projectId,
  agentPresence,
  worktreeAgentGroups,
  markAgentsForRestart,
}: UseAgentConfigSwitchOptions): UseAgentConfigSwitchResult {
  const queryClient = useQueryClient();
  const { showSuccess, showError } = useToastHelpers();

  // Track which agent is being updated
  const [updatingConfigAgentId, setUpdatingConfigAgentId] = useState<string | null>(null);

  // Track which worktree agent is being updated (composite key: `${apiBase}:${agentId}`)
  const [updatingWorktreeConfigKey, setUpdatingWorktreeConfigKey] = useState<string | null>(null);

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

      queryClient.invalidateQueries({ queryKey: ['agents', projectId] });
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

  const updateWorktreeAgentConfigMutation = useMutation({
    mutationFn: async ({
      apiBase,
      agentId,
      providerConfigId,
      modelOverride,
      effortOverride,
    }: ConfigUpdateVars & { apiBase: string; agentId: string }) => {
      const res = await fetch(`${apiBase}/api/agents/${agentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfigBody({ providerConfigId, modelOverride, effortOverride })),
      });
      if (!res.ok) throw new Error('Failed to update agent config');
      return res.json();
    },
    onMutate: ({ apiBase, agentId }) => {
      setUpdatingWorktreeConfigKey(`${apiBase}:${agentId}`);
    },
    onSuccess: (_, { apiBase, agentId, modelOverride, effortOverride }) => {
      const group = worktreeAgentGroups.find((g) => g.apiBase === apiBase);
      const isOnline = group?.agentPresence[agentId]?.online === true;
      const isOverrideUpdate = modelOverride !== undefined || effortOverride !== undefined;

      // Mark for restart if agent has active session
      if (isOnline) {
        markAgentsForRestart([restartKeyForWorktree(apiBase, agentId)]);
      }

      queryClient.invalidateQueries({ queryKey: ['chat-worktree-agent-groups'] });
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
      setUpdatingWorktreeConfigKey(null);
    },
  });

  // Handle switching provider config for a worktree agent (returns a promise so
  // the Overrides dialog can await success/failure)
  const handleSwitchWorktreeConfig = useCallback(
    (
      group: WorktreeAgentGroup,
      agentId: string,
      providerConfigId: string,
      modelOverride?: string | null,
      effortOverride?: string | null,
    ) =>
      updateWorktreeAgentConfigMutation.mutateAsync({
        apiBase: group.apiBase,
        agentId,
        providerConfigId,
        modelOverride,
        effortOverride,
      }),
    [updateWorktreeAgentConfigMutation],
  );

  // Helper to fetch provider configs for a profile (used by ChatSidebar)
  const fetchProviderConfigsForProfile = useCallback(
    async (profileId: string): Promise<OverridesConfigOption[]> => {
      const res = await apiFetch(`/api/profiles/${profileId}/provider-configs`);
      if (!res.ok) throw new Error('Failed to fetch provider configs');
      return res.json();
    },
    [apiFetch],
  );

  // Build updating config agent IDs record for ChatSidebar
  const updatingConfigAgentIds: Record<string, boolean> = useMemo(
    () => (updatingConfigAgentId ? { [updatingConfigAgentId]: true } : {}),
    [updatingConfigAgentId],
  );

  return {
    handleSwitchConfig,
    handleSwitchWorktreeConfig,
    fetchProviderConfigsForProfile,
    updatingConfigAgentIds,
    updatingWorktreeConfigKey,
  };
}
