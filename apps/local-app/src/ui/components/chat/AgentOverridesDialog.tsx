import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { Label } from '@/ui/components/ui/label';
import { Button } from '@/ui/components/ui/button';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';
import { shortModelName } from '@/ui/lib/model-utils';
import type { AgentOrGuest } from '@/ui/hooks/useChatQueries';

// ============================================
// Types
// ============================================

/**
 * Provider config option surfaced in the Overrides dialog. Mirrors the shape
 * returned by `GET /api/profiles/:id/provider-configs` (with the provider name
 * resolved via JOIN and the structured model/effort defaults).
 */
export interface OverridesConfigOption {
  id: string;
  name: string;
  providerId: string;
  providerName?: string;
  model: string | null;
  effort: string | null;
}

interface CatalogOption {
  id: string;
  name: string;
}

interface EffortsCatalogState {
  efforts: CatalogOption[];
  supportsEffort: boolean;
  requiresModelForEffort: boolean;
  isLoading: boolean;
  isError: boolean;
}

export interface AgentOverridesSavePayload {
  providerConfigId: string;
  modelOverride: string | null;
  effortOverride: string | null;
}

interface AgentOverridesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agent: AgentOrGuest;
  /** Whether the agent currently has an online session (drives the restart warning). */
  isOnline: boolean;
  /** Worktree apiBase; omitted/empty for main agents. */
  apiBase?: string;
  isSaving: boolean;
  fetchProviderConfigsForProfile: (profileId: string) => Promise<OverridesConfigOption[]>;
  onSave: (payload: AgentOverridesSavePayload) => Promise<unknown> | void;
  /** Element to restore focus to when the dialog closes (context-menu trigger). */
  triggerEl?: HTMLElement | null;
}

const DEFAULT_VALUE = '__default__';

// Mirrors parseProviderModels in ChatSidebar/AgentFormDialog — provider model
// catalogs are stored verbatim, so we defensively normalise the raw payload.
function parseCatalogOptions(payload: unknown, providerId: string): CatalogOption[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map((raw, index) => {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        typeof (raw as { name?: unknown }).name !== 'string'
      ) {
        return null;
      }
      const item = raw as { id?: unknown; name: string };
      const name = item.name.trim();
      if (!name) {
        return null;
      }
      const id =
        typeof item.id === 'string' && item.id.trim().length > 0
          ? item.id
          : `${providerId}:${name}:${index}`;
      return { id, name };
    })
    .filter((item): item is CatalogOption => Boolean(item));
}

// ============================================
// Controller hook (business logic per development-standards)
// ============================================

interface OverridesController {
  configs: OverridesConfigOption[];
  configsLoading: boolean;
  configsError: boolean;
  selectedConfigId: string;
  selectedConfig: OverridesConfigOption | undefined;
  modelValue: string;
  effortValue: string;
  models: CatalogOption[];
  modelsLoading: boolean;
  efforts: EffortsCatalogState;
  effortDisabledReason: string | null;
  effortHidden: boolean;
  hasChanges: boolean;
  showRestartWarning: boolean;
  handleConfigChange: (configId: string) => void;
  setModelValue: (value: string) => void;
  setEffortValue: (value: string) => void;
  buildSavePayload: () => AgentOverridesSavePayload;
}

