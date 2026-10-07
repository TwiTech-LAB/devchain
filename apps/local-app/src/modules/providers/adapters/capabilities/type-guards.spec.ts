import { ClaudeAdapter } from '../claude.adapter';
import { CodexAdapter } from '../codex.adapter';
import { OpencodeAdapter } from '../opencode.adapter';
import { AntigravityAdapter } from '../antigravity.adapter';
import { CopilotAdapter } from '../copilot.adapter';
import type { ProviderAdapter } from '../provider-adapter.interface';
import {
  isMcpCli,
  isGlobalMcpConfigCapable,
  isAutoCompactCapable,
  isEffortCapable,
  isHookCapable,
  isProjectProvisioningCapable,
  isTranscriptDiscoveryCapable,
  isProviderPluginCapable,
} from './type-guards';

describe('type-guards', () => {
  const claude: ProviderAdapter = new ClaudeAdapter();
  const codex: ProviderAdapter = new CodexAdapter();
  const opencode: ProviderAdapter = new OpencodeAdapter();
  const antigravity: ProviderAdapter = new AntigravityAdapter({ ensure: jest.fn() } as never);
  const copilot: ProviderAdapter = new CopilotAdapter(
    { ensure: jest.fn() } as never,
    { isAuthenticated: jest.fn() } as never,
  );

  describe('isGlobalMcpConfigCapable', () => {
    it('returns false for CLI and project-local config providers', () => {
      expect(isGlobalMcpConfigCapable(claude)).toBe(false);
      expect(isGlobalMcpConfigCapable(codex)).toBe(false);
      expect(isGlobalMcpConfigCapable(opencode)).toBe(false);
    });
  });

  describe('isMcpCli (agy defaults to CLI but is routed by isGlobalMcpConfigCapable first)', () => {
    it('returns true for agy (no project_config mode) — the port checks global-config first', () => {
      // agy has no `mcpMode='project_config'`, so the loose isMcpCli default is
      // true; McpRegistrationPort.resolveAdapter MUST check isGlobalMcpConfigCapable
      // before isMcpCli so agy never routes to the CLI adapter.
      expect(isMcpCli(antigravity)).toBe(true);
      expect(isGlobalMcpConfigCapable(antigravity)).toBe(true);
    });
  });

  describe('isMcpCli', () => {
    it.each([
      { name: 'claude', expected: true },
      { name: 'codex', expected: true },
      { name: 'opencode', expected: false },
    ])('classifies $name MCP mode', ({ name, expected }) => {
      expect(isMcpCli(name === 'claude' ? claude : name === 'codex' ? codex : opencode)).toBe(
        expected,
      );
    });
  });

  describe('isAutoCompactCapable', () => {
    it('returns true for Claude', () => {
      expect(isAutoCompactCapable(claude)).toBe(true);
    });

    it('returns false for non-Claude adapters', () => {
      expect(isAutoCompactCapable(codex)).toBe(false);
      expect(isAutoCompactCapable(opencode)).toBe(false);
    });
  });

  describe('isProviderPluginCapable', () => {
    it('returns true only for Claude and Codex', () => {
      expect(isProviderPluginCapable(claude)).toBe(true);
      expect(isProviderPluginCapable(codex)).toBe(true);
      expect(isProviderPluginCapable(opencode)).toBe(false);
      expect(isProviderPluginCapable(antigravity)).toBe(false);
      expect(isProviderPluginCapable(copilot)).toBe(false);
    });
  });

  describe('isEffortCapable', () => {
    it('returns true for the effort adopters (claude, codex, copilot argv + opencode env overlay)', () => {
      expect(isEffortCapable(claude)).toBe(true);
      expect(isEffortCapable(codex)).toBe(true);
      expect(isEffortCapable(copilot)).toBe(true);
      expect(isEffortCapable(opencode)).toBe(true);
    });

    it('returns false for agy (not effort-capable — effort is embedded in model names)', () => {
      expect(isEffortCapable(antigravity)).toBe(false);
    });

    it('flags opencode as per-model (requiresModelForEffort) but not the argv adopters', () => {
      if (isEffortCapable(opencode)) {
        expect(opencode.requiresModelForEffort).toBe(true);
      }
      if (isEffortCapable(claude)) {
        expect(claude.requiresModelForEffort).toBeUndefined();
      }
    });
  });

  describe('isHookCapable', () => {
    it('returns true for Claude and Copilot (the two HookCapability adopters)', () => {
      expect(isHookCapable(claude)).toBe(true);
      expect(isHookCapable(copilot)).toBe(true);
    });

    it('returns false for non-hook adapters', () => {
      expect(isHookCapable(codex)).toBe(false);
      expect(isHookCapable(opencode)).toBe(false);
      expect(isHookCapable(antigravity)).toBe(false);
    });
  });

  describe('isProjectProvisioningCapable', () => {
    it('returns true for Claude, Antigravity, Copilot, and Codex (ProjectProvisioningCapability adopters)', () => {
      expect(isProjectProvisioningCapable(claude)).toBe(true);
      expect(isProjectProvisioningCapable(antigravity)).toBe(true);
      expect(isProjectProvisioningCapable(copilot)).toBe(true);
      expect(isProjectProvisioningCapable(codex)).toBe(true);
    });

    it('returns false for adapters without project provisioning', () => {
      expect(isProjectProvisioningCapable(opencode)).toBe(false);
    });
  });

  describe('isTranscriptDiscoveryCapable', () => {
    it('returns true for Claude, Codex, and OpenCode', () => {
      expect(isTranscriptDiscoveryCapable(claude)).toBe(true);
      expect(isTranscriptDiscoveryCapable(codex)).toBe(true);
      expect(isTranscriptDiscoveryCapable(opencode)).toBe(true);
    });

    it('marks OpenCode as DB-backed: requires providerSessionId for restore', () => {
      if (isTranscriptDiscoveryCapable(opencode)) {
        expect(opencode.transcriptDiscoveryStrategy).toBe('all');
        expect(opencode.providerSessionIdRequiredForRestore).toBe(true);
      }
    });

    it('narrows type with correct strategy per provider', () => {
      if (isTranscriptDiscoveryCapable(claude)) {
        expect(claude.transcriptDiscoveryStrategy).toBe('first');
      }
      if (isTranscriptDiscoveryCapable(codex)) {
        expect(codex.transcriptContentSearchMaxBytes).toBe(65_536);
        expect(codex.contentMatchMaxCandidates).toBe(200);
        expect(codex.providerSessionIdRequiredForRestore).toBe(true);
      }
    });
  });
});
