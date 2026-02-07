import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Button } from '@/ui/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/components/ui/dropdown-menu';
import { useToast } from '@/ui/hooks/use-toast';
import { Loader2, CheckCircle2, AlertCircle, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { validatePresetAvailability, type Preset } from '@/ui/lib/preset-validation';
import type { AgentPresenceMap } from '@/ui/lib/sessions';

interface Agent {
  id: string;
  name: string;
  profileId: string;
}

interface ProviderConfig {
  id: string;
  name: string;
  profileId: string;
  providerId: string;
}

interface PresetsResponse {
  presets: Preset[];
  activePreset: string | null;
}

interface ApplyPresetResponse {
  applied: number;
  warnings: string[];
  agents: Agent[];
}

interface PresetSelectorProps {
  projectId: string;
  agents: Agent[];
  agentPresence: AgentPresenceMap;
  onAgentsRefresh?: () => void;
  onEditPreset?: (preset: Preset) => void;
  onDeletePreset?: (preset: Preset) => void;
}

async function fetchPresets(projectId: string): Promise<PresetsResponse> {
  const res = await fetch(`/api/projects/${projectId}/presets`);
  if (!res.ok) throw new Error('Failed to fetch presets');
  return res.json();
}

async function fetchProviderConfigs(profileId: string): Promise<ProviderConfig[]> {
  const res = await fetch(`/api/profiles/${profileId}/provider-configs`);
  if (!res.ok) throw new Error('Failed to fetch provider configs');
  return res.json();
}

async function applyPreset(projectId: string, presetName: string): Promise<ApplyPresetResponse> {
  const res = await fetch(`/api/projects/${projectId}/presets/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetName }),
  });
  if (!res.ok) throw new Error('Failed to apply preset');
  return res.json();
}

export function PresetSelector({
  projectId,
  agents,
  agentPresence,
  onAgentsRefresh,
  onEditPreset,
  onDeletePreset,
}: PresetSelectorProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedPreset, setSelectedPreset] = useState<string>('');
  const [isApplying, setIsApplying] = useState(false);
  const initializedRef = useRef(false);

  // Fetch presets
  const { data: presetsData, isLoading: presetsLoading } = useQuery({
    queryKey: ['project-presets', projectId],
    queryFn: () => fetchPresets(projectId),
    enabled: !!projectId,
  });

  // Fetch provider configs for all unique profileIds used by agents
  const { data: configsMap, isLoading: configsLoading } = useQuery<Map<string, ProviderConfig[]>>({
    queryKey: ['provider-configs-by-profile', projectId, agents.map((a) => a.profileId)],
    queryFn: async () => {
      const profileIds = new Set(agents.map((a) => a.profileId).filter(Boolean));
      if (profileIds.size === 0) return new Map();

      const results = await Promise.all(
        Array.from(profileIds).map(async (profileId) => {
          try {
            const configs = await fetchProviderConfigs(profileId);
            return { profileId, configs };
          } catch {
            return { profileId, configs: [] };
          }
        }),
      );

      const map = new Map<string, ProviderConfig[]>();
      results.forEach(({ profileId, configs }) => {
        map.set(profileId, configs);
      });
      return map;
    },
    enabled: !!projectId && agents.length > 0,
  });

  const presets = presetsData?.presets || [];
  const activePreset = presetsData?.activePreset ?? null;
  const hasPresets = presets.length > 0;

  // Initialize selectedPreset with activePreset on first data load only
  useEffect(() => {
    if (activePreset && !initializedRef.current) {
      setSelectedPreset(activePreset);
      initializedRef.current = true;
    }
  }, [activePreset]);

  // Validate preset availability and sort (available first, then by update time within each group)
  const sortedPresets = useMemo(() => {
    if (!configsMap) return [];
    // Track original index to preserve storage order (which represents update time)
    const validated = presets.map((p, index) => ({
      ...validatePresetAvailability(p, agents, configsMap),
      originalIndex: index,
    }));
    return validated.sort((a, b) => {
      // Available presets first
      if (a.available && !b.available) return -1;
      if (!a.available && b.available) return 1;
      // Within same availability, most recently updated first
      return b.originalIndex - a.originalIndex;
    });
  }, [presets, agents, configsMap]);

  // Get the selected preset object for management actions
  const selectedPresetData = useMemo(() => {
    if (!selectedPreset) return null;
    return sortedPresets.find((p) => p.preset.name === selectedPreset) ?? null;
  }, [selectedPreset, sortedPresets]);

  const handleApplyPreset = async () => {
    if (!selectedPreset) return;

    // Check for active sessions
    const preset = presets.find((p) => p.name === selectedPreset);
    const agentIdsInPreset = new Set(
      preset?.agentConfigs.map((ac) => ac.agentName.trim().toLowerCase()) || [],
    );
    const agentsWithActiveSessions = agents.filter(
      (a) => agentIdsInPreset.has(a.name.trim().toLowerCase()) && agentPresence[a.id]?.online,
    );

    if (agentsWithActiveSessions.length > 0) {
      const agentNames = agentsWithActiveSessions.map((a) => a.name).join(', ');
      const confirmed = window.confirm(
        `The following agents have active sessions: ${agentNames}. ` +
          'Changing their provider configuration may affect running sessions. Continue?',
      );
      if (!confirmed) return;
    }

    setIsApplying(true);
    try {
      const result = await applyPreset(projectId, selectedPreset);

      toast({
        title: 'Preset applied',
        description: `Applied preset to ${result.applied} agent(s)${
          result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : ''
        }`,
      });

      // Refresh agents list and presets (to update activePreset indicator)
      await queryClient.invalidateQueries({ queryKey: ['agents', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['project-presets', projectId] });
      onAgentsRefresh?.();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to apply preset',
        variant: 'destructive',
      });
    } finally {
      setIsApplying(false);
    }
  };

  const handleEdit = () => {
    if (selectedPresetData && onEditPreset) {
      onEditPreset(selectedPresetData.preset);
    }
  };

  const handleDelete = () => {
    if (selectedPresetData && onDeletePreset) {
      onDeletePreset(selectedPresetData.preset);
    }
  };

  if (!hasPresets) {
    return null;
  }

  // Apply button is enabled only when selection differs from activePreset and a preset is selected
  const canApply = selectedPreset && selectedPreset !== activePreset;
  // Management menu is always shown when a preset is selected
  const canManage = !!selectedPreset;

  return (
    <div className="flex items-center gap-2">
      <Select value={selectedPreset} onValueChange={setSelectedPreset} disabled={isApplying}>
        <SelectTrigger className="w-[240px]">
          {presetsLoading || configsLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading presets...</span>
            </div>
          ) : (
            <SelectValue placeholder="Select a preset..." />
          )}
        </SelectTrigger>
        <SelectContent>
          {sortedPresets.map(({ preset, available, missingConfigs }) => (
            <SelectItem key={preset.name} value={preset.name}>
              <div className="flex items-center gap-2">
                {available ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                ) : (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <AlertCircle className="h-4 w-4 text-yellow-500 flex-shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs">
                        <p className="font-medium mb-1">Missing configs:</p>
                        <ul className="text-sm list-disc pl-4">
                          {missingConfigs.map((m, i) => (
                            <li key={i}>
                              {m.agentName} → {m.configName}
                            </li>
                          ))}
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <span className="font-medium">{preset.name}</span>
                {preset.description && (
                  <span className="text-xs text-muted-foreground truncate max-w-[100px]">
                    {preset.description}
                  </span>
                )}
              </div>
            </SelectItem>
          ))}
          {sortedPresets.length === 0 && (
            <div className="p-2 text-sm text-muted-foreground text-center">
              No presets available
            </div>
          )}
        </SelectContent>
      </Select>

      {/* Apply button - always visible, enabled only when selection differs from activePreset */}
      <Button
        onClick={handleApplyPreset}
        disabled={!canApply || isApplying}
        size="sm"
        variant="default"
      >
        {isApplying && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        Apply
      </Button>

      {/* Management menu - always visible, enabled when a preset is selected */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={!canManage}>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onEditPreset && (
            <DropdownMenuItem onClick={handleEdit} disabled={!canManage}>
              <Pencil className="h-4 w-4 mr-2" />
              Edit preset
            </DropdownMenuItem>
          )}
          {onDeletePreset && (
            <DropdownMenuItem
              onClick={handleDelete}
              disabled={!canManage}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete preset
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
