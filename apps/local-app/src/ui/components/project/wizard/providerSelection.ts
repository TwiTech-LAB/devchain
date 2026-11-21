import type { ExportData } from '@devchain/shared';
import type {
  SetupPreviewFamilyAlternative,
  SetupPreviewResponse,
} from '@/ui/pages/projects/lib/project-contracts';
import {
  agentsThatCannotRun,
  availableConfigs,
  configProviderName,
  profileForAgent,
  type TemplateAgent,
  type TemplateProfile,
} from './agentPlan';

const normalize = (name: string): string => name.trim().toLowerCase();

/**
 * Lowercased names of the locally installed providers. Read from `localAvailability`, never from
 * `providerSummary`: the summary omits a config provider of a profile without a `familySlug`.
 */
export function installedProviderNames(preview: SetupPreviewResponse): string[] {
  return [...new Set(preview.localAvailability.installedProviders.map((p) => normalize(p.name)))];
}

/** Lowercased names of every provider the template payload references (profile defaults + configs). */
export function referencedProviderNames(payload: SetupPreviewResponse['payload']): Set<string> {
  const referenced = new Set<string>();
  for (const profile of payload.profiles ?? []) {
    if (profile.provider?.name) referenced.add(normalize(profile.provider.name));
    for (const config of profile.providerConfigs ?? []) {
      referenced.add(normalize(config.providerName));
    }
  }
  return referenced;
}

/** Every installed provider the template references, sorted. */
export function installedReferencedProviders(preview: SetupPreviewResponse): string[] {
  const referenced = referencedProviderNames(preview.payload);
  return installedProviderNames(preview)
    .filter((name) => referenced.has(name))
    .sort();
}

export interface SetupProvider {
  name: string;
  installed: boolean;
}

/** Lowercased provider of the option that an agent names (undefined when it names none). */
function namedOptionProvider(agent: TemplateAgent, profiles: TemplateProfile[]) {
  return configProviderName(profileForAgent(agent, profiles), agent.providerConfigName ?? null);
}

export function setupProviderList(
  preview: SetupPreviewResponse,
  currentExport?: ExportData | null,
): SetupProvider[] {
  const { payload, presetProviderCoverage } = preview;
  const agents = payload.agents ?? [];
  const profiles = payload.profiles ?? [];
  const installedNames = installedProviderNames(preview);
  const installed = new Set(installedNames);
  const listed = new Set(
    presetProviderCoverage.flatMap((setup) => setup.referencedProviders.map(normalize)),
  );

  for (const agent of agents) {
    const provider = namedOptionProvider(agent, profiles);
    if (provider) listed.add(provider);
  }

  if (![...listed].some((name) => installed.has(name))) {
    for (const name of installedReferencedProviders(preview)) listed.add(name);
  }

  const installedListed = [...listed].filter((name) => installed.has(name));
  const uncoveredAgents = new Set(agentsThatCannotRun(payload, installedListed));
  for (const agent of agents) {
    if (!uncoveredAgents.has(agent.name)) continue;
    for (const config of availableConfigs(profileForAgent(agent, profiles), installedNames)) {
      listed.add(normalize(config.providerName));
    }
  }

  if (currentExport) {
    const referenced = referencedProviderNames(payload);
    for (const agent of currentExport.agents ?? []) {
      const provider = namedOptionProvider(agent, currentExport.profiles ?? []);
      if (provider && referenced.has(provider)) listed.add(provider);
    }
  }

  return [...listed].sort().map((name) => ({ name, installed: installed.has(name) }));
}

export function defaultSelectedProviders(list: ReadonlyArray<SetupProvider>): string[] {
  return list.filter(({ installed }) => installed).map(({ name }) => name);
}

/**
 * Derive the `familyProviderMappings` from the selected providers — this replaces the legacy
 * ProviderMappingModal (family → available-provider mapping) with no separate UI.
 *
 * For every family whose template DEFAULT provider is not in the selection but which HAS a selected
 * available alternative, we map the family slug to the first such alternative (in
 * `availableProviders` order). Families already covered by their default need no mapping; families
 * with no selected alternative are left unmapped (a pre-existing server-substituted case).
 *
 * Keys/values are lowercased canonical (the backend lowercases both on receipt).
 */
export function deriveFamilyProviderMappings(
  familyAlternatives: ReadonlyArray<SetupPreviewFamilyAlternative>,
  selectedProviderNames: ReadonlyArray<string>,
): Record<string, string> {
  const selected = new Set(selectedProviderNames.map((name) => name.trim().toLowerCase()));
  const mappings: Record<string, string> = {};
  for (const family of familyAlternatives) {
    const defaultSelected = selected.has(family.defaultProvider.trim().toLowerCase());
    if (defaultSelected) continue;
    const substitute = family.availableProviders.find((provider) =>
      selected.has(provider.trim().toLowerCase()),
    );
    if (substitute) {
      mappings[family.familySlug.trim().toLowerCase()] = substitute.trim().toLowerCase();
    }
  }
  return mappings;
}
