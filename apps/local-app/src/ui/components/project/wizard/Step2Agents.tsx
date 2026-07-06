import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { AlertTriangle, Plug, Users } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
import { Label } from '@/ui/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { cn } from '@/ui/lib/utils';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import { shortModelName } from '@/ui/lib/model-utils';
import { providerModelQueryKeys } from '@/ui/lib/provider-model-query-keys';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-api';
import {
  agentKey,
  availableConfigs,
  buildAgentGroups,
  eqName,
  findConfig,
  profileForAgent,
  resolveAgentRow,
  selectablePresetNames,
  type AgentRow,
  type TemplateAgent,
  type TemplateProfile,
} from './agentPlan';

const DEFAULT_MODEL_OVERRIDE = '__default_model_override__';
const DEFAULT_EFFORT_OVERRIDE = '__default_effort_override__';
const NO_PRESET = '__no_preset__';

interface ProviderEffortsCatalog {
  efforts: string[];
  supportsEffort: boolean;
  requiresModelForEffort: boolean;
}

const EMPTY_EFFORTS: ProviderEffortsCatalog = {
  efforts: [],
  supportsEffort: false,
  requiresModelForEffort: false,
};

/** Parse the `/api/providers/:id/models` payload into a flat list of model names (defensive). */
function parseModelNames(payload: unknown): string[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((raw) => {
      if (typeof raw === 'string') return raw.trim();
      if (raw && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string') {
        return (raw as { name: string }).name.trim();
      }
      return '';
    })
    .filter((name) => name.length > 0);
}

/** Parse the `/api/providers/:id/efforts` payload (mirrors PresetDialog's shape, defensively). */
function parseEfforts(payload: unknown): ProviderEffortsCatalog {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return EMPTY_EFFORTS;
  const obj = payload as {
    efforts?: unknown;
    supportsEffort?: unknown;
    requiresModelForEffort?: unknown;
  };
  const efforts = Array.isArray(obj.efforts)
    ? obj.efforts
        .map((raw) => (typeof raw === 'string' ? raw : (raw as { name?: unknown })?.name))
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map((name) => name.trim())
    : [];
  return {
    efforts,
    supportsEffort: obj.supportsEffort === true,
    requiresModelForEffort: obj.requiresModelForEffort === true,
  };
}

