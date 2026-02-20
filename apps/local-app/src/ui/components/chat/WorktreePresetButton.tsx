import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/ui/hooks/use-toast';
import {
  validatePresetAvailability,
  type Preset,
  type ProviderConfig,
} from '@/ui/lib/preset-validation';
import type { WorktreeAgentGroup } from '@/ui/hooks/useWorktreeAgents';
import { restartKeyForWorktree } from '@/ui/lib/restart-keys';
import { PresetPopover } from './PresetPopover';

interface WorktreePresetButtonProps {
  group: WorktreeAgentGroup;
  onMarkForRestart: (keys: string[]) => void;
}

export function WorktreePresetButton({ group, onMarkForRestart }: WorktreePresetButtonProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const enabled = !group.disabled && Boolean(group.devchainProjectId);

  // Lazy fetch presets — only when popover is open
  const { data: presetsData } = useQuery<{ presets: Preset[]; activePreset: string | null }>({
    queryKey: ['worktree-presets', group.apiBase, group.devchainProjectId],
    queryFn: async () => {
      const res = await fetch(`${group.apiBase}/api/projects/${group.devchainProjectId}/presets`);
      if (!res.ok) throw new Error('Failed to fetch presets');
      return res.json();
    },
    enabled: enabled && open,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const presets = presetsData?.presets ?? [];
  const activePreset = presetsData?.activePreset ?? null;

  // Filter agents with valid profileIds
  const agentsWithProfiles = useMemo(
    () =>
      group.agents.filter(
        (a): a is typeof a & { profileId: string } => typeof a.profileId === 'string',
      ),
    [group.agents],
  );

  // Fetch provider configs for all agent profiles (for preset validation)
  const { data: configsMap } = useQuery<Map<string, ProviderConfig[]>>({
    queryKey: [
      'worktree-profile-provider-configs',
      group.apiBase,
      agentsWithProfiles.map((a) => a.profileId),
    ],
    queryFn: async () => {
      const profileIds = new Set(agentsWithProfiles.map((a) => a.profileId));
      if (profileIds.size === 0) return new Map();

      const results = await Promise.all(
        Array.from(profileIds).map(async (profileId) => {
          try {
            const res = await fetch(`${group.apiBase}/api/profiles/${profileId}/provider-configs`);
            if (!res.ok) return { profileId, configs: [] as ProviderConfig[] };
            const configs: ProviderConfig[] = await res.json();
            return { profileId, configs };
          } catch {
            return { profileId, configs: [] as ProviderConfig[] };
          }
        }),
      );

      const map = new Map<string, ProviderConfig[]>();
      results.forEach(({ profileId, configs }) => {
        map.set(profileId, configs);
      });
      return map;
    },
    enabled: enabled && open && agentsWithProfiles.length > 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  // Validate presets
  const validatedPresets = useMemo(() => {
    if (!configsMap || presets.length === 0) return [];
    const validated = presets.map((p, index) => ({
      ...validatePresetAvailability(p, agentsWithProfiles, configsMap),
      originalIndex: index,
    }));
    return validated.sort((a, b) => {
      if (a.available && !b.available) return -1;
      if (!a.available && b.available) return 1;
      return b.originalIndex - a.originalIndex;
    });
  }, [configsMap, presets, agentsWithProfiles]);

  // Apply mutation
  const applyMutation = useMutation({
    mutationFn: async (presetName: string) => {
      const res = await fetch(
        `${group.apiBase}/api/projects/${group.devchainProjectId}/presets/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ presetName }),
        },
      );
      if (!res.ok) throw new Error('Failed to apply preset');
      return res.json() as Promise<{
        applied: number;
        warnings: string[];
        agents: Array<{ id: string; name: string; providerConfigId?: string | null }>;
      }>;
    },
    onSuccess: (result) => {
      // Find agents whose config changed
      const currentConfigMap = new Map(group.agents.map((a) => [a.id, a.providerConfigId]));
      const affectedIds: string[] = [];
      for (const updated of result.agents) {
        if (currentConfigMap.get(updated.id) !== updated.providerConfigId) {
          affectedIds.push(updated.id);
        }
      }

      // Mark online agents for restart using composite key
      const onlineIds = affectedIds.filter((id) => group.agentPresence[id]?.online === true);
      if (onlineIds.length > 0) {
        onMarkForRestart(onlineIds.map((id) => restartKeyForWorktree(group.apiBase, id)));
      }

      queryClient.invalidateQueries({ queryKey: ['chat-worktree-agent-groups'] });
      queryClient.invalidateQueries({
        queryKey: ['worktree-presets', group.apiBase, group.devchainProjectId],
      });

      toast({
        title: 'Preset applied',
        description: `${result.applied} agent(s) updated. Restart sessions to apply.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Failed to apply preset',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  const handleApply = (presetName: string) => {
    const validated = validatedPresets.find((v) => v.preset.name === presetName);
    if (!validated?.available) {
      toast({
        title: 'Cannot apply preset',
        description: 'Some required provider configurations are missing.',
        variant: 'destructive',
      });
      return;
    }

    // Check for active sessions among affected agents
    const preset = presets.find((p) => p.name === presetName);
    if (!preset) return;

    const agentNamesInPreset = new Set(
      preset.agentConfigs.map((ac) => ac.agentName.trim().toLowerCase()),
    );

    const agentsWithActiveSessions = group.agents.filter(
      (a) =>
        agentNamesInPreset.has(a.name.trim().toLowerCase()) && group.agentPresence[a.id]?.online,
    );

    if (agentsWithActiveSessions.length > 0) {
      const agentNames = agentsWithActiveSessions.map((a) => a.name).join(', ');
      const confirmed = window.confirm(
        `The following agents have active sessions: ${agentNames}. ` +
          'Changing their provider configuration may affect running sessions. Continue?',
      );
      if (!confirmed) return;
    }

    applyMutation.mutate(presetName);
  };

  return (
    <PresetPopover
      presets={validatedPresets}
      activePreset={activePreset}
      applying={applyMutation.isPending}
      onApply={handleApply}
      disabled={!enabled}
      onOpenChange={setOpen}
      alwaysShowTrigger
    />
  );
}
