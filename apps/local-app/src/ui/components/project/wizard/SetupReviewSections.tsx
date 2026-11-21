import { createContext, useContext, useId, useMemo, type ReactNode } from 'react';
import { Info, Plug, Users } from 'lucide-react';
import { Alert, AlertDescription } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
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

// The dialog body is at most 60dvh high (ProjectSetupWizard). The two scroll blocks take their
// size from that limit, so the page itself does not scroll on a wide window.
// - Setup list: 35dvh leaves room for the Providers section above it. 24rem (about three cards)
//   is the limit on a tall window.
// - Roster: 60dvh less 6rem leaves room for the section title and the summary lines. The limit
//   applies only while the columns are side by side; stacked columns scroll with the page.
const PRESET_LIST_CLASS = 'grid max-h-[min(24rem,35dvh)] gap-2 overflow-y-auto';
export const ROSTER_SCROLL_CLASS = 'md:max-h-[calc(60dvh-6rem)] md:overflow-y-auto';

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

/**
 * One block of the roster: a team, or the agents in no team. The name and its note sit in a
 * tinted header band; the rows follow on the card surface. The band and the surface make each
 * block read as one unit.
 */
export function RosterGroup({
  title,
  headingLevel = 4,
  badge,
  description,
  children,
}: {
  title: string;
  /** 4 under a titled section, 3 when the block is not inside one. */
  headingLevel?: 3 | 4;
  badge?: ReactNode;
  description?: ReactNode;
  /** The rows. With no rows the block is the header band only. */
  children?: ReactNode;
}) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return (
    <section aria-labelledby={headingId} className="overflow-hidden rounded-lg border bg-card">
      <div className="space-y-0.5 bg-muted px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Heading
            id={headingId}
            className="min-w-0 break-words text-sm font-semibold text-foreground"
          >
            {title}
          </Heading>
          {badge}
        </div>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {/* The rows start to the right of the team name, so they read as members of the block. */}
      {children ? <div className="border-t pl-12 pr-3">{children}</div> : null}
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

export function ProvidersSection() {
  const {
    providers,
    state: { selectedProviderNames },
    handlers,
  } = useSetupReview();
  const fieldId = useId();
  const selected = new Set(selectedProviderNames);
  return (
    <ReviewSection title="Providers">
      {providers.length > 0 ? (
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
            const icon = getProviderIconDataUri(name);
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
                  {icon ? (
                    <img src={icon} alt="" width={16} height={16} className="shrink-0" />
                  ) : (
                    <Plug className="h-4 w-4 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0 break-words">
                    <span
                      id={nameId}
                      translate="no"
                      className={cn(
                        'block text-sm font-medium',
                        checked && 'text-selected-foreground',
                      )}
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
      ) : (
        <p className="text-sm text-muted-foreground">No providers are listed for this template.</p>
      )}
    </ReviewSection>
  );
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
    <span className="ml-auto flex shrink-0 items-center gap-1.5">
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

/** One radio card of the Setup section. Must render inside {@link SetupPresetSection}. */
export function SetupChoiceCard({
  title,
  checked,
  onSelect,
  badges,
  aside,
  children,
}: {
  title: string;
  checked: boolean;
  /** Fires on selection, and on a click of the checked card (restores it after row edits). */
  onSelect: () => void;
  badges?: ReactNode;
  /** Shown at the right end of the title line. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const radioName = useContext(SetupChoiceNameContext);
  return (
    <label
      data-state={checked ? 'selected' : undefined}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-md border p-3',
        checked ? 'border-primary bg-selected' : 'border-border hover:bg-accent',
      )}
    >
      <input
        type="radio"
        name={radioName}
        className="mt-1"
        checked={checked}
        onChange={onSelect}
        onClick={() => checked && onSelect()}
      />
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {badges}
          {aside}
        </span>
        {children}
      </span>
    </label>
  );
}

/**
 * The template's selectable ready-made setups (presets), newest first, as radio cards. All of them
 * are listed in a block that scrolls by itself, so a long list does not scroll the page. `children`
 * are extra cards listed before the presets. `noPresetChoice` is the card shown in place of the
 * presets when none fits the selected providers.
 */
export function SetupPresetSection({
  children,
  noPresetChoice,
  showPresetSelection = true,
}: {
  children?: ReactNode;
  noPresetChoice?: ReactNode;
  showPresetSelection?: boolean;
}) {
  const { preview, state, handlers } = useSetupReview();
  const radioName = useId();
  const presets = useMemo(
    () => selectablePresetsNewestFirst(preview, state.selectedProviderNames),
    [preview, state.selectedProviderNames],
  );

  const providersByPreset = new Map(
    preview.presetProviderCoverage.map((c) => [c.presetName, c.referencedProviders]),
  );
  const suggested = presets[0]?.name;
  const noPresetCard = presets.length === 0 ? noPresetChoice : null;

  return (
    <ReviewSection title="Setup">
      {(children || noPresetCard || presets.length > 0) && (
        <SetupChoiceNameContext.Provider value={radioName}>
          <fieldset className="grid gap-2">
            <legend className="sr-only">Setup</legend>
            {children}
            {noPresetCard}
            {presets.length > 0 && (
              <div className={PRESET_LIST_CLASS}>
                {presets.map((preset) => {
                  const checked = showPresetSelection && state.agentPresetName === preset.name;
                  return (
                    <SetupChoiceCard
                      key={preset.name}
                      title={preset.name}
                      checked={checked}
                      onSelect={() => handlers.onApplyPreset(preset.name)}
                      badges={
                        <>
                          {preset.name === suggested && (
                            <Badge variant="secondary">Suggested</Badge>
                          )}
                          {checked && state.agentPresetModified && (
                            <Badge variant="outline" data-testid="wizard-setup-modified">
                              modified
                            </Badge>
                          )}
                        </>
                      }
                      aside={
                        <SetupProviderIcons providers={providersByPreset.get(preset.name) ?? []} />
                      }
                    >
                      {preset.description && (
                        <span className="block whitespace-pre-line text-xs text-muted-foreground">
                          {preset.description}
                        </span>
                      )}
                    </SetupChoiceCard>
                  );
                })}
              </div>
            )}
          </fieldset>
        </SetupChoiceNameContext.Provider>
      )}
      {presets.length === 0 && !noPresetCard && (
        <p className="text-sm text-muted-foreground">
          No ready-made setup fits the selected providers.
        </p>
      )}
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
        {groups.map((group) => (
          <RosterGroup key={group.key} title={group.title} description={group.description}>
            <ul className="divide-y">
              {group.agents.map((agent) => (
                <AgentSetupRow
                  key={agent.name}
                  agent={agent}
                  isLead={group.leadAgentName !== null && eqName(group.leadAgentName, agent.name)}
                />
              ))}
              {group.configurableTeam && <TeamSetupRows team={group.configurableTeam} />}
            </ul>
          </RosterGroup>
        ))}
      </div>
    </ReviewSection>
  );
}
