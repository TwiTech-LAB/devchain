import { createContext, useContext, useId, useMemo, type ReactNode } from 'react';
import { ChevronDown, Info, Plug, RotateCcw } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import { cn } from '@/ui/lib/utils';
import { getProviderIconDataUri } from '@/ui/lib/providers';
import {
  agentKey,
  buildAgentGroups,
  configProviderName,
  eqName,
  profileForAgent,
  selectablePresetsNewestFirst,
  type TemplateAgent,
} from './agentPlan';
import { configurableTeams, type ParsedTemplateTeam } from './teamPlan';
import { providerDisplayList, providerDisplayName } from './providerDisplay';
import { AgentSetupRow } from './AgentSetupRow';
import { TeamSetupRows } from './TeamSetupRows';
import { useSetupReview } from './SetupReviewContext';
import { ROSTER_SCROLL_CLASS, RosterGroup, rosterRole } from './Roster';

/** A titled page section. */
export function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="text-sm font-semibold text-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** One line of names after a bold label, for example "Removed: A, B". Nothing with no names. */
export function SummaryLine({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <p className="break-words text-sm text-muted-foreground">
      <strong>{`${label}:`}</strong> {items.join(', ')}
    </p>
  );
}

/** A list of more than this many providers opens from one button instead of showing inline. */
const INLINE_PROVIDER_LIMIT = 3;

function ProviderIcon({ name }: { name: string }) {
  const icon = getProviderIconDataUri(name);
  return icon ? (
    <img src={icon} alt="" width={16} height={16} className="shrink-0" />
  ) : (
    <Plug className="h-4 w-4 shrink-0" aria-hidden="true" />
  );
}

