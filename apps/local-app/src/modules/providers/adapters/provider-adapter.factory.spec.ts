import { ProviderAdapterFactory } from './provider-adapter.factory';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';

describe('ProviderAdapterFactory', () => {
  let factory: ProviderAdapterFactory;

  beforeEach(() => {
    factory = new ProviderAdapterFactory();
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

    it('throws error for unsupported provider', () => {
      expect(() => factory.getAdapter('unknown')).toThrow(
        'Unsupported provider: unknown. Supported providers: claude, codex',
      );
    });

    it('throws error for empty provider name', () => {
      expect(() => factory.getAdapter('')).toThrow('Unsupported provider');
    });
  });

  describe('isSupported', () => {
    it('returns true for claude', () => {
      expect(factory.isSupported('claude')).toBe(true);
    });

    it('returns true for codex', () => {
      expect(factory.isSupported('codex')).toBe(true);
    });

    it('returns false for unsupported provider', () => {
      expect(factory.isSupported('unknown')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(factory.isSupported('')).toBe(false);
    });
  });

  describe('getSupportedProviders', () => {
    it('returns array of supported provider names', () => {
      const supported = factory.getSupportedProviders();
      expect(supported).toEqual(expect.arrayContaining(['claude', 'codex']));
      expect(supported).toHaveLength(2);
    });
  });
});
