import { useId, type ReactNode } from 'react';
import { ChevronDown, Plug } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Label } from '@/ui/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import { shortModelName } from '@/ui/lib/model-utils';
import { cn } from '@/ui/lib/utils';
import {
  agentKey,
  availableConfigs,
  configsForProfile,
  findConfig,
  profileForAgent,
  resolveAgentRow,
  type AgentRow,
  type TemplateAgent,
  type TemplateProfile,
  type TemplateProviderConfig,
} from './agentPlan';
import { optionLabel, providerDisplayList, providerDisplayName } from './providerDisplay';
import { installedProviderNames } from './providerSelection';
import { agentModelChoices } from './useProviderCatalogs';
import { useSetupReview } from './SetupReviewContext';

const DEFAULT_MODEL_OVERRIDE = '__default_model_override__';
const DEFAULT_EFFORT_OVERRIDE = '__default_effort_override__';

/** One agent the template creates: name, description, and the value it runs on. */
export function AgentSetupRow({ agent, isLead }: { agent: TemplateAgent; isLead: boolean }) {
  const { preview, state } = useSetupReview();
  const row = state.agentRows[agentKey(agent.name)];
  if (!row) return null;

  const profile = profileForAgent(agent, preview.payload.profiles ?? []);
  const installed = installedProviderNames(preview);
  const resolved = resolveAgentRow(row, profile, state.selectedProviderNames, installed);
  const config = findConfig(profile, resolved.resolvedConfigName);

  return (
    <li className="flex items-start gap-3 py-2" data-testid={`wizard-agent-row-${agent.name}`}>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{agent.name}</span>
          {isLead && (
            <Badge variant="outline" className="font-normal">
              Lead
            </Badge>
          )}
        </div>
        {agent.description && <p className="text-xs text-muted-foreground">{agent.description}</p>}
        {!config && (
          <p
            className="text-xs text-destructive"
            data-testid={`wizard-agent-blocked-${agent.name}`}
          >
            {blockedReason(profile)}
          </p>
        )}
      </div>
      {config && (
        <AgentValuePopover
          agent={agent}
          row={row}
          config={config}
          options={availableConfigs(profile, installed)}
        />
      )}
    </li>
  );
}

function blockedReason(profile: TemplateProfile | undefined): string {
  const supported = providerDisplayList(configsForProfile(profile).map((c) => c.providerName));
  return supported
    ? `No selected provider can run this agent. The template supports: ${supported}.`
    : 'No selected provider can run this agent. The template defines no provider for it.';
}

interface AgentValueProps {
  agent: TemplateAgent;
  row: AgentRow;
  config: TemplateProviderConfig;
}

function AgentValuePopover({
  agent,
  row,
  config,
  options,
}: AgentValueProps & { options: TemplateProviderConfig[] }) {
  const { handlers } = useSetupReview();
  return (
    <AgentOptionPicker
      agentName={agent.name}
      selected={config}
      options={options.map((option) => ({ ...option, model: option.model ?? null }))}
      displayValue={row.modelOverride ? shortModelName(row.modelOverride) : config.name}
      onSelect={(option) =>
        handlers.onAgentRowChange(agent.name, {
          configName: option.name,
          pinned: true,
          userSelectedOption: true,
        })
      }
    >
      <AgentModelEffort agent={agent} row={row} config={config} />
    </AgentOptionPicker>
  );
}

interface AgentOption {
  name: string;
  providerName: string;
  model?: string | null;
}

