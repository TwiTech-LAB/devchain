import { ProviderAdapterFactory } from './provider-adapter.factory';
import { ClaudeAdapter } from './claude.adapter';
import { CodexAdapter } from './codex.adapter';
import { OpencodeAdapter } from './opencode.adapter';
import { AntigravityAdapter } from './antigravity.adapter';
import { CopilotAdapter } from './copilot.adapter';
import { UnsupportedProviderError, NotFoundError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';

function makeMockStorage(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    getAgent: jest.fn(),
    getProfileProviderConfig: jest.fn(),
    getProvider: jest.fn(),
    ...overrides,
  } as unknown as StorageService;
}

describe('ProviderAdapterFactory', () => {
  let factory: ProviderAdapterFactory;
  let claudeAdapter: ClaudeAdapter;
  let codexAdapter: CodexAdapter;
  let opencodeAdapter: OpencodeAdapter;
  let antigravityAdapter: AntigravityAdapter;
  let copilotAdapter: CopilotAdapter;
  let mockStorage: StorageService;

  beforeEach(() => {
    claudeAdapter = new ClaudeAdapter();
    codexAdapter = new CodexAdapter();
    opencodeAdapter = new OpencodeAdapter();
    antigravityAdapter = new AntigravityAdapter({ ensure: jest.fn() } as never);
    copilotAdapter = new CopilotAdapter(
      { ensure: jest.fn() } as never,
      { isAuthenticated: jest.fn() } as never,
    );
    mockStorage = makeMockStorage();
    factory = new ProviderAdapterFactory(
      mockStorage,
      claudeAdapter,
      codexAdapter,
      opencodeAdapter,
      antigravityAdapter,
      copilotAdapter,
    );
  });

  describe('getAdapter', () => {
    it('returns AntigravityAdapter for agy provider (case-insensitive)', () => {
      expect(factory.getAdapter('agy')).toBeInstanceOf(AntigravityAdapter);
      expect(factory.getAdapter('agy').providerName).toBe('agy');
      expect(factory.getAdapter('AGY')).toBe(antigravityAdapter);
    });

    it('returns CopilotAdapter for copilot provider (case-insensitive)', () => {
      expect(factory.getAdapter('copilot')).toBeInstanceOf(CopilotAdapter);
      expect(factory.getAdapter('copilot').providerName).toBe('copilot');
      expect(factory.getAdapter('Copilot')).toBe(copilotAdapter);
      expect(factory.getAdapter('COPILOT')).toBe(copilotAdapter);
    });

    it('OpenCode adapter does not define launchInitialPromptBehavior', () => {
      const adapter = factory.getAdapter('opencode');
      expect(adapter.launchInitialPromptBehavior).toBeUndefined();
    });

    it('returns the exact injected adapter instances (DI)', () => {
      expect(factory.getAdapter('claude')).toBe(claudeAdapter);
      expect(factory.getAdapter('codex')).toBe(codexAdapter);
      expect(factory.getAdapter('opencode')).toBe(opencodeAdapter);
    });

    it('normalizes provider name to lowercase (case-insensitive lookup)', () => {
      expect(factory.getAdapter('Claude')).toBe(claudeAdapter);
      expect(factory.getAdapter('CLAUDE')).toBe(claudeAdapter);
      expect(factory.getAdapter('Codex')).toBe(codexAdapter);
      expect(factory.getAdapter('OpenCode')).toBe(opencodeAdapter);
      expect(factory.getAdapter('OPENCODE')).toBe(opencodeAdapter);
    });

    it('throws UnsupportedProviderError for unsupported provider', () => {
      expect(() => factory.getAdapter('unknown')).toThrow(UnsupportedProviderError);
      expect(() => factory.getAdapter('unknown')).toThrow(
        'Unsupported provider: unknown. Supported providers: claude, codex, opencode, agy, copilot',
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
          supportedProviders: ['claude', 'codex', 'opencode', 'agy', 'copilot'],
        });
      }
    });
  });

  describe('isSupported', () => {
    it.each([
      { name: 'claude', supported: true },
      { name: 'codex', supported: true },
      { name: 'opencode', supported: true },
      { name: 'unknown', supported: false },
    ])('reports support for $name', ({ name, supported }) => {
      expect(factory.isSupported(name)).toBe(supported);
    });

    it('normalizes provider name to lowercase (case-insensitive check)', () => {
      expect(factory.isSupported('Claude')).toBe(true);
      expect(factory.isSupported('CLAUDE')).toBe(true);
      expect(factory.isSupported('Codex')).toBe(true);
      expect(factory.isSupported('OpenCode')).toBe(true);
      expect(factory.isSupported('OPENCODE')).toBe(true);
    });
  });

  describe('getSupportedProviders', () => {
    it('returns array of supported provider names', () => {
      const supported = factory.getSupportedProviders();
      expect(supported).toEqual(
        expect.arrayContaining(['claude', 'codex', 'opencode', 'agy', 'copilot']),
      );
      expect(supported).toHaveLength(5);
    });
  });

  describe('getRuntimePromptBehaviorForAgent', () => {
    const AGENT_ID = 'agent-001';
    const CONFIG_ID = 'config-001';
    const PROVIDER_ID = 'provider-001';

    function setupChain(providerName: string) {
      (mockStorage.getAgent as jest.Mock).mockResolvedValue({
        id: AGENT_ID,
        providerConfigId: CONFIG_ID,
      });
      (mockStorage.getProfileProviderConfig as jest.Mock).mockResolvedValue({
        id: CONFIG_ID,
        providerId: PROVIDER_ID,
        providerName,
      });
    }

    it('turns the follow note on for a Claude agent', async () => {
      setupChain('claude');
      const result = await factory.getRuntimePromptBehaviorForAgent(AGENT_ID);
      expect(result).toEqual({ followNote: true });
    });

    it('returns no behavior for a Codex agent', async () => {
      setupChain('codex');
      const result = await factory.getRuntimePromptBehaviorForAgent(AGENT_ID);
      expect(result).toEqual({});
    });

    it('returns no behavior when agent not found', async () => {
      (mockStorage.getAgent as jest.Mock).mockRejectedValue(new NotFoundError('Agent', AGENT_ID));
      const result = await factory.getRuntimePromptBehaviorForAgent(AGENT_ID);
      expect(result).toEqual({});
    });

    it('returns no behavior when providerConfigId is missing', async () => {
      (mockStorage.getAgent as jest.Mock).mockResolvedValue({
        id: AGENT_ID,
        providerConfigId: null,
      });
      const result = await factory.getRuntimePromptBehaviorForAgent(AGENT_ID);
      expect(result).toEqual({});
    });

    it('returns no behavior when config not found', async () => {
      (mockStorage.getAgent as jest.Mock).mockResolvedValue({
        id: AGENT_ID,
        providerConfigId: CONFIG_ID,
      });
      (mockStorage.getProfileProviderConfig as jest.Mock).mockRejectedValue(
        new NotFoundError('Config', CONFIG_ID),
      );
      const result = await factory.getRuntimePromptBehaviorForAgent(AGENT_ID);
      expect(result).toEqual({});
    });

    it('falls back to getProvider when providerName not on config', async () => {
      (mockStorage.getAgent as jest.Mock).mockResolvedValue({
        id: AGENT_ID,
        providerConfigId: CONFIG_ID,
      });
      (mockStorage.getProfileProviderConfig as jest.Mock).mockResolvedValue({
        id: CONFIG_ID,
        providerId: PROVIDER_ID,
        providerName: undefined,
      });
      (mockStorage.getProvider as jest.Mock).mockResolvedValue({
        id: PROVIDER_ID,
        name: 'claude',
      });
      const result = await factory.getRuntimePromptBehaviorForAgent(AGENT_ID);
      // Fallback resolves the provider name via getProvider to the Claude adapter.
      expect(mockStorage.getProvider).toHaveBeenCalledWith(PROVIDER_ID);
      expect(result).toEqual({ followNote: true });
    });

    it('returns no behavior for an unsupported provider name', async () => {
      setupChain('unknown-provider');
      const result = await factory.getRuntimePromptBehaviorForAgent(AGENT_ID);
      expect(result).toEqual({});
    });
  });
});
