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
    it('returns SVG for claude', () => {
      const svg = getProviderIconSvg('claude');
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain('fill="#d97757"'); // Claude brand color
    });

    it('returns SVG for openai', () => {
      const svg = getProviderIconSvg('openai');
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain('fill="#10a37f"'); // OpenAI brand green
    });

    it('returns OpenAI SVG for codex', () => {
      const codexSvg = getProviderIconSvg('codex');
      const openaiSvg = getProviderIconSvg('openai');
      expect(codexSvg).toBe(openaiSvg);
    });

    it('returns SVG for opencode', () => {
      const svg = getProviderIconSvg('opencode');
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain('fill="white"');
    });

    it('returns SVG for agy', () => {
      const svg = getProviderIconSvg('agy');
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain('fill="#3789F6"'); // Antigravity brand blue
    });

    it('returns SVG for copilot', () => {
      const svg = getProviderIconSvg('copilot');
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain('fill="#8957e5"'); // Copilot brand purple
      expect(svg).toContain('fill-rule="evenodd"'); // spark knockout
    });

    it('returns Antigravity SVG for antigravity alias', () => {
      const aliasSvg = getProviderIconSvg('antigravity');
      const agySvg = getProviderIconSvg('agy');
      expect(aliasSvg).toBe(agySvg);
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

    it('returns valid data URI for openai', () => {
      const dataUri = getProviderIconDataUri('openai');
      expect(dataUri).not.toBeNull();
      expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it('returns valid data URI for copilot', () => {
      const dataUri = getProviderIconDataUri('copilot');
      expect(dataUri).not.toBeNull();
      expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it('returns null for unknown provider', () => {
      expect(getProviderIconDataUri('unknown')).toBeNull();
    });

    it('caches data URIs', () => {
      const first = getProviderIconDataUri('claude');
      const second = getProviderIconDataUri('claude');
      expect(first).toBe(second);
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
    it('returns proper alt text for claude', () => {
      expect(getProviderIconAltText('claude')).toBe('Claude icon');
    });

    it('returns proper alt text for openai', () => {
      expect(getProviderIconAltText('openai')).toBe('OpenAI icon');
    });

    it('returns proper alt text for codex (normalized to openai)', () => {
      // codex normalizes to openai
      expect(getProviderIconAltText('codex')).toBe('OpenAI icon');
    });

    it('returns proper alt text for opencode', () => {
      expect(getProviderIconAltText('opencode')).toBe('OpenCode icon');
    });

    it('returns generic alt text for retired gemini name', () => {
      expect(getProviderIconAltText('gemini')).toBe('gemini icon');
    });

    it('returns proper alt text for agy', () => {
      expect(getProviderIconAltText('agy')).toBe('Antigravity CLI icon');
    });

    it('returns proper alt text for antigravity (normalized to agy)', () => {
      expect(getProviderIconAltText('Antigravity CLI')).toBe('Antigravity CLI icon');
    });

    it('returns proper alt text for copilot', () => {
      expect(getProviderIconAltText('copilot')).toBe('Copilot CLI icon');
    });

    it('returns fallback for unknown', () => {
      expect(getProviderIconAltText(null)).toBe('AI provider icon');
    });
  });
});
