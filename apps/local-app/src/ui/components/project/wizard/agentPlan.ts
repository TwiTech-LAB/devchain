import type {
  AgentOverridePayload,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';

/**
 * Pure state + emission logic for the wizard's agent plan. No React, no I/O — every
 * function here is a deterministic transform over the setup-preview payload + the user's edits, so
 * the delta-6 emission rules (below) are unit-testable in isolation from the component.
 *
 * ## Row model
 * Each template agent owns one {@link AgentRow}: its chosen provider config (by name) plus optional
 * model/effort OVERRIDES (config-independent — `null` means "inherit the config's structured
 * default"). We store the config NAME even when its provider is not selected, so the row never
 * silently re-picks a different config.
 *
 * ## Resolution
 * {@link resolveAgentRow} resolves a stored row against the provider lists:
 *  - a config chosen in the popover resolves when its provider is installed,
 *  - other named configs resolve when their provider is selected,
 *  - a pinned config that fails its provider check blocks the step,
 *  - an unpinned row can auto-pick the first config on a selected provider.
 *
 * ## Provider fallback
 * {@link applyProviderFallback} runs once when the rows are created, before any preset: a
 * template-named config on a provider outside the selection moves to the first config of the same
 * profile on a selected provider (the config the server binds in the same case) and drops the
 * template's model/effort overrides, which belong to the other provider. A config the user picks
 * later never falls back.
 *
 * ## Emission (delta 6)
 * {@link buildAgentOverrides} compares each resolved row to the template BASELINE (the same agent
 * resolved with NO user edits, under the current selection):
 *  - untouched / edited-back-to-baseline rows emit NO entry,
 *  - a model/effort override equal to the selected config's structured default is NOT an override
 *    (collapsed away),
 *  - clearing an override the template carried emits an explicit `null` (backend: `null` = clear),
 *  - leaving an override unchanged emits nothing for that field (`undefined` = preserve).
 */

type ExportData = SetupPreviewResponse['payload'];
export type TemplateAgent = NonNullable<ExportData['agents']>[number];
export type TemplateProfile = NonNullable<ExportData['profiles']>[number];
export type TemplateTeam = NonNullable<ExportData['teams']>[number];
export type TemplateProviderConfig = NonNullable<TemplateProfile['providerConfigs']>[number];

/** Case-insensitive, whitespace-trimmed equality for provider/config/agent names. */
export function eqName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Stable lowercase key for the per-agent row map. */
export function agentKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * A single agent's editable configuration. `pinned` prevents automatic selection of another
 * config during resolution. `modelOverride`/`effortOverride` inherit the config default when null.
 */
export interface AgentRow {
  agentName: string;
  profileId?: string;
  configName: string | null;
  pinned: boolean;
  /** Allows a popover choice to use any installed provider. */
  userSelectedOption?: boolean;
  modelOverride: string | null;
  effortOverride: string | null;
  /** Set when the provider fallback replaced the template-named config: that config's name. */
  fallbackFromConfigName?: string;
}

/** A row resolved against the applicable provider list. */
export interface ResolvedAgentRow {
  agentName: string;
  /** The config actually in effect (null when unresolved). */
  resolvedConfigName: string | null;
  /** True when no config could be resolved (blocks the step). */
  unresolved: boolean;
}

export type AgentGroupKind = 'team' | 'independent';

/** A display grouping: a team (lead first, then members) or the catch-all independent bucket. */
export interface AgentGroup {
  kind: AgentGroupKind;
  /** Team name (absent for the independent bucket). */
  teamName?: string;
  /** The lead agent's name when this group is a team and the lead is a real agent. */
  leadAgentName: string | null;
  /** Agent names in display order — lead first for teams. */
  agentNames: string[];
}

/** Build the per-agent row map from the template (keyed by {@link agentKey}). */
export function initialAgentRows(agents: TemplateAgent[]): Record<string, AgentRow> {
  const rows: Record<string, AgentRow> = {};
  for (const agent of agents) {
    const named = agent.providerConfigName?.trim() || null;
    rows[agentKey(agent.name)] = {
      agentName: agent.name,
      profileId: agent.profileId,
      configName: named,
      pinned: Boolean(named),
      modelOverride: agent.modelOverride ?? null,
      effortOverride: agent.effortOverride ?? null,
    };
  }
  return rows;
}

/**
 * Group agents by team for display: teams in template order (lead first, then members), then every
 * remaining agent under a single "independent" bucket. Each agent appears exactly once — assigned to
 * the FIRST team that references it (as lead or member). Only names that map to real agents are kept.
 */
export function buildAgentGroups(agents: TemplateAgent[], teams: TemplateTeam[]): AgentGroup[] {
  const agentNames = new Set(agents.map((a) => agentKey(a.name)));
  const canonical = new Map(agents.map((a) => [agentKey(a.name), a.name]));
  const claimed = new Set<string>();
  const groups: AgentGroup[] = [];

  for (const team of teams) {
    const lead = team.teamLeadAgentName?.trim() || null;
    const leadKey = lead ? agentKey(lead) : null;
    const ordered: string[] = [];
    const pushUnique = (name: string | null) => {
      if (!name) return;
      const key = agentKey(name);
      if (!agentNames.has(key) || claimed.has(key) || ordered.some((n) => agentKey(n) === key)) {
        return;
      }
      ordered.push(canonical.get(key) ?? name);
    };

    pushUnique(lead);
    for (const member of team.memberAgentNames ?? []) pushUnique(member);
    ordered.forEach((n) => claimed.add(agentKey(n)));

    if (ordered.length > 0) {
      groups.push({
        kind: 'team',
        teamName: team.name,
        leadAgentName: leadKey && agentNames.has(leadKey) ? (canonical.get(leadKey) ?? lead) : null,
        agentNames: ordered,
      });
    }
  }

  const independent = agents.map((a) => a.name).filter((name) => !claimed.has(agentKey(name)));
  if (independent.length > 0) {
    groups.push({ kind: 'independent', leadAgentName: null, agentNames: independent });
  }
  return groups;
}

/** The profile an agent belongs to (matched by `profileId`). */
export function profileForAgent(
  agent: TemplateAgent,
  profiles: TemplateProfile[],
): TemplateProfile | undefined {
  if (!agent.profileId) return undefined;
  return profiles.find((p) => p.id === agent.profileId);
}

/** All provider configs declared on a profile (empty when none). */
export function configsForProfile(profile: TemplateProfile | undefined): TemplateProviderConfig[] {
  return profile?.providerConfigs ?? [];
}

/** Configs whose provider is in the given list. */
export function availableConfigs(
  profile: TemplateProfile | undefined,
  providerNames: string[],
): TemplateProviderConfig[] {
  const providers = new Set(providerNames.map((n) => n.trim().toLowerCase()));
  return configsForProfile(profile).filter((c) =>
    providers.has(c.providerName.trim().toLowerCase()),
  );
}

/** Look up a config by name within a profile (case-insensitive). */
export function findConfig(
  profile: TemplateProfile | undefined,
  configName: string | null,
): TemplateProviderConfig | undefined {
  if (!configName) return undefined;
  return configsForProfile(profile).find((c) => eqName(c.name, configName));
}

/** Lowercased provider of a named config in a profile (undefined when the name does not resolve). */
export function configProviderName(
  profile: TemplateProfile | undefined,
  configName: string | null,
): string | undefined {
  return findConfig(profile, configName)?.providerName.trim().toLowerCase();
}

/** The first config of a profile, in template order, whose provider is in `providerNames`. */
function firstConfigOnProviders(
  profile: TemplateProfile | undefined,
  providerNames: ReadonlySet<string>,
): TemplateProviderConfig | undefined {
  return configsForProfile(profile).find((c) =>
    providerNames.has(c.providerName.trim().toLowerCase()),
  );
}

/**
 * Move each row whose template-named config is on a provider outside `providerNames` to the first
 * config of its profile on one of those providers (see the module doc). Rows with no such config
 * stay as they are and resolve as unresolved. Returns a NEW map.
 */
export function applyProviderFallback(
  rows: Record<string, AgentRow>,
  agents: TemplateAgent[],
  profiles: TemplateProfile[],
  providerNames: string[],
): Record<string, AgentRow> {
  const providers = new Set(providerNames.map((n) => n.trim().toLowerCase()));
  const next: Record<string, AgentRow> = { ...rows };
  for (const agent of agents) {
    const key = agentKey(agent.name);
    const row = next[key];
    if (!row?.configName) continue;
    const profile = profileForAgent(agent, profiles);
    const named = findConfig(profile, row.configName);
    if (!named || providers.has(named.providerName.trim().toLowerCase())) continue;
    const fallback = firstConfigOnProviders(profile, providers);
    if (!fallback) continue;
    next[key] = {
      ...row,
      configName: fallback.name,
      pinned: true,
      modelOverride: null,
      effortOverride: null,
      fallbackFromConfigName: named.name,
    };
  }
  return next;
}

/** The row without its provider-fallback mark. */
export function withoutProviderFallback(row: AgentRow): AgentRow {
  const { fallbackFromConfigName: _replaced, ...rest } = row;
  return rest;
}

/** The template's agent rows for `providerNames`: the template rows with the fallback applied. */
export function templateAgentRows(
  payload: ExportData,
  providerNames: string[],
): Record<string, AgentRow> {
  const agents = payload.agents ?? [];
  return applyProviderFallback(
    initialAgentRows(agents),
    agents,
    payload.profiles ?? [],
    providerNames,
  );
}

/**
 * True when a row still carries a provider fallback. Applying a preset clears the mark on the
 * agents it names, so after a preset any remaining mark belongs to an agent outside that preset.
 */
export function hasProviderFallback(rows: Record<string, AgentRow>): boolean {
  return Object.values(rows).some((row) => row.fallbackFromConfigName !== undefined);
}

/** Names of the template agents whose profile has no config on any of `installedProviderNames`. */
export function agentsThatCannotRun(
  payload: ExportData,
  installedProviderNames: string[],
): string[] {
  const installed = new Set(installedProviderNames.map((n) => n.trim().toLowerCase()));
  const profiles = payload.profiles ?? [];
  return (payload.agents ?? [])
    .filter((agent) => !firstConfigOnProviders(profileForAgent(agent, profiles), installed))
    .map((agent) => agent.name);
}

/**
 * Resolve a stored row (see the module doc). `installedProviderNames` applies only to a row with
 * `userSelectedOption`. Never mutates the row.
 */
export function resolveAgentRow(
  row: AgentRow,
  profile: TemplateProfile | undefined,
  selectedProviderNames: string[],
  installedProviderNames: string[],
): ResolvedAgentRow {
  if (row.configName) {
    const named = findConfig(profile, row.configName);
    const allowedProviders = row.userSelectedOption
      ? installedProviderNames
      : selectedProviderNames;
    if (named && allowedProviders.some((provider) => eqName(provider, named.providerName))) {
      return { agentName: row.agentName, resolvedConfigName: named.name, unresolved: false };
    }
    if (row.pinned) {
      return { agentName: row.agentName, resolvedConfigName: null, unresolved: true };
    }
  }

  const first = availableConfigs(profile, selectedProviderNames)[0];
  return {
    agentName: row.agentName,
    resolvedConfigName: first?.name ?? null,
    unresolved: !first,
  };
}

/** Names of presets whose every referenced provider is currently selected (case-insensitive). */
export function selectablePresetNames(
  coverage: SetupPreviewResponse['presetProviderCoverage'],
  selectedProviderNames: string[],
): Set<string> {
  const selected = new Set(selectedProviderNames.map((n) => n.trim().toLowerCase()));
  const names = new Set<string>();
  for (const entry of coverage) {
    if (entry.referencedProviders.every((p) => selected.has(p.trim().toLowerCase()))) {
      names.add(entry.presetName);
    }
  }
  return names;
}

/**
 * The selectable presets, newest first. Storage order represents update time (newest appended
 * last) — the same convention the Agents page's PresetSelector sorts by. The first entry is the
 * default preset that the wizard applies on open.
 */
export function selectablePresetsNewestFirst(
  preview: Pick<SetupPreviewResponse, 'payload' | 'presetProviderCoverage'>,
  selectedProviderNames: string[],
): NonNullable<ExportData['presets']> {
  const selectable = selectablePresetNames(preview.presetProviderCoverage, selectedProviderNames);
  return [...(preview.payload.presets ?? [])].reverse().filter((p) => selectable.has(p.name));
}

/**
 * Apply a preset to the row map: for every agent the preset names, pin its config and set its
 * model/effort overrides verbatim from the preset. Agents the preset does not mention keep their
 * current rows. Returns a NEW map (the input is not mutated).
 */
export function applyPresetToRows(
  rows: Record<string, AgentRow>,
  preset: NonNullable<ExportData['presets']>[number],
): Record<string, AgentRow> {
  const next: Record<string, AgentRow> = { ...rows };
  for (const config of preset.agentConfigs) {
    const key = agentKey(config.agentName);
    const existing = next[key];
    if (!existing) continue;
    next[key] = {
      ...withoutProviderFallback(existing),
      configName: config.providerConfigName,
      pinned: true,
      modelOverride: config.modelOverride ?? null,
      effortOverride: config.effortOverride ?? null,
    };
  }
  return next;
}

/**
 * Delta-6 override payload for one field (model or effort).
 *  - an override equal to the selected config's structured default is collapsed to "no override",
 *  - unchanged vs. the template → `undefined` (omit the field; backend preserves),
 *  - cleared (template had one, now none) → `null` (backend clears),
 *  - otherwise → the new override value.
 */
export function computeOverridePayload(
  rowOverride: string | null,
  templateOverride: string | null | undefined,
  configDefault: string | null | undefined,
): string | null | undefined {
  const collapse = (value: string | null): string | null =>
    value !== null && configDefault != null && eqName(value, configDefault) ? null : value;

  const row = collapse(rowOverride);
  const template = collapse(templateOverride ?? null);

  if (row === template) return undefined;
  if (row === null) return null;
  return row;
}

export interface AgentOverridesResult {
  /** Emit-worthy overrides (untouched/back-to-baseline agents omitted). */
  overrides: AgentOverridePayload[];
  /** Agent names with no resolvable config (blocks the step). */
  unresolvedAgents: string[];
}

/**
 * Build the delta-6 `agentOverrides` array + the unresolved-agent list. Each agent's resolved row is
 * compared to its template baseline (same agent, no user edits, current selection); only genuinely
 * changed rows produce an entry, and the entry carries the minimal model/effort payload.
 */
export function buildAgentOverrides(
  rows: Record<string, AgentRow>,
  agents: TemplateAgent[],
  profiles: TemplateProfile[],
  selectedProviderNames: string[],
  installedProviderNames: string[],
): AgentOverridesResult {
  const overrides: AgentOverridePayload[] = [];
  const unresolvedAgents: string[] = [];

  for (const agent of agents) {
    const key = agentKey(agent.name);
    const row = rows[key];
    if (!row) continue;
    const profile = profileForAgent(agent, profiles);

    const current = resolveAgentRow(row, profile, selectedProviderNames, installedProviderNames);
    if (current.unresolved || current.resolvedConfigName === null) {
      unresolvedAgents.push(agent.name);
      continue;
    }

    const baseline = resolveAgentRow(
      initialRowForAgent(agent),
      profile,
      selectedProviderNames,
      installedProviderNames,
    );
    const config = findConfig(profile, current.resolvedConfigName);
    const modelPayload = computeOverridePayload(
      row.modelOverride,
      agent.modelOverride,
      config?.model ?? null,
    );
    const effortPayload = computeOverridePayload(
      row.effortOverride,
      agent.effortOverride,
      config?.effort ?? null,
    );
    const configChanged = !eqName(current.resolvedConfigName, baseline.resolvedConfigName);

    if (!configChanged && modelPayload === undefined && effortPayload === undefined) {
      continue;
    }

    const entry: AgentOverridePayload = {
      agentName: agent.name,
      providerConfigName: current.resolvedConfigName,
    };
    if (modelPayload !== undefined) entry.modelOverride = modelPayload;
    if (effortPayload !== undefined) entry.effortOverride = effortPayload;
    overrides.push(entry);
  }

  return { overrides, unresolvedAgents };
}

/** The template baseline row for a single agent (no user edits). */
function initialRowForAgent(agent: TemplateAgent): AgentRow {
  const named = agent.providerConfigName?.trim() || null;
  return {
    agentName: agent.name,
    profileId: agent.profileId,
    configName: named,
    pinned: Boolean(named),
    modelOverride: agent.modelOverride ?? null,
    effortOverride: agent.effortOverride ?? null,
  };
}

export type AgentPlanEmission =
  | { presetName: string }
  | { agentOverrides: AgentOverridePayload[] }
  | Record<string, never>;

/**
 * The agent-plan contribution to the create payload (presetName XOR agentOverrides, never both):
 *  - an unmodified, still-selectable preset → `{ presetName }`,
 *  - otherwise → `{ agentOverrides }` (omitted entirely when nothing changed).
 *
 * A preset that does not name an agent with a provider fallback goes out as `agentOverrides` for
 * all rows: `presetName` alone would leave that agent's template model override in place.
 */
export function buildAgentPlanEmission(params: {
  rows: Record<string, AgentRow>;
  agents: TemplateAgent[];
  profiles: TemplateProfile[];
  selectedProviderNames: string[];
  installedProviderNames: string[];
  presetName: string | null;
  presetModified: boolean;
  selectablePresets: Set<string>;
}): AgentPlanEmission {
  const { presetName, presetModified, selectablePresets } = params;

  if (
    presetName &&
    !presetModified &&
    selectablePresets.has(presetName) &&
    !hasProviderFallback(params.rows)
  ) {
    return { presetName };
  }

  const { overrides } = buildAgentOverrides(
    params.rows,
    params.agents,
    params.profiles,
    params.selectedProviderNames,
    params.installedProviderNames,
  );
  if (overrides.length === 0) return {};
  return { agentOverrides: overrides };
}
