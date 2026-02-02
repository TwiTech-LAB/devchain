import { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/ui/components/ui/table';
import { useToast } from '@/ui/hooks/use-toast';
import { Label } from '@/ui/components/ui/label';
import { Loader2, AlertTriangle, Settings, Info, AlertCircle } from 'lucide-react';
import { fetchAgentPresence, type AgentPresenceMap } from '@/ui/lib/sessions';
import { cn } from '@/ui/lib/utils';
import { validatePresetAvailability } from '@/ui/lib/preset-validation';

interface Agent {
  id: string;
  projectId: string;
  profileId: string;
  providerConfigId?: string | null;
  name: string;
  description?: string | null;
  profile?: AgentProfile;
  providerConfig?: ProviderConfig;
}

interface AgentProfile {
  id: string;
  name: string;
  providerId: string;
  familySlug?: string | null;
  provider?: {
    id: string;
    name: string;
  };
}

interface ProviderConfig {
  id: string;
  profileId: string;
  providerId: string;
  name: string;
  options: string | null;
  env: Record<string, string> | null;
}

interface Preset {
  name: string;
  description?: string | null;
  agentConfigs: Array<{
    agentName: string;
    providerConfigName: string;
  }>;
}

interface ProjectConfigurationModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function fetchAgents(projectId: string) {
  const res = await fetch(`/api/agents?projectId=${projectId}`);
  if (!res.ok) throw new Error('Failed to fetch agents');
  return res.json();
}

async function fetchProfiles(projectId: string) {
  const res = await fetch(`/api/profiles?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw new Error('Failed to fetch profiles');
  return res.json();
}

async function fetchProviders() {
  const res = await fetch('/api/providers');
  if (!res.ok) throw new Error('Failed to fetch providers');
  return res.json();
}

async function fetchProviderConfigs(profileId: string): Promise<ProviderConfig[]> {
  const res = await fetch(`/api/profiles/${profileId}/provider-configs`);
  if (!res.ok) throw new Error('Failed to fetch provider configs');
  return res.json();
}

async function fetchPresets(projectId: string): Promise<{ presets: Preset[] }> {
  const res = await fetch(`/api/projects/${projectId}/presets`);
  if (!res.ok) throw new Error('Failed to fetch presets');
  return res.json();
}

async function applyPreset(
  projectId: string,
  presetName: string,
): Promise<{ applied: number; warnings: string[]; agents: Agent[] }> {
  const res = await fetch(`/api/projects/${projectId}/presets/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetName }),
  });
  if (!res.ok) throw new Error('Failed to apply preset');
  return res.json();
}