/** Dedupe while preserving first-seen order (case-insensitive). */
function uniqueNames(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const key = value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export interface Step2AgentsProps {
  preview: SetupPreviewResponse;
  selectedProviderNames: string[];
  /** Per-agent row state, keyed by {@link agentKey}. Owned by the flow controller. */
  rows: Record<string, AgentRow>;
  /** Currently applied preset (null = custom). */
  presetName: string | null;
  /** True once a preset was applied then hand-edited. */
  presetModified: boolean;
  /** Patch a single agent's row (controller marks the preset modified when appropriate). */
  onRowChange: (agentName: string, patch: Partial<AgentRow>) => void;
  /** Apply a preset by name (controller pins configs + sets overrides + clears modified). */
  onApplyPreset: (presetName: string) => void;
  /** Drop back to a custom plan (keeps current rows). */
  onClearPreset: () => void;
}

/**
 * Wizard Step 2 — per-agent configuration. Agents are grouped by team (lead first + highlighted,
 * members indented) with a trailing "Independent agents" bucket. Each row filters its config options
 * to Step-1's selected providers, preselects the template's config, and exposes model/effort overrides
 * (model union = local provider catalog ∪ template `providerModels` ∪ the preselected value; effort
 * honours the provider's `supportsEffort`/`requiresModelForEffort`). A named config whose provider was
 * deselected is flagged UNRESOLVED (never auto-swapped) and hard-blocks Next until fixed in Step 1.
 *
 * The optional preset picker lists only presets whose every referenced provider is selected; applying
 * one prefills the rows, and any manual edit flags it "(modified)". Emission (presetName XOR
 * agentOverrides) lives in the controller via `buildAgentPlanEmission` — this component only renders +
 * lifts edits. It intentionally does NOT import ChatSidebar/AgentRow internals (visual parity only).
 */
export function Step2Agents({
  preview,
  selectedProviderNames,
  rows,
  presetName,
  presetModified,
  onRowChange,
  onApplyPreset,
  onClearPreset,
}: Step2AgentsProps) {
  const payload = preview.payload;
  const agents = useMemo<TemplateAgent[]>(() => payload.agents ?? [], [payload.agents]);
  const profiles = useMemo<TemplateProfile[]>(() => payload.profiles ?? [], [payload.profiles]);
  const groups = useMemo(
    () => buildAgentGroups(agents, payload.teams ?? []),
    [agents, payload.teams],
  );

  // Provider name → installed provider id (only installed providers expose model/effort catalogs).
  const providerIdByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of preview.localAvailability.installedProviders) {
      map.set(p.name.trim().toLowerCase(), p.id);
    }
    return map;
  }, [preview.localAvailability.installedProviders]);

  const selectedProviderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const name of selectedProviderNames) {
      const id = providerIdByName.get(name.trim().toLowerCase());
      if (id) ids.add(id);
    }
    return Array.from(ids).sort();
  }, [selectedProviderNames, providerIdByName]);

  const idToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const [name, id] of providerIdByName.entries()) map.set(id, name);
    return map;
  }, [providerIdByName]);

  const modelQueries = useQueries({
    queries: selectedProviderIds.map((providerId) => ({
      queryKey: providerModelQueryKeys.main(providerId),
      queryFn: async () => {
        const res = await fetch(`/api/providers/${providerId}/models`);
        if (!res.ok) return [] as string[];
        return parseModelNames((await res.json().catch(() => [])) as unknown);
      },
      staleTime: 5 * 60 * 1000,
    })),
  });

  const effortQueries = useQueries({
    queries: selectedProviderIds.map((providerId) => ({
      queryKey: ['provider-efforts', providerId],
      queryFn: async () => {
        const res = await fetch(`/api/providers/${providerId}/efforts`);
        if (!res.ok) return EMPTY_EFFORTS;
        return parseEfforts((await res.json().catch(() => null)) as unknown);
      },
      staleTime: 5 * 60 * 1000,
    })),
  });

  const localModelsByProvider = useMemo(() => {
    const map = new Map<string, string[]>();
    selectedProviderIds.forEach((id, index) => {
      const name = idToName.get(id);
      if (name)
        map.set(name, Array.isArray(modelQueries[index]?.data) ? modelQueries[index]!.data! : []);
    });
    return map;
  }, [selectedProviderIds, idToName, modelQueries]);

  const localEffortsByProvider = useMemo(() => {
    const map = new Map<string, ProviderEffortsCatalog>();
    selectedProviderIds.forEach((id, index) => {
      const name = idToName.get(id);
      if (name) map.set(name, effortQueries[index]?.data ?? EMPTY_EFFORTS);
    });
    return map;
  }, [selectedProviderIds, idToName, effortQueries]);

  // Template-carried catalogs (available even for providers not installed locally).
  const templateModelsByProvider = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of payload.providerModels ?? []) {
      map.set(entry.providerName.trim().toLowerCase(), entry.models);
    }
    return map;
  }, [payload.providerModels]);

  const templateEffortsByProvider = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const entry of payload.providerEfforts ?? []) {
      map.set(entry.providerName.trim().toLowerCase(), entry.efforts);
    }
    return map;
  }, [payload.providerEfforts]);

  const selectablePresets = useMemo(
    () => selectablePresetNames(preview.presetProviderCoverage, selectedProviderNames),
    [preview.presetProviderCoverage, selectedProviderNames],
  );
  // Newest first: storage order represents update time (newest appended last), and the
  // Agents page's PresetSelector lists most-recently-updated first — mirror it here.
  const presetOptions = useMemo(
    () => [...(payload.presets ?? [])].reverse().filter((p) => selectablePresets.has(p.name)),
    [payload.presets, selectablePresets],
  );

  const agentByName = useMemo(() => {
    const map = new Map<string, TemplateAgent>();
    for (const a of agents) map.set(agentKey(a.name), a);
    return map;
  }, [agents]);

  return (
    <div className="space-y-4" data-testid="wizard-agents-step">
      {presetOptions.length > 0 && (
        <div className="space-y-1.5" data-testid="wizard-agents-preset-picker">
          <Label htmlFor="wizard-agents-preset">Preset</Label>
          <div className="flex items-center gap-2">
            <Select
              value={presetName ?? NO_PRESET}
              onValueChange={(value) =>
                value === NO_PRESET ? onClearPreset() : onApplyPreset(value)
              }
            >
              <SelectTrigger
                id="wizard-agents-preset"
                data-testid="wizard-agents-preset-select"
                className="max-w-xs"
              >
                <SelectValue placeholder="Custom (no preset)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PRESET}>Custom (no preset)</SelectItem>
                {presetOptions.map((preset) => (
                  <SelectItem key={preset.name} value={preset.name}>
                    {preset.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {presetName && presetModified && (
              <Badge variant="secondary" data-testid="wizard-agents-preset-modified">
                modified
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Presets prefill every agent&rsquo;s provider config. Editing a row keeps your changes
            and marks the preset modified.
          </p>
        </div>
      )}

      {groups.map((group) => (
        <div
          key={group.kind === 'team' ? `team-${group.teamName}` : 'independent'}
          className="space-y-2"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {group.kind === 'team' ? group.teamName : 'Independent agents'}
          </div>
          <div className="space-y-2">
            {group.agentNames.map((name) => {
              const agent = agentByName.get(agentKey(name));
              if (!agent) return null;
              const isLead = group.leadAgentName != null && eqName(group.leadAgentName, name);
              const isMember = group.kind === 'team' && !isLead;
              return (
                <AgentConfigRow
                  key={name}
                  agent={agent}
                  row={rows[agentKey(name)]}
                  profile={profileForAgent(agent, profiles)}
                  selectedProviderNames={selectedProviderNames}
                  localModelsByProvider={localModelsByProvider}
                  localEffortsByProvider={localEffortsByProvider}
                  templateModelsByProvider={templateModelsByProvider}
                  templateEffortsByProvider={templateEffortsByProvider}
                  emphasizeLead={isLead}
                  indent={isMember}
                  onRowChange={onRowChange}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

interface AgentConfigRowProps {
  agent: TemplateAgent;
  row: AgentRow | undefined;
  profile: TemplateProfile | undefined;
  selectedProviderNames: string[];
  localModelsByProvider: Map<string, string[]>;
  localEffortsByProvider: Map<string, ProviderEffortsCatalog>;
  templateModelsByProvider: Map<string, string[]>;
  templateEffortsByProvider: Map<string, string[]>;
  emphasizeLead: boolean;
  indent: boolean;
  onRowChange: (agentName: string, patch: Partial<AgentRow>) => void;
}

function AgentConfigRow({
  agent,
  row,
  profile,
  selectedProviderNames,
  localModelsByProvider,
  localEffortsByProvider,
  templateModelsByProvider,
  templateEffortsByProvider,
  emphasizeLead,
  indent,
  onRowChange,
}: AgentConfigRowProps) {
  if (!row) return null;

  const configs = availableConfigs(profile, selectedProviderNames);
  const resolved = resolveAgentRow(row, profile, selectedProviderNames);
  const unresolved = resolved.unresolved || resolved.resolvedConfigName === null;
  const config = findConfig(profile, resolved.resolvedConfigName);
  const providerName = config?.providerName ?? null;
  const providerKey = providerName?.trim().toLowerCase() ?? '';
  const icon = providerName ? getProviderIconDataUri(providerName) : null;

  const modelOptions = uniqueNames([
    ...(localModelsByProvider.get(providerKey) ?? []),
    ...(templateModelsByProvider.get(providerKey) ?? []),
    config?.model ?? null,
    agent.modelOverride ?? null,
    row.modelOverride,
  ]);

  const localEfforts = localEffortsByProvider.get(providerKey) ?? EMPTY_EFFORTS;
  const effortOptions = uniqueNames([
    ...localEfforts.efforts,
    ...(templateEffortsByProvider.get(providerKey) ?? []),
    config?.effort ?? null,
    agent.effortOverride ?? null,
    row.effortOverride,
  ]);
  const supportsEffort = localEfforts.supportsEffort || effortOptions.length > 0;
  const hasResolvableModel = Boolean(row.modelOverride || config?.model);
  const effortDisabled = localEfforts.requiresModelForEffort && !hasResolvableModel;

  const configDefaultLabel = config?.model
    ? `Default (${shortModelName(config.model)})`
    : 'Default';
  const effortDefaultLabel = config?.effort ? `Default (${config.effort})` : 'Default';

  return (
    <div
      className={cn(
        'rounded-md border p-3',
        indent && 'ml-4',
        emphasizeLead ? 'border-primary/40 bg-primary/5' : 'border-border',
        unresolved && 'border-destructive/50',
      )}
      data-testid={`wizard-agent-row-${agent.name}`}
    >
      <div className="flex items-center gap-2">
        {icon ? (
          <img
            src={icon}
            alt=""
            aria-hidden="true"
            title={providerName ? `Provider: ${providerName}` : undefined}
            className="h-4 w-4 shrink-0"
          />
        ) : (
          <Plug className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {agent.name}
        </span>
        {emphasizeLead && (
          <Badge variant="outline" className="font-normal">
            Lead
          </Badge>
        )}
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Config</Label>
          <Select
            value={unresolved ? '' : (resolved.resolvedConfigName ?? '')}
            onValueChange={(value) => onRowChange(agent.name, { configName: value, pinned: true })}
          >
            <SelectTrigger
              aria-label={`${agent.name} provider config`}
              data-testid={`wizard-config-select-${agent.name}`}
              className={cn(unresolved && 'border-destructive text-destructive')}
            >
              <SelectValue placeholder="Select a config" />
            </SelectTrigger>
            <SelectContent>
              {configs.map((cfg) => (
                <SelectItem key={cfg.name} value={cfg.name}>
                  {cfg.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Model</Label>
          <Select
            value={row.modelOverride ?? DEFAULT_MODEL_OVERRIDE}
            disabled={unresolved}
            onValueChange={(value) =>
              onRowChange(agent.name, {
                modelOverride: value === DEFAULT_MODEL_OVERRIDE ? null : value,
              })
            }
          >
            <SelectTrigger
              aria-label={`${agent.name} model`}
              data-testid={`wizard-model-select-${agent.name}`}
            >
              <SelectValue placeholder="Default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL_OVERRIDE}>{configDefaultLabel}</SelectItem>
              {modelOptions.map((name) => (
                <SelectItem key={name} value={name}>
                  {shortModelName(name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {supportsEffort && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Effort</Label>
            <Select
              value={row.effortOverride ?? DEFAULT_EFFORT_OVERRIDE}
              disabled={unresolved || effortDisabled}
              onValueChange={(value) =>
                onRowChange(agent.name, {
                  effortOverride: value === DEFAULT_EFFORT_OVERRIDE ? null : value,
                })
              }
            >
              <SelectTrigger
                aria-label={`${agent.name} effort`}
                data-testid={`wizard-effort-select-${agent.name}`}
              >
                <SelectValue placeholder={effortDisabled ? 'Select a model first' : 'Default'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_EFFORT_OVERRIDE}>{effortDefaultLabel}</SelectItem>
                {effortOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {unresolved && (
        <Alert
          variant="destructive"
          className="mt-2"
          data-testid={`wizard-agent-unresolved-${agent.name}`}
        >
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {agent.providerConfigName
              ? `This agent's config "${agent.providerConfigName}" needs a provider that isn't selected. Re-select it in Step 1, or pick another config.`
              : 'No provider config is available under the current selection. Adjust the providers in Step 1, or pick a config.'}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