/** The provider checkboxes, shown inline or inside the popover. */
function ProviderCheckboxList() {
  const {
    providers,
    state: { selectedProviderNames },
    handlers,
  } = useSetupReview();
  const fieldId = useId();
  const selected = new Set(selectedProviderNames);
  return (
    <ul className="grid gap-2">
      {providers.map(({ name, installed }) => {
        const checked = selected.has(name);
        const disabledReason = !installed
          ? 'Not installed'
          : checked && selected.size === 1
            ? 'One provider is required'
            : undefined;
        const providerKey = encodeURIComponent(name);
        const nameId = `${fieldId}-name-${providerKey}`;
        const reasonId = `${fieldId}-reason-${providerKey}`;
        return (
          <li key={name}>
            <label
              className={cn(
                'flex min-h-11 touch-manipulation items-center gap-2 rounded-md border px-3 py-2',
                checked ? 'border-primary bg-selected' : 'border-border',
                disabledReason ? 'cursor-not-allowed' : 'cursor-pointer',
                !disabledReason && !checked && 'hover:bg-accent',
              )}
            >
              <input
                type="checkbox"
                name="providers"
                value={name}
                className="h-4 w-4 shrink-0 accent-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                checked={checked}
                disabled={Boolean(disabledReason)}
                aria-labelledby={nameId}
                aria-describedby={disabledReason ? reasonId : undefined}
                onChange={(event) =>
                  handlers.onSelectedProvidersChange(
                    event.target.checked
                      ? [...selectedProviderNames, name]
                      : selectedProviderNames.filter((provider) => provider !== name),
                  )
                }
              />
              <ProviderIcon name={name} />
              <span className="min-w-0 break-words">
                <span
                  id={nameId}
                  translate="no"
                  className={cn('block text-sm font-medium', checked && 'text-selected-foreground')}
                >
                  {providerDisplayName(name)}
                </span>
                {disabledReason && (
                  <span id={reasonId} className="block text-xs text-muted-foreground">
                    {disabledReason}
                  </span>
                )}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function ProviderPopover() {
  const {
    providers,
    state: { selectedProviderNames },
  } = useSetupReview();
  const chosen = providers.filter(({ name }) => selectedProviderNames.includes(name));
  const summary = chosen.length
    ? chosen.map(({ name }) => providerDisplayName(name)).join(', ')
    : 'None';
  return (
    <Popover modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-10 w-full justify-between gap-2 whitespace-normal py-1.5"
          aria-label={`Providers: ${summary}`}
        >
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {chosen.length ? (
              chosen.map(({ name }) => (
                <span
                  key={name}
                  className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
                >
                  <ProviderIcon name={name} />
                  <span translate="no">{providerDisplayName(name)}</span>
                </span>
              ))
            ) : (
              <span className="text-sm font-normal text-muted-foreground">None</span>
            )}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        collisionPadding={16}
        aria-label="Providers"
        className="max-h-[var(--radix-popover-content-available-height)] w-[var(--radix-popover-trigger-width)] overflow-y-auto"
      >
        <ProviderCheckboxList />
      </PopoverContent>
    </Popover>
  );
}

export function ProvidersSection() {
  const { providers } = useSetupReview();
  let body = <ProviderCheckboxList />;
  if (providers.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">No providers are listed for this template.</p>
    );
  } else if (providers.length > INLINE_PROVIDER_LIMIT) {
    body = <ProviderPopover />;
  }
  return <ReviewSection title="Providers">{body}</ReviewSection>;
}

const SetupChoiceNameContext = createContext<string>('');

/**
 * The providers that a setup runs on, as icons. The name of a provider shows on hover. The text
 * "Runs on ..." stays for a screen reader. A provider with no icon shows its name.
 */
function SetupProviderIcons({ providers }: { providers: string[] }) {
  const names = [...new Set(providers.map((name) => name.trim().toLowerCase()))];
  if (names.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="sr-only">Runs on {providerDisplayList(names)}</span>
      {names.map((name) => {
        const icon = getProviderIconDataUri(name);
        const label = providerDisplayName(name);
        return icon ? (
          <img
            key={name}
            src={icon}
            alt=""
            aria-hidden="true"
            title={label}
            width={16}
            height={16}
            className="shrink-0"
          />
        ) : (
          <span key={name} aria-hidden="true" className="text-xs text-muted-foreground">
            {label}
          </span>
        );
      })}
    </span>
  );
}

/** A group of {@link SetupChoiceCard} radios with one shared name. */
export function SetupChoiceGroup({ legend, children }: { legend: string; children: ReactNode }) {
  const radioName = useId();
  return (
    <SetupChoiceNameContext.Provider value={radioName}>
      {/* A fieldset is at least as wide as its content by default. min-w-0 and the minmax(0, 1fr)
          track keep a card with a long setup name inside the column, so the name truncates. */}
      <fieldset className="grid min-w-0 grid-cols-1 gap-2">
        <legend className="sr-only">{legend}</legend>
        {children}
      </fieldset>
    </SetupChoiceNameContext.Provider>
  );
}

/** One radio card. Must render inside {@link SetupChoiceGroup}. */
export function SetupChoiceCard({
  title,
  description,
  checked,
  onSelect,
  children,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onSelect: () => void;
  /**
   * Shown inside the card under the radio's label. It is not part of the label, so it does not
   * add to the radio's accessible name, and a click on it does not select the radio.
   */
  children?: ReactNode;
}) {
  const radioName = useContext(SetupChoiceNameContext);
  return (
    <div
      data-state={checked ? 'selected' : undefined}
      className={cn(
        'rounded-md border',
        checked ? 'border-primary bg-selected' : 'border-border hover:bg-accent',
      )}
    >
      <label className="flex cursor-pointer items-start gap-3 p-3">
        <input
          type="radio"
          name={radioName}
          className="mt-1"
          checked={checked}
          onChange={onSelect}
        />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block text-sm font-medium text-foreground">{title}</span>
          {description && (
            <span className="block text-xs text-muted-foreground">{description}</span>
          )}
        </span>
      </label>
      {/* Indented to the start of the label text. */}
      {children && <div className="px-3 pb-3 pl-9">{children}</div>}
    </div>
  );
}

/**
 * The ready-made setups (presets) that fit the selected providers, newest first, in one dropdown.
 * With no fitting setup it shows a note instead. "Reset" shows after an agent or team row edit.
 */
export function SetupPresetPicker() {
  const { preview, state, handlers } = useSetupReview();
  const presets = useMemo(
    () => selectablePresetsNewestFirst(preview, state.selectedProviderNames),
    [preview, state.selectedProviderNames],
  );
  const providersByPreset = useMemo(
    () => new Map(preview.presetProviderCoverage.map((c) => [c.presetName, c.referencedProviders])),
    [preview.presetProviderCoverage],
  );
  const selected = presets.find(({ name }) => name === state.agentPresetName);
  const suggested = presets[0]?.name;

  const reset = state.hasManualEdits ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0"
      aria-label="Reset setup"
      onClick={handlers.onResetSetup}
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
      Reset
    </Button>
  ) : null;

  if (presets.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          No ready-made setup fits the selected providers.
        </p>
        {reset}
      </div>
    );
  }

  const modified = selected && state.agentPresetModified;
  return (
    <div className="space-y-2">
      <Select value={selected?.name ?? ''} onValueChange={handlers.onApplyPreset}>
        {/* The value is a flex row of icons and name; line-clamp on it would stack them. */}
        <SelectTrigger
          aria-label="Ready-made setup"
          className="gap-2 data-[placeholder]:text-muted-foreground [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-2"
        >
          <SelectValue placeholder="Select a setup">
            {selected && (
              <>
                <SetupProviderIcons providers={providersByPreset.get(selected.name) ?? []} />
                <span className="min-w-0 truncate">{selected.name}</span>
              </>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent
          collisionPadding={16}
          className="max-h-[min(24rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)]"
        >
          {presets.map((preset) => (
            <SelectItem
              key={preset.name}
              value={preset.name}
              textValue={preset.name}
              // The first span is the check mark, at the height of the first line. The last span
              // holds the text: min-w-0 lets it shrink to the width of the list.
              className="items-start [&>span:first-child]:top-2.5 [&>span:last-child]:min-w-0"
            >
              {/* overflow-wrap: anywhere also breaks a long name with no spaces. */}
              <span className="block min-w-0 space-y-1 whitespace-normal [overflow-wrap:anywhere]">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{preset.name}</span>
                  {preset.name === suggested && <Badge variant="secondary">Suggested</Badge>}
                </span>
                <SetupProviderIcons providers={providersByPreset.get(preset.name) ?? []} />
                {preset.description && (
                  <span className="block whitespace-pre-line text-xs text-muted-foreground">
                    {preset.description}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(selected?.description || modified || reset) && (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            {selected?.description && (
              <p className="whitespace-pre-line break-words text-xs text-muted-foreground">
                {selected.description}
              </p>
            )}
            {modified && (
              <Badge variant="outline" data-testid="wizard-setup-modified">
                modified
              </Badge>
            )}
          </div>
          {reset}
        </div>
      )}
    </div>
  );
}

/** The Setup section with only the dropdown: the create flow, and a replace flow with no Keep. */
export function SetupPresetSection() {
  return (
    <ReviewSection title="Setup">
      <SetupPresetPicker />
    </ReviewSection>
  );
}

/** Tells the user when an agent or a team moved to a selected provider by the fallback rule. */
export function FallbackNotice() {
  const { preview, state } = useSetupReview();
  const profiles = preview.payload.profiles ?? [];
  const providers = new Set<string>();

  for (const agent of preview.payload.agents ?? []) {
    const row = state.agentRows[agentKey(agent.name)];
    if (!row?.fallbackFromConfigName) continue;
    const provider = configProviderName(profileForAgent(agent, profiles), row.configName);
    if (provider) providers.add(provider);
  }
  for (const teamState of state.teamStates.values()) {
    for (const fallback of teamState.fallbacks ?? []) {
      const profile = profiles.find((p) => eqName(p.name, fallback.profileName));
      const provider = configProviderName(profile, fallback.configName);
      if (provider) providers.add(provider);
    }
  }
  if (providers.size === 0) return null;

  return (
    <Alert variant="info" role="status" data-testid="wizard-fallback-notice">
      <Info className="h-4 w-4" />
      <AlertDescription>
        Some template options use providers that are not selected. The affected agents or teams now
        use {providerDisplayList([...providers].sort())}. Model and effort use the defaults of each
        option.
      </AlertDescription>
    </Alert>
  );
}

interface CreatedGroup {
  key: string;
  title: string;
  description?: string | null;
  leadAgentName: string | null;
  agents: TemplateAgent[];
  configurableTeam: ParsedTemplateTeam | null;
}

/** Agents grouped by team (lead first), the team rows, then the independent agents. */
export function CreatedAgentsSection() {
  const { preview } = useSetupReview();
  const payload = preview.payload;

  const groups = useMemo<CreatedGroup[]>(() => {
    const agents = payload.agents ?? [];
    const teams = (payload.teams ?? []) as ParsedTemplateTeam[];
    const agentByKey = new Map(agents.map((a) => [agentKey(a.name), a]));
    const configurable = new Map(configurableTeams(teams).map((t) => [t.name, t]));
    const toAgents = (names: string[]) =>
      names.map((n) => agentByKey.get(agentKey(n))).filter((a): a is TemplateAgent => !!a);

    const out: CreatedGroup[] = [];
    let independent: CreatedGroup | null = null;
    for (const group of buildAgentGroups(agents, payload.teams ?? [])) {
      if (group.kind === 'independent') {
        independent = {
          key: 'independent',
          title: 'Independent',
          leadAgentName: null,
          agents: toAgents(group.agentNames),
          configurableTeam: null,
        };
        continue;
      }
      const team = teams.find((t) => t.name === group.teamName);
      out.push({
        key: `team-${group.teamName}`,
        title: group.teamName ?? '',
        description: team?.description,
        leadAgentName: group.leadAgentName,
        agents: toAgents(group.agentNames),
        configurableTeam: configurable.get(group.teamName ?? '') ?? null,
      });
      configurable.delete(group.teamName ?? '');
    }
    // A configurable team whose agents are all claimed elsewhere still shows its team rows.
    for (const team of configurable.values()) {
      out.push({
        key: `team-${team.name}`,
        title: team.name,
        description: team.description,
        leadAgentName: null,
        agents: [],
        configurableTeam: team,
      });
    }
    if (independent) out.push(independent);
    return out;
  }, [payload.agents, payload.teams]);

  return (
    <ReviewSection title="What gets created">
      <div className={cn('space-y-4', ROSTER_SCROLL_CLASS)}>
        {groups.map((group) => {
          const { leadAgentName } = group;
          // A lead that an earlier team already shows is not in this block's agents.
          const lead =
            leadAgentName !== null && group.agents.some((a) => eqName(leadAgentName, a.name))
              ? leadAgentName
              : null;
          return (
            <RosterGroup key={group.key} title={group.title} description={group.description}>
              <ul className="divide-y">
                {group.agents.map((agent) => (
                  <AgentSetupRow
                    key={agent.name}
                    agent={agent}
                    role={rosterRole(lead, agent.name)}
                  />
                ))}
                {group.configurableTeam && (
                  <TeamSetupRows
                    team={group.configurableTeam}
                    role={lead === null ? undefined : 'member'}
                  />
                )}
              </ul>
            </RosterGroup>
          );
        })}
      </div>
    </ReviewSection>
  );
}