export function ProjectConfigurationModal({
  projectId,
  open,
  onOpenChange,
}: ProjectConfigurationModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [isSaving, setIsSaving] = useState(false);
  const [presence, setPresence] = useState<AgentPresenceMap>({});
  const [presetToApply, setPresetToApply] = useState<string>('');

  // Store fetched configs per profileId
  const [configsByProfile, setConfigsByProfile] = useState<Map<string, ProviderConfig[]>>(
    new Map(),
  );
  const [configsLoading, setConfigsLoading] = useState(false);

  // Fetch agents
  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => fetchAgents(projectId),
    enabled: open && !!projectId,
  });

  // Fetch profiles
  const { data: profilesData, isLoading: profilesLoading } = useQuery({
    queryKey: ['profiles', projectId],
    queryFn: () => fetchProfiles(projectId),
    enabled: open && !!projectId,
  });

  // Fetch providers
  const { isLoading: providersLoading } = useQuery({
    queryKey: ['providers'],
    queryFn: fetchProviders,
    enabled: open,
  });

  // Fetch presets
  const { data: presetsData, isLoading: presetsLoading } = useQuery<{ presets: Preset[] }>({
    queryKey: ['project-presets', projectId],
    queryFn: () => fetchPresets(projectId),
    enabled: open && !!projectId,
  });

  // Fetch presence when modal opens
  useEffect(() => {
    if (open && projectId) {
      fetchAgentPresence(projectId).then(setPresence).catch(console.error);
    }
  }, [open, projectId]);

  // Fetch provider configs for all unique profileIds used by agents
  useEffect(() => {
    if (!open || !agentsData?.items) return;

    const agents: Agent[] = agentsData.items;
    const profileIds = new Set(agents.map((a) => a.profileId).filter(Boolean));

    if (profileIds.size === 0) return;

    setConfigsLoading(true);
    Promise.all(
      Array.from(profileIds).map(async (profileId) => {
        try {
          const configs = await fetchProviderConfigs(profileId);
          return { profileId, configs };
        } catch {
          return { profileId, configs: [] };
        }
      }),
    )
      .then((results) => {
        const newMap = new Map<string, ProviderConfig[]>();
        results.forEach(({ profileId, configs }) => {
          newMap.set(profileId, configs);
        });
        setConfigsByProfile(newMap);
      })
      .finally(() => setConfigsLoading(false));
  }, [open, agentsData]);

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setPresetToApply('');
      setConfigsByProfile(new Map());
    }
  }, [open]);

  // Build profiles map
  const profilesById = useMemo(() => {
    const profiles: AgentProfile[] = profilesData?.items || [];
    return new Map(profiles.map((p) => [p.id, p]));
  }, [profilesData]);

  // Get available configs for an agent
  const getAvailableConfigs = (agent: Agent): ProviderConfig[] => {
    return configsByProfile.get(agent.profileId) || [];
  };

  // Check if agent has active session
  const hasActiveSession = (agentId: string): boolean => {
    return !!presence[agentId];
  };

  // Get current profile for an agent
  const getCurrentProfile = (agent: Agent): AgentProfile | undefined => {
    return profilesById.get(agent.profileId);
  };

  // Get current config object
  const getCurrentConfig = (agent: Agent): ProviderConfig | undefined => {
    if (!agent.providerConfigId) return undefined;
    const configs = getAvailableConfigs(agent);
    return configs.find((c) => c.id === agent.providerConfigId);
  };

  // Handle preset selection
  const handlePresetChange = (presetName: string) => {
    setPresetToApply(presetName);
  };

  // Apply the selected preset
  const handleApplyPreset = async () => {
    if (!presetToApply) {
      toast({
        title: 'No preset selected',
        description: 'Please select a preset to apply',
        variant: 'destructive',
      });
      return;
    }

    // Check for active sessions
    const preset = presetsData?.presets.find((p) => p.name === presetToApply);
    // Normalize agent names to lowercase for consistency with backend applyPreset
    const agentIdsInPreset = new Set(
      preset?.agentConfigs.map((ac) => ac.agentName.trim().toLowerCase()) || [],
    );
    const agents: Agent[] = agentsData?.items || [];
    const agentsWithActiveSessions = agents.filter(
      (a) => agentIdsInPreset.has(a.name.trim().toLowerCase()) && hasActiveSession(a.id),
    );

    if (agentsWithActiveSessions.length > 0) {
      const agentNames = agentsWithActiveSessions.map((a) => a.name).join(', ');
      const confirmed = window.confirm(
        `The following agents have active sessions: ${agentNames}. ` +
          'Changing their provider configuration may affect running sessions. Continue?',
      );
      if (!confirmed) return;
    }

    setIsSaving(true);
    try {
      const result = await applyPreset(projectId, presetToApply);

      toast({
        title: 'Preset applied',
        description: `Applied preset to ${result.applied} agent(s)${
          result.warnings.length > 0 ? ` (${result.warnings.length} warning(s))` : ''
        }`,
        ...(result.warnings.length > 0 && {
          variant: 'default',
        }),
      });

      // Refresh agents and presence
      await queryClient.invalidateQueries({ queryKey: ['agents', projectId] });
      fetchAgentPresence(projectId).then(setPresence).catch(console.error);

      // Reset selection
      setPresetToApply('');
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to apply preset',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const isLoading =
    agentsLoading || profilesLoading || providersLoading || configsLoading || presetsLoading;
  const agents: Agent[] = agentsData?.items || [];
  const presets: Preset[] = presetsData?.presets || [];
  const hasPresets = presets.length > 0;

  // Validate preset availability and sort (green first, then by name)
  const sortedPresets = useMemo(() => {
    const validated = presets.map((p) => validatePresetAvailability(p, agents, configsByProfile));
    return validated.sort((a, b) => {
      // Available presets first
      if (a.available && !b.available) return -1;
      if (!a.available && b.available) return 1;
      // Then alphabetically by name
      return a.preset.name.localeCompare(b.preset.name);
    });
  }, [presets, agents, configsByProfile]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Project Configuration
          </DialogTitle>
          <DialogDescription>
            {hasPresets
              ? 'Select a preset to quickly configure agent providers, or view current assignments below.'
              : 'View current agent provider assignments.'}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No agents found in this project.
          </div>
        ) : !hasPresets ? (
          // Fallback UI when no presets available - replaces entire dialog content
          <>
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <AlertCircle className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No presets available</h3>
              <p className="text-muted-foreground mb-6">
                {agents.length > 0
                  ? "This project was created from a template that doesn't include presets, or is a file-based template."
                  : 'No presets are stored for this project.'}
              </p>
              <div className="flex gap-3 justify-center">
                <Button variant="outline" onClick={() => navigate('/agents')}>
                  Go to Agents Page
                </Button>
                <Button onClick={() => onOpenChange(false)}>Close</Button>
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            {/* Preset Selector */}
            {hasPresets && (
              <div className="space-y-3 p-4 bg-muted/30 rounded-lg border">
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="preset-select" className="text-sm font-medium">
                    Quick Configuration
                  </Label>
                </div>
                <Select value={presetToApply} onValueChange={handlePresetChange}>
                  <SelectTrigger id="preset-select">
                    <SelectValue placeholder="Select a preset..." />
                  </SelectTrigger>
                  <SelectContent>
                    {sortedPresets.map(({ preset, available, missingConfigs }) => (
                      <SelectItem key={preset.name} value={preset.name}>
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'w-2 h-2 rounded-full flex-shrink-0',
                              available ? 'bg-green-500' : 'bg-yellow-500',
                            )}
                          />
                          <span className="font-medium">{preset.name}</span>
                          {!available && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Info className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>
                                Missing configs:{' '}
                                {missingConfigs
                                  .map((m) => `${m.agentName} → ${m.configName}`)
                                  .join(', ')}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        {preset.description && (
                          <div className="text-xs text-muted-foreground">{preset.description}</div>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {presetToApply && (
                  <div className="text-xs text-muted-foreground">
                    This will update{' '}
                    {presets.find((p) => p.name === presetToApply)?.agentConfigs.length || 0}{' '}
                    agent(s) to use their preset configurations.
                  </div>
                )}
              </div>
            )}

            {/* Current Assignments Table */}
            <div>
              <h3 className="text-sm font-medium mb-2">Current Agent Assignments</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Agent</TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Provider Config</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {agents.map((agent) => {
                    const currentProfile = getCurrentProfile(agent);
                    const currentConfig = getCurrentConfig(agent);
                    const isActive = hasActiveSession(agent.id);

                    const configDisplay = currentConfig ? currentConfig.name : 'Not configured';

                    return (
                      <TableRow key={agent.id}>
                        <TableCell>
                          <div className="font-medium">{agent.name}</div>
                          {agent.description && (
                            <div className="text-sm text-muted-foreground truncate max-w-[200px]">
                              {agent.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{currentProfile?.name || 'Unknown'}</span>
                          {currentProfile?.familySlug && (
                            <Badge variant="outline" className="ml-2">
                              {currentProfile.familySlug}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">
                            {configDisplay}
                            {currentConfig?.env && Object.keys(currentConfig.env).length > 0 && (
                              <Badge variant="outline" className="ml-2">
                                env
                              </Badge>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          {isActive && (
                            <Badge variant="secondary" className="gap-1">
                              <AlertTriangle className="h-3 w-3" />
                              Active
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* DialogFooter - only shown when not showing fallback UI */}
        {hasPresets && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
              Close
            </Button>
            <Button onClick={handleApplyPreset} disabled={isSaving || !presetToApply}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Apply Preset
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
