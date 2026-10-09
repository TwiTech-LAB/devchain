import type { ProviderTraits } from '../provider-traits.types';

export const CODEX_TRAITS: ProviderTraits = Object.freeze({
  activity: 'transcript',
  transcriptTurns: true,
  draftClearKeys: Object.freeze(['C-c']),
});
