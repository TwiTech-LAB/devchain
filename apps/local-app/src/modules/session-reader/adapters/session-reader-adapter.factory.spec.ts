import { SessionReaderAdapterFactory } from './session-reader-adapter.factory';
import type { SessionReaderAdapter } from './session-reader-adapter.interface';

function makeMockAdapter(name: string, roots?: string[]): SessionReaderAdapter {
  return {
    providerName: name,
    incrementalMode: name === 'gemini' ? 'snapshot' : 'delta',
    allowedRoots: roots ?? [`/home/user/.${name}/`],
    discoverSessionFile: jest.fn(),
    parseSessionFile: jest.fn(),
    parseIncremental: jest.fn(),
    getWatchPaths: jest.fn(),
    calculateCost: jest.fn(),
    parseFullSession: jest.fn(),
  };
}

describe('SessionReaderAdapterFactory', () => {
  let factory: SessionReaderAdapterFactory;

  beforeEach(() => {
    factory = new SessionReaderAdapterFactory();
  });

  describe('registerAdapter', () => {
    it('should register an adapter by provider name', () => {
      const adapter = makeMockAdapter('claude');
      factory.registerAdapter(adapter);

      expect(factory.isSupported('claude')).toBe(true);
    });

    it('should register multiple adapters', () => {
      factory.registerAdapter(makeMockAdapter('claude'));
      factory.registerAdapter(makeMockAdapter('codex'));

      expect(factory.isSupported('claude')).toBe(true);
      expect(factory.isSupported('codex')).toBe(true);
    });

    it('should register all three provider adapters', () => {
      factory.registerAdapter(makeMockAdapter('claude'));
      factory.registerAdapter(makeMockAdapter('codex'));
      factory.registerAdapter(makeMockAdapter('gemini'));

      expect(factory.getSupportedProviders()).toHaveLength(3);
      expect(factory.isSupported('claude')).toBe(true);
      expect(factory.isSupported('codex')).toBe(true);
      expect(factory.isSupported('gemini')).toBe(true);
    });

    it('should overwrite existing adapter for same provider', () => {
      const adapter1 = makeMockAdapter('claude');
      const adapter2 = makeMockAdapter('claude');
      factory.registerAdapter(adapter1);
      factory.registerAdapter(adapter2);

      expect(factory.getAdapter('claude')).toBe(adapter2);
    });
  });

  describe('getAdapter', () => {
    it('should return registered adapter by name', () => {
      const adapter = makeMockAdapter('claude');
      factory.registerAdapter(adapter);

      expect(factory.getAdapter('claude')).toBe(adapter);
    });

    it('should return undefined for unregistered provider', () => {
      expect(factory.getAdapter('nonexistent')).toBeUndefined();
    });

    it('should be case-insensitive', () => {
      const adapter = makeMockAdapter('Claude');
      factory.registerAdapter(adapter);

      expect(factory.getAdapter('claude')).toBe(adapter);
      expect(factory.getAdapter('CLAUDE')).toBe(adapter);
      expect(factory.getAdapter('Claude')).toBe(adapter);
    });
  });

  describe('getAdapterForPath', () => {
    it('should match adapter by file path prefix', () => {
      const claude = makeMockAdapter('claude', ['/home/user/.claude/projects/']);
      const codex = makeMockAdapter('codex', ['/home/user/.codex/sessions/']);
      const gemini = makeMockAdapter('gemini', ['/home/user/.gemini/tmp/']);
      factory.registerAdapter(claude);
      factory.registerAdapter(codex);
      factory.registerAdapter(gemini);

      expect(factory.getAdapterForPath('/home/user/.claude/projects/abc/session.jsonl')).toBe(
        claude,
      );
      expect(factory.getAdapterForPath('/home/user/.codex/sessions/2026/01/01/rollout.jsonl')).toBe(
        codex,
      );
      expect(
        factory.getAdapterForPath('/home/user/.gemini/tmp/my-project/chats/session.json'),
      ).toBe(gemini);
    });

    it('should return undefined when no adapter matches path', () => {
      factory.registerAdapter(makeMockAdapter('claude', ['/home/user/.claude/projects/']));

      expect(factory.getAdapterForPath('/home/user/.unknown/file.json')).toBeUndefined();
    });

    it('should return undefined when no adapters are registered', () => {
      expect(factory.getAdapterForPath('/any/path')).toBeUndefined();
    });

    it('should match adapter with multiple allowed roots', () => {
      const adapter = makeMockAdapter('multi', ['/root/a/', '/root/b/']);
      factory.registerAdapter(adapter);

      expect(factory.getAdapterForPath('/root/a/file.json')).toBe(adapter);
      expect(factory.getAdapterForPath('/root/b/file.json')).toBe(adapter);
      expect(factory.getAdapterForPath('/root/c/file.json')).toBeUndefined();
    });
  });

  describe('isSupported', () => {
    it('should return true for registered provider', () => {
      factory.registerAdapter(makeMockAdapter('claude'));
      expect(factory.isSupported('claude')).toBe(true);
    });

    it('should return false for unregistered provider', () => {
      expect(factory.isSupported('gemini')).toBe(false);
    });

    it('should be case-insensitive', () => {
      factory.registerAdapter(makeMockAdapter('codex'));
      expect(factory.isSupported('CODEX')).toBe(true);
    });
  });

  describe('getSupportedProviders', () => {
    it('should return empty array when no adapters registered', () => {
      expect(factory.getSupportedProviders()).toEqual([]);
    });

    it('should return all registered provider names', () => {
      factory.registerAdapter(makeMockAdapter('claude'));
      factory.registerAdapter(makeMockAdapter('codex'));
      factory.registerAdapter(makeMockAdapter('gemini'));

      const providers = factory.getSupportedProviders();
      expect(providers).toHaveLength(3);
      expect(providers).toContain('claude');
      expect(providers).toContain('codex');
      expect(providers).toContain('gemini');
    });
  });
});
