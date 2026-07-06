import { deriveFamilyProviderMappings, getUncoveredFamilies } from './providerSelection';
import type { SetupPreviewFamilyAlternative } from '@/ui/pages/projects/lib/project-api';

function family(
  over: Partial<SetupPreviewFamilyAlternative> & { familySlug: string },
): SetupPreviewFamilyAlternative {
  return {
    defaultProvider: 'claude',
    defaultProviderAvailable: true,
    availableProviders: ['claude'],
    hasAlternatives: false,
    ...over,
  };
}

describe('getUncoveredFamilies', () => {
  it('returns families with alternatives but none selected', () => {
    const alts = [
      family({
        familySlug: 'coder',
        defaultProvider: 'claude',
        availableProviders: ['claude', 'codex'],
      }),
    ];
    expect(getUncoveredFamilies(alts, ['openai'])).toEqual(['coder']);
    expect(getUncoveredFamilies(alts, ['codex'])).toEqual([]);
  });

  it('ignores families with no available providers (server-substituted)', () => {
    const alts = [family({ familySlug: 'orphan', availableProviders: [] })];
    expect(getUncoveredFamilies(alts, [])).toEqual([]);
  });
});

describe('deriveFamilyProviderMappings', () => {
  it('maps a family to the first selected alternative when its default is not selected', () => {
    const alts = [
      family({
        familySlug: 'coder',
        defaultProvider: 'claude',
        defaultProviderAvailable: false,
        availableProviders: ['codex', 'openai'],
        hasAlternatives: true,
      }),
    ];
    expect(deriveFamilyProviderMappings(alts, ['openai'])).toEqual({ coder: 'openai' });
    // First in availableProviders order that is selected wins.
    expect(deriveFamilyProviderMappings(alts, ['codex', 'openai'])).toEqual({ coder: 'codex' });
  });

  it('emits nothing when the default provider is selected', () => {
    const alts = [
      family({
        familySlug: 'coder',
        defaultProvider: 'claude',
        availableProviders: ['claude', 'codex'],
      }),
    ];
    expect(deriveFamilyProviderMappings(alts, ['claude', 'codex'])).toEqual({});
  });

  it('emits nothing when no alternative is selected', () => {
    const alts = [
      family({
        familySlug: 'coder',
        defaultProvider: 'claude',
        defaultProviderAvailable: false,
        availableProviders: ['codex'],
        hasAlternatives: true,
      }),
    ];
    expect(deriveFamilyProviderMappings(alts, ['openai'])).toEqual({});
  });

  it('lowercases slugs and provider names', () => {
    const alts = [
      family({
        familySlug: 'Coder',
        defaultProvider: 'Claude',
        defaultProviderAvailable: false,
        availableProviders: ['Codex'],
        hasAlternatives: true,
      }),
    ];
    expect(deriveFamilyProviderMappings(alts, ['CODEX'])).toEqual({ coder: 'codex' });
  });
});
