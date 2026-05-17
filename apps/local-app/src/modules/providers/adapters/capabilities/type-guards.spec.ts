import { ClaudeAdapter } from '../claude.adapter';
import { CodexAdapter } from '../codex.adapter';
import { GeminiAdapter } from '../gemini.adapter';
import { OpencodeAdapter } from '../opencode.adapter';
import type { ProviderAdapter } from '../provider-adapter.interface';
import {
  isMcpCli,
  isContextWindowCapable,
  isHookCapable,
  isProjectProvisioningCapable,
  isTranscriptDiscoveryCapable,
} from './type-guards';

describe('type-guards', () => {
  const claude: ProviderAdapter = new ClaudeAdapter();
  const codex: ProviderAdapter = new CodexAdapter();
  const gemini: ProviderAdapter = new GeminiAdapter({
    ensure: jest.fn(),
  } as unknown as ConstructorParameters<typeof GeminiAdapter>[0]);
  const opencode: ProviderAdapter = new OpencodeAdapter();

  describe('isMcpCli', () => {
    it('returns true for Claude', () => {
      expect(isMcpCli(claude)).toBe(true);
    });

    it('returns true for Codex', () => {
      expect(isMcpCli(codex)).toBe(true);
    });

    it('returns true for Gemini', () => {
      expect(isMcpCli(gemini)).toBe(true);
    });

    it('returns false for OpenCode (project_config mode)', () => {
      expect(isMcpCli(opencode)).toBe(false);
    });

    it('narrows type to McpCliCapability for CLI providers', () => {
      if (isMcpCli(claude)) {
        expect(typeof claude.addMcpServer).toBe('function');
        expect(typeof claude.listMcpServers).toBe('function');
        expect(typeof claude.removeMcpServer).toBe('function');
        expect(typeof claude.binaryCheck).toBe('function');
        expect(typeof claude.parseListOutput).toBe('function');
      }
    });
  });

  describe('isContextWindowCapable', () => {
    it('returns true for Claude (implements ContextWindowCapability)', () => {
      expect(isContextWindowCapable(claude)).toBe(true);
    });

    it('returns false for non-Claude adapters', () => {
      expect(isContextWindowCapable(codex)).toBe(false);
      expect(isContextWindowCapable(gemini)).toBe(false);
      expect(isContextWindowCapable(opencode)).toBe(false);
    });

    it('narrows type to ContextWindowCapability for Claude', () => {
      if (isContextWindowCapable(claude)) {
        expect(typeof claude.detectModelFamily).toBe('function');
        expect(typeof claude.is1mActiveForModel).toBe('function');
        expect(typeof claude.applyContextWindowConfig).toBe('function');
        expect(typeof claude.getCompactThreshold).toBe('function');
        expect(typeof claude.getReadTimeContextWindow).toBe('function');
      }
    });
  });

  describe('isHookCapable', () => {
    it('returns true for Claude (implements HookCapability)', () => {
      expect(isHookCapable(claude)).toBe(true);
    });

    it('returns false for non-Claude adapters', () => {
      expect(isHookCapable(codex)).toBe(false);
      expect(isHookCapable(gemini)).toBe(false);
      expect(isHookCapable(opencode)).toBe(false);
    });

    it('narrows type to HookCapability for Claude', () => {
      if (isHookCapable(claude)) {
        expect(claude.hooksEnabled).toBe(true);
        expect(typeof claude.hooksEventName).toBe('string');
        expect(typeof claude.buildHookEnv).toBe('function');
      }
    });
  });

  describe('isProjectProvisioningCapable', () => {
    it('returns true for Gemini (implements ProjectProvisioningCapability)', () => {
      expect(isProjectProvisioningCapable(gemini)).toBe(true);
    });

    it('returns false for non-Gemini adapters', () => {
      expect(isProjectProvisioningCapable(claude)).toBe(false);
      expect(isProjectProvisioningCapable(codex)).toBe(false);
      expect(isProjectProvisioningCapable(opencode)).toBe(false);
    });

    it('narrows type to ProjectProvisioningCapability for Gemini', () => {
      if (isProjectProvisioningCapable(gemini)) {
        expect(gemini.requiresProjectProvisioning).toBe(true);
        expect(typeof gemini.provisionProjectPath).toBe('function');
      }
    });
  });

  describe('isTranscriptDiscoveryCapable', () => {
    it('returns true for Claude, Codex, and Gemini', () => {
      expect(isTranscriptDiscoveryCapable(claude)).toBe(true);
      expect(isTranscriptDiscoveryCapable(codex)).toBe(true);
      expect(isTranscriptDiscoveryCapable(gemini)).toBe(true);
    });

    it('returns false for OpenCode', () => {
      expect(isTranscriptDiscoveryCapable(opencode)).toBe(false);
    });

    it('narrows type with correct strategy per provider', () => {
      if (isTranscriptDiscoveryCapable(claude)) {
        expect(claude.transcriptDiscoveryStrategy).toBe('first');
      }
      if (isTranscriptDiscoveryCapable(gemini)) {
        expect(gemini.transcriptDiscoveryStrategy).toBe('all');
        expect(gemini.transcriptContentSearchMaxBytes).toBe(32_768);
        expect(gemini.providerSessionIdRequiredForRestore).toBe(true);
      }
      if (isTranscriptDiscoveryCapable(codex)) {
        expect(codex.transcriptContentSearchMaxBytes).toBe(65_536);
        expect(codex.contentMatchMaxCandidates).toBe(200);
        expect(codex.providerSessionIdRequiredForRestore).toBe(true);
      }
    });
  });
});
