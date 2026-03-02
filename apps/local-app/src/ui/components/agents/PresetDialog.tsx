import { useState, useEffect, useMemo } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import { Textarea } from '@/ui/components/ui/textarea';
import { Checkbox } from '@/ui/components/ui/checkbox';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { useToast } from '@/ui/hooks/use-toast';
import { Loader2, Save, AlertCircle, Pencil } from 'lucide-react';
import type { Preset, PresetAgentConfig } from '@/ui/lib/preset-types';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';
import { shortModelName } from '@/ui/lib/model-utils';

interface Agent {
  id: string;
  name: string;
  profileId: string;
  providerConfigId?: string | null;
  modelOverride?: string | null;
  providerConfig?: {
    id: string;
    name: string;
  } | null;
}

interface PresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  agents: Agent[];
  existingPresetNames?: string[];
  presetToEdit?: Preset | null;
}

type CreatePresetResponse = Preset;
type UpdatePresetResponse = Preset;

interface ProviderConfig {
  id: string;
  name: string;
  profileId: string;
  providerId: string;
}

interface ProviderModelOption {
  id: string;
  name: string;
}

const DEFAULT_MODEL_OVERRIDE = '__default_model_override__';

function parseProviderModels(payload: unknown, providerId: string): ProviderModelOption[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((rawModel, index) => {
      if (
        !rawModel ||
        typeof rawModel !== 'object' ||
        Array.isArray(rawModel) ||
        typeof (rawModel as { name?: unknown }).name !== 'string'
      ) {
        return null;
      }

      const model = rawModel as { id?: unknown; name: string };
      const name = model.name.trim();
      if (!name) {
        return null;
      }

      const id =
        typeof model.id === 'string' && model.id.trim().length > 0
          ? model.id
          : `${providerId}:${name}:${index}`;
      return { id, name };
    })
    .filter((model): model is ProviderModelOption => Boolean(model));
}

