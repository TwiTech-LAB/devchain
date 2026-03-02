import { ProviderAdapterFactory } from './provider-adapter.factory';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { OpencodeAdapter } from './opencode.adapter';
import { UnsupportedProviderError } from '../../../common/errors/error-types';

describe('ProviderAdapterFactory', () => {
  let factory: ProviderAdapterFactory;
  let claudeAdapter: ClaudeAdapter;
  let codexAdapter: CodexAdapter;
  let geminiAdapter: GeminiAdapter;
  let opencodeAdapter: OpencodeAdapter;

  beforeEach(() => {
    claudeAdapter = new ClaudeAdapter();
    codexAdapter = new CodexAdapter();
    geminiAdapter = new GeminiAdapter();
    opencodeAdapter = new OpencodeAdapter();
    factory = new ProviderAdapterFactory(
      claudeAdapter,
      codexAdapter,
      geminiAdapter,
      opencodeAdapter,
    );
  });

  describe('getAdapter', () => {
    it('returns ClaudeAdapter for claude provider', () => {
      const adapter = factory.getAdapter('claude');
      expect(adapter).toBeInstanceOf(ClaudeAdapter);
      expect(adapter.providerName).toBe('claude');
    });

    it('returns CodexAdapter for codex provider', () => {
      const adapter = factory.getAdapter('codex');
      expect(adapter).toBeInstanceOf(CodexAdapter);
      expect(adapter.providerName).toBe('codex');
    });

    it('returns GeminiAdapter for gemini provider', () => {
      const adapter = factory.getAdapter('gemini');
      expect(adapter).toBeInstanceOf(GeminiAdapter);
      expect(adapter.providerName).toBe('gemini');
    });

    it('returns OpencodeAdapter for opencode provider', () => {
      const adapter = factory.getAdapter('opencode');
      expect(adapter).toBeInstanceOf(OpencodeAdapter);
      expect(adapter.providerName).toBe('opencode');
    });

    it('returns the exact injected adapter instances (DI)', () => {
      expect(factory.getAdapter('claude')).toBe(claudeAdapter);
      expect(factory.getAdapter('codex')).toBe(codexAdapter);
      expect(factory.getAdapter('gemini')).toBe(geminiAdapter);
      expect(factory.getAdapter('opencode')).toBe(opencodeAdapter);
    });

    it('normalizes provider name to lowercase (case-insensitive lookup)', () => {
      expect(factory.getAdapter('Claude')).toBe(claudeAdapter);
      expect(factory.getAdapter('CLAUDE')).toBe(claudeAdapter);
      expect(factory.getAdapter('Codex')).toBe(codexAdapter);
      expect(factory.getAdapter('GEMINI')).toBe(geminiAdapter);
      expect(factory.getAdapter('OpenCode')).toBe(opencodeAdapter);
      expect(factory.getAdapter('OPENCODE')).toBe(opencodeAdapter);
    });

    it('throws UnsupportedProviderError for unsupported provider', () => {
      expect(() => factory.getAdapter('unknown')).toThrow(UnsupportedProviderError);
      expect(() => factory.getAdapter('unknown')).toThrow(
        'Unsupported provider: unknown. Supported providers: claude, codex, gemini, opencode',
      );
    });

    it('throws UnsupportedProviderError with correct properties', () => {
      try {
        factory.getAdapter('unknown');
        fail('Expected UnsupportedProviderError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedProviderError);
        const unsupportedError = error as UnsupportedProviderError;
        expect(unsupportedError.providerName).toBe('unknown');
        expect(unsupportedError.statusCode).toBe(400);
        expect(unsupportedError.code).toBe('unsupported_provider');
        expect(unsupportedError.details).toEqual({
          providerName: 'unknown',
          supportedProviders: ['claude', 'codex', 'gemini', 'opencode'],
        });
      }
    });

    it('throws UnsupportedProviderError for empty provider name', () => {
      expect(() => factory.getAdapter('')).toThrow(UnsupportedProviderError);
    });
  });

  describe('isSupported', () => {
    it('returns true for claude', () => {
      expect(factory.isSupported('claude')).toBe(true);
    });

    it('returns true for codex', () => {
      expect(factory.isSupported('codex')).toBe(true);
    });

    it('returns true for gemini', () => {
      expect(factory.isSupported('gemini')).toBe(true);
    });

    it('returns true for opencode', () => {
      expect(factory.isSupported('opencode')).toBe(true);
    });

    it('returns false for unsupported provider', () => {
      expect(factory.isSupported('unknown')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(factory.isSupported('')).toBe(false);
    });

    it('normalizes provider name to lowercase (case-insensitive check)', () => {
      expect(factory.isSupported('Claude')).toBe(true);
      expect(factory.isSupported('CLAUDE')).toBe(true);
      expect(factory.isSupported('Codex')).toBe(true);
      expect(factory.isSupported('GEMINI')).toBe(true);
      expect(factory.isSupported('OpenCode')).toBe(true);
      expect(factory.isSupported('OPENCODE')).toBe(true);
    });
  });

  describe('getSupportedProviders', () => {
    it('returns array of supported provider names', () => {
      const supported = factory.getSupportedProviders();
      expect(supported).toEqual(expect.arrayContaining(['claude', 'codex', 'gemini', 'opencode']));
      expect(supported).toHaveLength(4);
    });
  });
});
