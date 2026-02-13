import { useState, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { type Preset } from '@/ui/lib/preset-validation';

interface Agent {
  id: string;
  name: string;
  profileId: string;
  providerConfigId?: string | null;
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

interface CreatePresetResponse {
  name: string;
  description?: string | null;
  agentConfigs: Array<{
    agentName: string;
    providerConfigName: string;
  }>;
}

interface UpdatePresetResponse {
  name: string;
  description?: string | null;
  agentConfigs: Array<{
    agentName: string;
    providerConfigName: string;
  }>;
}

interface ProviderConfig {
  id: string;
  name: string;
  profileId: string;
  providerId: string;
}

async function createPreset(
  projectId: string,
  preset: {
    name: string;
    description?: string | null;
    agentConfigs: Array<{ agentName: string; providerConfigName: string }>;
  },
): Promise<CreatePresetResponse> {
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
    agentConfigs?: Array<{ agentName: string; providerConfigName: string }>;
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
  const [selectedAgentConfigs, setSelectedAgentConfigs] = useState<
    Array<{ agentName: string; providerConfigName: string }>
  >([]);

  const isEditMode = !!presetToEdit;

  // Reset form when opening/closing or when presetToEdit changes
  useEffect(() => {
    if (open) {
      if (presetToEdit) {
        setName(presetToEdit.name);
        setDescription(presetToEdit.description || '');
        setSelectedAgentConfigs(presetToEdit.agentConfigs);
      } else {
        setName('');
        setDescription('');
        // Auto-populate from current agent configs for new preset
        const agentsWithConfigs = agents.filter((a) => a.providerConfigId && a.providerConfig);
        setSelectedAgentConfigs(
          agentsWithConfigs.map((a) => ({
            agentName: a.name,
            providerConfigName: a.providerConfig!.name,
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
      if (isEditMode) {
        const updates = {
          name: name.trim(),
          description: description.trim() || null,
          agentConfigs: selectedAgentConfigs,
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
          agentConfigs: selectedAgentConfigs,
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
          { agentName, providerConfigName: configToUse },
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
          i === existingIndex ? { agentName, providerConfigName: configName } : ac,
        ),
      );
    } else {
      // Add agent with selected config
      setSelectedAgentConfigs((prev) => [...prev, { agentName, providerConfigName: configName }]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
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
              <ScrollArea className="h-48 border rounded-md p-2">
                <div className="space-y-1 pr-4">
                  {agentsWithProfiles.map((agent) => {
                    const isSelected = isAgentSelected(agent.name);
                    const selectedConfig = getSelectedConfigName(agent.name);
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
                        <span className="flex-1 text-sm">{agent.name}</span>
                        <Select
                          value={displayValue}
                          onValueChange={(value) => handleAgentConfigSelect(agent.name, value)}
                          disabled={!isSelected || !hasConfigs}
                        >
                          <SelectTrigger className="h-7 w-32 text-xs">
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
