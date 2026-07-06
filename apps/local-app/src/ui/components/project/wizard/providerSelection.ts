import type { SetupPreviewFamilyAlternative } from '@/ui/pages/projects/lib/project-api';

/**
 * Family-coverage gate for wizard Step 1 (provider selection). Returns the family slugs that LOSE
 * coverage under the current selection — families that have at least one locally-available provider
 * (per the setup-preview's `familyAlternatives[].availableProviders`) but none of them is selected.
 *
 * The UI MUST NOT reimplement `computeFamilyAlternatives`; this is a pure set-intersection over the
 * server-provided alternatives (the single derivation lives on the backend, surfaced via setup-preview).
 *
 * Families with NO available providers (`availableProviders.length === 0`, i.e. `hasAlternatives ===
 * false`) are intentionally NOT returned: they cannot be covered by any selection and represent a
 * pre-existing template condition handled by provider substitution server-side, not a Step-1
 * violation the user can resolve here.
 *
 * Provider-name matching is case-insensitive — names are lowercased canonical on both sides, but we
 * normalize defensively so mixed-case selections (e.g. 'CLAUDE') still match.
 */
export function getUncoveredFamilies(
  familyAlternatives: ReadonlyArray<SetupPreviewFamilyAlternative>,
  selectedProviderNames: ReadonlyArray<string>,
): string[] {
  const selected = new Set(selectedProviderNames.map((name) => name.trim().toLowerCase()));
  return familyAlternatives
    .filter(
      (family) =>
        family.availableProviders.length > 0 &&
        !family.availableProviders.some((provider) => selected.has(provider.trim().toLowerCase())),
    )
    .map((family) => family.familySlug);
}

/**
 * Derive the import `familyProviderMappings` from the Step-1 provider selection — this is how the
 * wizard's Step 1 ABSORBS the legacy ProviderMappingModal (family → available-provider mapping) with
 * no separate UI: the user's provider choices ARE the mapping.
 *
 * For every family whose template DEFAULT provider is not in the selection (unavailable or
 * deselected) but which HAS a selected available alternative, we map the family slug to the first
 * such alternative (in `availableProviders` order). Families already covered by their default need no
 * mapping; families with no selected alternative are left unmapped (the coverage gate blocks Next for
 * those that have alternatives, and families with none are a pre-existing server-substituted case).
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
