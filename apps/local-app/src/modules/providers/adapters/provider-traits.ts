import { CLAUDE_TRAITS } from './claude.traits';
import { CODEX_TRAITS } from './codex.traits';
import { COPILOT_TRAITS } from './copilot.traits';
import { OPENCODE_TRAITS } from './opencode.traits';
import { ANTIGRAVITY_TRAITS } from './antigravity.traits';
import type { ProviderTraits } from '../provider-traits.types';

export const PROVIDER_TRAITS = Object.freeze({
  claude: CLAUDE_TRAITS,
  codex: CODEX_TRAITS,
  copilot: COPILOT_TRAITS,
  opencode: OPENCODE_TRAITS,
  agy: ANTIGRAVITY_TRAITS,
});

const DEFAULT_TRAITS: ProviderTraits = Object.freeze({
  activity: 'output',
  transcriptTurns: false,
  draftClearKeys: Object.freeze([]),
});

export function providerTraits(providerName: string | null | undefined): ProviderTraits {
  const name = providerName?.toLowerCase();
  return name && Object.hasOwn(PROVIDER_TRAITS, name)
    ? PROVIDER_TRAITS[name as keyof typeof PROVIDER_TRAITS]
    : DEFAULT_TRAITS;
}