async function createPreset(projectId: string, preset: Preset): Promise<CreatePresetResponse> {
  const res = await fetch(`/api/projects/${projectId}/presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preset),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to create preset' }));
    throw new Error(error.message || 'Failed to create preset');
  }
  return res.json();
}

async function updatePreset(
  projectId: string,
  presetName: string,
  updates: {
    name?: string;
    description?: string | null;
    agentConfigs?: PresetAgentConfig[];
  },
): Promise<UpdatePresetResponse> {
  const res = await fetch(`/api/projects/${projectId}/presets`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetName, updates }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to update preset' }));
    throw new Error(error.message || 'Failed to update preset');
  }
  return res.json();
}

export function PresetDialog({
  open,
  onOpenChange,
  projectId,
  agents,
  existingPresetNames = [],
  presetToEdit,
}: PresetDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedAgentConfigs, setSelectedAgentConfigs] = useState<PresetAgentConfig[]>([]);

  const isEditMode = !!presetToEdit;

  // Reset form when opening/closing or when presetToEdit changes
  useEffect(() => {
    if (open) {
      if (presetToEdit) {
        setName(presetToEdit.name);
        setDescription(presetToEdit.description || '');
        setSelectedAgentConfigs(
          presetToEdit.agentConfigs.map((config) => ({
            ...config,
            modelOverride: config.modelOverride ?? null,
          })),
        );
      } else {
        setName('');
        setDescription('');
        // Auto-populate from current agent configs for new preset
        const agentsWithConfigs = agents.filter((a) => a.providerConfigId && a.providerConfig);
        setSelectedAgentConfigs(
          agentsWithConfigs.map((a) => ({
            agentName: a.name,
            providerConfigName: a.providerConfig!.name,
            modelOverride: a.modelOverride ?? null,
          })),
        );
      }
    }
  }, [open, presetToEdit, agents]);

  // Filter agents with valid profileIds for config fetching
  const agentsWithProfiles = useMemo(
    () =>
      agents.filter((a): a is typeof a & { profileId: string } => typeof a.profileId === 'string'),
    [agents],
  );

  // Fetch provider configs for all agent profiles
  const { data: configsMap } = useQuery<Map<string, ProviderConfig[]>>({
    queryKey: [
      'provider-configs-by-profile',
      projectId,
      agentsWithProfiles.map((a) => a.profileId).sort(),
    ],
    queryFn: async () => {
      const profileIds = new Set(agentsWithProfiles.map((a) => a.profileId));
      if (profileIds.size === 0) return new Map();

      const results = await Promise.all(
        Array.from(profileIds).map(async (profileId) => {
          try {
            const res = await fetch(`/api/profiles/${profileId}/provider-configs`);
            if (!res.ok) return { profileId, configs: [] };
            const configs = await res.json();
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
    enabled: open && agentsWithProfiles.length > 0,
  });

  const selectedProviderIds = useMemo(() => {
    if (!configsMap) return [];

    const providerIds = new Set<string>();
    for (const agentConfig of selectedAgentConfigs) {
      const agent = agentsWithProfiles.find(
        (candidate) => candidate.name === agentConfig.agentName,
      );
      if (!agent) continue;

      const profileConfigsRaw = configsMap.get(agent.profileId);
      const profileConfigs = Array.isArray(profileConfigsRaw) ? profileConfigsRaw : [];
      const selectedConfig = profileConfigs.find(
        (config) => config.name === agentConfig.providerConfigName,
      );
      if (selectedConfig?.providerId) {
        providerIds.add(selectedConfig.providerId);
      }
    }

    return Array.from(providerIds).sort();
  }, [agentsWithProfiles, configsMap, selectedAgentConfigs]);

  const providerModelQueries = useQueries({
    queries: selectedProviderIds.map((providerId) => ({
      queryKey: providerModelQueryKeys.main(providerId),
      queryFn: async () => {
        const res = await fetch(`/api/providers/${providerId}/models`);
        if (!res.ok) {
          return [] as ProviderModelOption[];
        }

        const payload = (await res.json().catch(() => [])) as unknown;
        return parseProviderModels(payload, providerId);
      },
      staleTime: 5 * 60 * 1000,
      enabled: open,
    })),
  });

  const providerModelsByProviderId = useMemo(() => {
    const map = new Map<string, ProviderModelOption[]>();
    selectedProviderIds.forEach((providerId, index) => {
      const query = providerModelQueries[index];
      map.set(providerId, Array.isArray(query?.data) ? query.data : []);
    });
    return map;
  }, [providerModelQueries, selectedProviderIds]);

  // Validate name
  const nameError = name.trim()
    ? existingPresetNames.some(
        (existing) =>
          existing.trim().toLowerCase() === name.trim().toLowerCase() &&
          // Exclude current preset from duplicate check when editing
          existing !== presetToEdit?.name,
      )
      ? 'A preset with this name already exists'
      : ''
    : 'Name is required';

  const isValid = !nameError && name.trim() !== '' && selectedAgentConfigs.length > 0;

  const handleClose = () => {
    if (!isSaving) {
      setName('');
      setDescription('');
      setSelectedAgentConfigs([]);
      onOpenChange(false);
    }
  };

  const handleSave = async () => {
    if (!isValid) return;

    setIsSaving(true);
    try {
      const normalizedAgentConfigs: PresetAgentConfig[] = selectedAgentConfigs.map(
        (agentConfig) => ({
          ...agentConfig,
          modelOverride: agentConfig.modelOverride ?? null,
        }),
      );

      if (isEditMode) {
        const updates = {
          name: name.trim(),
          description: description.trim() || null,
          agentConfigs: normalizedAgentConfigs,
        };

        const result = await updatePreset(projectId, presetToEdit!.name, updates);

        toast({
          title: 'Preset Updated',
          description: `Updated preset "${result.name}" with ${selectedAgentConfigs.length} agent configuration(s)`,
        });
      } else {
        const preset = {
          name: name.trim(),
          description: description.trim() || null,
          agentConfigs: normalizedAgentConfigs,
        };

        const result = await createPreset(projectId, preset);

        toast({
          title: 'Preset Created',
          description: `Saved preset "${result.name}" with ${selectedAgentConfigs.length} agent configuration(s)`,
        });
      }

      // Refresh the presets list so it appears in the dropdown
      await queryClient.invalidateQueries({ queryKey: ['project-presets', projectId] });

      setName('');
      setDescription('');
      setSelectedAgentConfigs([]);
      onOpenChange(false);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save preset',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const isAgentSelected = (agentName: string): boolean => {
    return selectedAgentConfigs.some((ac) => ac.agentName === agentName);
  };

  const getSelectedConfigName = (agentName: string): string | undefined => {
    return selectedAgentConfigs.find((ac) => ac.agentName === agentName)?.providerConfigName;
  };

  const getSelectedModelOverride = (agentName: string): string | null => {
    return selectedAgentConfigs.find((ac) => ac.agentName === agentName)?.modelOverride ?? null;
  };

  // Handler for checkbox: toggles agent in/out of preset
  const handleAgentCheckboxChange = (agentName: string, checked: boolean) => {
    const existingIndex = selectedAgentConfigs.findIndex((ac) => ac.agentName === agentName);
    if (checked && existingIndex < 0) {
      // Adding: use agent's current config or first available from profile
      const agent = agents.find((a) => a.name === agentName);
      const agentConfigName = agent?.providerConfig?.name;
      const profileConfigs = (
        agent?.profileId ? (configsMap?.get(agent.profileId) ?? []) : []
      ) as ProviderConfig[];
      const configToUse = agentConfigName || profileConfigs[0]?.name;
      if (configToUse) {
        setSelectedAgentConfigs((prev) => [
          ...prev,
          {
            agentName,
            providerConfigName: configToUse,
            modelOverride: agent?.modelOverride ?? null,
          },
        ]);
      }
    } else if (!checked && existingIndex >= 0) {
      // Removing: take agent out of preset
      setSelectedAgentConfigs((prev) => prev.filter((_, i) => i !== existingIndex));
    }
  };

  // Handler for Select: changes the config for an agent in the preset
  const handleAgentConfigSelect = (agentName: string, configName: string) => {
    const existingIndex = selectedAgentConfigs.findIndex((ac) => ac.agentName === agentName);
    if (existingIndex >= 0) {
      // Update existing agent's config
      setSelectedAgentConfigs((prev) =>
        prev.map((ac, i) =>
          i === existingIndex
            ? { ...ac, agentName, providerConfigName: configName, modelOverride: null }
            : ac,
        ),
      );
    } else {
      // Add agent with selected config
      setSelectedAgentConfigs((prev) => [
        ...prev,
        { agentName, providerConfigName: configName, modelOverride: null },
      ]);
    }
  };

  const handleAgentModelSelect = (agentName: string, modelName: string | null) => {
    const existingIndex = selectedAgentConfigs.findIndex((ac) => ac.agentName === agentName);
    if (existingIndex < 0) return;

    setSelectedAgentConfigs((prev) =>
      prev.map((ac, i) => (i === existingIndex ? { ...ac, modelOverride: modelName } : ac)),
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Preset' : 'Save as Preset'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Modify the preset name, description, or agent configurations'
              : 'Create a named configuration from agent provider assignments'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Name field */}
          <div className="space-y-2">
            <Label htmlFor="preset-name">Name *</Label>
            <Input
              id="preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-preset"
              className="font-mono text-sm"
              disabled={isSaving}
            />
            {nameError && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {nameError}
              </p>
            )}
          </div>

          {/* Description field */}
          <div className="space-y-2">
            <Label htmlFor="preset-description">Description</Label>
            <Textarea
              id="preset-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description of this preset"
              rows={2}
              disabled={isSaving}
            />
          </div>

          {/* Agent selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Agent Configurations</Label>
              <span className="text-xs text-muted-foreground">
                {selectedAgentConfigs.length} selected
              </span>
            </div>
            {agentsWithProfiles.length > 0 ? (
              <ScrollArea className="h-56 border rounded-md p-2" data-testid="preset-agents-scroll">
                <div className="space-y-1 pr-4">
                  {agentsWithProfiles.map((agent) => {
                    const isSelected = isAgentSelected(agent.name);
                    const selectedConfig = getSelectedConfigName(agent.name);
                    const selectedModelOverride = getSelectedModelOverride(agent.name);
                    const agentConfigName = agent.providerConfig?.name;
                    const availableConfigs = configsMap?.get(agent.profileId);
                    const configsArray = Array.isArray(availableConfigs) ? availableConfigs : [];
                    const hasConfigs = configsArray.length > 0;
                    // Check if selected config is missing (not in available configs)
                    const isMissingConfig =
                      isSelected &&
                      selectedConfig &&
                      hasConfigs &&
                      !configsArray.some((c: ProviderConfig) => c.name === selectedConfig);
                    // Determine the display value for the Select
                    const displayValue =
                      isSelected && selectedConfig
                        ? selectedConfig
                        : isSelected && agentConfigName
                          ? agentConfigName
                          : '';
                    const selectedConfigOption = configsArray.find(
                      (config: ProviderConfig) => config.name === displayValue,
                    );
                    const selectedProviderId = selectedConfigOption?.providerId;
                    const providerModels = selectedProviderId
                      ? (providerModelsByProviderId.get(selectedProviderId) ?? [])
                      : [];
                    const hasProviderModels = providerModels.length > 0;

                    return (
                      <div
                        key={agent.id}
                        className="flex items-center gap-2 p-2 rounded hover:bg-muted"
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) =>
                            handleAgentCheckboxChange(agent.name, checked === true)
                          }
                        />
                        <span
                          className="flex-1 min-w-0 truncate text-sm"
                          title={agent.name}
                          data-testid={`preset-agent-name-${agent.id}`}
                        >
                          {agent.name}
                        </span>
                        <Select
                          value={displayValue}
                          onValueChange={(value) => handleAgentConfigSelect(agent.name, value)}
                          disabled={!isSelected || !hasConfigs}
                        >
                          <SelectTrigger
                            className="h-7 w-32 text-xs"
                            data-testid={`preset-config-select-${agent.id}`}
                          >
                            <SelectValue
                              placeholder={
                                isMissingConfig
                                  ? `Missing: ${selectedConfig}`
                                  : hasConfigs
                                    ? 'Select config'
                                    : 'No configs'
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {configsArray.map((config) => (
                              <SelectItem key={config.id} value={config.name} className="text-xs">
                                {config.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {isSelected && selectedProviderId && hasProviderModels ? (
                          <Select
                            value={selectedModelOverride ?? DEFAULT_MODEL_OVERRIDE}
                            onValueChange={(value) =>
                              handleAgentModelSelect(
                                agent.name,
                                value === DEFAULT_MODEL_OVERRIDE ? null : value,
                              )
                            }
                          >
                            <SelectTrigger
                              className="h-7 w-36 text-xs"
                              data-testid={`preset-model-select-${agent.id}`}
                            >
                              <SelectValue placeholder="Default" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={DEFAULT_MODEL_OVERRIDE} className="text-xs">
                                Default
                              </SelectItem>
                              {providerModels.map((model) => (
                                <SelectItem
                                  key={model.id}
                                  value={model.name}
                                  title={model.name}
                                  className="text-xs"
                                >
                                  {shortModelName(model.name)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            ) : (
              <div className="border rounded-md p-3 bg-muted/30">
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  No agents with profiles found
                </p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Check agents to include them, then select a provider configuration for each
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !isValid}>
            {isSaving ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : isEditMode ? (
              <Pencil className="h-4 w-4 mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            {isEditMode ? 'Update Preset' : 'Save Preset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
