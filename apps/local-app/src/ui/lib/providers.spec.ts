import {
  getProviderIconSvg,
  getProviderIconDataUri,
  hasProviderIcon,
  getProviderIconAltText,
  clearProviderIconCache,
} from './providers';

describe('providers', () => {
  beforeEach(() => {
    clearProviderIconCache();
  });

  describe('getProviderIconSvg', () => {
    it.each([
      { label: 'returns SVG for claude', provider: 'claude', brandColor: 'fill="#d97757"' },
      { label: 'returns SVG for openai', provider: 'openai', brandColor: 'fill="#10a37f"' },
      { label: 'returns SVG for opencode', provider: 'opencode', brandColor: 'fill="white"' },
      { label: 'returns SVG for agy', provider: 'agy', brandColor: 'fill="#3789F6"' },
    ] as const)('$label', ({ provider, brandColor }) => {
      const svg = getProviderIconSvg(provider);
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain(brandColor);
    });

    it.each([
      { alias: 'codex', canonical: 'openai' },
      { alias: 'antigravity', canonical: 'agy' },
    ] as const)('$alias shares the $canonical icon', ({ alias, canonical }) => {
      expect(getProviderIconSvg(alias)).toBe(getProviderIconSvg(canonical));
    });

    it('returns SVG for copilot', () => {
      const svg = getProviderIconSvg('copilot');
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain('fill="#8957e5"'); // Copilot brand purple
      expect(svg).toContain('fill-rule="evenodd"'); // spark knockout
    });

    it('returns null for unknown provider', () => {
      expect(getProviderIconSvg('unknown-provider')).toBeNull();
    });

    it('returns null for null/undefined', () => {
      expect(getProviderIconSvg(null)).toBeNull();
      expect(getProviderIconSvg(undefined)).toBeNull();
    });

    it('handles case-insensitive provider names', () => {
      expect(getProviderIconSvg('CLAUDE')).not.toBeNull();
      expect(getProviderIconSvg('Claude')).not.toBeNull();
      expect(getProviderIconSvg('OpenAI')).not.toBeNull();
      expect(getProviderIconSvg('Copilot')).not.toBeNull();
      expect(getProviderIconSvg('COPILOT')).not.toBeNull();
    });

    it('handles provider name variations', () => {
      expect(getProviderIconSvg('claude-3-opus')).not.toBeNull();
      expect(getProviderIconSvg('anthropic-claude')).not.toBeNull();
      expect(getProviderIconSvg('gpt-4')).not.toBeNull();
      expect(getProviderIconSvg('Antigravity CLI')).not.toBeNull();
      expect(getProviderIconSvg('antigravity-cli')).not.toBeNull();
    });

    it('returns null for retired gemini/google names', () => {
      expect(getProviderIconSvg('gemini')).toBeNull();
      expect(getProviderIconSvg('gemini-pro')).toBeNull();
      expect(getProviderIconSvg('google-gemini')).toBeNull();
      expect(getProviderIconSvg('google')).toBeNull();
    });
  });

  describe('getProviderIconDataUri', () => {
    it('returns valid data URI for claude', () => {
      const dataUri = getProviderIconDataUri('claude');
      expect(dataUri).not.toBeNull();
      expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it('returns null for unknown provider', () => {
      expect(getProviderIconDataUri('unknown')).toBeNull();
    });

    it('decoded data URI contains valid SVG', () => {
      const dataUri = getProviderIconDataUri('claude');
      expect(dataUri).not.toBeNull();
      const base64 = dataUri!.replace('data:image/svg+xml;base64,', '');
      const decoded = atob(base64);
      expect(decoded).toContain('<svg');
    });
  });

  describe('hasProviderIcon', () => {
    it('returns true for known providers', () => {
      expect(hasProviderIcon('claude')).toBe(true);
      expect(hasProviderIcon('openai')).toBe(true);
      expect(hasProviderIcon('codex')).toBe(true);
      expect(hasProviderIcon('opencode')).toBe(true);
      expect(hasProviderIcon('agy')).toBe(true);
      expect(hasProviderIcon('antigravity')).toBe(true);
      expect(hasProviderIcon('copilot')).toBe(true);
    });

    it('returns false for retired gemini/google names', () => {
      expect(hasProviderIcon('gemini')).toBe(false);
      expect(hasProviderIcon('google')).toBe(false);
    });

    it('returns false for unknown providers', () => {
      expect(hasProviderIcon('unknown')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(hasProviderIcon(null)).toBe(false);
      expect(hasProviderIcon(undefined)).toBe(false);
    });
  });

  describe('getProviderIconAltText', () => {
    it.each([
      {
        label: 'returns proper alt text for claude',
        provider: 'claude',
        expectedAlt: 'Claude icon',
      },
      {
        label: 'returns proper alt text for openai',
        provider: 'openai',
        expectedAlt: 'OpenAI icon',
      },
      {
        label: 'returns proper alt text for codex (normalized to openai)',
        provider: 'codex',
        expectedAlt: 'OpenAI icon',
      },
      {
        label: 'returns proper alt text for opencode',
        provider: 'opencode',
        expectedAlt: 'OpenCode icon',
      },
      {
        label: 'returns generic alt text for retired gemini name',
        provider: 'gemini',
        expectedAlt: 'gemini icon',
      },
      {
        label: 'returns proper alt text for agy',
        provider: 'agy',
        expectedAlt: 'Antigravity CLI icon',
      },
      {
        label: 'returns proper alt text for antigravity (normalized to agy)',
        provider: 'Antigravity CLI',
        expectedAlt: 'Antigravity CLI icon',
      },
      {
        label: 'returns proper alt text for copilot',
        provider: 'copilot',
        expectedAlt: 'Copilot CLI icon',
      },
      { label: 'returns fallback for unknown', provider: null, expectedAlt: 'AI provider icon' },
    ] as const)('$label', ({ provider, expectedAlt }) => {
      expect(getProviderIconAltText(provider)).toBe(expectedAlt);
    });
  });
});