function useOverridesController(
  agent: AgentOrGuest,
  open: boolean,
  isOnline: boolean,
  apiBase: string | undefined,
  fetchProviderConfigsForProfile: (profileId: string) => Promise<OverridesConfigOption[]>,
): OverridesController {
  const context = apiBase && apiBase.length > 0 ? apiBase : 'main';
  const base = apiBase ?? '';

  const currentConfigId = agent.providerConfigId ?? '';
  const currentModel = agent.modelOverride ?? null;
  const currentEffort = agent.effortOverride ?? null;

  const [selectedConfigId, setSelectedConfigId] = useState(currentConfigId);
  const [modelValue, setModelValue] = useState(currentModel ?? DEFAULT_VALUE);
  const [effortValue, setEffortValue] = useState(currentEffort ?? DEFAULT_VALUE);

  const {
    data: rawConfigs,
    isLoading: configsLoading,
    isError: configsError,
  } = useQuery({
    queryKey: ['profile-provider-configs', context, agent.profileId],
    queryFn: () => fetchProviderConfigsForProfile(agent.profileId!),
    enabled: open && Boolean(agent.profileId),
    staleTime: 5 * 60 * 1000,
  });
  const configs = useMemo(() => (Array.isArray(rawConfigs) ? rawConfigs : []), [rawConfigs]);

  const selectedConfig = configs.find((config) => config.id === selectedConfigId);
  const providerId = selectedConfig?.providerId ?? null;

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: providerModelQueryKeys.byContext(context, providerId ?? 'none'),
    queryFn: async () => {
      const res = await fetch(`${base}/api/providers/${providerId}/models`);
      if (!res.ok) {
        return [] as CatalogOption[];
      }
      const payload = (await res.json().catch(() => [])) as unknown;
      return parseCatalogOptions(payload, providerId!);
    },
    enabled: open && Boolean(providerId),
    staleTime: 5 * 60 * 1000,
  });
  const models = useMemo(() => (Array.isArray(modelsData) ? modelsData : []), [modelsData]);

  const {
    data: effortsData,
    isLoading: effortsLoading,
    isError: effortsError,
  } = useQuery({
    queryKey: ['provider-efforts', context, providerId ?? 'none'],
    queryFn: async () => {
      const res = await fetch(`${base}/api/providers/${providerId}/efforts`);
      if (!res.ok) {
        return { efforts: [], supportsEffort: false, requiresModelForEffort: false };
      }
      const payload = (await res.json().catch(() => null)) as {
        efforts?: unknown;
        supportsEffort?: unknown;
        requiresModelForEffort?: unknown;
      } | null;
      return {
        efforts: parseCatalogOptions(payload?.efforts, providerId!),
        supportsEffort: payload?.supportsEffort === true,
        requiresModelForEffort: payload?.requiresModelForEffort === true,
      };
    },
    enabled: open && Boolean(providerId),
    staleTime: 5 * 60 * 1000,
  });

  const efforts: EffortsCatalogState = {
    efforts: effortsData?.efforts ?? [],
    supportsEffort: effortsData?.supportsEffort ?? false,
    requiresModelForEffort: effortsData?.requiresModelForEffort ?? false,
    isLoading: effortsLoading,
    isError: effortsError,
  };

  const handleConfigChange = useCallback((configId: string) => {
    // Switching config rebinds both catalogs to the new provider and clears any
    // stale cross-provider selections back to Default.
    setSelectedConfigId(configId);
    setModelValue(DEFAULT_VALUE);
    setEffortValue(DEFAULT_VALUE);
  }, []);

  // Effective model for the requiresModelForEffort (opencode) gate: the in-dialog
  // model override if set, otherwise the selected config's structured default.
  const effectiveModel =
    modelValue !== DEFAULT_VALUE ? modelValue : (selectedConfig?.model ?? null);

  const effortHidden = !efforts.isLoading && !efforts.supportsEffort;

  let effortDisabledReason: string | null = null;
  if (efforts.supportsEffort && !efforts.isLoading) {
    if (efforts.efforts.length === 0) {
      effortDisabledReason = 'No effort levels configured';
    } else if (efforts.requiresModelForEffort && !effectiveModel) {
      effortDisabledReason = 'Select a model first';
    }
  }

  const normalizedModel = modelValue === DEFAULT_VALUE ? null : modelValue;
  const normalizedEffort = effortValue === DEFAULT_VALUE ? null : effortValue;

  const hasChanges =
    selectedConfigId !== currentConfigId ||
    normalizedModel !== currentModel ||
    normalizedEffort !== currentEffort;

  const showRestartWarning = isOnline && hasChanges;

  const buildSavePayload = useCallback(
    (): AgentOverridesSavePayload => ({
      providerConfigId: selectedConfigId,
      modelOverride: modelValue === DEFAULT_VALUE ? null : modelValue,
      effortOverride: effortValue === DEFAULT_VALUE ? null : effortValue,
    }),
    [selectedConfigId, modelValue, effortValue],
  );

  return {
    configs,
    configsLoading,
    configsError,
    selectedConfigId,
    selectedConfig,
    modelValue,
    effortValue,
    models,
    modelsLoading,
    efforts,
    effortDisabledReason,
    effortHidden,
    hasChanges,
    showRestartWarning,
    handleConfigChange,
    setModelValue,
    setEffortValue,
    buildSavePayload,
  };
}

