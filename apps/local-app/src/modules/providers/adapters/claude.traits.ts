import type { ProviderTraits } from '../provider-traits.types';

export const CLAUDE_TRAITS: ProviderTraits = Object.freeze({
  activity: 'hook-and-transcript',
  transcriptTurns: true,
  draftClearKeys: Object.freeze([]),
});
