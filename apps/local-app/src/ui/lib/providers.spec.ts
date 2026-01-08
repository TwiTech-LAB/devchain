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

    it('returns SVG for gemini', () => {
      const svg = getProviderIconSvg('gemini');
      expect(svg).not.toBeNull();
      expect(svg).toContain('<svg');
      expect(svg).toContain('fill="#4285F4"'); // Google brand color
    });

    it('returns Gemini SVG for google', () => {
      const googleSvg = getProviderIconSvg('google');
      const geminiSvg = getProviderIconSvg('gemini');
      expect(googleSvg).toBe(geminiSvg);
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
    });

    it('handles provider name variations', () => {
      expect(getProviderIconSvg('claude-3-opus')).not.toBeNull();
      expect(getProviderIconSvg('anthropic-claude')).not.toBeNull();
      expect(getProviderIconSvg('gpt-4')).not.toBeNull();
      expect(getProviderIconSvg('gemini-pro')).not.toBeNull();
      expect(getProviderIconSvg('google-gemini')).not.toBeNull();
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
      expect(hasProviderIcon('gemini')).toBe(true);
      expect(hasProviderIcon('google')).toBe(true);
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

    it('returns proper alt text for gemini', () => {
      expect(getProviderIconAltText('gemini')).toBe('Google Gemini icon');
    });

    it('returns proper alt text for google (normalized to gemini)', () => {
      expect(getProviderIconAltText('google-ai')).toBe('Google Gemini icon');
    });

    it('returns fallback for unknown', () => {
      expect(getProviderIconAltText(null)).toBe('AI provider icon');
    });
  });
});