export function AgentOptionPicker({
  agentName,
  selected,
  options,
  displayValue,
  onSelect,
  children,
}: {
  agentName: string;
  selected: AgentOption | null;
  options: AgentOption[];
  displayValue?: string;
  onSelect: (option: AgentOption) => void;
  children?: ReactNode;
}) {
  const runsOnId = useId();
  const label = selected
    ? optionLabel(selected.providerName, displayValue ?? selected.name)
    : 'Select an option';
  const groups = new Map<string, AgentOption[]>();
  for (const option of options) {
    const key = providerKey(option.providerName);
    groups.set(key, [...(groups.get(key) ?? []), option]);
  }

  if (!options.length) return null;

  // The provider line shows the provider of the selected option, else the first provider.
  const providers = [...groups.keys()];
  const selectedProvider = selected ? providerKey(selected.providerName) : null;
  const provider =
    selectedProvider !== null && groups.has(selectedProvider) ? selectedProvider : providers[0];
  const providerOptions = groups.get(provider) ?? [];
  const current = providerOptions.find(
    (option) => selected?.name === option.name && selected.providerName === option.providerName,
  );

  return (
    <Popover modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          aria-label={`${agentName}: ${label}`}
        >
          <ProviderIcon
            provider={selected?.providerName ?? null}
            className="h-4 w-4 text-muted-foreground"
          />
          <span className="max-w-[12rem] truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={16}
        className="max-h-[var(--radix-popover-content-available-height)] w-80 space-y-4 overflow-y-auto"
      >
        <div role="group" aria-labelledby={runsOnId} className="space-y-2">
          <p id={runsOnId} className="text-xs font-medium text-muted-foreground">
            Runs on
          </p>
          <div className="flex items-center gap-2">
            {providers.length > 1 ? (
              // A change of provider selects the first option of that provider.
              <Select
                value={provider}
                onValueChange={(next) => {
                  const first = groups.get(next)?.[0];
                  if (first) onSelect(first);
                }}
              >
                <SelectTrigger
                  aria-label={`${agentName} provider`}
                  title={providerDisplayName(provider)}
                  className="w-auto shrink-0 gap-1.5 px-2"
                >
                  <SelectValue>
                    <ProviderIcon provider={provider} className="h-5 w-5" />
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {providers.map((name) => (
                    <SelectItem key={name} value={name}>
                      <span className="flex items-center gap-2">
                        <ProviderIcon provider={name} className="h-4 w-4" />
                        {providerDisplayName(name)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span title={providerDisplayName(provider)} className="shrink-0 px-1">
                <ProviderIcon provider={provider} className="h-5 w-5" />
              </span>
            )}
            <Select
              value={current?.name ?? ''}
              onValueChange={(name) => {
                const option = providerOptions.find((candidate) => candidate.name === name);
                if (option) onSelect(option);
              }}
            >
              <SelectTrigger
                aria-label={`${agentName} option`}
                className="min-w-0 flex-1 data-[placeholder]:text-muted-foreground"
              >
                <SelectValue placeholder="Select an option">{current?.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((option) => (
                  <SelectItem key={option.name} value={option.name}>
                    {option.name}
                    {option.model !== undefined && (
                      <>
                        {' '}
                        <span className="text-xs text-muted-foreground">
                          {option.model ? shortModelName(option.model) : 'Provider default'}
                        </span>
                      </>
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}

const providerKey = (name: string): string => name.trim().toLowerCase();

/** The icon of a provider, or a plug when the provider has no icon. */
function ProviderIcon({ provider, className }: { provider: string | null; className?: string }) {
  const icon = provider ? getProviderIconDataUri(provider) : null;
  return icon ? (
    <img src={icon} alt="" aria-hidden="true" className={cn('shrink-0', className)} />
  ) : (
    <Plug className={cn('shrink-0', className)} aria-hidden="true" />
  );
}

/** Model and effort overrides for the agent's current config. */
function AgentModelEffort({ agent, row, config }: AgentValueProps) {
  const { catalogs, handlers } = useSetupReview();
  const { modelOptions, effortOptions, supportsEffort, effortDisabled } = agentModelChoices(
    catalogs,
    agent,
    row,
    config,
  );
  const modelId = useId();
  const effortId = useId();

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label htmlFor={modelId} className="text-xs text-muted-foreground">
          Model
        </Label>
        <Select
          value={row.modelOverride ?? DEFAULT_MODEL_OVERRIDE}
          onValueChange={(value) =>
            handlers.onAgentRowChange(agent.name, {
              modelOverride: value === DEFAULT_MODEL_OVERRIDE ? null : value,
            })
          }
        >
          <SelectTrigger id={modelId} aria-label={`${agent.name} model`}>
            <SelectValue placeholder="Default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_MODEL_OVERRIDE}>
              {config.model ? `Default (${shortModelName(config.model)})` : 'Default'}
            </SelectItem>
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
          <Label htmlFor={effortId} className="text-xs text-muted-foreground">
            Effort
          </Label>
          <Select
            value={row.effortOverride ?? DEFAULT_EFFORT_OVERRIDE}
            disabled={effortDisabled}
            onValueChange={(value) =>
              handlers.onAgentRowChange(agent.name, {
                effortOverride: value === DEFAULT_EFFORT_OVERRIDE ? null : value,
              })
            }
          >
            <SelectTrigger id={effortId} aria-label={`${agent.name} effort`}>
              <SelectValue placeholder={effortDisabled ? 'Select a model first' : 'Default'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_EFFORT_OVERRIDE}>
                {config.effort ? `Default (${config.effort})` : 'Default'}
              </SelectItem>
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
  );
}