// ============================================
// Component
// ============================================

function defaultLabel(structuredDefault: string | null | undefined): string {
  return structuredDefault ? `Default (config: ${shortModelName(structuredDefault)})` : 'Default';
}

export function AgentOverridesDialog({
  open,
  onOpenChange,
  agent,
  isOnline,
  apiBase,
  isSaving,
  fetchProviderConfigsForProfile,
  onSave,
  triggerEl,
}: AgentOverridesDialogProps) {
  const controller = useOverridesController(
    agent,
    open,
    isOnline,
    apiBase,
    fetchProviderConfigsForProfile,
  );
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSaveError(null);
    }
  }, [open]);

  const {
    configs,
    configsLoading,
    configsError,
    selectedConfigId,
    selectedConfig,
    modelValue,
    effortValue,
    models,
    modelsLoading,
    efforts,
    effortDisabledReason,
    effortHidden,
    hasChanges,
    showRestartWarning,
    handleConfigChange,
    setModelValue,
    setEffortValue,
    buildSavePayload,
  } = controller;

  const handleSave = useCallback(async () => {
    setSaveError(null);
    try {
      await onSave(buildSavePayload());
      onOpenChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save overrides');
    }
  }, [buildSavePayload, onSave, onOpenChange]);

  const effortDisabled = Boolean(effortDisabledReason) || efforts.isLoading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(event) => {
          // Restore focus to the row that opened the dialog (the context-menu
          // trigger is unmounted, so Radix cannot restore it automatically).
          if (triggerEl) {
            event.preventDefault();
            triggerEl.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Overrides — {agent.name}</DialogTitle>
          <DialogDescription>
            Choose the provider config, model, and reasoning effort for this agent. Leave a field on
            “Default” to inherit the config’s value.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Provider Config */}
          <div className="space-y-1.5">
            <Label htmlFor="overrides-config">Provider Config</Label>
            {configsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                Loading configs…
              </div>
            ) : configsError ? (
              <p className="text-sm text-destructive">Failed to load provider configs.</p>
            ) : configs.length === 0 ? (
              <p className="text-sm text-muted-foreground">No provider configs available.</p>
            ) : (
              <Select value={selectedConfigId} onValueChange={handleConfigChange}>
                <SelectTrigger id="overrides-config">
                  <SelectValue placeholder="Select a config" />
                </SelectTrigger>
                <SelectContent>
                  {configs.map((config) => (
                    <SelectItem key={config.id} value={config.id}>
                      <span className="truncate">{config.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Model */}
          <div className="space-y-1.5">
            <Label htmlFor="overrides-model">Model</Label>
            <Select
              value={modelValue}
              onValueChange={setModelValue}
              disabled={!selectedConfig || modelsLoading}
            >
              <SelectTrigger id="overrides-model">
                <SelectValue placeholder="Default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VALUE}>{defaultLabel(selectedConfig?.model)}</SelectItem>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.name} title={model.name}>
                    <span className="truncate">{shortModelName(model.name)}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Effort */}
          {!effortHidden && (
            <div className="space-y-1.5">
              <Label htmlFor="overrides-effort">Reasoning Effort</Label>
              <Select value={effortValue} onValueChange={setEffortValue} disabled={effortDisabled}>
                <SelectTrigger id="overrides-effort">
                  <SelectValue placeholder="Default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE}>
                    {defaultLabel(selectedConfig?.effort)}
                  </SelectItem>
                  {efforts.efforts.map((effort) => (
                    <SelectItem key={effort.id} value={effort.name} title={effort.name}>
                      <span className="truncate">{effort.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {effortDisabledReason && (
                <p className="text-xs text-muted-foreground">{effortDisabledReason}</p>
              )}
            </div>
          )}

          {/* Restart warning */}
          {showRestartWarning && (
            <div
              className="flex items-start gap-2 rounded-md border border-yellow-600/40 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-700 dark:text-yellow-500"
              role="status"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>This agent is online. Restart the session to apply the changes.</span>
            </div>
          )}

          {/* Save errors (a11y live region) */}
          <p className="text-xs text-destructive" role="alert" aria-live="assertive">
            {saveError}
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={!hasChanges || isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
