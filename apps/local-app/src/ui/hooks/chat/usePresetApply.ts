import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import {
  validatePresetAvailability,
  type Agent as PresetAgent,
  type PresetAvailability,
  type ProviderConfig,
} from '@/ui/lib/preset-validation';
import type { Preset } from '@/ui/lib/preset-types';
import { restartKeyForMain } from '@/ui/lib/restart-keys';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ApplyPresetResult {
  applied: number;
  warnings: string[];
  agents: Array<{
    id: string;
    name: string;
    providerConfigId?: string | null;
  }>;
}

async function applyPreset(
  projectId: string,
  presetName: string,
  fetchFn: FetchFn,
): Promise<ApplyPresetResult> {
  const res = await fetchFn(`/api/projects/${projectId}/presets/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetName }),
  });
  if (!res.ok) throw new Error('Failed to apply preset');
  return res.json();
}

/** Minimal agent shape the preset-apply flow reads (config diff + presence match). */
export interface PresetApplyAgent {
  id: string;
  name: string;
  providerConfigId?: string | null;
}

export interface UsePresetApplyOptions {
  projectId: string | null;
  apiFetch: FetchFn;
  presets: Preset[];
  /** Agents carrying a resolved `profileId`, used for client-side preset validation. */
  agentsWithProfiles: PresetAgent[];
  configsMap: Map<string, ProviderConfig[]> | undefined;
  agents: PresetApplyAgent[];
  agentPresence: Record<string, { online?: boolean } | undefined>;
  markAgentsForRestart: (keys: string[]) => void;
  confirmIfActiveSessions: (agentNames: string[], onConfirm: () => void) => void;
}

export interface UsePresetApplyResult {
  validatedPresets: PresetAvailability[];
  handleApplyPreset: (presetName: string) => Promise<void>;
  applyingPreset: boolean;
}

/**
 * Preset-apply domain flow, extracted from ChatPage. Owns availability sorting,
 * the apply mutation (affected-agent detection + restart marking), and the
 * active-session confirmation gate. Toast copy and the `['agents', projectId]`
 * invalidation are preserved verbatim. Query data (`presets`, `configsMap`,
 * `agentsWithProfiles`) stays owned by ChatPage and is injected, since it is
 * shared with rendering.
 */
export function usePresetApply({
  projectId,
  apiFetch,
  presets,
  agentsWithProfiles,
  configsMap,
  agents,
  agentPresence,
  markAgentsForRestart,
  confirmIfActiveSessions,
}: UsePresetApplyOptions): UsePresetApplyResult {
  const queryClient = useQueryClient();
  const { toast, showSuccess, showError } = useToastHelpers();

  // Validate presets and sort (available first, then by update time within each group)
  const validatedPresets = useMemo((): PresetAvailability[] => {
    if (!configsMap || presets.length === 0) return [];
    // Track original index to preserve storage order (which represents update time)
    const validated = presets.map((p, index) => ({
      ...validatePresetAvailability(p, agentsWithProfiles, configsMap),
      originalIndex: index,
    }));
    return validated.sort((a, b) => {
      if (a.available && !b.available) return -1;
      if (!a.available && b.available) return 1;
      // Within same availability, most recently updated first
      return b.originalIndex - a.originalIndex;
    });
  }, [presets, agentsWithProfiles, configsMap]);

  // Apply preset mutation with affected agent detection
  const applyPresetMutation = useMutation({
    mutationFn: ({ presetName }: { presetName: string }) =>
      applyPreset(projectId!, presetName, apiFetch),
    onSuccess: (result) => {
      // Build map of agentId -> providerConfigId (using stable IDs, not names)
      const currentConfigMap = new Map(agents.map((a) => [a.id, a.providerConfigId]));

      // Find agents whose providerConfigId changed (compare by agent.id)
      const affectedAgentIds: string[] = [];
      for (const updatedAgent of result.agents) {
        const oldConfigId = currentConfigMap.get(updatedAgent.id);
        if (oldConfigId !== updatedAgent.providerConfigId) {
          affectedAgentIds.push(updatedAgent.id);
        }
      }

      // Only mark online agents for restart (offline agents will use new config on next launch)
      const onlineAgentIds = affectedAgentIds.filter((id) => agentPresence[id]?.online === true);
      if (onlineAgentIds.length > 0) {
        markAgentsForRestart(onlineAgentIds.map(restartKeyForMain));
      }

      queryClient.invalidateQueries({ queryKey: ['agents', projectId] });

      showSuccess({
        title: 'Preset applied',
        description: `${result.applied} agent(s) updated. Restart sessions to apply.`,
      });
    },
    onError: (error) => {
      showError({
        title: 'Failed to apply preset',
        description: getErrorMessage(error, 'Unknown error'),
      });
    },
  });

  // Handle preset apply with active sessions confirmation
  const handleApplyPreset = useCallback(
    async (presetName: string) => {
      // Check if preset is available (all configs exist)
      const validated = validatedPresets.find((v) => v.preset.name === presetName);
      if (!validated?.available) {
        toast({
          title: 'Cannot apply preset',
          description: 'Some required provider configurations are missing.',
          variant: 'destructive',
        });
        return;
      }

      // Find agents that would be affected by this preset
      const preset = presets.find((p) => p.name === presetName);
      if (!preset) return;

      // Build set of agent names in preset (lowercase for matching)
      const agentNamesInPreset = new Set(
        preset.agentConfigs.map((ac) => ac.agentName.trim().toLowerCase()),
      );

      const activeAgentNames = agents
        .filter(
          (a) => agentNamesInPreset.has(a.name.trim().toLowerCase()) && agentPresence[a.id]?.online,
        )
        .map((a) => a.name);

      confirmIfActiveSessions(activeAgentNames, () => {
        applyPresetMutation.mutate({ presetName });
      });
    },
    [
      presets,
      validatedPresets,
      agents,
      agentPresence,
      applyPresetMutation,
      toast,
      confirmIfActiveSessions,
    ],
  );

  return {
    validatedPresets,
    handleApplyPreset,
    applyingPreset: applyPresetMutation.isPending,
  };
}
