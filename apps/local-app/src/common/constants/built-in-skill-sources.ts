export const BUILT_IN_SKILL_SOURCE_NAMES = {
  anthropic: 'anthropic',
  devchain: 'devchain',
  microsoft: 'microsoft',
  openai: 'openai',
  trailofbits: 'trailofbits',
  vercel: 'vercel',
} as const;

/** Sources whose global switch, project switches and single skills are always on. */
export const ALWAYS_ENABLED_SKILL_SOURCE_NAMES: readonly string[] = [
  BUILT_IN_SKILL_SOURCE_NAMES.devchain,
];

export function isAlwaysEnabledSkillSource(name: string): boolean {
  return ALWAYS_ENABLED_SKILL_SOURCE_NAMES.includes(name.trim().toLowerCase());
}
