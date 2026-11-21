/**
 * Display names for known providers. Provider names in templates are lowercase canonical ids, so a
 * small map avoids showing e.g. "agy" or "openai". Unknown providers fall back to title-casing.
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  codex: 'Codex',
  gpt: 'GPT',
  opencode: 'OpenCode',
  agy: 'Antigravity',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  devin: 'Devin',
};

export function providerDisplayName(name: string): string {
  const key = name.trim().toLowerCase();
  return PROVIDER_DISPLAY_NAMES[key] ?? (key ? key.charAt(0).toUpperCase() + key.slice(1) : key);
}

/** An option as the page shows it: the display name of its provider, then the option name. */
export function optionLabel(providerName: string, optionName: string): string {
  return `${providerDisplayName(providerName)} · ${optionName}`;
}

/** Display names of the given providers, deduplicated, in input order, joined for a sentence. */
export function providerDisplayList(names: Iterable<string>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const display = providerDisplayName(name);
    if (seen.has(display)) continue;
    seen.add(display);
    out.push(display);
  }
  return out.join(', ');
}
